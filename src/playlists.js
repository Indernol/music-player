// Playlist store. Persistence: a JSON file in the app data dir via the Rust
// backend (load_playlists / save_playlists). Falls back to localStorage in a
// plain browser (mock preview).
//
// A synchronous in-memory cache backs getPlaylists() so the rest of the UI stays
// simple; mutations update the cache and fire-and-forget a save. Call
// initPlaylists() once at startup (awaited) before the first render.

const T = window.__TAURI__;
const IS_NATIVE = !!(T && T.core && typeof T.core.invoke === "function");
const LS_KEY = "mp.playlists.v1";

let _cache = [];
let _loaded = false;

async function _read() {
  if (IS_NATIVE) {
    try { return JSON.parse((await T.core.invoke("load_playlists")) || "[]"); }
    catch (e) { console.error("[playlists] load failed:", e); return []; }
  }
  try { return JSON.parse(localStorage.getItem(LS_KEY)) || []; } catch { return []; }
}

async function _write() {
  const json = JSON.stringify(_cache);
  if (IS_NATIVE) {
    try { await T.core.invoke("save_playlists", { data: json }); }
    catch (e) { console.error("[playlists] save failed:", e); }
  } else {
    localStorage.setItem(LS_KEY, json);
  }
}

function _persist() { _write(); } // fire-and-forget; validated + atomic on the Rust side

/** Load persisted playlists into the cache. Awaited once before the first render. */
export async function initPlaylists() {
  if (_loaded) return;
  _cache = await _read();
  if (!Array.isArray(_cache)) _cache = [];
  _loaded = true;
}

export function getPlaylists() { return _cache; }

export function createPlaylist(name) {
  const pl = { id: crypto.randomUUID(), name: (name || "").trim() || "New playlist", paths: [] };
  _cache.push(pl);
  _persist();
  return pl;
}

export function deletePlaylist(id) {
  _cache = _cache.filter(p => p.id !== id);
  _persist();
}

export function renamePlaylist(id, name) {
  const pl = _cache.find(p => p.id === id);
  if (pl) { pl.name = (name || "").trim() || pl.name; _persist(); }
}

export function addToPlaylist(id, path) {
  const pl = _cache.find(p => p.id === id);
  if (pl && !pl.paths.includes(path)) { pl.paths.push(path); _persist(); }
}

export function removeFromPlaylist(id, path) {
  const pl = _cache.find(p => p.id === id);
  if (pl) { pl.paths = pl.paths.filter(p => p !== path); _persist(); }
}

// Reorder a track within a playlist (drag/drop or move up/down).
export function reorderPlaylist(id, fromIdx, toIdx) {
  const pl = _cache.find(p => p.id === id);
  if (!pl) return;
  const [moved] = pl.paths.splice(fromIdx, 1);
  if (moved === undefined) return;
  pl.paths.splice(toIdx, 0, moved);
  _persist();
}

export function exportPlaylist(id) {
  const pl = _cache.find(p => p.id === id);
  if (!pl) return;
  const blob = new Blob([JSON.stringify(pl, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${pl.name}.playlist.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}
