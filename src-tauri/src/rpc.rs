//! Discord Rich Presence (optional). Connects to the local Discord IPC socket and
//! shows the current track. Requires a Discord Application (Client ID) the user
//! creates + the Discord client running — so every op is best-effort and never
//! panics: failures are returned as strings and the frontend just ignores them.

use discord_rich_presence::{activity, DiscordIpc, DiscordIpcClient};
use std::sync::Mutex;
use tauri::State;

/// Holds the connected client alongside the client-id it was opened with, so we
/// can reconnect when the id changes.
#[derive(Default)]
pub struct RpcState(pub Mutex<Option<(String, DiscordIpcClient)>>);

#[tauri::command]
pub fn rpc_update(
    state: State<RpcState>,
    client_id: String,
    title: String,
    artist: String,
    playing: bool,
) -> Result<(), String> {
    if client_id.trim().is_empty() {
        return Err("no client id".into());
    }
    let mut guard = state.0.lock().map_err(|_| "rpc lock")?;

    let reconnect = match &*guard {
        Some((id, _)) => id != &client_id,
        None => true,
    };
    if reconnect {
        if let Some((_, mut old)) = guard.take() {
            let _ = old.close();
        }
        let mut client = DiscordIpcClient::new(&client_id).map_err(|e| e.to_string())?;
        client.connect().map_err(|e| e.to_string())?;
        *guard = Some((client_id.clone(), client));
    }

    if let Some((_, client)) = guard.as_mut() {
        let details = if title.is_empty() { "Idle".to_string() } else { title };
        let state_line = if artist.is_empty() { "—".to_string() } else { artist };
        let status = if playing { "Playing" } else { "Paused" };
        let act = activity::Activity::new()
            .details(&details)
            .state(&state_line)
            .assets(activity::Assets::new().large_text(status));
        client.set_activity(act).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn rpc_clear(state: State<RpcState>) {
    if let Ok(mut guard) = state.0.lock() {
        if let Some((_, mut client)) = guard.take() {
            let _ = client.clear_activity();
            let _ = client.close();
        }
    }
}
