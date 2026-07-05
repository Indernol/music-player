//! Playlist persistence: a single JSON file in the app data directory.
//!
//! The frontend owns the playlist schema; this module just reads/writes the raw
//! JSON string (validated as well-formed before writing, and written atomically
//! via a temp file + rename so a crash mid-write can't corrupt the library).

use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

fn playlists_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("playlists.json"))
}

#[tauri::command]
pub fn load_playlists(app: AppHandle) -> Result<String, String> {
    let path = playlists_path(&app)?;
    match fs::read_to_string(&path) {
        Ok(s) if !s.trim().is_empty() => Ok(s),
        _ => Ok("[]".to_string()), // missing / empty → no playlists yet
    }
}

#[tauri::command]
pub fn save_playlists(app: AppHandle, data: String) -> Result<(), String> {
    // Reject malformed JSON so we never overwrite a good file with garbage.
    serde_json::from_str::<serde_json::Value>(&data).map_err(|e| format!("invalid JSON: {e}"))?;
    let path = playlists_path(&app)?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, data.as_bytes()).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}
