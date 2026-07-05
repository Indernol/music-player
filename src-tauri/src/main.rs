// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio;
mod library;
mod playlists;

use audio::AudioController;
use library::Track;
use tauri::State;

struct AppState {
    audio: AudioController,
}

#[tauri::command]
fn scan(paths: Vec<String>) -> Vec<Track> {
    library::scan_library(&paths)
}

#[tauri::command]
fn play(path: String, state: State<AppState>) {
    state.audio.play(path);
}

#[tauri::command]
fn pause(state: State<AppState>) {
    state.audio.pause();
}

#[tauri::command]
fn resume(state: State<AppState>) {
    state.audio.resume();
}

#[tauri::command]
fn stop(state: State<AppState>) {
    state.audio.stop();
}

#[tauri::command]
fn set_volume(level: f32, state: State<AppState>) {
    state.audio.set_volume(level);
}

#[tauri::command]
fn seek(secs: f64, state: State<AppState>) {
    state.audio.seek(secs);
}

#[tauri::command]
fn status(state: State<AppState>) -> audio::PlaybackStatus {
    state.audio.status()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            audio: AudioController::new(),
        })
        .invoke_handler(tauri::generate_handler![
            scan, play, pause, resume, stop, set_volume, seek, status,
            playlists::load_playlists, playlists::save_playlists
        ])
        .run(tauri::generate_context!())
        .expect("error while running Music Player");
}
