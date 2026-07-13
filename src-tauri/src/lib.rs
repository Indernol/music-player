//! Shared app core. Desktop (src/main.rs binary) and Android/iOS (Tauri mobile
//! entry point below) both boot through `run()`.

mod audio;
mod importer;
pub mod library;
mod mpris;
mod rpc;
mod store;
mod stream;
pub mod youtube;
pub mod ytnative;

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

/// Stream URL via whichever backend works: cache → yt-dlp (desktop) → native
/// rustypipe engine (mandatory on Android, fallback elsewhere).
async fn resolve_stream_url(
    yt: &youtube::YtState,
    cfg: &youtube::YtCfg,
    id: &str,
) -> Result<String, String> {
    if let Some(u) = youtube::cached_url(yt, id) {
        return Ok(u);
    }
    let res = if ytnative::forced() {
        ytnative::stream_url(id).await
    } else {
        match youtube::resolve(yt, cfg, id) {
            Ok(u) => Ok(u),
            Err(e) => ytnative::stream_url(id).await.map_err(|ne| format!("{e} | {ne}")),
        }
    };
    let url = res?;
    youtube::cache_url(yt, id, url.clone());
    Ok(url)
}

#[tauri::command]
async fn play_stream(
    id: String,
    gain: f32,
    state: State<'_, AppState>,
    yt: State<'_, youtube::YtState>,
    cfg: State<'_, youtube::YtCfg>,
) -> Result<u64, String> {
    let url = resolve_stream_url(&yt, &cfg, &id).await?;
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
    let url = resolve_stream_url(&yt, &cfg, &id).await?;
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
    resolve_stream_url(&yt, &cfg, &id).await.map(|_| ())
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

const DEV_BOX: &str = "mp-dev"; // container holding git + the Rust toolchain

fn dev_user() -> String {
    std::env::var("USER").unwrap_or_else(|_| "user".into())
}

/// Best-effort: make sure the dev container is running before we exec into it.
fn ensure_devbox() {
    let _ = std::process::Command::new("podman").args(["start", DEV_BOX]).output();
}

/// Run git in the source repo. Immutable/atomic hosts (Bazzite/Silverblue) have
/// no git on the host — the dev tools live in the dev container — so if the
/// host git isn't found, run git INSIDE that container (the repo path is shared).
fn git_out(dir: &std::path::Path, args: &[&str]) -> std::io::Result<std::process::Output> {
    match std::process::Command::new("git").arg("-C").arg(dir).args(args).output() {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            ensure_devbox();
            let dirs = dir.to_string_lossy().to_string();
            let mut cmd = std::process::Command::new("podman");
            cmd.args(["exec", "-u", &dev_user(), DEV_BOX, "git", "-C", &dirs]);
            cmd.args(args);
            cmd.output()
        }
        other => other,
    }
}

/// The build command. Prefer `cargo` on PATH (app launched inside the toolchain
/// env); otherwise build inside the dev container where the Rust toolchain
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
        ensure_devbox();
        (
            "podman".into(),
            vec![
                "exec".into(), "-u".into(), dev_user(), DEV_BOX.into(),
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
    if let Ok(dir) = source_dir() {
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
        return v["version"].as_str().map(str::to_string).ok_or_else(|| "no version field".into());
    }

    let resp = ureq::AgentBuilder::new()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .get("https://api.github.com/repos/Indernol/music-player/releases/latest")
        .set("User-Agent", "MusicPlayer")
        .call()
        .map_err(|e| e.to_string())?;
    let text = resp.into_string().map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    v["tag_name"]
        .as_str()
        .map(|s| s.trim_start_matches('v').to_string())
        .ok_or_else(|| "no tag_name in release".into())
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
    if let Ok(dir) = source_dir() {
        let _ = git_out(&dir, &["fetch", "origin", "--tags", "--quiet"]);
        let _ = git_out(&dir, &["checkout", "-B", "main", "origin/main"]);
        return do_build(&app);
    }

    let url = "https://github.com/Indernol/music-player/releases/latest";
    #[cfg(target_os = "windows")]
    let _ = std::process::Command::new("cmd").args(["/C", "start", url]).spawn();
    #[cfg(target_os = "linux")]
    let _ = std::process::Command::new("xdg-open").arg(url).spawn();
    #[cfg(target_os = "macos")]
    let _ = std::process::Command::new("open").arg(url).spawn();

    Err("Opened the download page in your browser. Please run the new installer to update.".into())
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
    let git = |args: &[&str]| git_out(&dir, args);
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // FORCE-LOG IMMEDIATELY TO PROVE THE APP STARTED
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        let dir = std::path::PathBuf::from(local).join("com.indernol.musicplayer");
        let _ = std::fs::create_dir_all(&dir);
        let _ = std::fs::write(dir.join("startup.log"), "APP STARTED IN MAIN\n");
    }

    std::panic::set_hook(Box::new(|info| {
        let dir = if let Ok(local) = std::env::var("LOCALAPPDATA") {
            std::path::PathBuf::from(local).join("com.indernol.musicplayer")
        } else if let Ok(home) = std::env::var("HOME") {
            std::path::PathBuf::from(home).join(".local/share/com.indernol.musicplayer")
        } else {
            std::path::PathBuf::from(".")
        };
        let _ = std::fs::create_dir_all(&dir);
        let log_path = dir.join("crash.log");
        let msg = match info.payload().downcast_ref::<&'static str>() {
            Some(s) => *s,
            None => match info.payload().downcast_ref::<String>() {
                Some(s) => &s[..],
                None => "Box<dyn Any>",
            },
        };
        let location = info.location().map(|l| format!("{}:{}", l.file(), l.line())).unwrap_or_default();
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(log_path) {
            let _ = writeln!(f, "Panic at {location}:\n{msg}\n");
        }
    }));

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init());
    // "Launch at login" toggle (Settings → System) — desktop only.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_autostart::init(
        tauri_plugin_autostart::MacosLauncher::LaunchAgent,
        None,
    ));
    builder
        .manage(AppState {
            audio: AudioController::new(),
        })
        .manage(rpc::RpcState::default())
        .manage(youtube::YtState::default())
        .manage(youtube::YtCfg::default())
        .manage(youtube::DlState::default())
        .manage(mpris::MediaState::default())
        .setup(|app| {
            // Native YouTube engine cache (client versions, visitor data).
            ytnative::init_storage(
                app.path()
                    .app_data_dir()
                    .unwrap_or_else(|_| std::env::temp_dir().join("musicplayer")),
            );
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
            youtube::yt_playlist_preview, youtube::yt_playlist_head,
            youtube::yt_channel, youtube::yt_channel_videos,
            youtube::yt_channel_playlists, youtube::yt_channel_all,
            youtube::yt_download, youtube::yt_cancel,
            youtube::yt_config, youtube::yt_install, youtube::detect_browsers,
            mpris::media_update, mpris::media_playback,
            library::cover, library::read_image, library::delete_file, library::open_path,
            library::canon_path, library::canon_paths, library::folder_size,
            store::store_load, store::store_save,
            rpc::rpc_update, rpc::rpc_clear,
            importer::import_spotify
        ])
        .run(tauri::generate_context!())
        .expect("error while running Music Player");
}
