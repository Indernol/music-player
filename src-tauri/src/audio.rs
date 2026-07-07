//! Native audio engine — gapless queue + per-track gain + anti-click fade.
//!
//! `rodio`'s `OutputStream` is `!Send`, so the stream lives in a dedicated thread
//! that owns a single persistent `Sink`. Gapless playback is achieved the way
//! rodio is designed for: the NEXT track is `append`ed to the same sink before the
//! current one ends, so rodio transitions with no gap. Each appended source is
//! wrapped with a short `fade_in` (kills clicks) and `amplify(gain)` (per-track
//! ReplayGain — the sink's own volume stays the user's master control on top).
//!
//! Play/Preload/Clear need the (!Send) stream handle, so they go through the
//! channel. Pause/resume/seek/volume/status act on the shared `Sink` directly.

use crate::stream::HttpStream;
use rodio::{Decoder, OutputStreamBuilder, Sink, Source};
use serde::Serialize;
use std::fs::File;
use std::io::BufReader;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

const FADE: Duration = Duration::from_millis(20);
// Automatic gain control: evens out perceived loudness across tracks (YouTube
// rips have no ReplayGain tags, so tag-based normalization can't help them).
const AGC_TARGET: f32 = 0.85;
const AGC_ATTACK: f32 = 4.0;
const AGC_RELEASE: f32 = 0.005;
const AGC_MAX_GAIN: f32 = 4.0;

enum AudioCmd {
    Play(String, f32, u64),    // path, linear gain, epoch — hard start (fresh sink)
    Preload(String, f32),      // path, linear gain — append for gapless continuation
    PlayUrl(String, f32, u64), // remote stream URL, epoch — hard start (fresh sink)
    PreloadUrl(String, f32),   // remote stream URL — append for gapless continuation
    Clear(u64),                // stop everything (empty sink)
}

#[derive(Serialize)]
pub struct PlaybackStatus {
    pub queued: u32,    // sources still in the sink (current + preloaded)
    pub finished: bool, // sink is empty
    pub position: f64,  // seconds into the current source (secondary; UI uses a wall clock)
    pub epoch: u64,     // which play/clear command this sink belongs to
}

// The epoch tags each hard start: play() hands it to the frontend and status()
// reports the sink's epoch, so a status poll taken while a slow stream is still
// connecting (the previous sink still audible) can be recognized as stale and
// ignored instead of being misread as a gapless track transition.
pub struct AudioController {
    tx: Mutex<Sender<AudioCmd>>,
    sink: Arc<Mutex<(u64, Option<Sink>)>>,
    next_epoch: AtomicU64,
    agc: Arc<AtomicBool>,
}

fn append_source<S>(sink: &Sink, src: S, gain: f32, agc: bool)
where
    S: Source + Send + 'static,
{
    let base = src.fade_in(FADE).amplify(gain);
    if agc {
        sink.append(base.automatic_gain_control(AGC_TARGET, AGC_ATTACK, AGC_RELEASE, AGC_MAX_GAIN));
    } else {
        sink.append(base);
    }
}

fn append_track(sink: &Sink, path: &str, gain: f32, agc: bool) {
    // rodio 0.21 defaults to is_seekable=false; opt back in so Sink::try_seek works.
    match File::open(path).map_err(|e| e.to_string()).and_then(|f| {
        let len = f.metadata().map(|m| m.len()).ok();
        let mut b = Decoder::builder()
            .with_data(BufReader::new(f))
            .with_seekable(true);
        if let Some(l) = len {
            b = b.with_byte_len(l);
        }
        b.build().map_err(|e| e.to_string())
    }) {
        Ok(dec) => append_source(sink, dec, gain, agc),
        Err(e) => eprintln!("[audio] cannot load {path}: {e}"),
    }
}

fn append_url(sink: &Sink, url: &str, gain: f32, agc: bool) {
    // byte_len is mandatory here: symphonia's isomp4 demuxer refuses to probe
    // YouTube's moov-after-mdat m4a files without knowing the total size.
    match HttpStream::open(url.to_string()).and_then(|s| {
        let len = s.byte_len();
        Decoder::builder()
            .with_data(s)
            .with_byte_len(len)
            .with_seekable(true)
            .build()
            .map_err(|e| e.to_string())
    }) {
        Ok(dec) => append_source(sink, dec, gain, agc),
        Err(e) => eprintln!("[audio] cannot stream: {e}"),
    }
}

impl AudioController {
    pub fn new() -> Self {
        let (tx, rx) = channel::<AudioCmd>();
        let sink: Arc<Mutex<(u64, Option<Sink>)>> = Arc::new(Mutex::new((0, None)));
        let sink_t = sink.clone();
        let agc = Arc::new(AtomicBool::new(true));
        let agc_t = agc.clone();

        thread::spawn(move || {
            // The OutputStream must stay alive for the whole thread.
            let stream = match OutputStreamBuilder::open_default_stream() {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("[audio] no output device available: {e}");
                    return;
                }
            };
            *sink_t.lock().unwrap() = (0, Some(Sink::connect_new(stream.mixer())));

            while let Ok(cmd) = rx.recv() {
                let agc_on = agc_t.load(Ordering::Relaxed);
                match cmd {
                    AudioCmd::Play(path, gain, epoch) => {
                        let new_sink = Sink::connect_new(stream.mixer());
                        append_track(&new_sink, &path, gain, agc_on);
                        new_sink.play();
                        *sink_t.lock().unwrap() = (epoch, Some(new_sink));
                    }
                    AudioCmd::Preload(path, gain) => {
                        if let (_, Some(s)) = &*sink_t.lock().unwrap() {
                            append_track(s, &path, gain, agc_on);
                        }
                    }
                    AudioCmd::PlayUrl(url, gain, epoch) => {
                        let new_sink = Sink::connect_new(stream.mixer());
                        append_url(&new_sink, &url, gain, agc_on);
                        new_sink.play();
                        *sink_t.lock().unwrap() = (epoch, Some(new_sink));
                    }
                    AudioCmd::PreloadUrl(url, gain) => {
                        if let (_, Some(s)) = &*sink_t.lock().unwrap() {
                            append_url(s, &url, gain, agc_on);
                        }
                    }
                    AudioCmd::Clear(epoch) => {
                        *sink_t.lock().unwrap() = (epoch, Some(Sink::connect_new(stream.mixer())));
                    }
                }
            }
        });

        AudioController {
            tx: Mutex::new(tx),
            sink,
            next_epoch: AtomicU64::new(0),
            agc,
        }
    }

    /// Toggle automatic loudness normalization (applies to the NEXT queued
    /// sources — the currently playing one keeps its chain).
    pub fn set_agc(&self, on: bool) {
        self.agc.store(on, Ordering::Relaxed);
    }

    fn send(&self, cmd: AudioCmd) {
        if let Ok(tx) = self.tx.lock() {
            let _ = tx.send(cmd);
        }
    }
    fn bump_epoch(&self) -> u64 {
        self.next_epoch.fetch_add(1, Ordering::Relaxed) + 1
    }
    fn with_sink<R>(&self, f: impl FnOnce(&Sink) -> R) -> Option<R> {
        self.sink.lock().unwrap().1.as_ref().map(f)
    }

    pub fn play(&self, path: String, gain: f32) -> u64 {
        let e = self.bump_epoch();
        self.send(AudioCmd::Play(path, gain, e));
        e
    }
    pub fn preload(&self, path: String, gain: f32) {
        self.send(AudioCmd::Preload(path, gain));
    }
    pub fn play_url(&self, url: String, gain: f32) -> u64 {
        let e = self.bump_epoch();
        self.send(AudioCmd::PlayUrl(url, gain, e));
        e
    }
    pub fn preload_url(&self, url: String, gain: f32) {
        self.send(AudioCmd::PreloadUrl(url, gain));
    }
    pub fn stop(&self) -> u64 {
        let e = self.bump_epoch();
        self.send(AudioCmd::Clear(e));
        e
    }
    pub fn pause(&self) {
        self.with_sink(|s| s.pause());
    }
    pub fn resume(&self) {
        self.with_sink(|s| s.play());
    }
    pub fn set_volume(&self, level: f32) {
        self.with_sink(|s| s.set_volume(level.clamp(0.0, 2.0)));
    }
    pub fn seek(&self, secs: f64) {
        self.with_sink(|s| {
            let _ = s.try_seek(Duration::from_secs_f64(secs.max(0.0)));
        });
    }
    pub fn status(&self) -> PlaybackStatus {
        let guard = self.sink.lock().unwrap();
        match &guard.1 {
            Some(s) => PlaybackStatus {
                queued: s.len() as u32,
                finished: s.empty(),
                position: s.get_pos().as_secs_f64(),
                epoch: guard.0,
            },
            None => PlaybackStatus {
                queued: 0,
                finished: true,
                position: 0.0,
                epoch: guard.0,
            },
        }
    }
}

impl Default for AudioController {
    fn default() -> Self {
        Self::new()
    }
}
