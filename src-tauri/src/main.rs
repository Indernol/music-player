// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio;
mod library;
mod mpris;
mod rpc;
mod store;
mod stream;
mod youtube;

use audio::AudioController;
use library::Track;
use tauri::{Manager, State};

struct AppState {
    audio: AudioController,
}

// Scans read tags from hundreds of files — async so the UI thread never blocks.
#[tauri::command]
async fn scan(paths: Vec<String>) -> Result<Vec<Track>, String> {
    Ok(library::scan_library(&paths))
}

#[tauri::command]
async fn scan_diff(
    paths: Vec<String>,
    known: Vec<String>,
) -> Result<library::ScanDiff, String> {
    let known: std::collections::HashSet<String> = known.into_iter().collect();
    Ok(library::scan_diff(&paths, &known))
}

#[tauri::command]
fn play(path: String, gain: f32, state: State<AppState>) -> u64 {
    state.audio.play(path, gain)
}

#[tauri::command]
fn preload(path: String, gain: f32, state: State<AppState>) {
    state.audio.preload(path, gain);
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
fn stop(state: State<AppState>) -> u64 {
    state.audio.stop()
}

#[tauri::command]
fn set_volume(level: f32, state: State<AppState>) {
    state.audio.set_volume(level);
}

#[tauri::command]
fn set_agc(on: bool, state: State<AppState>) {
    state.audio.set_agc(on);
}

#[tauri::command]
fn seek(secs: f64, state: State<AppState>) {
    state.audio.seek(secs);
}

#[tauri::command]
fn status(state: State<AppState>) -> audio::PlaybackStatus {
    state.audio.status()
}

// Streaming commands are async so yt-dlp resolution never blocks the UI thread.

#[tauri::command]
async fn play_stream(
    id: String,
    gain: f32,
    state: State<'_, AppState>,
    yt: State<'_, youtube::YtState>,
    cfg: State<'_, youtube::YtCfg>,
) -> Result<u64, String> {
    let url = youtube::resolve(&yt, &cfg, &id)?;
    Ok(state.audio.play_url(url, gain))
}

#[tauri::command]
async fn preload_stream(
    id: String,
    gain: f32,
    state: State<'_, AppState>,
    yt: State<'_, youtube::YtState>,
    cfg: State<'_, youtube::YtCfg>,
) -> Result<(), String> {
    let url = youtube::resolve(&yt, &cfg, &id)?;
    state.audio.preload_url(url, gain);
    Ok(())
}

/// Resolve a stream URL into the cache without playing anything, so the actual
/// play later is near-instant (called when the user selects an online track).
#[tauri::command]
async fn prefetch_stream(
    id: String,
    yt: State<'_, youtube::YtState>,
    cfg: State<'_, youtube::YtCfg>,
) -> Result<(), String> {
    youtube::resolve(&yt, &cfg, &id).map(|_| ())
}

// ─── Self-update: the binary is built from the local source tree (the GitHub
// repo checkout), so "latest version" = the version in the tree's
// tauri.conf.json, and "update" = cargo build + restart. ───

fn source_dir() -> Result<std::path::PathBuf, String> {
    // exe lives at <src-tauri>/target/debug/music-player
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe
        .ancestors()
        .nth(3)
        .ok_or("cannot locate the source tree")?
        .to_path_buf();
    if dir.join("tauri.conf.json").exists() {
        Ok(dir)
    } else {
        Err("source tree not found next to the binary".into())
    }
}

/// Version currently in the source tree (what a rebuild would produce).
#[tauri::command]
async fn source_version() -> Result<String, String> {
    let conf = source_dir()?.join("tauri.conf.json");
    let txt = std::fs::read_to_string(&conf).map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&txt).map_err(|e| e.to_string())?;
    v["version"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| "no version field".into())
}

/// Relaunch the app process — used right after a successful self-update, since
/// cargo replaced the binary at the same path.
#[tauri::command]
fn restart_app(app: tauri::AppHandle) {
    app.restart();
}

/// Rebuild the app from the source tree; progress lines stream as "update"
/// events. On success the user just restarts the app to run the new build.
#[tauri::command]
async fn self_update(app: tauri::AppHandle) -> Result<String, String> {
    use std::io::BufRead;
    use tauri::Emitter;
    let dir = source_dir()?;
    let mut child = std::process::Command::new("bash")
        .arg("-lc")
        .arg(format!(
            "export PATH=\"$HOME/.cargo/bin:$PATH\"; cd '{}' && cargo build 2>&1",
            dir.display()
        ))
        .stdout(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("cannot run the build: {e}"))?;
    let mut tail: Vec<String> = Vec::new();
    if let Some(out) = child.stdout.take() {
        for line in std::io::BufReader::new(out).lines().map_while(Result::ok) {
            let _ = app.emit("update", line.clone());
            tail.push(line);
            if tail.len() > 30 {
                tail.remove(0);
            }
        }
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    if !status.success() {
        return Err(format!("build failed:\n{}", tail.join("\n")));
    }
    Ok("built".into())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(AppState {
            audio: AudioController::new(),
        })
        .manage(rpc::RpcState::default())
        .manage(youtube::YtState::default())
        .manage(youtube::YtCfg::default())
        .manage(youtube::DlState::default())
        .manage(mpris::MediaState::default())
        .setup(|app| {
            // Register on D-Bus right away so desktop media widgets see the player.
            let handle = app.handle();
            if let Err(e) = mpris::init(handle, &app.state::<mpris::MediaState>()) {
                eprintln!("[mpris] init failed (desktop integration disabled): {e}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            scan, scan_diff, play, preload, pause, resume, stop, set_volume, set_agc, seek, status,
            source_version, self_update, restart_app,
            play_stream, preload_stream, prefetch_stream,
            youtube::yt_search, youtube::yt_search_playlists, youtube::yt_playlist,
            youtube::yt_playlist_preview,
            youtube::yt_download, youtube::yt_cancel,
            youtube::yt_config,
            mpris::media_update, mpris::media_playback,
            library::cover, library::read_image,
            store::store_load, store::store_save,
            rpc::rpc_update, rpc::rpc_clear
        ])
        .run(tauri::generate_context!())
        .expect("error while running Music Player");
}
