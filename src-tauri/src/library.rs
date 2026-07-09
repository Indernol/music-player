//! Filesystem music library: recursive scan + best-effort tag reading.
//! Returns plain `Track` structs — no coupling to audio or UI.

use serde::Serialize;
use std::collections::HashSet;
use walkdir::WalkDir;

// lofty imports (VERSION-SENSITIVE — see Cargo.toml note). The prelude brings the
// `Accessor` (title/artist/album) and `AudioFile`/`TaggedFileExt` (properties/tags)
// traits into scope. If cargo build complains about these, align lofty's version.
use base64::{engine::general_purpose::STANDARD, Engine as _};
use lofty::prelude::*;
use lofty::read_from_path;
use lofty::tag::ItemKey;

/// Embedded cover art for a single track, as a `data:` URL (or None if the file
/// has no embedded picture). Called lazily by the frontend, deduped per album.
/// async: reads a file — must never block the main (UI) thread.
#[tauri::command]
pub async fn cover(path: String) -> Option<String> {
    let tagged = read_from_path(&path).ok()?;
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag())?;
    let pic = tag.pictures().first()?;
    let mime = pic.mime_type().map(|m| m.as_str()).unwrap_or("image/jpeg");
    Some(format!("data:{};base64,{}", mime, STANDARD.encode(pic.data())))
}

#[derive(Serialize, Clone)]
pub struct Track {
    pub path: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration_secs: u64,
    pub gain: f32, // linear ReplayGain multiplier (1.0 = no change)
}

// Parse a ReplayGain tag value like "-6.48 dB" into a linear multiplier.
fn parse_db_gain(s: &str) -> Option<f32> {
    let cleaned = s.trim().trim_end_matches(|c: char| c.is_alphabetic() || c == ' ');
    let db: f32 = cleaned.trim().parse().ok()?;
    Some(10f32.powf(db / 20.0).clamp(0.2, 2.0))
}

const AUDIO_EXTS: &[&str] = &["mp3", "flac", "wav", "ogg", "opus", "m4a", "aac"];

/// Recursively scan the given root folders for supported audio files.
pub fn scan_library(roots: &[String]) -> Vec<Track> {
    let mut tracks = Vec::new();
    for root in roots {
        for entry in WalkDir::new(root).into_iter().filter_map(Result::ok) {
            if !entry.file_type().is_file() {
                continue;
            }
            let path = entry.path();
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_lowercase();
            if AUDIO_EXTS.contains(&ext.as_str()) {
                tracks.push(read_track(path));
            }
        }
    }
    tracks.sort_by(|a, b| (a.artist.to_lowercase(), a.album.to_lowercase(), a.title.to_lowercase())
        .cmp(&(b.artist.to_lowercase(), b.album.to_lowercase(), b.title.to_lowercase())));
    tracks
}

/// Permanently delete a local audio file from disk. Guarded: the path must
/// exist, be a regular file, and carry a known audio extension — so a stray
/// call can never nuke arbitrary files.
#[tauri::command]
pub async fn delete_file(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    let meta = std::fs::metadata(p).map_err(|e| e.to_string())?;
    if !meta.is_file() {
        return Err("not a regular file".into());
    }
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if !AUDIO_EXTS.contains(&ext.as_str()) {
        return Err(format!("refusing to delete a non-audio file (.{ext})"));
    }
    std::fs::remove_file(p).map_err(|e| e.to_string())
}

/// Reveal a path in the host file manager. For a file we open its containing
/// folder (so it works for both source folders and individual tracks). The app
/// may run inside a container whose `xdg-open` forwards to the host; if that
/// isn't wired, fall back to `distrobox-host-exec xdg-open`.
#[tauri::command]
pub fn open_path(path: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    let target = if p.is_dir() {
        path.clone()
    } else {
        p.parent()
            .map(|d| d.to_string_lossy().into_owned())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| path.clone())
    };
    #[cfg(target_os = "windows")]
    {
        return std::process::Command::new("explorer")
            .arg(&target)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("cannot open file manager: {e}"));
    }
    #[cfg(not(target_os = "windows"))]
    {
        if std::process::Command::new("xdg-open").arg(&target).spawn().is_ok() {
            return Ok(());
        }
        std::process::Command::new("distrobox-host-exec")
            .args(["xdg-open", target.as_str()])
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("cannot open file manager: {e}"))
    }
}

/// Local image file → data URL (custom app backgrounds). Kept off the UI thread.
#[tauri::command]
pub async fn read_image(path: String) -> Result<String, String> {
    let ext = std::path::Path::new(&path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    let mime = match ext.as_str() {
        "png" => "image/png",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        _ => "image/jpeg",
    };
    let data = std::fs::read(&path).map_err(|e| e.to_string())?;
    if data.len() > 25 * 1024 * 1024 {
        return Err("image too large (max 25 MB)".into());
    }
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(data)))
}

/// Differential scan for refreshes: walk the folders, but only read tags for
/// files NOT in `known` — the frontend keeps its cached metadata for the rest.
/// `present` lists every audio file found so the caller can prune deletions.
#[derive(Serialize)]
pub struct ScanDiff {
    pub new_tracks: Vec<Track>,
    pub present: Vec<String>,
}

pub fn scan_diff(roots: &[String], known: &HashSet<String>) -> ScanDiff {
    let mut new_tracks = Vec::new();
    let mut present = Vec::new();
    for root in roots {
        for entry in WalkDir::new(root).into_iter().filter_map(Result::ok) {
            if !entry.file_type().is_file() {
                continue;
            }
            let path = entry.path();
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_lowercase();
            if !AUDIO_EXTS.contains(&ext.as_str()) {
                continue;
            }
            let p = path.to_string_lossy().to_string();
            if !known.contains(&p) {
                new_tracks.push(read_track(path));
            }
            present.push(p);
        }
    }
    new_tracks.sort_by(|a, b| (a.artist.to_lowercase(), a.album.to_lowercase(), a.title.to_lowercase())
        .cmp(&(b.artist.to_lowercase(), b.album.to_lowercase(), b.title.to_lowercase())));
    ScanDiff { new_tracks, present }
}

fn read_track(path: &std::path::Path) -> Track {
    let path_str = path.to_string_lossy().to_string();
    let fallback = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Unknown")
        .to_string();

    match read_from_path(path) {
        Ok(tagged) => {
            let duration_secs = tagged.properties().duration().as_secs();
            let tag = tagged.primary_tag().or_else(|| tagged.first_tag());
            let (title, artist, album, gain) = match tag {
                Some(t) => (
                    t.title().map(|s| s.to_string()).unwrap_or_else(|| fallback.clone()),
                    t.artist().map(|s| s.to_string()).unwrap_or_else(|| "Unknown Artist".into()),
                    t.album().map(|s| s.to_string()).unwrap_or_else(|| "Unknown Album".into()),
                    t.get_string(&ItemKey::ReplayGainTrackGain).and_then(parse_db_gain).unwrap_or(1.0),
                ),
                None => (fallback.clone(), "Unknown Artist".into(), "Unknown Album".into(), 1.0),
            };
            Track { path: path_str, title, artist, album, duration_secs, gain }
        }
        Err(_) => Track {
            path: path_str,
            title: fallback,
            artist: "Unknown Artist".into(),
            album: "Unknown Album".into(),
            duration_secs: 0,
            gain: 1.0,
        },
    }
}
