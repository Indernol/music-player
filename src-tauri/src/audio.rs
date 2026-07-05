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

use rodio::{Decoder, OutputStream, Sink, Source};
use serde::Serialize;
use std::fs::File;
use std::io::BufReader;
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

const FADE: Duration = Duration::from_millis(20);

enum AudioCmd {
    Play(String, f32),    // path, linear gain — hard start (fresh sink)
    Preload(String, f32), // path, linear gain — append for gapless continuation
    Clear,                // stop everything (empty sink)
}

#[derive(Serialize)]
pub struct PlaybackStatus {
    pub queued: u32,    // sources still in the sink (current + preloaded)
    pub finished: bool, // sink is empty
    pub position: f64,  // seconds into the current source (secondary; UI uses a wall clock)
}

pub struct AudioController {
    tx: Mutex<Sender<AudioCmd>>,
    sink: Arc<Mutex<Option<Sink>>>,
}

fn append_track(sink: &Sink, path: &str, gain: f32) {
    match File::open(path)
        .map(BufReader::new)
        .map_err(|e| e.to_string())
        .and_then(|r| Decoder::new(r).map_err(|e| e.to_string()))
    {
        Ok(dec) => sink.append(dec.fade_in(FADE).amplify(gain)),
        Err(e) => eprintln!("[audio] cannot load {path}: {e}"),
    }
}

impl AudioController {
    pub fn new() -> Self {
        let (tx, rx) = channel::<AudioCmd>();
        let sink: Arc<Mutex<Option<Sink>>> = Arc::new(Mutex::new(None));
        let sink_t = sink.clone();

        thread::spawn(move || {
            let (_stream, handle) = match OutputStream::try_default() {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("[audio] no output device available: {e}");
                    return;
                }
            };
            if let Ok(s) = Sink::try_new(&handle) {
                *sink_t.lock().unwrap() = Some(s);
            }

            while let Ok(cmd) = rx.recv() {
                match cmd {
                    AudioCmd::Play(path, gain) => match Sink::try_new(&handle) {
                        Ok(new_sink) => {
                            append_track(&new_sink, &path, gain);
                            new_sink.play();
                            *sink_t.lock().unwrap() = Some(new_sink);
                        }
                        Err(e) => eprintln!("[audio] sink error: {e}"),
                    },
                    AudioCmd::Preload(path, gain) => {
                        if let Some(s) = sink_t.lock().unwrap().as_ref() {
                            append_track(s, &path, gain);
                        }
                    }
                    AudioCmd::Clear => {
                        if let Ok(s) = Sink::try_new(&handle) {
                            *sink_t.lock().unwrap() = Some(s);
                        }
                    }
                }
            }
        });

        AudioController {
            tx: Mutex::new(tx),
            sink,
        }
    }

    fn send(&self, cmd: AudioCmd) {
        if let Ok(tx) = self.tx.lock() {
            let _ = tx.send(cmd);
        }
    }
    fn with_sink<R>(&self, f: impl FnOnce(&Sink) -> R) -> Option<R> {
        self.sink.lock().unwrap().as_ref().map(f)
    }

    pub fn play(&self, path: String, gain: f32) {
        self.send(AudioCmd::Play(path, gain));
    }
    pub fn preload(&self, path: String, gain: f32) {
        self.send(AudioCmd::Preload(path, gain));
    }
    pub fn stop(&self) {
        self.send(AudioCmd::Clear);
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
        match self.sink.lock().unwrap().as_ref() {
            Some(s) => PlaybackStatus {
                queued: s.len() as u32,
                finished: s.empty(),
                position: s.get_pos().as_secs_f64(),
            },
            None => PlaybackStatus {
                queued: 0,
                finished: true,
                position: 0.0,
            },
        }
    }
}

impl Default for AudioController {
    fn default() -> Self {
        Self::new()
    }
}
