//! YouTube integration via the yt-dlp CLI — flat-playlist extraction for
//! search/playlists and multi-client rotation to dodge bot checks. Stream URLs
//! are resolved on demand and cached (they expire server-side), so a track the
//! user already looked at starts instantly.

use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::io::BufRead;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

/// Resolved stream URLs stay valid for hours on googlevideo; keep them well
/// under that so we never hand rodio a dead link.
const RESOLVE_TTL: Duration = Duration::from_secs(45 * 60);

/// Prefer AAC-in-mp4: rodio/symphonia decodes it (opus/webm is unsupported).
const FORMAT: &str = "bestaudio[ext=m4a]/bestaudio[acodec^=mp4a]/bestaudio[acodec=aac]/best[ext=mp4]";

#[derive(Default)]
pub struct YtState {
    cache: Mutex<HashMap<String, (Instant, String)>>, // video id -> (resolved_at, stream url)
}

/// Live download processes, so the frontend can cancel them.
#[derive(Default)]
pub struct DlState {
    procs: Mutex<HashMap<String, Arc<Mutex<Child>>>>,
    canceled: Mutex<HashSet<String>>,
}

#[derive(Serialize)]
pub struct OnlineTrack {
    pub id: String,
    pub title: String,
    pub artist: String,
    pub duration_secs: u64,
    pub thumbnail: String,
}

#[derive(Serialize)]
pub struct PlaylistImport {
    pub title: String,
    pub tracks: Vec<OnlineTrack>,
}

/// User-facing yt-dlp configuration (fed by the setup wizard / Settings via
/// `yt_config`): explicit binary path + optional browser to take cookies from
/// (the script's anti-bot option). Auto-detection fills `bin` when unset.
#[derive(Default)]
pub struct YtCfg {
    bin: Mutex<Option<String>>,
    cookies: Mutex<String>, // browser name for --cookies-from-browser, "" = off
}

/// Append yt-dlp failures to a persistent log so real error causes can be
/// inspected after the fact (~/.local/share/com.indernol.musicplayer/yt.log).
pub fn dbg_log(msg: &str) {
    if let Ok(home) = std::env::var("HOME") {
        let dir = format!("{home}/.local/share/com.indernol.musicplayer");
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(format!("{dir}/yt.log"))
        {
            use std::io::Write;
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let _ = writeln!(f, "[{ts}] {msg}");
        }
    }
}

fn check_bin(path: &str) -> Result<String, String> {
    let out = Command::new(path)
        .arg("--version")
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err("binary returned an error".into());
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Candidate locations: PATH, ~/.local/bin, any "<dir>/bin/yt-dlp" under
/// Desktop (follows symlinks to external drives), any "<drive>/<dir>/bin/yt-dlp"
/// on removable media (host path and its /run/host view inside a container),
/// then linuxbrew. This survives the user renaming folders on the drive.
fn scan_bins() -> Vec<String> {
    let home = std::env::var("HOME").unwrap_or_default();
    let mut c = vec!["yt-dlp".to_string(), format!("{home}/.local/bin/yt-dlp")];
    if let Ok(rd) = std::fs::read_dir(format!("{home}/Desktop")) {
        for e in rd.filter_map(Result::ok) {
            c.push(e.path().join("bin/yt-dlp").to_string_lossy().into_owned());
        }
    }
    for media_root in ["/run/media", "/run/host/run/media"] {
        if let Ok(users) = std::fs::read_dir(media_root) {
            for u in users.filter_map(Result::ok) {
                if let Ok(drives) = std::fs::read_dir(u.path()) {
                    for d in drives.filter_map(Result::ok) {
                        if let Ok(tops) = std::fs::read_dir(d.path()) {
                            for t in tops.filter_map(Result::ok) {
                                c.push(t.path().join("bin/yt-dlp").to_string_lossy().into_owned());
                            }
                        }
                    }
                }
            }
        }
    }
    c.push("/home/linuxbrew/.linuxbrew/bin/yt-dlp".into());
    c.push("/run/host/home/linuxbrew/.linuxbrew/bin/yt-dlp".into());
    c
}

fn detect_bin() -> Option<(String, String)> {
    scan_bins()
        .into_iter()
        .filter(|p| !p.contains('/') || std::path::Path::new(p).exists())
        .find_map(|p| check_bin(&p).ok().map(|v| (p, v)))
}

/// Download the self-contained yt-dlp standalone into ~/.local/bin/yt-dlp and
/// mark it executable. Runs when no yt-dlp is found on the system (e.g. the
/// external drive that held the binary was unplugged) so the app heals itself.
/// The `*_linux` PyInstaller builds bundle their own Python — no system deps.
fn install_bin() -> Result<String, String> {
    use std::sync::OnceLock;
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    let _guard = LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    // Another thread may have installed it while we waited on the lock.
    if let Some((p, _)) = detect_bin() {
        return Ok(p);
    }
    let home = std::env::var("HOME").map_err(|_| "no HOME directory".to_string())?;
    let asset = match std::env::consts::ARCH {
        "x86_64" => "yt-dlp_linux",
        "aarch64" => "yt-dlp_linux_aarch64",
        "arm" => "yt-dlp_linux_armv7l",
        other => return Err(format!("no prebuilt yt-dlp for this CPU ({other})")),
    };
    let url = format!("https://github.com/yt-dlp/yt-dlp/releases/latest/download/{asset}");
    let dir = format!("{home}/.local/bin");
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {dir}: {e}"))?;
    let dest = format!("{dir}/yt-dlp");
    let tmp = format!("{dest}.part"); // download aside, rename in — never a half file
    dbg_log(&format!("installing yt-dlp from {url}"));
    let resp = ureq::get(&url).call().map_err(|e| format!("download failed: {e}"))?;
    {
        let mut reader = resp.into_reader();
        let mut f = std::fs::File::create(&tmp).map_err(|e| format!("cannot write {tmp}: {e}"))?;
        std::io::copy(&mut reader, &mut f).map_err(|e| format!("download interrupted: {e}"))?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755))
            .map_err(|e| format!("cannot make yt-dlp executable: {e}"))?;
    }
    std::fs::rename(&tmp, &dest).map_err(|e| format!("cannot finalize {dest}: {e}"))?;
    // Prove it actually runs before trusting it.
    check_bin(&dest).map_err(|e| {
        let _ = std::fs::remove_file(&dest);
        format!("downloaded yt-dlp did not run: {e}")
    })?;
    dbg_log(&format!("yt-dlp installed at {dest}"));
    Ok(dest)
}

fn find_named(root: &std::path::Path, name: &str) -> Option<std::path::PathBuf> {
    walkdir::WalkDir::new(root)
        .into_iter()
        .filter_map(Result::ok)
        .find(|e| e.file_type().is_file() && e.file_name() == name)
        .map(|e| e.path().to_path_buf())
}

/// Download a static ffmpeg + ffprobe into ~/.local/bin (needed for the mp3
/// conversion and thumbnail embedding). Extracts the .tar.xz with the system
/// `tar` so we don't pull an xz decoder into the build. No-op if ffmpeg is
/// already present there.
fn install_ffmpeg() -> Result<String, String> {
    use std::sync::OnceLock;
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    let _guard = LOCK.get_or_init(|| Mutex::new(())).lock().unwrap();
    let home = std::env::var("HOME").map_err(|_| "no HOME directory".to_string())?;
    let dir = format!("{home}/.local/bin");
    std::fs::create_dir_all(&dir).map_err(|e| format!("cannot create {dir}: {e}"))?;
    let ff = format!("{dir}/ffmpeg");
    if check_bin(&ff).is_ok() {
        return Ok(ff);
    }
    let asset = match std::env::consts::ARCH {
        "x86_64" => "ffmpeg-release-amd64-static.tar.xz",
        "aarch64" => "ffmpeg-release-arm64-static.tar.xz",
        other => return Err(format!("no static ffmpeg for this CPU ({other})")),
    };
    let url = format!("https://johnvansickle.com/ffmpeg/releases/{asset}");
    let tmp = std::env::temp_dir().join("mp-ffmpeg.tar.xz");
    let ex = std::env::temp_dir().join("mp-ffmpeg-extract");
    dbg_log(&format!("installing ffmpeg from {url}"));
    let resp = ureq::get(&url).call().map_err(|e| format!("ffmpeg download failed: {e}"))?;
    {
        let mut reader = resp.into_reader();
        let mut f = std::fs::File::create(&tmp).map_err(|e| format!("cannot write {tmp:?}: {e}"))?;
        std::io::copy(&mut reader, &mut f).map_err(|e| format!("ffmpeg download interrupted: {e}"))?;
    }
    let _ = std::fs::remove_dir_all(&ex);
    std::fs::create_dir_all(&ex).map_err(|e| e.to_string())?;
    let ok = Command::new("tar")
        .arg("-xJf")
        .arg(&tmp)
        .arg("-C")
        .arg(&ex)
        .status()
        .map_err(|e| format!("cannot run tar to unpack ffmpeg: {e}"))?
        .success();
    if !ok {
        return Err("tar failed to extract ffmpeg".into());
    }
    for name in ["ffmpeg", "ffprobe"] {
        if let Some(found) = find_named(&ex, name) {
            let dest = format!("{dir}/{name}");
            std::fs::copy(&found, &dest).map_err(|e| format!("cannot install {name}: {e}"))?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755));
            }
        }
    }
    let _ = std::fs::remove_file(&tmp);
    let _ = std::fs::remove_dir_all(&ex);
    check_bin(&ff).map_err(|e| format!("installed ffmpeg did not run: {e}"))?;
    dbg_log(&format!("ffmpeg installed at {ff}"));
    Ok(ff)
}

/// Ensure an ffmpeg is reachable for mp3 conversion: if none sits next to the
/// yt-dlp binary and none is on PATH, fetch a static build. Best-effort — on
/// failure the download itself reports the missing ffmpeg.
fn ensure_ffmpeg(bin: &str) {
    let near = std::path::Path::new(bin)
        .parent()
        .map(|p| p.join("ffmpeg").exists())
        .unwrap_or(false);
    if near || check_bin("ffmpeg").is_ok() {
        return;
    }
    let _ = install_ffmpeg();
}

fn ensure_bin(cfg: &YtCfg) -> Result<String, String> {
    {
        let guard = cfg.bin.lock().unwrap();
        if let Some(b) = guard.as_ref() {
            if !b.contains('/') || std::path::Path::new(b).exists() {
                return Ok(b.clone());
            }
        }
    }
    // Prefer whatever is already on the system; otherwise fetch a standalone copy.
    let path = match detect_bin() {
        Some((p, _)) => p,
        None => install_bin()?,
    };
    *cfg.bin.lock().unwrap() = Some(path.clone());
    Ok(path)
}

#[derive(Serialize)]
pub struct BrowserInfo {
    pub browser: String,
    pub profiles: Vec<String>,
    pub source: String, // "system" | "flatpak"
}

/// Which browsers (and profiles) exist on this machine — shown in the cookies
/// consent dialog so the user knows what they are actually picking.
#[tauri::command]
pub async fn detect_browsers() -> Vec<BrowserInfo> {
    let home = std::env::var("HOME").unwrap_or_default();
    let mut out: Vec<BrowserInfo> = Vec::new();

    // Firefox: profiles.ini lists named profiles.
    for (source, base) in [
        ("system", format!("{home}/.mozilla/firefox")),
        ("flatpak", format!("{home}/.var/app/org.mozilla.firefox/.mozilla/firefox")),
    ] {
        if let Ok(ini) = std::fs::read_to_string(format!("{base}/profiles.ini")) {
            let profiles: Vec<String> = ini
                .lines()
                .filter_map(|l| l.strip_prefix("Name="))
                .map(str::to_string)
                .collect();
            if !profiles.is_empty() {
                out.push(BrowserInfo { browser: "firefox".into(), profiles, source: source.into() });
            }
        }
    }

    // Chromium family: profile directories ("Default", "Profile N").
    let chromiums = [
        ("chrome", vec![format!("{home}/.config/google-chrome"), format!("{home}/.var/app/com.google.Chrome/config/google-chrome")]),
        ("chromium", vec![format!("{home}/.config/chromium"), format!("{home}/.var/app/org.chromium.Chromium/config/chromium")]),
        ("brave", vec![format!("{home}/.config/BraveSoftware/Brave-Browser"), format!("{home}/.var/app/com.brave.Browser/config/BraveSoftware/Brave-Browser")]),
        ("edge", vec![format!("{home}/.config/microsoft-edge")]),
        ("vivaldi", vec![format!("{home}/.config/vivaldi")]),
        ("opera", vec![format!("{home}/.config/opera")]),
    ];
    for (name, bases) in chromiums {
        for (i, base) in bases.iter().enumerate() {
            if !std::path::Path::new(&format!("{base}/Default")).exists() {
                continue;
            }
            let mut profiles = vec!["Default".to_string()];
            if let Ok(rd) = std::fs::read_dir(base) {
                for e in rd.filter_map(Result::ok) {
                    let n = e.file_name().to_string_lossy().into_owned();
                    if n.starts_with("Profile ") {
                        profiles.push(n);
                    }
                }
            }
            out.push(BrowserInfo {
                browser: name.into(),
                profiles,
                source: if i == 0 { "system".into() } else { "flatpak".into() },
            });
            break; // one entry per browser
        }
    }
    out
}

/// Set (or auto-detect when `path` is empty) the yt-dlp binary + the cookies
/// browser. Returns "path (version)" so the UI can show what's active.
#[tauri::command]
pub async fn yt_config(cfg: State<'_, YtCfg>, path: String, cookies: String) -> Result<String, String> {
    *cfg.cookies.lock().unwrap() = cookies.trim().to_lowercase();
    let p = path.trim();
    if !p.is_empty() {
        let v = check_bin(p).map_err(|e| format!("“{p}”: {e}"))?;
        *cfg.bin.lock().unwrap() = Some(p.to_string());
        return Ok(format!("{p} ({v})"));
    }
    // No explicit path: use a system yt-dlp if present, else download one so the
    // app works out of the box even after the drive holding it was unplugged.
    let (found, v) = match detect_bin() {
        Some(x) => x,
        None => {
            let p = install_bin()?;
            let v = check_bin(&p).unwrap_or_default();
            (p, v)
        }
    };
    *cfg.bin.lock().unwrap() = Some(found.clone());
    Ok(format!("{found} ({v})"))
}

/// Force-download the standalone yt-dlp (Settings → “Install yt-dlp”). Returns
/// "path (version)". Reuses a system copy if one is already present.
#[tauri::command]
pub async fn yt_install(cfg: State<'_, YtCfg>) -> Result<String, String> {
    let path = install_bin()?;
    let v = check_bin(&path).unwrap_or_default();
    *cfg.bin.lock().unwrap() = Some(path.clone());
    // Downloads also need ffmpeg for the mp3 conversion — grab it too so the
    // one button gives a fully working setup. A failure here is non-fatal
    // (search/stream still work), so it's only appended to the status.
    let ff = match install_ffmpeg() {
        Ok(_) => " + ffmpeg".to_string(),
        Err(e) => format!(" (ffmpeg not installed: {e})"),
    };
    Ok(format!("{path} ({v}){ff}"))
}

fn run_ytdlp_raw(bin: &str, args: &[&str], cookies: Option<&str>) -> Result<String, String> {
    let mut cmd = Command::new(bin);
    cmd.args(args);
    if let Some(c) = cookies {
        cmd.arg("--cookies-from-browser").arg(c);
    }
    let out = cmd
        .output()
        .map_err(|e| format!("cannot run yt-dlp: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let msg = err
            .lines()
            .rev()
            .find(|l| l.contains("ERROR"))
            .or_else(|| err.lines().last())
            .unwrap_or("yt-dlp failed");
        return Err(msg.to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

fn run_ytdlp(cfg: &YtCfg, args: &[&str]) -> Result<String, String> {
    let bin = ensure_bin(cfg)?;
    let cookies = cfg.cookies.lock().unwrap().clone();
    if cookies.is_empty() {
        return run_ytdlp_raw(&bin, args, None);
    }
    // Logged-in sessions are frequently SABR-blocked by YouTube ("Requested
    // format is not available"): cookies then BREAK extraction instead of
    // helping. Retry once without cookies before giving up.
    match run_ytdlp_raw(&bin, args, Some(&cookies)) {
        Ok(o) => Ok(o),
        Err(first) => run_ytdlp_raw(&bin, args, None).map_err(|_| first),
    }
}

fn track_from_json(v: &Value) -> Option<OnlineTrack> {
    let id = v["id"].as_str()?.to_string();
    // mqdefault always exists, no extra request needed to find the "best" thumb.
    let thumbnail = format!("https://i.ytimg.com/vi/{id}/mqdefault.jpg");
    Some(OnlineTrack {
        title: v["title"].as_str().unwrap_or("Untitled").to_string(),
        artist: v["uploader"]
            .as_str()
            .or_else(|| v["channel"].as_str())
            .unwrap_or("Unknown Artist")
            .to_string(),
        duration_secs: v["duration"].as_f64().unwrap_or(0.0) as u64,
        id,
        thumbnail,
    })
}

fn flat_extract(cfg: &YtCfg, target: &str) -> Result<Vec<Value>, String> {
    // Default player clients: yt-dlp keeps those working; forcing android/web
    // intermittently yields zero formats/entries these days.
    let out = run_ytdlp(cfg, &["--flat-playlist", "-j", "--no-warnings", target])?;
    Ok(out
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .collect())
}

#[tauri::command]
pub async fn yt_search(
    cfg: State<'_, YtCfg>,
    query: String,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<Vec<OnlineTrack>, String> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let n = limit.unwrap_or(20).clamp(1, 100);
    let off = offset.unwrap_or(0).min(900);
    // Pagination: ask the search "playlist" only for the requested slice —
    // yt-dlp walks results lazily, so page 1 stays as cheap as before.
    let total = off + n;
    let target = format!("ytsearch{total}:{q}");
    let range = format!("{}:{}", off + 1, total);
    let out = run_ytdlp(
        &cfg,
        &["--flat-playlist", "-j", "--no-warnings", "-I", &range, &target],
    )?;
    Ok(out
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter_map(|v| track_from_json(&v))
        .collect())
}

/// First few track titles of a playlist — cheap preview for search hits.
#[tauri::command]
pub async fn yt_playlist_preview(
    cfg: State<'_, YtCfg>,
    url: String,
    count: Option<u32>,
) -> Result<Vec<String>, String> {
    let n = count.unwrap_or(3).clamp(1, 6);
    let range = format!("1:{n}");
    let out = run_ytdlp(
        &cfg,
        &["--flat-playlist", "-j", "--no-warnings", "-I", &range, url.trim()],
    )?;
    Ok(out
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter_map(|v| v["title"].as_str().map(str::to_string))
        .collect())
}

#[derive(Serialize)]
pub struct PlaylistHit {
    pub url: String,
    pub title: String,
    pub author: String,
}

fn url_encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

/// Search YouTube for PLAYLISTS by name/author (the results page with the
/// playlist filter applied, flat-extracted).
#[tauri::command]
pub async fn yt_search_playlists(
    cfg: State<'_, YtCfg>,
    query: String,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<Vec<PlaylistHit>, String> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(Vec::new());
    }
    let n = limit.unwrap_or(15).clamp(1, 100);
    let off = offset.unwrap_or(0).min(900);
    let page = format!(
        "https://www.youtube.com/results?search_query={}&sp=EgIQAw%3D%3D",
        url_encode(q)
    );
    let range = format!("{}:{}", off + 1, off + n);
    let out = run_ytdlp(
        &cfg,
        &["--flat-playlist", "-j", "--no-warnings", "-I", &range, &page],
    )?;
    Ok(out
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter_map(|v| {
            let url = v["url"].as_str()?.to_string();
            if !url.contains("list=") {
                return None;
            }
            Some(PlaylistHit {
                title: v["title"].as_str().unwrap_or("Untitled playlist").to_string(),
                author: v["uploader"]
                    .as_str()
                    .or_else(|| v["channel"].as_str())
                    .unwrap_or("")
                    .to_string(),
                url,
            })
        })
        .collect())
}

#[derive(Serialize)]
pub struct Channel {
    pub title: String,
    pub url: String,
    pub thumbnail: String,
}

fn best_thumb(v: &Value) -> String {
    let mut t = v["thumbnails"]
        .as_array()
        .and_then(|a| a.last())
        .and_then(|t| t["url"].as_str())
        .unwrap_or("")
        .to_string();
    if let Some(rest) = t.strip_prefix("//") {
        t = format!("https:{rest}");
    }
    t
}

fn is_channel_url(u: &str) -> bool {
    u.contains("/channel/") || u.contains("/@") || u.contains("/user/") || u.contains("/c/")
}

/// Top channel/artist matching `query` (results page with the channel filter).
/// Shown as the header card of a YouTube search.
#[tauri::command]
pub async fn yt_channel(cfg: State<'_, YtCfg>, query: String) -> Result<Option<Channel>, String> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(None);
    }
    let page = format!(
        "https://www.youtube.com/results?search_query={}&sp=EgIQAg%3D%3D",
        url_encode(q)
    );
    let out = run_ytdlp(
        &cfg,
        &["--flat-playlist", "-j", "--no-warnings", "-I", "1:3", &page],
    )?;
    Ok(out
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .find_map(|v| {
            let url = v["url"].as_str()?.to_string();
            if !is_channel_url(&url) {
                return None;
            }
            Some(Channel {
                title: v["channel"]
                    .as_str()
                    .or_else(|| v["title"].as_str())
                    .or_else(|| v["uploader"].as_str())
                    .unwrap_or("Channel")
                    .to_string(),
                url,
                thumbnail: best_thumb(&v),
            })
        }))
}

/// A channel's uploaded videos (its "Videos" tab), paginated.
#[tauri::command]
pub async fn yt_channel_videos(
    cfg: State<'_, YtCfg>,
    url: String,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<Vec<OnlineTrack>, String> {
    let n = limit.unwrap_or(20).clamp(1, 100);
    let off = offset.unwrap_or(0).min(5000);
    let target = format!("{}/videos", url.trim().trim_end_matches('/'));
    let range = format!("{}:{}", off + 1, off + n);
    let out = run_ytdlp(
        &cfg,
        &["--flat-playlist", "-j", "--no-warnings", "-I", &range, &target],
    )?;
    Ok(out
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter_map(|v| track_from_json(&v))
        .collect())
}

/// A channel's public playlists (its "Playlists" tab), paginated.
#[tauri::command]
pub async fn yt_channel_playlists(
    cfg: State<'_, YtCfg>,
    url: String,
    limit: Option<u32>,
    offset: Option<u32>,
) -> Result<Vec<PlaylistHit>, String> {
    let n = limit.unwrap_or(15).clamp(1, 100);
    let off = offset.unwrap_or(0).min(2000);
    let target = format!("{}/playlists", url.trim().trim_end_matches('/'));
    let range = format!("{}:{}", off + 1, off + n);
    let out = run_ytdlp(
        &cfg,
        &["--flat-playlist", "-j", "--no-warnings", "-I", &range, &target],
    )?;
    Ok(out
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter_map(|v| {
            let url = v["url"].as_str()?.to_string();
            if !url.contains("list=") {
                return None;
            }
            Some(PlaylistHit {
                title: v["title"].as_str().unwrap_or("Untitled playlist").to_string(),
                author: v["uploader"]
                    .as_str()
                    .or_else(|| v["channel"].as_str())
                    .unwrap_or("")
                    .to_string(),
                url,
            })
        })
        .collect())
}

/// Every uploaded video of a channel (capped) — feeds the "Download all" action.
#[tauri::command]
pub async fn yt_channel_all(cfg: State<'_, YtCfg>, url: String) -> Result<Vec<OnlineTrack>, String> {
    let target = format!("{}/videos", url.trim().trim_end_matches('/'));
    let out = run_ytdlp(
        &cfg,
        &["--flat-playlist", "-j", "--no-warnings", "-I", "1:1000", &target],
    )?;
    Ok(out
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter_map(|v| track_from_json(&v))
        .collect())
}

#[tauri::command]
pub async fn yt_playlist(cfg: State<'_, YtCfg>, url: String) -> Result<PlaylistImport, String> {
    let url = url.trim().to_string();
    if url.is_empty() {
        return Err("empty URL".into());
    }
    let entries = flat_extract(&cfg, &url)?;
    let title = entries
        .iter()
        .find_map(|v| v["playlist_title"].as_str())
        .unwrap_or("Imported playlist")
        .to_string();
    Ok(PlaylistImport {
        title,
        tracks: entries.iter().filter_map(track_from_json).collect(),
    })
}

const LOCAL_EXTS: &[&str] = &["mp3", "m4a", "opus", "ogg", "flac", "wav"];

/// Find an already-downloaded audio file for a video id anywhere under `dir`
/// (recursive): filename contains "[<id>]", audio extension, and a plausible
/// size — empty/partial leftovers from killed downloads don't count.
fn find_existing(dir: &str, id: &str) -> Option<String> {
    let tag = format!("[{id}]");
    for entry in walkdir::WalkDir::new(dir)
        .max_depth(4)
        .into_iter()
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file() {
            continue;
        }
        if !entry.file_name().to_string_lossy().contains(&tag) {
            continue;
        }
        let ext = entry
            .path()
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        if !LOCAL_EXTS.contains(&ext.as_str()) {
            continue;
        }
        if entry.metadata().map(|m| m.len()).unwrap_or(0) < 16 * 1024 {
            continue;
        }
        return Some(entry.path().to_string_lossy().into_owned());
    }
    None
}

fn resolve_download_dir(dir: &str) -> Result<String, String> {
    let dir = dir.trim();
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let default = format!("{home}/Music/MusicPlayer");
    let resolved = if dir.is_empty() {
        default.clone()
    } else if let Some(rest) = dir.strip_prefix("~/") {
        format!("{home}/{rest}")
    } else {
        dir.to_string()
    };
    if std::fs::create_dir_all(&resolved).is_ok() {
        return Ok(resolved);
    }
    // The configured folder can't be created — typically it lived on a drive that
    // has been unplugged, leaving a root-owned empty mountpoint ("permission
    // denied"). Fall back to the default location instead of failing every
    // download; a re-plugged drive works again automatically next time.
    if resolved != default {
        dbg_log(&format!("download dir '{resolved}' unavailable; using '{default}'"));
        std::fs::create_dir_all(&default).map_err(|e| format!("cannot create {default}: {e}"))?;
        return Ok(default);
    }
    Err(format!("cannot create {resolved}"))
}

/// Download a video's audio as mp3 into `dir` (empty = ~/Music/MusicPlayer),
/// mirroring the desktop script's download step: `-x --audio-format mp3` with
/// the `%(title)s [%(id)s]` naming so files are matchable by video id.
/// Cancelable via `yt_cancel`; emits "dl" events {id, pct} while downloading.
/// Returns the final file path. Skips the download if the file already exists.
#[tauri::command]
pub async fn yt_download(
    app: AppHandle,
    cfg: State<'_, YtCfg>,
    dls: State<'_, DlState>,
    id: String,
    dir: String,
) -> Result<String, String> {
    let dir = resolve_download_dir(&dir)?;

    // Already downloaded? Recursive scan (the folder may hold subdirs like the
    // script's audio_downloads/<subdir>), same `[id]` naming convention.
    if let Some(existing) = find_existing(&dir, &id) {
        return Ok(existing);
    }

    let bin = ensure_bin(&cfg)?;
    ensure_ffmpeg(&bin); // best-effort: fetch a static ffmpeg if none is around
    let cookies = cfg.cookies.lock().unwrap().clone();
    let res = if cookies.is_empty() {
        download_clients(&app, &dls, &bin, &id, &dir, None)
    } else {
        // A logged-in session often makes YouTube withhold every format. If the
        // cookies attempt fails, the no-cookies attempt is the meaningful one —
        // surface ITS error, not the misleading "format not available" cookies one.
        match download_clients(&app, &dls, &bin, &id, &dir, Some(&cookies)) {
            Ok(p) => Ok(p),
            Err(e) if e == "canceled" => Err(e),
            Err(_) => download_clients(&app, &dls, &bin, &id, &dir, None),
        }
    };
    if let Err(e) = &res {
        if e != "canceled" {
            dbg_log(&format!("download {id}: {e}"));
        }
    }
    res
}

/// Format availability is a per-client roulette (see resolve): when a client
/// yields "Requested format is not available", the next one often works.
/// Definitive refusals (Premium/private/deleted…) stop the cycle immediately.
fn download_clients(
    app: &AppHandle,
    dls: &DlState,
    bin: &str,
    id: &str,
    dir: &str,
    cookies: Option<&str>,
) -> Result<String, String> {
    // `android,web` is the most reliable audio client, so try it right after the
    // default; the default's stream URL often 403s or is DRM-flagged while
    // `android,web` succeeds on the very same video.
    const CLIENTS: [Option<&str>; 4] = [
        None,
        Some("youtube:player_client=android,web"),
        Some("youtube:player_client=tv"),
        Some("youtube:player_client=ios"),
    ];
    let mut last = String::from("no download attempt ran");
    for client in CLIENTS {
        match download_attempt(app, dls, bin, id, dir, cookies, client) {
            Ok(p) => return Ok(p),
            Err(e) if e == "canceled" => return Err(e),
            Err(e) => {
                let definitive = is_definitive_refusal(&e);
                last = e;
                if definitive {
                    break; // private/deleted/geo/age/premium — no client changes it
                }
                // Otherwise (403, "DRM protected", format roulette, network) the
                // next client frequently works — keep going.
            }
        }
    }
    Err(last)
}

/// Errors that no amount of client-switching will fix — stop trying immediately.
/// Everything else (403 Forbidden, "DRM protected", "format is not available",
/// transient network) is worth retrying with the next player client.
fn is_definitive_refusal(e: &str) -> bool {
    let m = e.to_lowercase();
    [
        "private video",
        "video unavailable",
        "has been removed",
        "account associated with this video has been terminated",
        "members-only",
        "join this channel",
        "sign in to confirm your age",
        "age-restricted",
        "not available in your country",
        "blocked it on copyright",
        "who has blocked it in your country",
        "premium",
        "this live event will begin",
        "premieres in",
    ]
    .iter()
    .any(|s| m.contains(s))
}

fn download_attempt(
    app: &AppHandle,
    dls: &DlState,
    bin: &str,
    id: &str,
    dir: &str,
    cookies: Option<&str>,
    client: Option<&str>,
) -> Result<String, String> {
    let mut cmd = Command::new(bin);
    if let Some(c) = client {
        cmd.arg("--extractor-args").arg(c);
    }
    // The standalone yt-dlp ships next to ffmpeg (same bin/ folder) — point at
    // it explicitly since the container PATH has no ffmpeg for the mp3 convert.
    if let Some(parent) = std::path::Path::new(bin).parent() {
        if parent.join("ffmpeg").exists() {
            cmd.arg("--ffmpeg-location").arg(parent);
        }
    }
    if let Some(c) = cookies {
        cmd.arg("--cookies-from-browser").arg(c);
    }
    let out_tpl = format!("{dir}/%(title)s [%(id)s].%(ext)s");
    let page = format!("https://www.youtube.com/watch?v={id}");
    cmd.args([
        "-x",
        "--audio-format",
        "mp3",
        // Keep the artwork + title/artist inside the mp3 itself.
        "--embed-thumbnail",
        "--embed-metadata",
        "-o",
        &out_tpl,
        "--no-playlist",
        "--no-warnings",
        "--no-simulate",
        "--newline",
        "--progress-template",
        "download:%(progress._percent_str)s",
        "--print",
        "after_move:filepath",
        &page,
    ]);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    let child = Arc::new(Mutex::new(
        cmd.spawn().map_err(|e| format!("cannot run yt-dlp: {e}"))?,
    ));
    dls.canceled.lock().unwrap().remove(id);
    dls.procs.lock().unwrap().insert(id.to_string(), child.clone());

    // Drain stderr on a side thread (so neither pipe can deadlock) — it holds
    // the actual failure reason when yt-dlp exits non-zero.
    let stderr = child.lock().unwrap().stderr.take();
    let err_reader = stderr.map(|mut s| {
        std::thread::spawn(move || {
            use std::io::Read;
            let mut buf = String::new();
            let _ = s.read_to_string(&mut buf);
            buf
        })
    });

    let stdout = child.lock().unwrap().stdout.take().ok_or("no stdout")?;
    let mut filepath: Option<String> = None;
    let mut last_pct = -1i32;
    for line in std::io::BufReader::new(stdout).lines().map_while(Result::ok) {
        let l = line.trim();
        if let Some(p) = l.strip_prefix("download:") {
            let pct = p.trim().trim_end_matches('%').parse::<f32>().unwrap_or(0.0) as i32;
            if pct != last_pct {
                last_pct = pct;
                let _ = app.emit("dl", serde_json::json!({ "id": id, "pct": pct }));
            }
        } else if !l.is_empty() {
            filepath = Some(l.to_string());
        }
    }
    let status = child.lock().unwrap().wait().map_err(|e| e.to_string());
    dls.procs.lock().unwrap().remove(id);
    let was_canceled = dls.canceled.lock().unwrap().remove(id);
    let err_text = err_reader
        .and_then(|t| t.join().ok())
        .unwrap_or_default();

    let status = status?;
    if !status.success() {
        if was_canceled {
            return Err("canceled".into());
        }
        let msg = err_text
            .lines()
            .rev()
            .find(|l| l.contains("ERROR"))
            .or_else(|| err_text.lines().rev().find(|l| !l.trim().is_empty()))
            .unwrap_or("yt-dlp failed")
            .to_string();
        return Err(msg);
    }
    filepath.ok_or_else(|| "yt-dlp did not report the output file".into())
}

/// Kill a running download started by `yt_download`.
#[tauri::command]
pub fn yt_cancel(dls: State<DlState>, id: String) {
    dls.canceled.lock().unwrap().insert(id.clone());
    if let Some(child) = dls.procs.lock().unwrap().get(&id) {
        let _ = child.lock().unwrap().kill();
    }
}

fn resolve_once(cfg: &YtCfg, page: &str, client: Option<&str>) -> Result<String, String> {
    let mut args = vec!["-g", "-f", FORMAT, "--no-playlist", "--no-warnings"];
    if let Some(c) = client {
        args.push("--extractor-args");
        args.push(c);
    }
    args.push(page);
    let out = run_ytdlp(cfg, &args)?;
    out.lines()
        .next()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "no stream URL returned".into())
}

/// Direct audio stream URL for a video id, served from cache when fresh.
/// YouTube's format availability is a per-request roulette (SABR rollout:
/// audio-only formats often vanish for one client and are back seconds later),
/// so try several player clients — each attempt is a fresh dice roll, and the
/// format chain ends with itag-18-style full mp4 which the engine can decode.
pub fn resolve(state: &YtState, cfg: &YtCfg, id: &str) -> Result<String, String> {
    if let Some((at, url)) = state.cache.lock().unwrap().get(id) {
        if at.elapsed() < RESOLVE_TTL {
            return Ok(url.clone());
        }
    }
    let page = format!("https://www.youtube.com/watch?v={id}");
    const CLIENTS: [Option<&str>; 4] = [
        None, // yt-dlp defaults (best maintained)
        Some("youtube:player_client=tv"),
        Some("youtube:player_client=android,web"),
        Some("youtube:player_client=ios"),
    ];
    let mut url = None;
    let mut last_err = String::from("no resolve attempt ran");
    for client in CLIENTS {
        match resolve_once(cfg, &page, client) {
            Ok(u) => {
                url = Some(u);
                break;
            }
            Err(e) => last_err = e,
        }
    }
    let url = url.ok_or_else(|| {
        dbg_log(&format!("resolve {id}: {last_err}"));
        last_err
    })?;
    state
        .cache
        .lock()
        .unwrap()
        .insert(id.to_string(), (Instant::now(), url.clone()));
    Ok(url)
}
