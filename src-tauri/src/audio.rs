//! Native audio engine.
//!
//! `rodio`'s `OutputStream` is `!Send`, so it can't live in Tauri's shared state.
//! The correct pattern (and what we do here) is a dedicated audio thread that owns
//! the stream + sink, driven by an mpsc command channel. `AudioController` only
//! holds the `Sender` (wrapped in a `Mutex` so the whole struct is `Send + Sync`
//! and can be `.manage()`d by Tauri).

use rodio::{Decoder, OutputStream, Sink};
use std::fs::File;
use std::io::BufReader;
use std::sync::mpsc::{channel, Sender};
use std::sync::Mutex;
use std::thread;

pub enum AudioCmd {
    Play(String), // absolute file path
    Pause,
    Resume,
    Stop,
    Volume(f32), // 0.0 ..= 1.0 (rodio allows >1.0 for gain)
}

pub struct AudioController {
    tx: Mutex<Sender<AudioCmd>>,
}

impl AudioController {
    pub fn new() -> Self {
        let (tx, rx) = channel::<AudioCmd>();

        thread::spawn(move || {
            // The stream handle must stay alive for playback; created inside the
            // thread because it is not `Send`.
            let (_stream, handle) = match OutputStream::try_default() {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("[audio] no output device available: {e}");
                    return;
                }
            };
            let mut sink = Sink::try_new(&handle).expect("failed to create audio sink");

            while let Ok(cmd) = rx.recv() {
                match cmd {
                    AudioCmd::Play(path) => {
                        // Fresh sink per track: dropping the old one stops playback cleanly.
                        sink = match Sink::try_new(&handle) {
                            Ok(s) => s,
                            Err(e) => {
                                eprintln!("[audio] sink error: {e}");
                                continue;
                            }
                        };
                        let opened = File::open(&path)
                            .map(BufReader::new)
                            .map_err(|e| e.to_string())
                            .and_then(|r| Decoder::new(r).map_err(|e| e.to_string()));
                        match opened {
                            Ok(source) => {
                                sink.append(source);
                                sink.play();
                            }
                            Err(e) => eprintln!("[audio] cannot play {path}: {e}"),
                        }
                    }
                    AudioCmd::Pause => sink.pause(),
                    AudioCmd::Resume => sink.play(),
                    AudioCmd::Stop => {
                        // Replace with an empty sink → stops immediately.
                        if let Ok(s) = Sink::try_new(&handle) {
                            sink = s;
                        }
                    }
                    AudioCmd::Volume(v) => sink.set_volume(v.clamp(0.0, 2.0)),
                }
            }
        });

        AudioController { tx: Mutex::new(tx) }
    }

    fn send(&self, cmd: AudioCmd) {
        if let Ok(tx) = self.tx.lock() {
            let _ = tx.send(cmd);
        }
    }

    pub fn play(&self, path: String) {
        self.send(AudioCmd::Play(path));
    }
    pub fn pause(&self) {
        self.send(AudioCmd::Pause);
    }
    pub fn resume(&self) {
        self.send(AudioCmd::Resume);
    }
    pub fn stop(&self) {
        self.send(AudioCmd::Stop);
    }
    pub fn set_volume(&self, level: f32) {
        self.send(AudioCmd::Volume(level));
    }
}

impl Default for AudioController {
    fn default() -> Self {
        Self::new()
    }
}
