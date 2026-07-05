// Playlist CRUD. Scaffold persistence = localStorage (roadmap #2 swaps this for
// native app-data JSON). A playlist stores track paths; tracks resolve against the
// scanned library at render time.

const KEY = "mp.playlists.v1";

export function getPlaylists() {
  try { return JSON.parse(localStorage.getItem(KEY)) || []; }
  catch { return []; }
}

function save(list) { localStorage.setItem(KEY, JSON.stringify(list)); }

export function createPlaylist(name) {
  const list = getPlaylists();
  const pl = { id: crypto.randomUUID(), name: name.trim() || "New playlist", paths: [] };
  list.push(pl);
  save(list);
  return pl;
}

export function deletePlaylist(id) {
  save(getPlaylists().filter(p => p.id !== id));
}

export function renamePlaylist(id, name) {
  const list = getPlaylists();
  const pl = list.find(p => p.id === id);
  if (pl) { pl.name = name.trim() || pl.name; save(list); }
}

export function addToPlaylist(id, path) {
  const list = getPlaylists();
  const pl = list.find(p => p.id === id);
  if (pl && !pl.paths.includes(path)) { pl.paths.push(path); save(list); }
}

export function removeFromPlaylist(id, path) {
  const list = getPlaylists();
  const pl = list.find(p => p.id === id);
  if (pl) { pl.paths = pl.paths.filter(p => p !== path); save(list); }
}

// Reorder a track within a playlist (drag/drop or move up/down).
export function reorderPlaylist(id, fromIdx, toIdx) {
  const list = getPlaylists();
  const pl = list.find(p => p.id === id);
  if (!pl) return;
  const [moved] = pl.paths.splice(fromIdx, 1);
  if (moved === undefined) return;
  pl.paths.splice(toIdx, 0, moved);
  save(list);
}

export function exportPlaylist(id) {
  const pl = getPlaylists().find(p => p.id === id);
  if (!pl) return;
  const blob = new Blob([JSON.stringify(pl, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${pl.name}.playlist.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}
