//! Import playlists from other apps. A local/YouTube player can't read Spotify
//! audio (DRM), but it CAN read a public Spotify playlist's *track list* — song
//! title + artist — and then resolve each one to a YouTube stream (front-end).
//!
//! No API keys: we fetch Spotify's public **embed** page, whose inlined
//! `__NEXT_DATA__` JSON carries the whole track list for public playlists/albums.
//! If that ever breaks, the user can still paste an "Artist - Title" list.

use serde::Serialize;

#[derive(Serialize)]
pub struct ExtTrack {
    pub title: String,
    pub artist: String,
}

#[derive(Serialize)]
pub struct ExtImport {
    pub name: String,
    pub tracks: Vec<ExtTrack>,
}

/// Pull `(kind, id)` out of any Spotify reference: web links (incl. localized
/// `/intl-xx/` ones and `?si=` query strings) and `spotify:` URIs.
fn parse_spotify(url: &str) -> Option<(String, String)> {
    if let Some(rest) = url.trim().strip_prefix("spotify:") {
        let mut it = rest.split(':');
        let kind = it.next()?;
        let id = it.next()?;
        if matches!(kind, "playlist" | "album" | "track") {
            return Some((kind.to_string(), id.to_string()));
        }
    }
    for kind in ["playlist", "album", "track"] {
        let needle = format!("{kind}/");
        if let Some(pos) = url.find(&needle) {
            let id: String = url[pos + needle.len()..]
                .chars()
                .take_while(|c| c.is_ascii_alphanumeric())
                .collect();
            if id.len() >= 10 {
                return Some((kind.to_string(), id));
            }
        }
    }
    None
}

/// Extract the `<script id="__NEXT_DATA__" ...>…</script>` JSON payload.
fn extract_next_data(html: &str) -> Option<String> {
    let mpos = html.find("__NEXT_DATA__")?;
    let after = &html[mpos..];
    let start = after.find('>')? + 1;
    let end = after[start..].find("</script>")?;
    Some(after[start..start + end].to_string())
}

/// Depth-first search for the object that owns a non-empty `trackList` array —
/// resilient to Spotify moving it around inside the state tree.
fn find_entity(v: &serde_json::Value) -> Option<&serde_json::Value> {
    match v {
        serde_json::Value::Object(map) => {
            if map.get("trackList").and_then(|t| t.as_array()).map_or(false, |a| !a.is_empty()) {
                return Some(v);
            }
            map.values().find_map(find_entity)
        }
        serde_json::Value::Array(arr) => arr.iter().find_map(find_entity),
        _ => None,
    }
}

fn collect(v: &serde_json::Value) -> Option<ExtImport> {
    let entity = find_entity(v)?;
    let name = entity
        .get("name")
        .and_then(|x| x.as_str())
        .or_else(|| entity.get("title").and_then(|x| x.as_str()))
        .unwrap_or("Imported playlist")
        .trim()
        .to_string();
    let list = entity.get("trackList")?.as_array()?;
    let mut tracks = Vec::new();
    for t in list {
        // embed track entries: { title, subtitle (= artist), uri, duration, … }
        let title = t.get("title").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
        let artist = t.get("subtitle").and_then(|x| x.as_str()).unwrap_or("").trim().to_string();
        if !title.is_empty() {
            tracks.push(ExtTrack { title, artist });
        }
    }
    Some(ExtImport { name, tracks })
}

#[tauri::command]
pub async fn import_spotify(url: String) -> Result<ExtImport, String> {
    let (kind, id) = parse_spotify(&url)
        .ok_or_else(|| "Not a Spotify playlist / album / track link.".to_string())?;
    let embed = format!("https://open.spotify.com/embed/{kind}/{id}");
    let body = ureq::get(&embed)
        .set(
            "User-Agent",
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
        )
        .call()
        .map_err(|e| format!("Could not reach Spotify: {e}"))?
        .into_string()
        .map_err(|e| e.to_string())?;
    let json = extract_next_data(&body).ok_or_else(|| {
        "Could not read the Spotify page (private playlist, or Spotify changed its layout — paste the songs as text instead).".to_string()
    })?;
    let v: serde_json::Value = serde_json::from_str(&json).map_err(|e| e.to_string())?;
    let imp = collect(&v)
        .filter(|i| !i.tracks.is_empty())
        .ok_or_else(|| "No tracks found (private or empty playlist?).".to_string())?;
    Ok(imp)
}
