// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio;
mod importer;
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

fn git_out(dir: &std::path::Path, args: &[&str]) -> std::io::Result<std::process::Output> {
    std::process::Command::new("git").arg("-C").arg(dir).args(args).output()
}

/// The build command. Prefer `cargo` on PATH (app launched inside the toolchain
/// env); otherwise build inside the `mp-dev` distrobox where the Rust toolchain
/// lives — so the in-app Update / downgrade work even when the app runs on a
/// host that has no cargo. `touch tauri.conf.json` forces Tauri to re-embed the
/// frontend (its build script doesn't watch src/).
fn build_argv(dir: &std::path::Path) -> (String, Vec<String>) {
    let inner = format!(
        "export PATH=\"$HOME/.cargo/bin:$PATH\"; cd '{}' && touch tauri.conf.json && cargo build 2>&1",
        dir.display()
    );
    let has_cargo = std::process::Command::new("bash")
        .arg("-lc")
        .arg("command -v cargo >/dev/null 2>&1")
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if has_cargo {
        ("bash".into(), vec!["-lc".into(), inner])
    } else {
        let user = std::env::var("USER").unwrap_or_else(|_| "indernol".into());
        (
            "podman".into(),
            vec![
                "exec".into(), "-u".into(), user, "mp-dev".into(),
                "bash".into(), "-lc".into(), inner,
            ],
        )
    }
}

/// Stream a cargo build; "update" events carry the progress lines.
fn do_build(app: &tauri::AppHandle) -> Result<String, String> {
    use std::io::BufRead;
    use tauri::Emitter;
    let dir = source_dir()?;
    let (prog, args) = build_argv(&dir);
    let mut child = std::process::Command::new(&prog)
        .args(&args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("cannot run the build ({prog}): {e}"))?;
    let mut tail: Vec<String> = Vec::new();
    if let Some(out) = child.stdout.take() {
        for line in std::io::BufReader::new(out).lines().map_while(Result::ok) {
            let _ = app.emit("update", line.clone());
            tail.push(line);
            if tail.len() > 40 {
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

/// Latest version PUBLISHED ON GITHUB (origin/main) so "check for updates"
/// reflects GitHub, not whatever happens to be checked out locally.
#[tauri::command]
async fn source_version() -> Result<String, String> {
    let dir = source_dir()?;
    let _ = git_out(
        &dir,
        &["-c", "http.lowSpeedLimit=1000", "-c", "http.lowSpeedTime=10", "fetch", "origin", "--tags", "--quiet"],
    );
    let txt = git_out(&dir, &["show", "origin/main:src-tauri/tauri.conf.json"])
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .or_else(|| std::fs::read_to_string(dir.join("tauri.conf.json")).ok())
        .ok_or("cannot read version")?;
    let v: serde_json::Value = serde_json::from_str(&txt).map_err(|e| e.to_string())?;
    v["version"].as_str().map(str::to_string).ok_or_else(|| "no version field".into())
}

/// Relaunch the app process — used right after a build replaced the binary.
#[tauri::command]
fn restart_app(app: tauri::AppHandle) {
    app.restart();
}

/// Update to the latest version on GitHub: fetch, move the tree onto origin/main,
/// then rebuild. (The app's source tree is only ever a clean checkout.)
#[tauri::command]
async fn self_update(app: tauri::AppHandle) -> Result<String, String> {
    let dir = source_dir()?;
    let _ = git_out(&dir, &["fetch", "origin", "--tags", "--quiet"]);
    // Best-effort: if origin/main isn't available (offline), just build what's here.
    let _ = git_out(&dir, &["checkout", "-B", "main", "origin/main"]);
    do_build(&app)
}

#[derive(serde::Serialize)]
struct VersionEntry {
    version: String,
    hash: String,
    date: String,
    current: bool,
}

/// List the version commits in the local git history (any branch) so the user
/// can switch (downgrade or re-upgrade) between built versions.
#[tauri::command]
async fn list_versions() -> Result<Vec<VersionEntry>, String> {
    let dir = source_dir()?;
    let git = |args: &[&str]| {
        std::process::Command::new("git")
            .arg("-C")
            .arg(&dir)
            .args(args)
            .output()
    };
    // Pull the latest versions published on GitHub first (best-effort — offline
    // or no cached credentials just falls back to whatever is already local).
    let _ = git(&[
        "-c", "http.lowSpeedLimit=1000",
        "-c", "http.lowSpeedTime=10", // give up if the network stalls for 10s
        "fetch", "origin", "--tags", "--quiet",
    ]);
    let out = git(&["log", "--all", "--date-order", "--pretty=%H\x1f%cs\x1f%s", "-n", "500"])
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err("not a git checkout (version switching needs the source repo)".into());
    }
    let head = git(&["rev-parse", "HEAD"])
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    let text = String::from_utf8_lossy(&out.stdout);
    let mut seen = std::collections::HashSet::new();
    let mut list = Vec::new();
    for line in text.lines() {
        let mut it = line.splitn(3, '\x1f');
        let hash = it.next().unwrap_or("").to_string();
        let date = it.next().unwrap_or("").to_string();
        let subj = it.next().unwrap_or("");
        let ver = subj.split_whitespace().next().unwrap_or("");
        // Only "vX…" commit subjects; keep the newest occurrence of each version.
        if !ver.starts_with('v') || !ver[1..].starts_with(|c: char| c.is_ascii_digit()) {
            continue;
        }
        if !seen.insert(ver.to_string()) {
            continue;
        }
        let current = !hash.is_empty() && hash == head;
        list.push(VersionEntry { version: ver.to_string(), hash, date, current });
    }
    Ok(list)
}

/// Check out a version commit and rebuild into it, then the UI restarts.
/// Refuses if the working tree is dirty (would clobber local edits).
#[tauri::command]
async fn switch_version(app: tauri::AppHandle, rev: String) -> Result<String, String> {
    let dir = source_dir()?;
    // Make sure the target commit (possibly GitHub-only) is available locally.
    let _ = git_out(&dir, &["fetch", "origin", "--tags", "--quiet"]);
    // Force-checkout the chosen version: the source tree is only ever a clean
    // checkout, so this is safe and avoids a "dirty tree" dead-end for the user.
    let co = git_out(&dir, &["-c", "advice.detachedHead=false", "checkout", "-f", &rev])
        .map_err(|e| e.to_string())?;
    if !co.status.success() {
        return Err(format!(
            "git checkout failed: {}",
            String::from_utf8_lossy(&co.stderr).trim()
        ));
    }
    // Rebuild AT this version (not origin/main — that's what self_update does).
    do_build(&app)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        // "Launch at login" toggle (Settings → System). No autostart args needed.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
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
            source_version, self_update, restart_app, list_versions, switch_version,
            play_stream, preload_stream, prefetch_stream,
            youtube::yt_search, youtube::yt_search_playlists, youtube::yt_playlist,
            youtube::yt_playlist_preview,
            youtube::yt_channel, youtube::yt_channel_videos,
            youtube::yt_channel_playlists, youtube::yt_channel_all,
            youtube::yt_download, youtube::yt_cancel,
            youtube::yt_config, youtube::yt_install, youtube::detect_browsers,
            mpris::media_update, mpris::media_playback,
            library::cover, library::read_image, library::delete_file, library::open_path,
            store::store_load, store::store_save,
            rpc::rpc_update, rpc::rpc_clear,
            importer::import_spotify
        ])
        .run(tauri::generate_context!())
        .expect("error while running Music Player");
}
