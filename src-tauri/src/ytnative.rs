//! Native YouTube backend — rustypipe (Innertube client, the NewPipe approach).
//! No yt-dlp binary involved, so it runs everywhere Rust runs — most notably
//! Android, where yt-dlp's glibc build can't execute. On desktop it is the
//! automatic fallback whenever yt-dlp is missing or a call fails.
//!
//! Every function mirrors the shape of its yt-dlp twin in `youtube.rs`
//! (OnlineTrack / PlaylistHit / PlaylistImport / Channel), so the frontend
//! doesn't know or care which backend served a request.

use crate::youtube::{Channel, DlState, OnlineTrack, PlaylistHit, PlaylistImport};
use rustypipe::client::RustyPipe;
use rustypipe::model::{ChannelItem, PlaylistItem, VideoItem};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::OnceLock;
use tauri::Emitter;

static STORAGE: OnceLock<PathBuf> = OnceLock::new();
static RP: OnceLock<RustyPipe> = OnceLock::new();

/// Called once at app setup with the app-data dir (rustypipe caches client
/// versions + visitor data there). Before/without it, a temp dir is used.
pub fn init_storage(dir: PathBuf) {
    let _ = STORAGE.set(dir);
}

fn rp() -> Result<&'static RustyPipe, String> {
    if let Some(r) = RP.get() {
        return Ok(r);
    }
    let dir = STORAGE
        .get()
        .cloned()
        .unwrap_or_else(|| std::env::temp_dir().join("musicplayer-rustypipe"));
    let _ = std::fs::create_dir_all(&dir);
    let client = RustyPipe::builder()
        .storage_dir(dir)
        .build()
        .map_err(|e| format!("native yt client: {e}"))?;
    let _ = RP.set(client);
    Ok(RP.get().unwrap())
}

fn es(e: impl std::fmt::Display) -> String {
    format!("native yt: {e}")
}

fn thumb(id: &str) -> String {
    format!("https://i.ytimg.com/vi/{id}/mqdefault.jpg")
}

fn vid_to_track(v: &VideoItem) -> OnlineTrack {
    OnlineTrack {
        thumbnail: thumb(&v.id),
        title: v.name.clone(),
        artist: v
            .channel
            .as_ref()
            .map(|c| c.name.clone())
            .unwrap_or_else(|| "Unknown Artist".to_string()),
        duration_secs: v.duration.map(u64::from).unwrap_or(0),
        views: v.view_count,
        id: v.id.clone(),
    }
}

fn pl_to_hit(p: &PlaylistItem) -> PlaylistHit {
    PlaylistHit {
        url: format!("https://www.youtube.com/playlist?list={}", p.id),
        title: p.name.clone(),
        author: p.channel.as_ref().map(|c| c.name.clone()).unwrap_or_default(),
    }
}

/// "list=" query param, or the raw input when it already looks like an id.
fn playlist_id(url: &str) -> String {
    let u = url.trim();
    if let Some(pos) = u.find("list=") {
        u[pos + 5..]
            .split(['&', '#'])
            .next()
            .unwrap_or("")
            .to_string()
    } else {
        u.rsplit('/').next().unwrap_or(u).to_string()
    }
}

/// Channel id (UC…) from any channel URL form; @handles etc. are resolved.
async fn channel_id(url: &str) -> Result<String, String> {
    let u = url.trim().trim_end_matches('/');
    if let Some(pos) = u.find("/channel/") {
        return Ok(u[pos + 9..].split(['/', '?']).next().unwrap_or("").to_string());
    }
    use rustypipe::model::UrlTarget;
    match rp()?.query().resolve_url(u, false).await.map_err(es)? {
        UrlTarget::Channel { id, .. } => Ok(id),
        _ => Err("not a channel URL".into()),
    }
}

pub async fn search(q: &str, limit: u32, offset: u32) -> Result<Vec<OnlineTrack>, String> {
    let rp = rp()?;
    let mut res = rp.query().search::<VideoItem, _>(q).await.map_err(es)?;
    let want = (offset + limit) as usize;
    let _ = res.items.extend_limit(rp.query(), want).await;
    Ok(res
        .items
        .items
        .iter()
        .skip(offset as usize)
        .take(limit as usize)
        .map(vid_to_track)
        .collect())
}

pub async fn search_playlists(q: &str, limit: u32, offset: u32) -> Result<Vec<PlaylistHit>, String> {
    let rp = rp()?;
    let mut res = rp.query().search::<PlaylistItem, _>(q).await.map_err(es)?;
    let want = (offset + limit) as usize;
    let _ = res.items.extend_limit(rp.query(), want).await;
    Ok(res
        .items
        .items
        .iter()
        .skip(offset as usize)
        .take(limit as usize)
        .map(pl_to_hit)
        .collect())
}

pub async fn channel_search(q: &str) -> Result<Option<Channel>, String> {
    let rp = rp()?;
    let res = rp.query().search::<ChannelItem, _>(q).await.map_err(es)?;
    Ok(res.items.items.first().map(|c| Channel {
        title: c.name.clone(),
        url: format!("https://www.youtube.com/channel/{}", c.id),
        thumbnail: c.avatar.first().map(|t| t.url.clone()).unwrap_or_default(),
    }))
}

pub async fn channel_videos(url: &str, limit: u32, offset: u32) -> Result<Vec<OnlineTrack>, String> {
    let rp = rp()?;
    let id = channel_id(url).await?;
    let mut ch = rp.query().channel_videos(&id).await.map_err(es)?;
    let want = (offset + limit) as usize;
    let _ = ch.content.extend_limit(rp.query(), want).await;
    Ok(ch
        .content
        .items
        .iter()
        .skip(offset as usize)
        .take(limit as usize)
        .map(vid_to_track)
        .collect())
}

pub async fn channel_playlists(url: &str, limit: u32, offset: u32) -> Result<Vec<PlaylistHit>, String> {
    let rp = rp()?;
    let id = channel_id(url).await?;
    let mut ch = rp.query().channel_playlists(&id).await.map_err(es)?;
    let want = (offset + limit) as usize;
    let _ = ch.content.extend_limit(rp.query(), want).await;
    Ok(ch
        .content
        .items
        .iter()
        .skip(offset as usize)
        .take(limit as usize)
        .map(pl_to_hit)
        .collect())
}

pub async fn channel_all(url: &str) -> Result<Vec<OnlineTrack>, String> {
    let rp = rp()?;
    let id = channel_id(url).await?;
    let mut ch = rp.query().channel_videos(&id).await.map_err(es)?;
    let _ = ch.content.extend_limit(rp.query(), 1000).await;
    Ok(ch.content.items.iter().map(vid_to_track).collect())
}

pub async fn playlist(url: &str) -> Result<PlaylistImport, String> {
    let rp = rp()?;
    let mut pl = rp.query().playlist(playlist_id(url)).await.map_err(es)?;
    let _ = pl.videos.extend_limit(rp.query(), 1000).await;
    Ok(PlaylistImport {
        title: pl.name.clone(),
        tracks: pl.videos.items.iter().map(vid_to_track).collect(),
    })
}

pub async fn playlist_preview(url: &str, count: u32) -> Result<Vec<String>, String> {
    let pl = rp()?.query().playlist(playlist_id(url)).await.map_err(es)?;
    Ok(pl
        .videos
        .items
        .iter()
        .take(count as usize)
        .map(|v| v.name.clone())
        .collect())
}

/// Best playable stream URL. rodio/symphonia decodes AAC-in-mp4 only (no
/// opus/webm), so: highest-bitrate m4a audio stream, else a combined mp4
/// (itag-18 style — the decoder skips the video track).
pub async fn stream_url(id: &str) -> Result<String, String> {
    let player = rp()?.query().player(id).await.map_err(es)?;
    if let Some(s) = player
        .audio_streams
        .iter()
        .filter(|s| s.mime.to_lowercase().contains("mp4"))
        .max_by_key(|s| s.bitrate)
    {
        return Ok(s.url.clone());
    }
    player
        .video_streams
        .iter()
        .filter(|s| s.mime.to_lowercase().contains("mp4"))
        .min_by_key(|s| s.bitrate)
        .map(|s| s.url.clone())
        .ok_or_else(|| "no AAC/mp4 stream available for this video".into())
}

fn safe_filename(s: &str) -> String {
    let cleaned: String = s
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect();
    let t = cleaned.trim().trim_matches('.').to_string();
    if t.is_empty() { "Untitled".into() } else { t }
}

/// Download the best AAC stream to `<dir>/<title> [<id>].m4a` with title /
/// artist / album / cover tags. No ffmpeg conversion — the m4a is stored as-is
/// (every place in the app matches files by the `[videoId]` tag, extension
/// agnostic). Emits the same "dl" {id, pct} events as the yt-dlp path and
/// honors `yt_cancel` via DlState's canceled set.
pub async fn download(
    app: tauri::AppHandle,
    dls: &DlState,
    id: &str,
    dir: &str,
) -> Result<String, String> {
    let player = rp()?.query().player(id).await.map_err(es)?;
    let title = player.details.name.clone().unwrap_or_else(|| format!("YouTube {id}"));
    let artist = player.details.channel_name.clone().unwrap_or_default();
    let url = stream_url_of(&player)?;

    let path = format!("{dir}/{} [{id}].m4a", safe_filename(&title));
    let part = format!("{path}.part");
    dls.canceled.lock().unwrap().remove(id);

    // Blocking transfer inline — consistent with the yt-dlp path, which also
    // does blocking process I/O inside async commands.
    let resp = crate::stream::media_agent(&url)
        .get(&url)
        .call()
        .map_err(|e| format!("stream fetch: {e}"))?;
    let total: u64 = resp
        .header("Content-Length")
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let mut reader = resp.into_reader();
    let mut out = std::fs::File::create(&part).map_err(|e| e.to_string())?;
    let mut buf = [0u8; 64 * 1024];
    let mut done: u64 = 0;
    let mut last_pct: i32 = -1;
    loop {
        if dls.canceled.lock().unwrap().remove(id) {
            drop(out);
            let _ = std::fs::remove_file(&part);
            return Err("canceled".into());
        }
        let n = reader.read(&mut buf).map_err(|e| format!("stream read: {e}"))?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        done += n as u64;
        if total > 0 {
            let pct = ((done * 100) / total) as i32;
            if pct != last_pct {
                last_pct = pct;
                let _ = app.emit("dl", serde_json::json!({ "id": id, "pct": pct }));
            }
        }
    }
    out.flush().map_err(|e| e.to_string())?;
    drop(out);
    if total > 0 && done < total {
        let _ = std::fs::remove_file(&part);
        return Err("stream ended early".into());
    }
    std::fs::rename(&part, &path).map_err(|e| e.to_string())?;

    // Tags (best-effort — an untagged file is still playable and enriched from
    // the online index by the frontend).
    let _ = write_tags(&path, &title, &artist, id);
    Ok(path)
}

fn stream_url_of(player: &rustypipe::model::VideoPlayer) -> Result<String, String> {
    player
        .audio_streams
        .iter()
        .filter(|s| s.mime.to_lowercase().contains("mp4"))
        .max_by_key(|s| s.bitrate)
        .map(|s| s.url.clone())
        .ok_or_else(|| "no AAC/m4a audio stream available".into())
}

fn write_tags(path: &str, title: &str, artist: &str, id: &str) -> Result<(), String> {
    use lofty::config::WriteOptions;
    use lofty::picture::{MimeType, Picture, PictureType};
    use lofty::prelude::*;
    use lofty::probe::Probe;
    let mut tagged = Probe::open(path)
        .map_err(|e| e.to_string())?
        .read()
        .map_err(|e| e.to_string())?;
    let tag = match tagged.primary_tag_mut() {
        Some(t) => t,
        None => {
            let ty = tagged.primary_tag_type();
            tagged.insert_tag(lofty::tag::Tag::new(ty));
            tagged.primary_tag_mut().ok_or("no tag")?
        }
    };
    tag.set_title(title.to_string());
    tag.set_artist(artist.to_string());
    tag.set_album("YouTube".to_string());
    if let Ok(resp) = ureq::get(&thumb(id)).call() {
        let mut bytes = Vec::new();
        if resp.into_reader().take(2 * 1024 * 1024).read_to_end(&mut bytes).is_ok() && !bytes.is_empty() {
            tag.push_picture(Picture::new_unchecked(
                PictureType::CoverFront,
                Some(MimeType::Jpeg),
                None,
                bytes,
            ));
        }
    }
    tagged
        .save_to_path(path, WriteOptions::default())
        .map_err(|e| e.to_string())
}

/// True when the native backend is the only option (Android: yt-dlp's glibc
/// binary cannot run on bionic).
pub fn forced() -> bool {
    cfg!(target_os = "android")
}
