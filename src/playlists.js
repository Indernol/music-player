// Playlist store, persisted as JSON via the generic store ("playlists").
// A synchronous in-memory cache backs getPlaylists(); mutations update it and
// fire-and-forget a save. Call initPlaylists() once at startup before rendering.

import { storeLoad, storeSave } from "./store.js";

let _cache = [];
let _loaded = false;

function _persist() { storeSave("playlists", JSON.stringify(_cache)); }

export async function initPlaylists() {
  if (_loaded) return;
  const raw = await storeLoad("playlists");
  if (raw) { try { _cache = JSON.parse(raw); } catch {} }
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

export function deletePlaylist(id) { _cache = _cache.filter(p => p.id !== id); _persist(); }

export function renamePlaylist(id, name) {
  const pl = _cache.find(p => p.id === id);
  if (pl) { pl.name = (name || "").trim() || pl.name; _persist(); }
}

// Remember where an imported playlist came from (enables follow-after-import).
export function setSourceUrl(id, url) {
  const pl = _cache.find(p => p.id === id);
  if (pl) { pl.sourceUrl = url; _persist(); }
}

// allowDup: push even if the path is already present (creates a duplicate entry).
export function addToPlaylist(id, path, allowDup = false) {
  const pl = _cache.find(p => p.id === id);
  if (pl && (allowDup || !pl.paths.includes(path))) { pl.paths.push(path); _persist(); }
}

// How many of `paths` are already in the playlist (for the duplicate prompt).
export function countExisting(id, paths) {
  const pl = _cache.find(p => p.id === id);
  if (!pl) return 0;
  const set = new Set(pl.paths);
  return paths.filter(p => set.has(p)).length;
}

export function removeFromPlaylist(id, path) {
  const pl = _cache.find(p => p.id === id);
  if (pl) { pl.paths = pl.paths.filter(p => p !== path); _persist(); }
}

// Swap a path in every playlist (e.g. online "yt:<id>" → downloaded local file).
export function replacePath(oldPath, newPath) {
  for (const pl of _cache) {
    const i = pl.paths.indexOf(oldPath);
    if (i < 0) continue;
    if (pl.paths.includes(newPath)) pl.paths.splice(i, 1);
    else pl.paths[i] = newPath;
  }
  _persist();
}

export function reorderPlaylist(id, fromIdx, toIdx) {
  const pl = _cache.find(p => p.id === id);
  if (!pl) return;
  const [moved] = pl.paths.splice(fromIdx, 1);
  if (moved === undefined) return;
  pl.paths.splice(toIdx, 0, moved);
  _persist();
}
