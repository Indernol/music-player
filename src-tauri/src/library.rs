//! Filesystem music library: recursive scan + best-effort tag reading.
//! Returns plain `Track` structs — no coupling to audio or UI.

use serde::Serialize;
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
#[tauri::command]
pub fn cover(path: String) -> Option<String> {
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
