// Frontend controller. Native Rust core over Tauri IPC: gapless engine, wall-clock
// progress, persisted library + sources + playlists + settings, Spotify-style
// selection + context menu, desktop notifications + optional Discord Rich Presence.

import * as PL from "./playlists.js";
import * as SETTINGS from "./settings.js";
import { storeLoad, storeSave } from "./store.js";

const T = window.__TAURI__;
const IS_NATIVE = !!(T && T.core && typeof T.core.invoke === "function");

const MOCK_TRACKS = [
  { path: "/demo/a.flac", title: "Aurora", artist: "Kioku", album: "Night Drive", duration_secs: 214, gain: 1 },
  { path: "/demo/b.mp3",  title: "Low Tide", artist: "Kioku", album: "Night Drive", duration_secs: 187, gain: 1 },
  { path: "/demo/c.opus", title: "Paper Planes", artist: "Halcyon", album: "Kites", duration_secs: 243, gain: 1 },
];

async function invoke(cmd, args) {
  if (IS_NATIVE) return T.core.invoke(cmd, args);
  if (cmd === "scan") return MOCK_TRACKS;
  if (cmd === "status") return { queued: 0, finished: false, position: 0 };
  return null;
}

// ─── State ───
let library = [];
let folders = [];
let view = [];
let queue = [];
let curIndex = -1, preIndex = -1;
let expectedQueued = 0, queueSettled = false;
let playing = false, shuffle = false, normalize = true;
let history = [];
let seeking = false;
const selected = new Set();
let anchorIdx = -1;
let active = { type: "library", id: "" }; // current view for highlighting

const $ = (s) => document.querySelector(s);
const S = () => SETTINGS.getSettings();

// ─── Wall clock ───
const clock = { origin: 0, pausedAt: null };
function wallStart(atSec = 0) { clock.origin = performance.now() - atSec * 1000; clock.pausedAt = null; }
function wallPause() { if (clock.pausedAt === null) clock.pausedAt = performance.now(); }
function wallResume() { if (clock.pausedAt !== null) { clock.origin += performance.now() - clock.pausedAt; clock.pausedAt = null; } }
function wallSeek(sec) { clock.origin = performance.now() - sec * 1000; if (clock.pausedAt !== null) clock.pausedAt = performance.now(); }
function wallPos() { const now = clock.pausedAt !== null ? clock.pausedAt : performance.now(); return Math.max(0, (now - clock.origin) / 1000); }

// ─── helpers ───
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function fmtDur(s) { s = Math.max(0, Math.floor(s || 0)); const m = Math.floor(s / 60), x = String(s % 60).padStart(2, "0"); return `${m}:${x}`; }
function baseName(p) { return String(p || "").split("/").filter(Boolean).pop() || p; }
function inFolder(t, f) { return t.path === f || t.path.startsWith(f.endsWith("/") ? f : f + "/"); }
function trackByPath(p) { return library.find(t => t.path === p) || view.find(t => t.path === p) || null; }
function gainFor(t) { if (!normalize) return 1.0; const g = t && Number(t.gain); return Number.isFinite(g) && g > 0 ? g : 1.0; }
function artColor(s) { let h = 0; for (const c of String(s || "?")) h = (h * 31 + c.charCodeAt(0)) >>> 0; return `hsl(${h % 360} 42% 40%)`; }
function artInitial(t) { const s = (t.album || t.title || "?").trim(); return (s[0] || "♪").toUpperCase(); }

function flash(msg) {
  let el = $("#toast");
  if (!el) { el = document.createElement("div"); el.id = "toast"; el.className = "toast"; document.body.appendChild(el); }
  el.textContent = msg; el.classList.add("show");
  clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove("show"), 1800);
}

// ─── View header ───
function setViewHead({ icon = "", title = "", subtitle = "" }) {
  $("#viewHead").innerHTML = `<div class="vh-icon">${icon}</div><div class="vh-txt"><div class="vh-title">${esc(title)}</div><div class="vh-sub">${esc(subtitle)}</div></div>`;
}

// ─── Track list ───
function renderTracks(list) {
  view = list;
  updateCount();
  const host = $("#trackList");
  $("#listHead").style.display = list.length ? "" : "none";
  if (!list.length) { host.innerHTML = `<div class="empty"><div class="empty-ico">🎵</div>Nothing here yet.</div>`; return; }
  const nowPath = curIndex >= 0 ? queue[curIndex] : null;
  host.innerHTML = list.map((t, i) => {
    const isNow = nowPath === t.path;
    return `<div class="track ${isNow ? "playing" : ""} ${selected.has(t.path) ? "selected" : ""}" data-path="${esc(t.path)}" data-idx="${i}">
      <div class="tk-idx"><span class="idx-num">${i + 1}</span><span class="idx-play">▶</span>${isNow && playing ? `<span class="eq"><i></i><i></i><i></i></span>` : ""}</div>
      <div class="art" style="background:${artColor(t.artist + t.album)}">${esc(artInitial(t))}</div>
      <div class="meta"><div class="t">${esc(t.title)}</div><div class="s">${esc(t.artist)}</div></div>
      <div class="album">${esc(t.album)}</div>
      <span class="dur">${fmtDur(t.duration_secs)}</span>
      <button class="more" title="More" data-more="${i}">⋯</button>
    </div>`;
  }).join("");

  host.querySelectorAll(".track").forEach(el => {
    const idx = Number(el.dataset.idx), path = el.dataset.path;
    el.addEventListener("click", (e) => { if (e.target.dataset.more !== undefined) return; rowClick(e, idx, path); });
    el.addEventListener("dblclick", (e) => { if (e.target.dataset.more !== undefined) return; playFrom(idx); });
    el.addEventListener("contextmenu", (e) => { e.preventDefault(); ensureSelected(path, idx); openContextMenu(e.clientX, e.clientY); });
  });
  host.querySelectorAll("[data-more]").forEach(btn => btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const idx = Number(btn.dataset.more);
    ensureSelected(view[idx]?.path, idx);
    const r = btn.getBoundingClientRect(); openContextMenu(r.left, r.bottom);
  }));
}

function updateCount() {
  const n = selected.size;
  $("#count").textContent = n ? `${n} selected` : `${view.length} track${view.length === 1 ? "" : "s"}`;
}
function refreshSelectionUI() {
  document.querySelectorAll("#trackList .track").forEach(el => el.classList.toggle("selected", selected.has(el.dataset.path)));
  updateCount();
}

// ─── Selection ───
function rowClick(e, idx, path) {
  if (e.ctrlKey || e.metaKey) { if (selected.has(path)) selected.delete(path); else selected.add(path); anchorIdx = idx; }
  else if (e.shiftKey && anchorIdx >= 0) { const a = Math.min(anchorIdx, idx), b = Math.max(anchorIdx, idx); selected.clear(); for (let i = a; i <= b; i++) if (view[i]) selected.add(view[i].path); }
  else { selected.clear(); selected.add(path); anchorIdx = idx; }
  refreshSelectionUI();
}
function ensureSelected(path, idx) { if (path && !selected.has(path)) { selected.clear(); selected.add(path); anchorIdx = idx; refreshSelectionUI(); } }

// ─── Context menu ───
function openContextMenu(x, y) {
  const paths = [...selected]; if (!paths.length) return;
  const menu = $("#ctxMenu");
  const pls = PL.getPlaylists();
  menu.innerHTML =
    `<div class="ctx-item" data-play="1">▶ Play</div><div class="ctx-sep"></div>` +
    `<div class="ctx-label">Add ${paths.length > 1 ? paths.length + " tracks" : "track"} to</div>` +
    pls.map(p => `<div class="ctx-item" data-add="${p.id}">🎧 ${esc(p.name)}</div>`).join("") +
    `<div class="ctx-item" data-add="__new">➕ New playlist…</div>`;
  menu.hidden = false;
  menu.style.left = Math.min(x, window.innerWidth - 224) + "px";
  menu.style.top = Math.min(y, window.innerHeight - Math.min(menu.offsetHeight + 8, 340)) + "px";
  menu.querySelector("[data-play]")?.addEventListener("click", () => { const i = view.findIndex(t => t.path === paths[0]); if (i >= 0) playFrom(i); closeCtx(); });
  menu.querySelectorAll("[data-add]").forEach(it => it.addEventListener("click", () => {
    let id = it.dataset.add;
    if (id === "__new") { const name = prompt("New playlist name:"); if (!name) { closeCtx(); return; } id = PL.createPlaylist(name).id; }
    let n = 0; for (const p of paths) { PL.addToPlaylist(id, p); n++; }
    const nm = PL.getPlaylists().find(p => p.id === id)?.name || "playlist";
    renderPlaylists(); flash(`Added ${n} track${n === 1 ? "" : "s"} to “${nm}”`); closeCtx();
  }));
}
function closeCtx() { const m = $("#ctxMenu"); if (m && !m.hidden) { m.hidden = true; m.innerHTML = ""; } }

// ─── Sources (folders) ───
function renderSources() {
  const host = $("#sourcesList");
  if (!folders.length) { host.innerHTML = `<div class="src-empty">No folders yet — add one above.</div>`; return; }
  host.innerHTML = folders.map(f => {
    const count = library.filter(t => inFolder(t, f)).length;
    const on = active.type === "source" && active.id === f;
    return `<div class="src-row ${on ? "active" : ""}" data-src="${esc(f)}" title="${esc(f)}">
      <span class="src-ico">📁</span>
      <span class="src-name">${esc(baseName(f))}</span>
      <span class="src-count">${count}</span>
      <button class="src-btn" data-refresh="${esc(f)}" title="Check for new songs">⟳</button>
      <button class="src-btn" data-remove="${esc(f)}" title="Remove source">✕</button>
    </div>`;
  }).join("");
  host.querySelectorAll("[data-src]").forEach(el => el.addEventListener("click", (e) => { if (e.target.dataset.refresh !== undefined || e.target.dataset.remove !== undefined) return; openSource(el.dataset.src); }));
  host.querySelectorAll("[data-refresh]").forEach(b => b.addEventListener("click", (e) => { e.stopPropagation(); rescanFolder(b.dataset.refresh); }));
  host.querySelectorAll("[data-remove]").forEach(b => b.addEventListener("click", (e) => { e.stopPropagation(); removeSource(b.dataset.remove); }));
}

function openSource(folder) {
  active = { type: "source", id: folder };
  markActive();
  selected.clear();
  const tracks = library.filter(t => inFolder(t, folder));
  setViewHead({ icon: "📁", title: baseName(folder), subtitle: `${tracks.length} songs · ${folder}` });
  renderTracks(tracks);
}

async function rescanFolder(folder) {
  const tr = await invoke("scan", { paths: [folder] });
  const found = Array.isArray(tr) ? tr : [];
  const present = new Set(found.map(t => t.path));
  const known = new Set(library.filter(t => inFolder(t, folder)).map(t => t.path));
  const fresh = found.filter(t => !known.has(t.path));
  // Keep tracks outside this folder + this folder's tracks that still exist, add new.
  library = library.filter(t => !inFolder(t, folder) || present.has(t.path)).concat(fresh);
  await saveLibrary();
  renderSources();
  if (active.type === "source" && active.id === folder) openSource(folder);
  else if (active.type === "library") showLibrary();
  flash(fresh.length ? `${fresh.length} new track${fresh.length === 1 ? "" : "s"} in ${baseName(folder)}` : `No new songs in ${baseName(folder)}`);
}

function removeSource(folder) {
  if (!confirm(`Remove this source?\n${folder}\n\nIts tracks leave the library. The files on disk are NOT deleted.`)) return;
  folders = folders.filter(f => f !== folder);
  library = library.filter(t => !inFolder(t, folder));
  saveLibrary();
  renderSources();
  showLibrary();
  flash("Source removed");
}

// ─── Playlists sidebar ───
function renderPlaylists() {
  const host = $("#playlistsList");
  const pls = PL.getPlaylists();
  host.innerHTML =
    `<div class="pl-row" id="plNew">➕ New playlist</div>` +
    pls.map(p => {
      const on = active.type === "playlist" && active.id === p.id;
      return `<div class="pl-row ${on ? "active" : ""}" data-pl="${p.id}">🎧 ${esc(p.name)} <span class="pl-count">${p.paths.length}</span>
        <button class="pl-del" data-del="${p.id}" title="Delete">✕</button></div>`;
    }).join("");
  host.querySelector("#plNew").addEventListener("click", () => { const name = prompt("Playlist name:"); if (name !== null) { PL.createPlaylist(name); renderPlaylists(); } });
  host.querySelectorAll("[data-pl]").forEach(el => el.addEventListener("click", (e) => { if (e.target.dataset.del !== undefined) return; openPlaylist(el.dataset.pl); }));
  host.querySelectorAll("[data-del]").forEach(btn => btn.addEventListener("click", (e) => { e.stopPropagation(); if (confirm("Delete this playlist?")) { PL.deletePlaylist(btn.dataset.del); renderPlaylists(); } }));
}
function openPlaylist(id) {
  const pl = PL.getPlaylists().find(p => p.id === id);
  if (!pl) return;
  active = { type: "playlist", id };
  markActive();
  const byPath = new Map(library.map(t => [t.path, t]));
  selected.clear();
  setViewHead({ icon: "🎧", title: pl.name, subtitle: `${pl.paths.length} songs` });
  renderTracks(pl.paths.map(p => byPath.get(p)).filter(Boolean));
}

function showLibrary() {
  active = { type: "library", id: "" };
  markActive();
  selected.clear();
  const artists = new Set(library.map(t => t.artist)).size;
  setViewHead({ icon: "📚", title: "Your Library", subtitle: `${library.length} songs · ${artists} artist${artists === 1 ? "" : "s"} · ${folders.length} folder${folders.length === 1 ? "" : "s"}` });
  renderTracks(library);
}
function markActive() {
  $("#navLibrary").classList.toggle("active", active.type === "library");
  renderSources();
  // playlist highlight is refreshed by renderPlaylists on open; refresh to sync
  document.querySelectorAll("#playlistsList .pl-row[data-pl]").forEach(el => el.classList.toggle("active", active.type === "playlist" && active.id === el.dataset.pl));
}

// ─── Playback (gapless) ───
function nextIndex(from) {
  if (!queue.length) return -1;
  if (shuffle) { if (queue.length === 1) return -1; let r; do { r = Math.floor(Math.random() * queue.length); } while (r === from); return r; }
  return from + 1 <= queue.length - 1 ? from + 1 : -1;
}
function updateNowPlaying(t, path) {
  $("#playBtn").textContent = "⏸";
  $("#nowTitle").textContent = t ? t.title : (path || "").split("/").pop();
  $("#nowSub").textContent = t ? `${t.artist} — ${t.album}` : "";
  const art = $("#npArt");
  if (t) { art.textContent = artInitial(t); art.style.background = artColor(t.artist + t.album); }
  const dur = t?.duration_secs || 0;
  $("#totTime").textContent = fmtDur(dur);
  $("#seek").max = dur > 0 ? dur : 1; $("#seek").value = 0; $("#curTime").textContent = "0:00";
  notifyTrack(t); updateRPC(t, true);
}
async function playFrom(viewIdx) { queue = view.map(t => t.path); history = []; await hardPlay(viewIdx); }
async function hardPlay(i) {
  if (i < 0 || i >= queue.length) return;
  curIndex = i;
  const t = trackByPath(queue[i]);
  await invoke("play", { path: queue[i], gain: gainFor(t) });
  playing = true; wallStart(0);
  updateNowPlaying(t, queue[i]); renderTracks(view);
  await schedulePreload();
}
async function schedulePreload() {
  const j = nextIndex(curIndex);
  if (j >= 0 && j !== curIndex) { const t = trackByPath(queue[j]); await invoke("preload", { path: queue[j], gain: gainFor(t) }); preIndex = j; expectedQueued = 2; }
  else { preIndex = -1; expectedQueued = 1; }
  queueSettled = false;
}
async function togglePlay() {
  if (curIndex < 0 && view.length) return playFrom(0);
  if (playing) { await invoke("pause"); playing = false; wallPause(); $("#playBtn").textContent = "▶"; }
  else { await invoke("resume"); playing = true; wallResume(); $("#playBtn").textContent = "⏸"; }
  updateRPC(trackByPath(queue[curIndex]), playing); renderTracks(view);
}
async function next() { const j = nextIndex(curIndex); if (j < 0) { playing = false; $("#playBtn").textContent = "▶"; return; } history.push(curIndex); await hardPlay(j); }
async function prev() {
  if (wallPos() > 3) { await invoke("seek", { secs: 0 }); wallSeek(0); return; }
  if (history.length) await hardPlay(history.pop());
  else if (curIndex > 0) await hardPlay(curIndex - 1);
  else { await invoke("seek", { secs: 0 }); wallSeek(0); }
}
function startPolling() {
  setInterval(async () => {
    if (curIndex < 0) return;
    if (!seeking && playing) { const p = wallPos(); $("#seek").value = p; $("#curTime").textContent = fmtDur(p); }
    const st = await invoke("status"); if (!st) return;
    const queued = st.queued || 0;
    if (!queueSettled) { if (queued >= expectedQueued) queueSettled = true; return; }
    if (queued < expectedQueued && queued >= 1 && preIndex >= 0) {
      history.push(curIndex); curIndex = preIndex;
      const t = trackByPath(queue[curIndex]);
      wallStart(0); updateNowPlaying(t, queue[curIndex]); renderTracks(view);
      await schedulePreload();
    } else if (queued === 0 && playing) { playing = false; $("#playBtn").textContent = "▶"; }
  }, 300);
}

// ─── Notifications + Rich Presence ───
let _notifChecked = false, _notifGranted = false;
async function ensureNotifPerm() {
  if (_notifChecked) return _notifGranted;
  try {
    _notifGranted = await T.core.invoke("plugin:notification|is_permission_granted");
    if (!_notifGranted) { const r = await T.core.invoke("plugin:notification|request_permission"); _notifGranted = r === "granted"; }
  } catch (e) { console.error("[notif perm]", e); _notifGranted = false; }
  _notifChecked = true; return _notifGranted;
}
async function notifyTrack(t) {
  if (!IS_NATIVE || !S().notifyOnChange || !t) return;
  if (!(await ensureNotifPerm())) return;
  try { await T.core.invoke("plugin:notification|notify", { options: { title: t.title, body: `${t.artist} — ${t.album}` } }); }
  catch (e) { console.error("[notify]", e); }
}
async function updateRPC(t, isPlaying) {
  if (!IS_NATIVE || !S().rpcEnabled || !S().rpcClientId) return;
  try { await invoke("rpc_update", { clientId: S().rpcClientId, title: t?.title || "", artist: t?.artist || "", playing: !!isPlaying }); }
  catch (e) { console.error("[rpc]", e); }
}
async function clearRPC() { if (IS_NATIVE) { try { await invoke("rpc_clear"); } catch {} } }

// ─── Library (persisted) ───
async function saveLibrary() { await storeSave("library", JSON.stringify({ folders, tracks: library })); }
async function loadLibrary() {
  const raw = await storeLoad("library");
  if (raw) { try { const d = JSON.parse(raw); folders = Array.isArray(d.folders) ? d.folders : []; library = Array.isArray(d.tracks) ? d.tracks : []; } catch {} }
}
async function addSource(path) {
  if (!path) return;
  const tracks = await invoke("scan", { paths: [path] });
  const found = Array.isArray(tracks) ? tracks : [];
  const seen = new Set(library.map(t => t.path));
  library = library.concat(found.filter(t => !seen.has(t.path)));
  if (!folders.includes(path)) folders.push(path);
  await saveLibrary();
  renderSources();
  openSource(path);
  flash(`Added ${baseName(path)} · ${found.length} song${found.length === 1 ? "" : "s"}`);
}
async function rescanAll() {
  if (!folders.length) { flash("No sources to refresh"); return; }
  let total = 0;
  for (const f of [...folders]) {
    const tr = await invoke("scan", { paths: [f] });
    const found = Array.isArray(tr) ? tr : [];
    const present = new Set(found.map(t => t.path));
    const known = new Set(library.filter(t => inFolder(t, f)).map(t => t.path));
    total += found.filter(t => !known.has(t.path)).length;
    library = library.filter(t => !inFolder(t, f) || present.has(t.path)).concat(found.filter(t => !known.has(t.path)));
  }
  await saveLibrary(); renderSources();
  if (active.type === "source") openSource(active.id); else showLibrary();
  flash(total ? `${total} new song${total === 1 ? "" : "s"} found` : "Library up to date");
}
async function pickFolder() {
  if (!IS_NATIVE) { document.querySelector(".manual")?.setAttribute("open", ""); $("#folderInput")?.focus(); return; }
  const btn = $("#pickBtn"); btn.disabled = true;
  try {
    const path = await T.core.invoke("plugin:dialog|open", { options: { directory: true, multiple: false, title: "Choose a music folder" } });
    if (path) await addSource(path);
  } catch (e) { console.error("[dialog]", e); document.querySelector(".manual")?.setAttribute("open", ""); }
  finally { btn.disabled = false; }
}
async function scanFromInput() {
  const path = $("#folderInput").value.trim(); if (!path) return;
  $("#scanBtn").disabled = true; $("#scanBtn").textContent = "…";
  try { await addSource(path); $("#folderInput").value = ""; } finally { $("#scanBtn").disabled = false; $("#scanBtn").textContent = "Add"; }
}

// ─── Settings ───
function applyAccent() {
  const [a, b] = SETTINGS.ACCENTS[S().accent] || SETTINGS.ACCENTS.violet;
  document.documentElement.style.setProperty("--accent", a);
  document.documentElement.style.setProperty("--accent-2", b);
}
function applySettings() {
  applyAccent();
  normalize = S().normalizeDefault; $("#normChk").checked = normalize;
  shuffle = S().shuffleDefault; $("#shuffleBtn").classList.toggle("active", shuffle);
  const v = S().defaultVolume; $("#volume").value = v; invoke("set_volume", { level: v / 100 });
}
function openSettings() {
  const s = S();
  $("#settingsBody").innerHTML = `
    <div class="set-group"><div class="set-title">Appearance</div>
      <div class="set-row"><label>Accent color</label>
        <div class="swatches">${Object.entries(SETTINGS.ACCENTS).map(([k, v]) => `<button class="swatch ${s.accent === k ? "on" : ""}" data-accent="${k}" style="background:${v[0]};color:${v[0]}" title="${k}"></button>`).join("")}</div></div>
    </div>
    <div class="set-group"><div class="set-title">Playback</div>
      <div class="set-row"><label>Default volume</label><input type="range" id="setVol" min="0" max="100" value="${s.defaultVolume}"></div>
      <div class="set-row"><label>Normalize loudness by default</label><input type="checkbox" id="setNorm" ${s.normalizeDefault ? "checked" : ""}></div>
      <div class="set-row"><label>Shuffle by default</label><input type="checkbox" id="setShuf" ${s.shuffleDefault ? "checked" : ""}></div>
    </div>
    <div class="set-group"><div class="set-title">Notifications</div>
      <div class="set-row"><label>Desktop notification on track change</label><input type="checkbox" id="setNotify" ${s.notifyOnChange ? "checked" : ""}></div>
    </div>
    <div class="set-group"><div class="set-title">Discord Rich Presence</div>
      <div class="set-row"><label>Show what I'm listening to</label><input type="checkbox" id="setRpc" ${s.rpcEnabled ? "checked" : ""}></div>
      <div class="set-row"><label>Discord Application ID</label><input type="text" id="setRpcId" class="text-in" placeholder="Discord app client id" value="${esc(s.rpcClientId)}"></div>
      <div class="set-hint">Create an app at <b>discord.com/developers</b> → copy its <b>Application ID</b>. Requires the Discord desktop app running.</div>
    </div>`;
  const body = $("#settingsBody");
  body.querySelectorAll("[data-accent]").forEach(b => b.addEventListener("click", () => { SETTINGS.setSetting("accent", b.dataset.accent); applyAccent(); body.querySelectorAll(".swatch").forEach(x => x.classList.toggle("on", x === b)); }));
  $("#setVol").addEventListener("change", e => { SETTINGS.setSetting("defaultVolume", Number(e.target.value)); $("#volume").value = e.target.value; invoke("set_volume", { level: Number(e.target.value) / 100 }); });
  $("#setNorm").addEventListener("change", e => { SETTINGS.setSetting("normalizeDefault", e.target.checked); normalize = e.target.checked; $("#normChk").checked = normalize; });
  $("#setShuf").addEventListener("change", e => { SETTINGS.setSetting("shuffleDefault", e.target.checked); shuffle = e.target.checked; $("#shuffleBtn").classList.toggle("active", shuffle); if (curIndex >= 0) schedulePreload(); });
  $("#setNotify").addEventListener("change", e => SETTINGS.setSetting("notifyOnChange", e.target.checked));
  $("#setRpc").addEventListener("change", e => { SETTINGS.setSetting("rpcEnabled", e.target.checked); if (e.target.checked) updateRPC(trackByPath(queue[curIndex]), playing); else clearRPC(); });
  $("#setRpcId").addEventListener("change", e => { SETTINGS.setSetting("rpcClientId", e.target.value.trim()); if (S().rpcEnabled) updateRPC(trackByPath(queue[curIndex]), playing); });
  $("#settingsModal").hidden = false;
}

// ─── Wire up ───
async function init() {
  await Promise.all([PL.initPlaylists(), SETTINGS.loadSettings()]);
  await loadLibrary();

  if (!IS_NATIVE) {
    const banner = document.createElement("div");
    banner.className = "mock-banner";
    banner.textContent = "Browser preview (mock data, no audio). Run the app for real playback.";
    $(".main").prepend(banner);
    if (!library.length) { library = MOCK_TRACKS; folders = ["/demo"]; }
  }

  $("#pickBtn").addEventListener("click", pickFolder);
  $("#rescanBtn").addEventListener("click", rescanAll);
  $("#scanBtn").addEventListener("click", scanFromInput);
  $("#folderInput").addEventListener("keydown", e => { if (e.key === "Enter") scanFromInput(); });
  $("#navLibrary").addEventListener("click", showLibrary);

  $("#playBtn").addEventListener("click", togglePlay);
  $("#nextBtn").addEventListener("click", next);
  $("#prevBtn").addEventListener("click", prev);
  $("#shuffleBtn").addEventListener("click", () => { shuffle = !shuffle; $("#shuffleBtn").classList.toggle("active", shuffle); if (curIndex >= 0) schedulePreload(); flash(shuffle ? "Shuffle on" : "Shuffle off"); });
  $("#normChk").addEventListener("change", e => { normalize = e.target.checked; flash(normalize ? "Normalize on (next tracks)" : "Normalize off"); });
  $("#volume").addEventListener("input", e => invoke("set_volume", { level: Number(e.target.value) / 100 }));

  $("#seek").addEventListener("input", () => { seeking = true; $("#curTime").textContent = fmtDur(Number($("#seek").value)); });
  $("#seek").addEventListener("change", async () => { const s = Number($("#seek").value); await invoke("seek", { secs: s }); wallSeek(s); seeking = false; });

  $("#search").addEventListener("input", e => {
    const q = e.target.value.trim().toLowerCase();
    selected.clear();
    if (!q) { showLibrary(); return; }
    setViewHead({ icon: "🔍", title: "Search", subtitle: `“${e.target.value.trim()}”` });
    renderTracks(library.filter(t => t.title.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q) || t.album.toLowerCase().includes(q)));
  });

  $("#settingsBtn").addEventListener("click", openSettings);
  $("#settingsClose").addEventListener("click", () => $("#settingsModal").hidden = true);
  $("#settingsModal").addEventListener("click", e => { if (e.target.id === "settingsModal") $("#settingsModal").hidden = true; });

  document.addEventListener("click", e => { if (!e.target.closest("#ctxMenu") && e.target.dataset.more === undefined) closeCtx(); });
  document.addEventListener("scroll", closeCtx, true);
  document.addEventListener("keydown", e => { if (e.key === "Escape") { closeCtx(); $("#settingsModal").hidden = true; } });

  renderPlaylists();
  applySettings();
  startPolling();
  showLibrary();
}

init().catch(e => console.error("[init] failed:", e));
