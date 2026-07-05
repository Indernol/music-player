//! Native audio engine.
//!
//! `rodio`'s `OutputStream` is `!Send`, so the stream lives in a dedicated thread
//! that also creates the sinks (creating a sink needs the stream handle, which is
//! `!Send`). The current `Sink` is `Send + Sync`, so we share it back through an
//! `Arc<Mutex<Option<Sink>>>`: the thread swaps in a fresh sink on Play/Stop, while
//! the controller reads/pauses/seeks it directly (no round-trip needed for those).

use rodio::{Decoder, OutputStream, Sink};
use serde::Serialize;
use std::fs::File;
use std::io::BufReader;
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

// Only Play/Stop go through the channel — they need the (!Send) stream handle.
enum AudioCmd {
    Play(String),
    Stop,
}

#[derive(Serialize)]
pub struct PlaybackStatus {
    pub position: f64, // seconds into the current track
    pub finished: bool, // sink has nothing left to play
}

pub struct AudioController {
    tx: Mutex<Sender<AudioCmd>>,
    sink: Arc<Mutex<Option<Sink>>>,
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
            // Start with an empty, ready sink.
            if let Ok(s) = Sink::try_new(&handle) {
                *sink_t.lock().unwrap() = Some(s);
            }

            while let Ok(cmd) = rx.recv() {
                match cmd {
                    AudioCmd::Play(path) => match Sink::try_new(&handle) {
                        Ok(new_sink) => {
                            let loaded = File::open(&path)
                                .map(BufReader::new)
                                .map_err(|e| e.to_string())
                                .and_then(|r| Decoder::new(r).map_err(|e| e.to_string()));
                            match loaded {
                                Ok(source) => {
                                    new_sink.append(source);
                                    new_sink.play();
                                    *sink_t.lock().unwrap() = Some(new_sink);
                                }
                                Err(e) => eprintln!("[audio] cannot play {path}: {e}"),
                            }
                        }
                        Err(e) => eprintln!("[audio] sink error: {e}"),
                    },
                    AudioCmd::Stop => {
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

    fn with_sink<R>(&self, f: impl FnOnce(&Sink) -> R) -> Option<R> {
        self.sink.lock().unwrap().as_ref().map(f)
    }

    pub fn play(&self, path: String) {
        if let Ok(tx) = self.tx.lock() {
            let _ = tx.send(AudioCmd::Play(path));
        }
    }
    pub fn stop(&self) {
        if let Ok(tx) = self.tx.lock() {
            let _ = tx.send(AudioCmd::Stop);
        }
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
                position: s.get_pos().as_secs_f64(),
                finished: s.empty(),
            },
            None => PlaybackStatus {
                position: 0.0,
                finished: true,
            },
        }
    }
}

impl Default for AudioController {
    fn default() -> Self {
        Self::new()
    }
}
