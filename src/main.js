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
  if (cmd === "status") return { queued: 0, finished: false, position: 0, epoch: 0 };
  if (cmd === "scan_diff") return { new_tracks: [], present: MOCK_TRACKS.map(t => t.path) };
  if (cmd === "play") return 0;
  return null;
}

// ─── State ───
let library = [];
let folders = [];
let view = [];
let queue = [];
let curIndex = -1, preIndex = -1;
let expectedQueued = 0, queueSettled = false;
let curEpoch = 0; // tags the current sink; stale status polls are ignored
let playing = false, shuffle = false, normalize = true;
let repeatMode = "off"; // off | all | one
let history = [];
let seeking = false;
const selected = new Set();
let anchorIdx = -1;
let active = { type: "library", id: "" }; // current view for highlighting

const $ = (s) => document.querySelector(s);
const S = () => SETTINGS.getSettings();

// ─── UI icons (inline SVG shapes — no emoji in the chrome) ───
const IC = {
  headphones: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="3" y="14" width="4" height="6" rx="1.5"/><rect x="17" y="14" width="4" height="6" rx="1.5"/></svg>`,
  disc: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none"/></svg>`,
  folder: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>`,
  note: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`,
  globe: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/></svg>`,
  search: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>`,
  gear: `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M12 2v3m0 14v3M4.9 4.9l2.1 2.1m10 10 2.1 2.1M2 12h3m14 0h3M4.9 19.1l2.1-2.1m10-10 2.1-2.1"/></svg>`,
  clock: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>`,
  plus: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`,
  dl: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0 4-4m-4 4-4-4"/><path d="M4 21h16"/></svg>`,
  pin: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 3h6l1 7 2 2H6l2-2z"/></svg>`,
  pencil: `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>`,
  check: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="m4 12 5 5L20 6"/></svg>`,
  slash: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/></svg>`,
  alert: `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v9"/><circle cx="12" cy="18" r="1.2" fill="currentColor" stroke="none"/></svg>`,
};
function hydrateIcons(root = document) {
  root.querySelectorAll("[data-ic]").forEach(el => { el.innerHTML = IC[el.dataset.ic] || ""; });
}

// ─── Player control icons (inline SVG, colored via currentColor) ───
const ICON_PLAY = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
const ICON_PAUSE = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>`;
const ICON_REPEAT = `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/></svg>`;
function setPlayIcon(on) { $("#playBtn").innerHTML = on ? ICON_PAUSE : ICON_PLAY; }
function updateRepeatBtn() {
  const b = $("#repeatBtn");
  b.classList.toggle("active", repeatMode !== "off");
  b.title = `Repeat: ${repeatMode}`;
  b.innerHTML = ICON_REPEAT + (repeatMode === "one" ? `<span class="rep-one">1</span>` : "");
}

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
function trackByPath(p) { return library.find(t => t.path === p) || onlineIndex.get(p) || view.find(t => t.path === p) || null; }
function gainFor(t) { if (!normalize) return 1.0; const g = t && Number(t.gain); return Number.isFinite(g) && g > 0 ? g : 1.0; }
function artColor(s) { let h = 0; for (const c of String(s || "?")) h = (h * 31 + c.charCodeAt(0)) >>> 0; return `hsl(${h % 360} 42% 40%)`; }
function artInitial(t) { const s = (t.album || t.title || "?").trim(); return (s[0] || "♪").toUpperCase(); }

// ─── Album art (embedded cover, deduped per album, lazily fetched) ───
const coverCache = new Map(); // albumKey -> dataURL | "" (none/pending)
function albumKey(t) { return `${t.artist}|||${t.album}`; }
function setArtImg(el, url) { el.style.backgroundImage = `url("${url}")`; el.textContent = ""; el.classList.add("has-cover"); }
function setArtPlaceholder(el, t) { el.classList.remove("has-cover"); el.style.backgroundImage = ""; el.style.background = artColor(t.artist + t.album); el.textContent = artInitial(t); el.dataset.album = albumKey(t); }
function artCell(t) {
  if (t.thumbnail && S().showArt) return `<div class="art has-cover" style="background-image:url('${esc(t.thumbnail)}')"></div>`;
  const k = albumKey(t);
  const cov = S().showArt ? coverCache.get(k) : "";
  if (cov) return `<div class="art has-cover" data-album="${esc(k)}" style="background-image:url('${cov}')"></div>`;
  return `<div class="art" data-album="${esc(k)}" style="background:${artColor(t.artist + t.album)}">${esc(artInitial(t))}</div>`;
}
function applyCover(key, url) {
  if (!url) return;
  document.querySelectorAll("#trackList .art, #upNextList .art").forEach(el => { if (el.dataset.album === key) setArtImg(el, url); });
  for (const sel of ["#npArt", "#ovArt"]) { const el = $(sel); if (el && el.dataset.album === key) setArtImg(el, url); }
}
function fetchCover(t) {
  if (isOnline(t.path)) return; // online art comes from the thumbnail URL
  const k = albumKey(t);
  if (coverCache.has(k)) { const u = coverCache.get(k); if (u) applyCover(k, u); return; }
  coverCache.set(k, ""); // reserve
  invoke("cover", { path: t.path }).then(url => { coverCache.set(k, url || ""); if (url) applyCover(k, url); }).catch(() => {});
}
// Covers load lazily as rows scroll into view (IntersectionObserver) instead of
// firing one file-read per album for the whole 1700-track list at once.
let artObserver = null;
function ensureArtObserver() {
  if (artObserver || typeof IntersectionObserver === "undefined") return;
  artObserver = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      artObserver.unobserve(en.target);
      const key = en.target.dataset.album;
      if (!key || coverCache.get(key)) { if (key) applyCover(key, coverCache.get(key) || ""); continue; }
      const t = view.find(x => albumKey(x) === key) || library.find(x => albumKey(x) === key);
      if (t) fetchCover(t);
    }
  }, { root: $("#trackList"), rootMargin: "300px" });
}
function hydrateCovers() {
  if (!S().showArt) return;
  ensureArtObserver();
  const arts = document.querySelectorAll("#trackList .art[data-album]:not(.has-cover)");
  if (artObserver) arts.forEach(el => artObserver.observe(el));
  else { const seen = new Set(); for (const t of view.slice(0, 60)) { const k = albumKey(t); if (!seen.has(k)) { seen.add(k); fetchCover(t); } } }
}
function refreshView() { if (active.type === "source") openSource(active.id); else if (active.type === "playlist") openPlaylist(active.id); else if (active.type === "online") renderOnlineResults(); else showLibrary(); }

// ─── Online tracks (YouTube via yt-dlp, same approach as play_yt_audio.sh) ───
// Online tracks live under pseudo-paths "yt:<videoId>" so queue/playlist/selection
// logic works unchanged. Metadata for playlist members persists in store "online".
const onlineIndex = new Map(); // "yt:<id>" -> track
function isOnline(p) { return String(p || "").startsWith("yt:"); }
function ytId(p) { return String(p).slice(3); }
function onlineFromResult(r) { return { path: "yt:" + r.id, title: r.title, artist: r.artist, album: "YouTube", duration_secs: r.duration_secs, gain: 1, thumbnail: r.thumbnail }; }
async function saveOnline() {
  // Persist the whole index (capped): it also restores title/artist/artwork of
  // downloaded mp3 files that have no embedded tags (see enrichLibrary).
  const entries = [...onlineIndex.entries()].slice(-4000);
  await storeSave("online", JSON.stringify(Object.fromEntries(entries)));
}
async function loadOnline() {
  const raw = await storeLoad("online");
  if (raw) { try { const d = JSON.parse(raw); for (const k of Object.keys(d)) onlineIndex.set(k, d[k]); } catch {} }
}
// Downloaded files are named "Title [videoId].mp3"; when the mp3 has no tags
// (older downloads), borrow title/artist/artwork from the online metadata.
function enrichLibrary() {
  let changed = 0;
  for (const t of library) {
    if (t.thumbnail) continue;
    const m = String(t.path).match(/\[([A-Za-z0-9_-]{11})\]\.[a-z0-9]+$/);
    if (!m) continue;
    const o = onlineIndex.get("yt:" + m[1]);
    if (!o) continue;
    if (t.title.includes(`[${m[1]}]`)) t.title = o.title;
    if (!t.artist || t.artist === "Unknown Artist") t.artist = o.artist;
    if (!t.album || t.album === "Unknown Album") t.album = "YouTube";
    t.thumbnail = o.thumbnail;
    changed++;
  }
  return changed;
}

// ─── In-app dialogs (replaces the ugly native prompt()/confirm() popups) ───
let _dlgResolve = null, _dlgHasInput = false;
function dlgClose(val) {
  $("#dlgModal").hidden = true;
  const r = _dlgResolve; _dlgResolve = null;
  r?.(val);
}
function askText(title, { placeholder = "", value = "", ok = "OK" } = {}) {
  return new Promise(res => {
    _dlgResolve = res; _dlgHasInput = true;
    $("#dlgTitle").textContent = title;
    $("#dlgMsg").hidden = true;
    const inp = $("#dlgInput");
    inp.hidden = false; inp.placeholder = placeholder; inp.value = value;
    $("#dlgOk").textContent = ok;
    $("#dlgModal").hidden = false;
    setTimeout(() => inp.focus(), 0);
  });
}
function askConfirm(title, msg = "", ok = "OK") {
  return new Promise(res => {
    _dlgResolve = res; _dlgHasInput = false;
    $("#dlgTitle").textContent = title;
    $("#dlgMsg").textContent = msg; $("#dlgMsg").hidden = !msg;
    $("#dlgInput").hidden = true;
    $("#dlgOk").textContent = ok;
    $("#dlgModal").hidden = false;
    setTimeout(() => $("#dlgOk").focus(), 0);
  });
}
function wireDialogs() {
  $("#dlgOk").addEventListener("click", () => dlgClose(_dlgHasInput ? $("#dlgInput").value.trim() : true));
  $("#dlgCancel").addEventListener("click", () => dlgClose(_dlgHasInput ? null : false));
  $("#dlgInput").addEventListener("keydown", e => { if (e.key === "Enter") dlgClose($("#dlgInput").value.trim()); });
  $("#dlgModal").addEventListener("click", e => { if (e.target.id === "dlgModal") dlgClose(_dlgHasInput ? null : false); });
}

function flash(msg) {
  let el = $("#toast");
  if (!el) { el = document.createElement("div"); el.id = "toast"; el.className = "toast"; document.body.appendChild(el); }
  el.textContent = msg; el.classList.add("show");
  clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove("show"), 1800);
}

// ─── View header ───
function setViewHead({ icon = "", title = "", subtitle = "", actions = "" }) {
  $("#viewHead").innerHTML = `<div class="vh-icon">${icon}</div><div class="vh-txt"><div class="vh-title">${esc(title)}</div><div class="vh-sub">${esc(subtitle)}</div></div>${actions ? `<div class="vh-actions">${actions}</div>` : ""}`;
}

// ─── Sorting ───
let sortMode = "default";
function sortTracks(list) {
  const c = (a, b, k) => String(a[k] || "").localeCompare(String(b[k] || ""), undefined, { sensitivity: "base" });
  switch (sortMode) {
    case "title": return list.sort((a, b) => c(a, b, "title"));
    case "title-desc": return list.sort((a, b) => c(b, a, "title"));
    case "artist": return list.sort((a, b) => c(a, b, "artist") || c(a, b, "album") || c(a, b, "title"));
    case "album": return list.sort((a, b) => c(a, b, "album") || c(a, b, "title"));
    case "dur": return list.sort((a, b) => (a.duration_secs || 0) - (b.duration_secs || 0));
    case "dur-desc": return list.sort((a, b) => (b.duration_secs || 0) - (a.duration_secs || 0));
    default: return list; // natural order (playlist / scan order)
  }
}

// ─── Track list ───
function renderTracks(list, presorted = false) {
  view = presorted ? [...list] : sortTracks([...list]);
  list = view;
  updateCount();
  const host = $("#trackList");
  $("#listHead").style.display = list.length ? "" : "none";
  if (!list.length) { host.innerHTML = `<div class="empty"><div class="empty-ico">🎶</div>Nothing here yet.</div>`; return; }
  const nowPath = curIndex >= 0 ? queue[curIndex] : null;
  host.innerHTML = list.map((t, i) => {
    const isNow = nowPath === t.path;
    return `<div class="track ${isNow ? "playing" : ""} ${selected.has(t.path) ? "selected" : ""}" data-path="${esc(t.path)}" data-idx="${i}">
      <div class="tk-idx"><span class="idx-num">${i + 1}</span><span class="idx-play">▶</span></div>
      ${artCell(t)}
      <div class="meta"><div class="t">${esc(t.title)}</div><div class="s">${esc(t.artist)}</div></div>
      <div class="album">${esc(t.album)}</div>
      <span class="dur">${fmtDur(t.duration_secs)}</span>
      <button class="more" title="More" data-more="${i}">⋯</button>
    </div>`;
  }).join("");

  // Rows use event delegation (wired once in init) — attaching thousands of
  // per-row listeners on every render made big libraries stutter.
  updatePlayingRow();
  hydrateCovers();
}

function wireTrackList() {
  const host = $("#trackList");
  host.addEventListener("click", (e) => {
    const more = e.target.closest("[data-more]");
    if (more) {
      e.stopPropagation();
      const idx = Number(more.dataset.more);
      ensureSelected(view[idx]?.path, idx);
      const r = more.getBoundingClientRect();
      openContextMenu(r.left, r.bottom);
      return;
    }
    const row = e.target.closest(".track");
    if (row) rowClick(e, Number(row.dataset.idx), row.dataset.path);
  });
  host.addEventListener("dblclick", (e) => {
    if (e.target.closest("[data-more]")) return;
    const row = e.target.closest(".track");
    if (row) playFrom(Number(row.dataset.idx));
  });
  host.addEventListener("contextmenu", (e) => {
    const row = e.target.closest(".track");
    if (!row) return;
    e.preventDefault();
    ensureSelected(row.dataset.path, Number(row.dataset.idx));
    openContextMenu(e.clientX, e.clientY);
  });
}

// Cheap in-place update of the "now playing" row highlight — avoids re-rendering
// the whole list (1000+ rows) on every track change or play/pause.
function updatePlayingRow() {
  const nowPath = curIndex >= 0 ? queue[curIndex] : null;
  document.querySelectorAll("#trackList .track").forEach(el => el.classList.toggle("playing", el.dataset.path === nowPath));
  document.body.classList.toggle("paused", !playing);
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
  else {
    selected.clear(); selected.add(path); anchorIdx = idx;
    // Warm up the stream URL so a double-click play is near-instant.
    if (isOnline(path) && IS_NATIVE) invoke("prefetch_stream", { id: ytId(path) }).catch(() => {});
  }
  refreshSelectionUI();
}
function ensureSelected(path, idx) { if (path && !selected.has(path)) { selected.clear(); selected.add(path); anchorIdx = idx; refreshSelectionUI(); } }

// ─── Context menu ───
function openContextMenu(x, y) {
  const paths = [...selected]; if (!paths.length) return;
  const menu = $("#ctxMenu");
  const pls = PL.getPlaylists();
  const nOnline = paths.filter(isOnline).length;
  menu.innerHTML =
    `<div class="ctx-item" data-play="1">▶ Play</div>` +
    (nOnline ? `<div class="ctx-item" data-dl="1">📥 Download ${nOnline > 1 ? nOnline + " tracks" : "track"} locally</div>` : "") +
    `<div class="ctx-sep"></div>` +
    `<div class="ctx-label">Add ${paths.length > 1 ? paths.length + " tracks" : "track"} to</div>` +
    pls.map(p => `<div class="ctx-item" data-add="${p.id}"><span class="row-ic">${IC.note}</span> ${esc(p.name)}</div>`).join("") +
    `<div class="ctx-item" data-add="__new">✚ New playlist…</div>`;
  menu.hidden = false;
  menu.querySelector("[data-dl]")?.addEventListener("click", () => { downloadTracks(paths.filter(isOnline)); closeCtx(); });
  menu.style.left = Math.min(x, window.innerWidth - 224) + "px";
  menu.style.top = Math.min(y, window.innerHeight - Math.min(menu.offsetHeight + 8, 340)) + "px";
  menu.querySelector("[data-play]")?.addEventListener("click", () => { const i = view.findIndex(t => t.path === paths[0]); if (i >= 0) playFrom(i); closeCtx(); });
  menu.querySelectorAll("[data-add]").forEach(it => it.addEventListener("click", async () => {
    let id = it.dataset.add;
    if (id === "__new") { closeCtx(); const name = await askText("New playlist", { placeholder: "Playlist name", ok: "Create" }); if (!name) return; id = PL.createPlaylist(name).id; }
    let n = 0; for (const p of paths) { PL.addToPlaylist(id, p); n++; }
    if (paths.some(isOnline)) saveOnline(); // keep online metadata across restarts
    const nm = PL.getPlaylists().find(p => p.id === id)?.name || "playlist";
    renderPlaylists(); flash(`Added ${n} track${n === 1 ? "" : "s"} to “${nm}”`); closeCtx();
  }));
}
function closeCtx() { const m = $("#ctxMenu"); if (m && !m.hidden) { m.hidden = true; m.innerHTML = ""; } }

function placeCtx(menu, x, y) {
  menu.hidden = false;
  menu.style.left = Math.min(x, window.innerWidth - 224) + "px";
  menu.style.top = Math.min(y, window.innerHeight - Math.min(menu.offsetHeight + 8, 340)) + "px";
}

// Right-click menu for a sidebar playlist: everything you can do to it.
function openPlaylistCtx(x, y, id) {
  const pl = PL.getPlaylists().find(p => p.id === id);
  if (!pl) return;
  const fw = followFor(id);
  const menu = $("#ctxMenu");
  menu.innerHTML =
    `<div class="ctx-item" data-a="open">🎼 Open</div>` +
    `<div class="ctx-item" data-a="rename">✏️ Rename…</div>` +
    `<div class="ctx-item" data-a="follow">${fw ? "🔁 Unfollow" : "🔁 Follow…"}</div>` +
    `<div class="ctx-item" data-a="save">📥 Save locally</div>` +
    `<div class="ctx-sep"></div>` +
    `<div class="ctx-item ctx-danger" data-a="del">🗑 Delete</div>`;
  placeCtx(menu, x, y);
  menu.querySelectorAll("[data-a]").forEach(it => it.addEventListener("click", async () => {
    const a = it.dataset.a;
    closeCtx();
    if (a === "open") openPlaylist(id);
    else if (a === "rename") {
      const name = await askText("Rename playlist", { value: pl.name, ok: "Rename" });
      if (name) { PL.renamePlaylist(id, name); renderPlaylists(); if (active.type === "playlist" && active.id === id) openPlaylist(id); }
    }
    else if (a === "follow") { if (fw) unfollowPlaylist(id); else followPlaylistFlow(id); }
    else if (a === "save") downloadPlaylist(id);
    else if (a === "del") {
      if (await askConfirm("Delete this playlist?", `“${pl.name}” — its tracks stay in the library.`, "Delete")) {
        PL.deletePlaylist(id); renderPlaylists();
        if (active.type === "playlist" && active.id === id) showLibrary();
      }
    }
  }));
}

// Right-click menu for a source folder.
function openSourceCtx(x, y, folder) {
  const menu = $("#ctxMenu");
  menu.innerHTML =
    `<div class="ctx-item" data-a="open">🗂️ Open</div>` +
    `<div class="ctx-item" data-a="refresh">⟳ Check for new songs</div>` +
    `<div class="ctx-sep"></div>` +
    `<div class="ctx-item ctx-danger" data-a="remove">✕ Remove source</div>`;
  placeCtx(menu, x, y);
  menu.querySelectorAll("[data-a]").forEach(it => it.addEventListener("click", () => {
    const a = it.dataset.a;
    closeCtx();
    if (a === "open") openSource(folder);
    else if (a === "refresh") rescanFolder(folder);
    else if (a === "remove") removeSource(folder);
  }));
}

// ─── Sources (folders) ───
function renderSources() {
  const host = $("#sourcesList");
  if (!folders.length) { host.innerHTML = `<div class="src-empty">No folders yet — add one above.</div>`; return; }
  host.innerHTML = folders.map(f => {
    const count = library.filter(t => inFolder(t, f)).length;
    const on = active.type === "source" && active.id === f;
    return `<div class="src-row ${on ? "active" : ""}" data-src="${esc(f)}" title="${esc(f)}">
      <span class="src-ico" data-ic="folder"></span>
      <span class="src-name">${esc(baseName(f))}</span>
      <span class="src-count">${count}</span>
      <button class="src-btn" data-refresh="${esc(f)}" title="Check for new songs">⟳</button>
      <button class="src-btn" data-remove="${esc(f)}" title="Remove source">✕</button>
    </div>`;
  }).join("");
  host.querySelectorAll("[data-src]").forEach(el => {
    el.addEventListener("click", (e) => { if (e.target.dataset.refresh !== undefined || e.target.dataset.remove !== undefined) return; openSource(el.dataset.src); });
    el.addEventListener("contextmenu", (e) => { e.preventDefault(); openSourceCtx(e.clientX, e.clientY, el.dataset.src); });
  });
  host.querySelectorAll("[data-refresh]").forEach(b => b.addEventListener("click", (e) => { e.stopPropagation(); rescanFolder(b.dataset.refresh); }));
  host.querySelectorAll("[data-remove]").forEach(b => b.addEventListener("click", (e) => { e.stopPropagation(); removeSource(b.dataset.remove); }));
  $("#sideFilter")?.dispatchEvent(new Event("input")); // keep the filter applied
}

function openSource(folder) {
  active = { type: "source", id: folder };
  markActive();
  selected.clear();
  const tracks = library.filter(t => inFolder(t, folder));
  setViewHead({ icon: IC.folder, title: baseName(folder), subtitle: `${tracks.length} songs · ${folder}` });
  renderTracks(tracks);
}

// Differential refresh: the backend only reads tags of files we don't know yet
// (async command), so refreshing 1000+ known files is near-instant and the UI
// never freezes.
async function diffFolder(folder) {
  const known = library.filter(t => inFolder(t, folder)).map(t => t.path);
  const diff = await invoke("scan_diff", { paths: [folder], known }).catch(e => { console.error("[scan]", e); return null; });
  if (!diff) return 0;
  const present = new Set(diff.present || []);
  const fresh = diff.new_tracks || [];
  // Keep tracks outside this folder + this folder's tracks that still exist, add new.
  library = library.filter(t => !inFolder(t, folder) || present.has(t.path)).concat(fresh);
  return fresh.length;
}
async function rescanFolder(folder) {
  flash(`Checking ${baseName(folder)}…`);
  const fresh = await diffFolder(folder);
  await saveLibrary();
  renderSources();
  if (active.type === "source" && active.id === folder) openSource(folder);
  else if (active.type === "library") showLibrary();
  flash(fresh ? `${fresh} new track${fresh === 1 ? "" : "s"} in ${baseName(folder)}` : `No new songs in ${baseName(folder)}`);
}

async function removeSource(folder) {
  if (!await askConfirm("Remove this source?", `${folder}\n\nIts tracks leave the library. The files on disk are NOT deleted.`, "Remove")) return;
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
    `<div class="pl-row" id="plNew"><span class="row-ic">${IC.plus}</span> New playlist</div>` +
    pls.map(p => {
      const on = active.type === "playlist" && active.id === p.id;
      const fw = followFor(p.id);
      return `<div class="pl-row ${on ? "active" : ""}" data-pl="${p.id}"><span class="row-ic">${IC.note}</span> ${esc(p.name)}${fw ? ` <span class="pl-follow" title="Following “${esc(fw.title)}” — new tracks are added automatically">🔁</span>` : ""} <span class="pl-count">${p.paths.length}</span>
        <button class="pl-del" data-del="${p.id}" title="Delete">✕</button></div>`;
    }).join("");
  host.querySelector("#plNew").addEventListener("click", async () => { const name = await askText("New playlist", { placeholder: "Playlist name", ok: "Create" }); if (name !== null) { PL.createPlaylist(name); renderPlaylists(); } });
  host.querySelectorAll("[data-pl]").forEach(el => {
    el.addEventListener("click", (e) => { if (e.target.dataset.del !== undefined) return; openPlaylist(el.dataset.pl); });
    el.addEventListener("contextmenu", (e) => { e.preventDefault(); openPlaylistCtx(e.clientX, e.clientY, el.dataset.pl); });
  });
  host.querySelectorAll("[data-del]").forEach(btn => btn.addEventListener("click", async (e) => { e.stopPropagation(); if (await askConfirm("Delete this playlist?", "", "Delete")) { PL.deletePlaylist(btn.dataset.del); renderPlaylists(); } }));
  $("#sideFilter")?.dispatchEvent(new Event("input")); // keep the filter applied
}
function openPlaylist(id) {
  const pl = PL.getPlaylists().find(p => p.id === id);
  if (!pl) return;
  active = { type: "playlist", id };
  markActive();
  const byPath = new Map(library.map(t => [t.path, t]));
  selected.clear();
  const nOnline = pl.paths.filter(isOnline).length;
  const fw = followFor(id);
  setViewHead({
    icon: IC.note, title: pl.name, subtitle: `${pl.paths.length} songs${nOnline ? ` · ${nOnline} online` : ""}${fw ? " · 🔁 followed" : ""}`,
    actions:
      `<button id="plFollowBtn" class="btn-line sm" title="${fw ? esc(`Following “${fw.title}” — click to unfollow`) : "Watch the source playlist and auto-add its new tracks"}">${fw ? "🔁 Following ✓" : "🔁 Follow"}</button>` +
      (nOnline ? `<button id="plDlBtn" class="btn-line sm">📥 Save locally (${nOnline} mp3)</button>` : ""),
  });
  $("#plDlBtn")?.addEventListener("click", () => downloadPlaylist(id));
  $("#plFollowBtn")?.addEventListener("click", () => (followFor(id) ? unfollowPlaylist(id) : followPlaylistFlow(id)));
  renderTracks(pl.paths.map(p => byPath.get(p) || onlineIndex.get(p)).filter(Boolean));
}

// Follow an ALREADY-imported playlist: reuse its remembered source URL, or ask
// for one. Everything currently upstream or already in the playlist counts as
// known — only future additions will arrive.
async function followPlaylistFlow(id) {
  const pl = PL.getPlaylists().find(p => p.id === id);
  if (!pl) return;
  let url = pl.sourceUrl || await askText("Follow a playlist", { placeholder: "YouTube playlist URL", ok: "Follow" });
  if (!url || !url.trim()) return;
  url = url.trim();
  flash("Linking playlist…");
  try {
    const res = await invoke("yt_playlist", { url });
    const upstream = (res.tracks || []).map(t => t.id);
    const local = pl.paths
      .map(p => (isOnline(p) ? ytId(p) : (String(p).match(/\[([A-Za-z0-9_-]{11})\]/) || [])[1]))
      .filter(Boolean);
    addFollow({ url, title: res.title || pl.name, playlistId: id, autoDownload: S().autoSaveImports, knownIds: [...upstream, ...local] });
    PL.setSourceUrl(id, url);
    renderPlaylists(); openPlaylist(id);
    flash(`🔁 Following “${res.title || pl.name}” — new tracks will be added automatically`);
  } catch (e) { flash(`Cannot follow: ${e}`); }
}
async function unfollowPlaylist(id) {
  const fw = followFor(id);
  if (!fw) return;
  if (!await askConfirm(`Unfollow “${fw.title}”?`, "Already-added tracks are kept.", "Unfollow")) return;
  follows = follows.filter(f => f.id !== fw.id);
  saveFollows(); renderPlaylists(); openPlaylist(id);
  flash("Unfollowed");
}

// ─── YouTube search (Enter in the search bar) ───
let onlineResults = [];
let onlineQuery = "";
let ytPage = 0, ytHasMore = false, ytFilter = "all";
function ytFiltered() {
  const q = onlineQuery.toLowerCase();
  if (ytFilter === "title") return onlineResults.filter(t => t.title.toLowerCase().includes(q));
  if (ytFilter === "artist") return onlineResults.filter(t => t.artist.toLowerCase().includes(q));
  return onlineResults;
}
function renderOnlineResults() {
  active = { type: "online", id: onlineQuery };
  markActive();
  const shown = ytFiltered();
  // Tracks already saved locally sink to their own section at the bottom.
  const fresh = [], owned = [];
  for (const t of shown) (libraryLocalFor(ytId(t.path)) ? owned : fresh).push(t);
  setViewHead({
    icon: IC.globe, title: "YouTube",
    subtitle: `Page ${ytPage + 1} · ${shown.length} result${shown.length === 1 ? "" : "s"} for “${onlineQuery}”` +
      (ytFilter !== "all" ? ` (filter: ${ytFilter})` : "") +
      (owned.length ? ` · ${owned.length} already in your library` : ""),
    actions:
      `<select id="ytFilter" class="sel sm-sel">
        <option value="all" ${ytFilter === "all" ? "selected" : ""}>All results</option>
        <option value="title" ${ytFilter === "title" ? "selected" : ""}>Title contains</option>
        <option value="artist" ${ytFilter === "artist" ? "selected" : ""}>Artist matches</option>
      </select>` +
      `<button id="ytPrev" class="btn-line sm" ${ytPage ? "" : "disabled"}>‹ Prev</button>` +
      `<button id="ytNext" class="btn-line sm" ${ytHasMore ? "" : "disabled"}>Next ›</button>`,
  });
  $("#ytFilter")?.addEventListener("change", e => { ytFilter = e.target.value; renderOnlineResults(); });
  $("#ytPrev")?.addEventListener("click", () => searchOnline(onlineQuery, ytPage - 1));
  $("#ytNext")?.addEventListener("click", () => searchOnline(onlineQuery, ytPage + 1));
  renderTracks([...sortTracks([...fresh]), ...sortTracks([...owned])], true);
  if (owned.length) {
    const host = $("#trackList");
    const firstOwned = host.querySelector(`.track[data-idx="${fresh.length}"]`);
    if (firstOwned) firstOwned.insertAdjacentHTML("beforebegin", `<div class="list-sep">${IC.check} Already in your library</div>`);
    for (let i = fresh.length; i < view.length; i++) host.querySelector(`.track[data-idx="${i}"]`)?.classList.add("owned");
  }
}
async function searchOnline(q, page = 0) {
  if (!q) return;
  if (!IS_NATIVE) { flash("YouTube search needs the native app"); return; }
  onlineQuery = q;
  ytPage = Math.max(0, page);
  active = { type: "online", id: q };
  markActive();
  selected.clear();
  setViewHead({ icon: IC.globe, title: "YouTube", subtitle: `Searching “${q}” — page ${ytPage + 1}…` });
  $("#listHead").style.display = "none";
  $("#trackList").innerHTML = `<div class="empty"><div class="empty-ico">📡</div>Searching YouTube…</div>`;
  try {
    const limit = Number(S().searchLimit) || 20;
    const res = await invoke("yt_search", { query: q, limit, offset: ytPage * limit });
    ytHasMore = Array.isArray(res) && res.length >= limit;
    onlineResults = (res || []).map(onlineFromResult);
    onlineResults.forEach(t => onlineIndex.set(t.path, t));
    renderOnlineResults();
  } catch (e) {
    setViewHead({ icon: IC.globe, title: "YouTube", subtitle: "Search failed" });
    $("#trackList").innerHTML = `<div class="empty"><div class="empty-ico">⚠️</div>${esc(String(e))}</div>`;
  }
}

// ─── Playlist import from an external URL ───
let impTracks = [];
function openImport() {
  impTracks = [];
  $("#impQuery").value = ""; $("#impHits").innerHTML = "";
  $("#impUrl").value = ""; $("#impStatus").textContent = ""; $("#impList").innerHTML = "";
  $("#impDl").checked = S().autoSaveImports;
  $("#impFoot").hidden = true; $("#importModal").hidden = false;
  $("#impQuery").focus();
}
// Search YouTube for playlists by name/author; picking a hit fetches its tracks.
async function impSearchGo() {
  const q = $("#impQuery").value.trim();
  if (!q) return;
  if (!IS_NATIVE) { flash("Playlist search needs the native app"); return; }
  const host = $("#impHits");
  host.innerHTML = `<div class="nx-note">Searching playlists…</div>`;
  try {
    const hits = await invoke("yt_search_playlists", { query: q, limit: Number(S().searchLimit) || 20 });
    if (!hits?.length) { host.innerHTML = `<div class="nx-note">No playlists found for “${esc(q)}”.</div>`; return; }
    host.innerHTML = hits.map((h, i) =>
      `<div class="imp-hit" data-hit="${i}" title="${esc(h.url)}">
        <span class="ih-t">${esc(h.title)}</span>
        <span class="ih-a">${esc(h.author || "")}</span>
      </div>`).join("");
    host.querySelectorAll("[data-hit]").forEach(el => el.addEventListener("click", () => {
      host.querySelectorAll(".imp-hit").forEach(x => x.classList.toggle("on", x === el));
      $("#impUrl").value = hits[Number(el.dataset.hit)].url;
      impFetch();
    }));
    // Background previews: first titles of each playlist, filled in lazily.
    (async () => {
      for (let i = 0; i < hits.length; i++) {
        const el = host.querySelector(`[data-hit="${i}"]`);
        if (!el || !el.isConnected) break;
        try {
          const titles = await invoke("yt_playlist_preview", { url: hits[i].url, count: 3 });
          if (!el.isConnected) break;
          if (titles?.length) el.insertAdjacentHTML("beforeend", `<div class="ih-prev">${esc(titles.join("  ·  "))}</div>`);
        } catch { break; }
      }
    })();
  } catch (e) { host.innerHTML = `<div class="nx-note">Search failed: ${esc(String(e))}</div>`; }
}
async function impFetch() {
  const url = $("#impUrl").value.trim();
  if (!url) return;
  if (!IS_NATIVE) { flash("Playlist import needs the native app"); return; }
  $("#impStatus").textContent = "Fetching tracks…"; $("#impList").innerHTML = ""; $("#impFoot").hidden = true;
  const btn = $("#impFetch"); btn.disabled = true;
  try {
    const res = await invoke("yt_playlist", { url });
    impTracks = (res.tracks || []).map(onlineFromResult);
    if (!impTracks.length) { $("#impStatus").textContent = "No tracks found at this URL."; return; }
    // Register metadata for everything fetched: this also repairs the display
    // of already-downloaded files from this playlist (title/artist/artwork).
    impTracks.forEach(t => onlineIndex.set(t.path, t));
    saveOnline();
    if (enrichLibrary()) { saveLibrary(); refreshView(); }
    $("#impStatus").textContent = `“${res.title}” — ${impTracks.length} tracks. Untick what you don't want.`;
    $("#impList").innerHTML = impTracks.map((t, i) =>
      `<label class="imp-item"><input type="checkbox" data-imp="${i}" checked>
        <img src="${esc(t.thumbnail)}" alt="" loading="lazy">
        <span class="imp-meta"><span class="t">${esc(t.title)}</span><span class="s">${esc(t.artist)}${t.duration_secs ? " · " + fmtDur(t.duration_secs) : ""}</span></span>
      </label>`).join("");
    const pls = PL.getPlaylists();
    $("#impDest").innerHTML =
      `<option value="__new">New playlist — “${esc(res.title)}”</option>` +
      pls.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
    $("#impDest").dataset.title = res.title;
    $("#impDest").dataset.url = url;
    $("#impFollow").checked = follows.some(f => f.url === url && f.enabled !== false);
    $("#impFoot").hidden = false;
    updateImpCount();
  } catch (e) { $("#impStatus").textContent = `Import failed: ${e}`; }
  finally { btn.disabled = false; }
}
function updateImpCount() {
  const boxes = [...document.querySelectorAll("#impList [data-imp]")];
  const n = boxes.filter(c => c.checked).length;
  const followOnly = !n && $("#impFollow").checked;
  $("#impCount").textContent = `${n} of ${boxes.length} selected`;
  $("#impGo").textContent = followOnly ? "Follow only" : n ? `Import ${n} track${n === 1 ? "" : "s"}` : "Import";
  $("#impGo").disabled = !n && !followOnly;
}
async function impGo() {
  const chosen = [...document.querySelectorAll("#impList [data-imp]")].filter(c => c.checked).map(c => impTracks[Number(c.dataset.imp)]);
  const following = $("#impFollow").checked;
  if (!chosen.length && !following) { flash("No tracks selected"); return; }
  let dest = $("#impDest").value;
  if (dest === "__new") dest = PL.createPlaylist($("#impDest").dataset.title).id;
  PL.setSourceUrl(dest, $("#impDest").dataset.url); // enables follow-after-import
  for (const t of chosen) { onlineIndex.set(t.path, t); PL.addToPlaylist(dest, t.path); }
  await saveOnline();
  if (following) {
    // Everything fetched now counts as "known" — only FUTURE additions to the
    // playlist will be auto-added (respecting the tracks the user unticked).
    addFollow({
      url: $("#impDest").dataset.url, title: $("#impDest").dataset.title,
      playlistId: dest, autoDownload: $("#impDl").checked,
      knownIds: impTracks.map(t => ytId(t.path)),
    });
  }
  renderPlaylists();
  $("#importModal").hidden = true;
  const nm = PL.getPlaylists().find(p => p.id === dest)?.name || "playlist";
  flash(chosen.length
    ? `Imported ${chosen.length} track${chosen.length === 1 ? "" : "s"} into “${nm}”${following ? " · 🔁 following" : ""}`
    : `🔁 Following “${nm}” — new tracks will be added automatically`);
  openPlaylist(dest);
  if ($("#impDl").checked && chosen.length) downloadTracks(chosen.map(t => t.path)); // background batch
}

// ─── Download manager (queue + action bar, cancelable) ───
const dlQueue = []; // {path, id, title, status: queued|active|done|error|canceled, pct, tries, err}
let dlRunning = false, dlStopAll = false, dlNotice = "";
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// Only these errors are worth retrying: YouTube throttling/bot-check, the
// format-availability roulette, or network blips. EVERYTHING else (copyright
// claims, private/deleted, geo-block, age, premium…) is final — retrying just
// wastes quota and time.
const DL_TRANSIENT = [
  "not a bot", "sign in to confirm you", "429", "too many requests", "rate limit", "rate-limited",
  "http error 403", "format is not available", "no video formats",
  "unable to download", "connection", "timed out", "timeout", "temporary failure", "network", "getaddrinfo",
];
function dlTransientErr(msg) { const m = String(msg).toLowerCase(); return DL_TRANSIENT.some(s => m.includes(s)); }
const DL_ICON = { queued: IC.clock, active: IC.dl, done: IC.check, error: IC.alert, canceled: IC.slash };
// Permanently-unavailable videos (Premium-only, deleted, private, geo…):
// remembered across batches and restarts so they are never attempted again.
let dlBlock = {};
async function loadDlBlock() {
  const raw = await storeLoad("dlblock");
  if (raw) { try { dlBlock = JSON.parse(raw) || {}; } catch {} }
}
function saveDlBlock() { storeSave("dlblock", JSON.stringify(dlBlock)); }

function dlRow(d) {
  return `
    <div class="dl-row ${d.status}" title="${esc(d.err || d.title)}">
      <span class="dl-ico">${d.permanent ? IC.slash : DL_ICON[d.status]}</span>
      <span class="dl-name">${esc(d.title)}</span>
      <span class="dl-prog"><i style="width:${d.status === "done" ? 100 : (d.pct || 0)}%"></i></span>
      <span class="dl-pct">${d.status === "active" ? (d.pct || 0) + "%" : d.status}</span>
      ${d.status === "queued" || d.status === "active" ? `<button class="dl-x" data-dlx="${esc(d.path)}" title="Cancel">✕</button>` : ""}
    </div>`;
}
let dlOpen = false; // drawer is opt-in: nothing pops up on its own
function dlRender() {
  const bar = $("#dlBar"), tog = $("#dlToggle");
  if (!dlQueue.length) { bar.hidden = true; tog.hidden = true; dlOpen = false; return; }
  const n = { done: 0, error: 0, canceled: 0, queued: 0, active: 0 };
  for (const d of dlQueue) n[d.status]++;
  const busy = n.queued + n.active > 0;
  // Discreet badge at the edge — the panel only opens when the user clicks it.
  tog.hidden = false;
  tog.classList.toggle("busy", busy);
  $("#dlBadge").textContent = `${n.done}/${dlQueue.length}${busy ? "" : " ✓"}`;
  tog.title = `Downloads — ${n.done}/${dlQueue.length} saved` +
    (n.error ? ` · ${n.error} failed` : "") + (dlNotice ? ` · ${dlNotice}` : "") + " (click to open)";
  bar.hidden = !dlOpen;
  if (!dlOpen) return;
  $("#dlTitle").textContent =
    (busy ? `Downloading… ${n.done}/${dlQueue.length}` : `Downloads — ${n.done}/${dlQueue.length} saved`) +
    (n.error ? ` · ${n.error} failed` : "") + (n.canceled ? ` · ${n.canceled} canceled` : "") +
    (dlNotice ? ` · ${dlNotice}` : "");
  $("#dlAction").textContent = busy ? "Stop all" : "Clear";
  // Only rate-limit failures + canceled are retriable; final refusals
  // (copyright/private/geo…) stay out — retrying them can't succeed.
  const retriable = dlQueue.filter(d => d.status === "canceled" || (d.status === "error" && !d.permanent)).length;
  $("#dlRetry").hidden = busy || !retriable;
  if (retriable) $("#dlRetry").textContent = `Retry ${retriable}`;

  // Windowed render: active + next queued + recent finished — never 1000+ rows.
  const active = dlQueue.filter(d => d.status === "active");
  const queued = dlQueue.filter(d => d.status === "queued");
  const finished = dlQueue.filter(d => !["queued", "active"].includes(d.status));
  const parts = [
    ...active.map(dlRow),
    ...queued.slice(0, 12).map(dlRow),
    queued.length > 12 ? `<div class="dl-more">… ${queued.length - 12} more queued</div>` : "",
    ...finished.slice(-8).reverse().map(dlRow),
    finished.length > 8 ? `<div class="dl-more">… ${finished.length - 8} more finished</div>` : "",
  ];
  $("#dlList").innerHTML = parts.join("");
  $("#dlList").querySelectorAll("[data-dlx]").forEach(b => b.addEventListener("click", () => dlCancel(b.dataset.dlx)));
}
function dlProgress(id, pct) {
  const d = dlQueue.find(x => x.status === "active" && x.id === id);
  if (!d) return;
  d.pct = Math.max(0, Math.min(100, pct));
  const row = $("#dlList")?.querySelector(".dl-row.active");
  if (row) { row.querySelector(".dl-prog i").style.width = d.pct + "%"; row.querySelector(".dl-pct").textContent = d.pct + "%"; }
}
function dlCancel(path) {
  const d = dlQueue.find(x => x.path === path && (x.status === "queued" || x.status === "active"));
  if (!d) return;
  if (d.status === "queued") { d.status = "canceled"; dlRender(); }
  else invoke("yt_cancel", { id: d.id }).catch(() => {});
}
function dlStop() {
  if (dlQueue.some(d => d.status === "queued" || d.status === "active")) {
    dlStopAll = true;
    dlQueue.forEach(d => { if (d.status === "queued") d.status = "canceled"; });
    const act = dlQueue.find(d => d.status === "active");
    if (act) invoke("yt_cancel", { id: act.id }).catch(() => {});
    dlRender();
  } else { dlQueue.length = 0; dlRender(); }
}
function dlRetry() {
  for (const d of dlQueue) {
    if (d.permanent) continue; // final refusals (copyright/private/geo…) stay skipped
    if (d.status === "error" || d.status === "canceled") { d.status = "queued"; d.pct = 0; d.err = ""; d.tries = 0; }
  }
  dlRender();
  if (!dlRunning) dlPump();
}
async function downloadPlaylist(id) {
  const pl = PL.getPlaylists().find(p => p.id === id);
  if (!pl) return;
  const online = pl.paths.filter(isOnline);
  if (!online.length) { flash("All tracks of this playlist are already local"); return; }
  if (!await askConfirm(`Save “${pl.name}” locally?`, `${online.length} track${online.length === 1 ? "" : "s"} will be downloaded as mp3 (already-downloaded ones are skipped).`, "Download")) return;
  downloadTracks(online);
}
// A file for this video id already in the library (ANY source folder — the
// desktop script and the app share the "Title [id].ext" naming convention).
function libraryLocalFor(id) {
  const tag = `[${id}]`;
  const t = library.find(x => x.path.includes(tag));
  return t ? t.path : null;
}
function downloadTracks(paths) {
  if (!IS_NATIVE) { flash("Downloads need the native app"); return; }
  let added = 0, linked = 0, blocked = 0;
  for (const p of paths) {
    if (!isOnline(p)) continue;
    if (dlQueue.some(d => d.path === p && (d.status === "queued" || d.status === "active"))) continue;
    const local = libraryLocalFor(ytId(p));
    if (local) { PL.replacePath(p, local); linked++; continue; } // no download needed
    if (dlBlock[ytId(p)]) { blocked++; continue; } // known-unavailable: never retried
    const t = onlineIndex.get(p);
    dlQueue.push({ path: p, id: ytId(p), title: t?.title || p, status: "queued", pct: 0 });
    added++;
  }
  if (linked) { saveOnline(); renderPlaylists(); refreshView(); }
  const skipNote = blocked ? ` · ${blocked} unavailable skipped` : "";
  if (!added) { flash((linked ? `${linked} track${linked === 1 ? "" : "s"} already local` : blocked ? "Nothing to download" : "Already in the download queue") + skipNote); return; }
  if (linked || blocked) flash(`Downloading ${added}${linked ? ` · ${linked} already local` : ""}${skipNote}`);
  dlRender();
  if (!dlRunning) dlPump();
}
async function dlPump() {
  dlRunning = true;
  dlStopAll = false;

  // Health check before churning through the queue: if yt-dlp itself is
  // broken/missing, fail the whole batch at once with the real reason.
  try { await ytConfigPush(); }
  catch (e) {
    for (const d of dlQueue) if (d.status === "queued") { d.status = "error"; d.err = String(e); }
    dlRunning = false; dlRender();
    flash(`Downloads unavailable: ${e}`);
    return;
  }

  let dir = "", ok = 0, cooldownIdx = 0, consecTransient = 0;
  dlNotice = "";
  for (;;) {
    const d = dlQueue.find(x => x.status === "queued");
    if (!d || dlStopAll) break;
    // The library may have grown mid-batch (rescans): link instead of downloading.
    const local = libraryLocalFor(d.id);
    if (local) {
      d.status = "done"; d.pct = 100;
      PL.replacePath(d.path, local);
      dlRender();
      continue;
    }
    d.status = "active"; d.pct = 0; dlRender();
    try {
      const file = await invoke("yt_download", { id: d.id, dir: S().downloadDir || "" });
      d.status = "done"; d.pct = 100; ok++; cooldownIdx = 0; consecTransient = 0;
      dir = file.slice(0, file.lastIndexOf("/"));
      PL.replacePath(d.path, file); // playlists now point at the local file
    } catch (e) {
      const msg = String(e);
      if (msg.includes("canceled") || dlStopAll) { d.status = "canceled"; }
      else if (dlTransientErr(msg)) {
        // Rate-limit-style refusal or network blip: never abandon the track —
        // requeue it at the BACK so one stubborn video doesn't block the
        // batch, and retry it later.
        d.tries = (d.tries || 0) + 1;
        consecTransient++;
        console.warn("[download transient]", d.id, `try ${d.tries}`, msg);
        if (d.tries >= 4) { d.status = "error"; d.err = `${msg} (after ${d.tries} tries)`; }
        else {
          d.status = "queued"; d.err = msg;
          const at = dlQueue.indexOf(d);
          if (at >= 0) { dlQueue.splice(at, 1); dlQueue.push(d); }
        }
      } else {
        // Final refusal (copyright claim, private/deleted, geo/age/premium…):
        // mark it, remember it forever, move on — no retry, no cooldown.
        d.status = "error"; d.permanent = true; d.err = msg;
        dlBlock[d.id] = msg; saveDlBlock();
        console.error("[download final]", d.id, msg);
      }
    }
    dlRender();
    if (dlStopAll) break;

    if (consecTransient >= 3) {
      // Three different tracks refused in a row = real rate limit. Pause
      // (progressively longer, capped at 20 min, repeated as needed) — after
      // any success the ladder resets to short waits.
      const COOLDOWNS = [120, 300, 600, 1200];
      const wait = COOLDOWNS[Math.min(cooldownIdx, COOLDOWNS.length - 1)];
      cooldownIdx++;
      consecTransient = 0;
      for (let s = wait; s > 0 && !dlStopAll; s--) {
        dlNotice = `⏸ YouTube rate-limit — resuming in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
        dlRender();
        await sleep(1000);
      }
      dlNotice = "";
      dlRender();
    } else if (dlQueue.some(x => x.status === "queued")) {
      // Polite pacing between tracks (the script sleeps 2-5s for the same reason).
      await sleep(1200 + Math.random() * 1800);
    }
  }
  if (dir) {
    if (!folders.includes(dir)) folders.push(dir);
    await rescanFolder(dir); // picks up the new files with proper tags
  }
  await saveOnline();
  renderPlaylists(); refreshView();
  dlRunning = false;
  dlRender();
  if (ok) flash(`📥 ${ok} track${ok === 1 ? "" : "s"} saved locally`);
}

function showLibrary() {
  active = { type: "library", id: "" };
  markActive();
  selected.clear();
  const artists = new Set(library.map(t => t.artist)).size;
  setViewHead({ icon: IC.disc, title: "Your Library", subtitle: `${library.length} songs · ${artists} artist${artists === 1 ? "" : "s"} · ${folders.length} folder${folders.length === 1 ? "" : "s"}` });
  renderTracks(library);
}
function markActive() {
  $("#navLibrary").classList.toggle("active", active.type === "library");
  renderSources();
  // playlist highlight is refreshed by renderPlaylists on open; refresh to sync
  document.querySelectorAll("#playlistsList .pl-row[data-pl]").forEach(el => el.classList.toggle("active", active.type === "playlist" && active.id === el.dataset.pl));
}

// ─── Playback (gapless) ───
// `manual` = user pressed Next: skips repeat-one and still wraps on repeat-all.
function nextIndex(from, manual = false) {
  if (!queue.length) return -1;
  if (repeatMode === "one" && !manual) return from;
  if (shuffle) {
    if (queue.length === 1) return repeatMode !== "off" ? from : -1;
    let r; do { r = Math.floor(Math.random() * queue.length); } while (r === from);
    return r;
  }
  if (from + 1 <= queue.length - 1) return from + 1;
  return repeatMode !== "off" ? 0 : -1; // wrap around when repeating
}
function updateNowPlaying(t, path) {
  setPlayIcon(true);
  $("#nowTitle").textContent = t ? t.title : (path || "").split("/").pop();
  $("#nowSub").textContent = t ? `${t.artist} — ${t.album}` : "";
  const art = $("#npArt");
  if (t) {
    setArtPlaceholder(art, t);
    if (S().showArt) {
      if (t.thumbnail) setArtImg(art, t.thumbnail);
      else { const cov = coverCache.get(albumKey(t)); if (cov) setArtImg(art, cov); else fetchCover(t); }
    }
  }
  const dur = t?.duration_secs || 0;
  $("#totTime").textContent = fmtDur(dur);
  const sk = $("#seek");
  sk.max = dur > 0 ? dur : 1; sk.value = 0; sk.style.setProperty("--fill", "0%");
  $("#curTime").textContent = "0:00"; _lastTimeTxt = "0:00";
  notifyTrack(t); updateRPC(t, true); mediaUpdate(t); renderNpPanel();
}
async function playFrom(viewIdx) { queue = view.map(t => t.path); history = []; await hardPlay(viewIdx); }
// If an online track was downloaded (file named "… [<id>].mp3"), play the local
// file instead of streaming from YouTube (Settings → "Prefer local file").
function effectivePath(path) {
  if (!isOnline(path) || !S().preferLocal) return path;
  const tag = `[${ytId(path)}]`;
  const local = library.find(x => x.path.includes(tag));
  return local ? local.path : path;
}
async function startSource(cmd, path, gain) {
  // Local files use play/preload; "yt:" pseudo-paths stream via yt-dlp resolution.
  if (isOnline(path)) return invoke(cmd + "_stream", { id: ytId(path), gain });
  return invoke(cmd, { path, gain });
}
let playSeq = 0; // guards against overlapping hardPlay calls (fast double-clicks)
async function hardPlay(i) {
  if (i < 0 || i >= queue.length) return;
  const seq = ++playSeq;
  curIndex = i;
  const path = effectivePath(queue[i]);
  const t = trackByPath(path) || trackByPath(queue[i]);
  updateNowPlaying(t, path); updatePlayingRow(); // show metadata instantly
  if (isOnline(path)) {
    $("#nowSub").textContent += " · loading…";
    // Streams take a moment to resolve: silence the previous track right away
    // instead of letting it play over the "loading" state.
    try { const se = await invoke("stop"); curEpoch = Number(se) || curEpoch; } catch {}
    if (seq !== playSeq) return;
  }
  let e;
  try { e = await startSource("play", path, gainFor(t)); }
  catch (err) {
    if (seq !== playSeq) return; // a newer selection took over meanwhile
    flash(`Stream failed: ${err}`);
    // Stop the previous sink too — otherwise the old track keeps playing
    // while the UI already shows the new one as stopped.
    try { const se = await invoke("stop"); curEpoch = Number(se) || curEpoch; } catch {}
    playing = false; setPlayIcon(false); updatePlayingRow(); mediaPlayback();
    return;
  }
  if (seq !== playSeq) return; // superseded by a newer click
  curEpoch = Number(e) || 0;
  playing = true; wallStart(0); updatePlayingRow();
  if (t) $("#nowSub").textContent = `${t.artist} — ${t.album}`;
  mediaPlayback();
  await schedulePreload();
}
async function schedulePreload() {
  const j = S().preloadNext ? nextIndex(curIndex) : -1;
  queueSettled = false;
  if (j >= 0 && j !== curIndex) {
    preIndex = j; expectedQueued = 2;
    const path = effectivePath(queue[j]);
    const t = trackByPath(path) || trackByPath(queue[j]);
    try { await startSource("preload", path, gainFor(t)); }
    catch (e) {
      // Preload failed (e.g. stream resolve error): expect only the current
      // track in the sink, so end-of-track recovery can kick in instead of
      // waiting forever for a second entry that will never arrive.
      console.warn("[preload]", e);
      preIndex = -1; expectedQueued = 1;
    }
  }
  else { preIndex = -1; expectedQueued = 1; }
}
async function togglePlay() {
  if (curIndex < 0 && view.length) return playFrom(0);
  if (playing) { await invoke("pause"); playing = false; wallPause(); setPlayIcon(false); }
  else { await invoke("resume"); playing = true; wallResume(); setPlayIcon(true); }
  updateRPC(trackByPath(queue[curIndex]), playing); updatePlayingRow(); mediaPlayback();
}
async function next() { const j = nextIndex(curIndex, true); if (j < 0) { playing = false; setPlayIcon(false); updatePlayingRow(); mediaPlayback(); return; } history.push(curIndex); await hardPlay(j); }
async function prev() {
  if (wallPos() > 3) { await invoke("seek", { secs: 0 }); wallSeek(0); return; }
  if (history.length) await hardPlay(history.pop());
  else if (curIndex > 0) await hardPlay(curIndex - 1);
  else { await invoke("seek", { secs: 0 }); wallSeek(0); }
}
// Smooth 60fps progress bar (fill % + time), gated so it costs nothing when
// paused, hidden or unfocused.
let _lastTimeTxt = "";
function startProgressLoop() {
  const loop = () => {
    if (playing && !seeking && curIndex >= 0 && !document.hidden) {
      const el = $("#seek");
      const p = wallPos();
      el.value = p;
      const max = Number(el.max) || 1;
      el.style.setProperty("--fill", `${Math.min(100, (p / max) * 100).toFixed(2)}%`);
      const txt = fmtDur(p);
      if (txt !== _lastTimeTxt) { _lastTimeTxt = txt; $("#curTime").textContent = txt; }
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

let _posTick = 0;
function startPolling() {
  setInterval(async () => {
    // Paused or idle: nothing can change on its own — poll nothing (CPU).
    if (curIndex < 0 || !playing) return;
    if (++_posTick % 4 === 0) mediaPlayback(); // ~1.2s: keep the desktop widget's position fresh
    const st = await invoke("status"); if (!st) return;
    if ((st.epoch || 0) !== curEpoch) return; // stale: previous sink still up while a play/stream starts
    // Re-anchor the wall clock on the engine's real position when they drift
    // (stream connect latency etc.) — kills progress-bar jumps.
    if (queueSettled && st.position > 0.5 && Math.abs(st.position - wallPos()) > 1.5) wallSeek(st.position);
    const queued = st.queued || 0;
    if (!queueSettled) {
      if (queued >= expectedQueued) queueSettled = true;
      else if (queued > 0) return; // still filling up
      // queued === 0 while never settled: the preload silently failed and the
      // current track already ended — fall through to end-of-track recovery.
    }
    if (queueSettled && queued < expectedQueued && queued >= 1 && preIndex >= 0) {
      history.push(curIndex); curIndex = preIndex;
      const t = trackByPath(effectivePath(queue[curIndex])) || trackByPath(queue[curIndex]);
      wallStart(0); updateNowPlaying(t, queue[curIndex]); updatePlayingRow(); mediaPlayback();
      await schedulePreload();
    } else if (queued === 0 && playing) {
      // Sink drained: end of queue — or the preload failed (e.g. stream error).
      // If there is a next track, recover by hard-starting it instead of dying.
      const j = nextIndex(curIndex);
      if (j >= 0) { history.push(curIndex); await hardPlay(j); }
      else { playing = false; setPlayIcon(false); updatePlayingRow(); mediaPlayback(); }
    }
  }, 300);
}

// ─── Interface arrangement: hide/collapse sections, dock the up-next panel ───
function applyUiPrefs() {
  const s = S();
  $("#secSources").hidden = !s.uiSources;
  $("#pickBtn").hidden = !s.uiSrcButtons;
  $("#manualBtn").hidden = !s.uiSrcButtons;
  $("#secPlaylists").hidden = !s.uiPlaylists;
  $("#importBtn").hidden = !s.uiImportBtn;
  $("#sortSel").hidden = !s.uiSortSel;
  $("#secSources").classList.toggle("collapsed", !!s.collSources);
  $("#secPlaylists").classList.toggle("collapsed", !!s.collPlaylists);
  document.body.classList.toggle("np-docked", !!s.npDocked);
  $("#npPin").classList.toggle("active", !!s.npDocked);
}

// ─── Now Playing panel: big artwork + track info + up-next queue ───
let npOpen = false;
function toggleNpPanel(force) {
  npOpen = force !== undefined ? force : !npOpen;
  if (npOpen && dlOpen) { dlOpen = false; dlRender(); }
  $("#npPanel").hidden = !npOpen;
  document.body.classList.toggle("np-open", npOpen);
  SETTINGS.setSetting("uiNpOpen", npOpen);
  if (npOpen) renderNpPanel();
}
function renderNpPanel() {
  if (!npOpen) return;
  const path = curIndex >= 0 ? queue[curIndex] : null;
  const eff = path ? effectivePath(path) : null;
  const t = path ? (trackByPath(eff) || trackByPath(path)) : null;
  const art = $("#ovArt");
  if (t) {
    setArtPlaceholder(art, t);
    if (S().showArt) {
      if (t.thumbnail) setArtImg(art, t.thumbnail);
      else { const cov = coverCache.get(albumKey(t)); if (cov) setArtImg(art, cov); else fetchCover(t); }
    }
    $("#ovTitle").textContent = t.title;
    $("#ovSub").textContent = t.artist;
    $("#ovMeta").textContent = `${t.album}${t.duration_secs ? ` · ${fmtDur(t.duration_secs)}` : ""} · ${isOnline(eff) ? "streaming" : "local file"}`;
  } else {
    art.classList.remove("has-cover"); art.style.backgroundImage = ""; art.style.background = "var(--bg-3)"; art.textContent = "🎶";
    $("#ovTitle").textContent = "Nothing playing"; $("#ovSub").textContent = ""; $("#ovMeta").textContent = "";
  }
  // Up next
  const items = [];
  if (curIndex >= 0 && queue.length) {
    if (repeatMode === "one") items.push({ note: "🔂 Repeat one — this track loops" });
    else if (shuffle) {
      if (preIndex >= 0 && preIndex !== curIndex) items.push({ qi: preIndex });
      items.push({ note: "🔀 Shuffle — order is random" });
    } else {
      for (let i = curIndex + 1, n = 0; i < queue.length && n < 25; i++, n++) items.push({ qi: i });
      if (repeatMode === "all") { for (let i = 0, n = items.length; i < curIndex && n < 25; i++, n++) items.push({ qi: i }); }
      if (!items.length) items.push({ note: "End of queue" });
    }
  }
  const host = $("#upNextList");
  host.innerHTML = items.length
    ? items.map(it => {
        if (it.note) return `<div class="nx-note">${it.note}</div>`;
        const p = queue[it.qi];
        const tr = trackByPath(effectivePath(p)) || trackByPath(p);
        if (!tr) return "";
        return `<div class="nx-row" data-qi="${it.qi}" title="${esc(tr.title)}">${artCell(tr)}
          <span class="nx-meta"><span class="t">${esc(tr.title)}</span><span class="s">${esc(tr.artist)}</span></span>
          <span class="nx-dur">${fmtDur(tr.duration_secs)}</span></div>`;
      }).join("")
    : `<div class="nx-note">Queue is empty — play something.</div>`;
  host.querySelectorAll("[data-qi]").forEach(el => el.addEventListener("click", () => { history.push(curIndex); hardPlay(Number(el.dataset.qi)); }));
}

// ─── Desktop media integration (MPRIS) ───
// Pushes track + playback state to the OS so KDE/GNOME widgets, playerctl and
// media keys see the player; their commands come back as "media" events.
async function mediaUpdate(t) {
  if (!IS_NATIVE || !t) return;
  try {
    await invoke("media_update", {
      title: t.title || "", artist: t.artist || "", album: t.album || "",
      art: t.thumbnail || "", durationSecs: t.duration_secs || 0,
    });
  } catch (e) { console.error("[mpris meta]", e); }
}
async function mediaPlayback() {
  if (!IS_NATIVE || curIndex < 0) return;
  try { await invoke("media_playback", { playing, positionSecs: wallPos() }); }
  catch (e) { console.error("[mpris state]", e); }
}
function listenDlEvents() {
  if (!IS_NATIVE || !T.event?.listen) return;
  T.event.listen("dl", ({ payload }) => {
    try { const { id, pct } = typeof payload === "string" ? JSON.parse(payload) : payload; dlProgress(id, Number(pct) || 0); }
    catch {}
  }).catch(e => console.error("[dl listen]", e));
}

function listenMediaEvents() {
  if (!IS_NATIVE || !T.event?.listen) return;
  T.event.listen("media", async ({ payload }) => {
    const msg = String(payload || "");
    if (msg === "toggle") return togglePlay();
    if (msg === "play") { if (!playing) togglePlay(); return; }
    if (msg === "pause") { if (playing) togglePlay(); return; }
    if (msg === "next") return next();
    if (msg === "previous") return prev();
    if (msg.startsWith("position:")) {
      const s = Math.max(0, Number(msg.slice(9)) || 0);
      await invoke("seek", { secs: s }); wallSeek(s);
      $("#seek").value = s; $("#curTime").textContent = fmtDur(s); mediaPlayback();
      return;
    }
    if (msg.startsWith("seekby:")) {
      const d = Number(msg.slice(7)) || 0;
      const s = Math.max(0, wallPos() + d);
      await invoke("seek", { secs: s }); wallSeek(s);
      $("#seek").value = s; $("#curTime").textContent = fmtDur(s); mediaPlayback();
    }
  }).catch(e => console.error("[mpris listen]", e));
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
  try {
    await invoke("rpc_update", {
      clientId: S().rpcClientId, title: t?.title || "", artist: t?.artist || "", playing: !!isPlaying,
      art: t?.thumbnail || "", durationSecs: t?.duration_secs || 0, positionSecs: wallPos(),
    });
  } catch (e) { console.error("[rpc]", e); }
}
async function clearRPC() { if (IS_NATIVE) { try { await invoke("rpc_clear"); } catch {} } }

// ─── Library (persisted) ───
async function saveLibrary() { enrichLibrary(); await storeSave("library", JSON.stringify({ folders, tracks: library })); }
async function loadLibrary() {
  const raw = await storeLoad("library");
  if (raw) { try { const d = JSON.parse(raw); folders = Array.isArray(d.folders) ? d.folders : []; library = Array.isArray(d.tracks) ? d.tracks : []; } catch {} }
}
async function addSource(path) {
  if (!path) return;
  flash(`Scanning ${baseName(path)}…`);
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
  flash("Refreshing library…");
  let total = 0;
  for (const f of [...folders]) total += await diffFolder(f);
  await saveLibrary(); renderSources();
  if (active.type === "source") openSource(active.id); else showLibrary();
  flash(total ? `${total} new song${total === 1 ? "" : "s"} found` : "Library up to date");
}
async function pickFolder() {
  if (!IS_NATIVE) { const p = await askText("Add a folder", { placeholder: "Folder path" }); if (p) await addSource(p); return; }
  const btn = $("#pickBtn"); btn.disabled = true;
  try {
    const path = await T.core.invoke("plugin:dialog|open", { options: { directory: true, multiple: false, title: "Choose a music folder" } });
    if (path) await addSource(path);
  } catch (e) { console.error("[dialog]", e); const p = await askText("Add a folder", { placeholder: "Folder path" }); if (p) await addSource(p); }
  finally { btn.disabled = false; }
}
async function addManual() { const p = await askText("Add a folder", { placeholder: "/path/to/music" }); if (p) addSource(p); }

// ─── Settings ───
function applyAccent() {
  const [a, b] = SETTINGS.ACCENTS[S().accent] || SETTINGS.ACCENTS.violet;
  document.documentElement.style.setProperty("--accent", a);
  document.documentElement.style.setProperty("--accent-2", b);
}
let _bgCachePath = "", _bgCacheData = "";
function hexRgb(h) { h = String(h || "#000").replace("#", ""); return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) || 0); }
function mixHex(hex, rgb, p) { const a = hexRgb(hex); return "#" + a.map((x, i) => Math.round(x + (rgb[i] - x) * p).toString(16).padStart(2, "0")).join(""); }
// "Custom" theme: three user colors, all shades derived.
function customTheme(s) {
  const W = [255, 255, 255];
  const panelRgb = hexRgb(s.customPanel);
  return {
    "--bg-0": s.customBg, "--bg-1": s.customPanel,
    "--bg-2": mixHex(s.customPanel, W, 0.05), "--bg-3": mixHex(s.customPanel, W, 0.10), "--bg-4": mixHex(s.customPanel, W, 0.17),
    "--tx-1": s.customText, "--tx-2": mixHex(s.customText, panelRgb, 0.38), "--tx-3": mixHex(s.customText, panelRgb, 0.62),
  };
}
async function applyTheme() {
  const s = S();
  const root = document.documentElement.style;
  const theme = s.theme === "custom" ? customTheme(s) : (SETTINGS.THEMES[s.theme] || SETTINGS.THEMES.dark);
  for (const [k, v] of Object.entries(theme)) root.setProperty(k, v);
  root.setProperty("--r", `${s.radius ?? 12}px`);
  document.body.style.zoom = String((s.uiScale ?? 100) / 100);
  applyAccent();
  root.setProperty("--app-bg-blur", `${s.bgBlur ?? 18}px`);
  root.setProperty("--app-bg-dim", String(s.bgDim ?? 45));
  root.setProperty("--panel-alpha", String(s.panelAlpha ?? 85));
  let src = (s.bgImage || "").trim();
  if (src && !/^(https?:|data:)/.test(src)) {
    // Local file path → data URL via the backend (cached per path).
    if (_bgCachePath !== src) {
      try { _bgCacheData = await invoke("read_image", { path: src }); _bgCachePath = src; }
      catch (e) { console.error("[bg]", e); _bgCacheData = ""; _bgCachePath = src; flash("Background image could not be loaded"); }
    }
    src = _bgCacheData;
  }
  root.setProperty("--app-bg-image", src ? `url("${src}")` : "none");
  document.body.classList.toggle("has-bg", !!src);
  // Text/panel scheme on top of the wallpaper: auto-detect its brightness
  // (data-URL images are sampled; http images fall back to dark) or forced.
  let light = false;
  if (src) {
    if (s.bgTextMode === "light") light = false;
    else if (s.bgTextMode === "dark") light = true; // dark TEXT => light scheme
    else light = (await probeLuma(src)) > 0.55;
  }
  document.body.classList.toggle("bg-light", !!src && light);
}
const _lumaCache = new Map();
function probeLuma(src) {
  if (_lumaCache.has(src)) return Promise.resolve(_lumaCache.get(src));
  return new Promise(res => {
    const done = v => { _lumaCache.set(src, v); res(v); };
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement("canvas");
        c.width = c.height = 12;
        const g = c.getContext("2d");
        g.drawImage(img, 0, 0, 12, 12);
        const d = g.getImageData(0, 0, 12, 12).data;
        let l = 0;
        for (let i = 0; i < d.length; i += 4) l += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        done(l / (d.length / 4) / 255);
      } catch { done(0.2); } // cross-origin: assume dark
    };
    img.onerror = () => done(0.2);
    img.src = src;
  });
}
function applySettings() {
  applyTheme();
  applyUiPrefs();
  document.body.classList.toggle("compact", S().compactRows);
  document.body.classList.toggle("no-anim", !S().animations);
  normalize = S().normalizeDefault;
  invoke("set_agc", { on: normalize }).catch(() => {});
  shuffle = S().shuffleDefault; $("#shuffleBtn").classList.toggle("active", shuffle);
  repeatMode = ["off", "all", "one"].includes(S().repeatDefault) ? S().repeatDefault : "off";
  updateRepeatBtn();
  const v = S().defaultVolume; $("#volume").value = v; $("#volume").style.setProperty("--fill", `${v}%`); invoke("set_volume", { level: v / 100 });
}
function openSettings() {
  const s = S();
  $("#settingsBody").innerHTML = `
    <div class="set-group"><div class="set-title">Theme</div>
      <div class="set-row"><label>Theme</label>
        <select id="setTheme" class="sel sm-sel wide">${Object.keys(SETTINGS.THEMES).map(k => `<option value="${k}" ${s.theme === k ? "selected" : ""}>${k[0].toUpperCase() + k.slice(1)}</option>`).join("")}<option value="custom" ${s.theme === "custom" ? "selected" : ""}>Custom</option></select></div>
      <div class="set-row"><label>Custom colors <span class="set-sub">(background · panels · text)</span></label>
        <span class="color-row">
          <input type="color" id="setCustBg" value="${s.customBg}" title="Window background">
          <input type="color" id="setCustPanel" value="${s.customPanel}" title="Panels">
          <input type="color" id="setCustText" value="${s.customText}" title="Text">
        </span></div>
      <div class="set-row"><label>Corner radius</label><input type="range" id="setRadius" min="0" max="22" value="${s.radius}"></div>
      <div class="set-row"><label>UI scale</label><input type="range" id="setScale" min="85" max="125" value="${s.uiScale}"></div>
      <div class="set-row"><label>Accent color</label>
        <div class="swatches">${Object.entries(SETTINGS.ACCENTS).map(([k, v]) => `<button class="swatch ${s.accent === k ? "on" : ""}" data-accent="${k}" style="background:${v[0]};color:${v[0]}" title="${k}"></button>`).join("")}</div></div>
      <div class="set-row"><label>Background image</label>
        <span class="dir-pick">
          <input type="text" id="setBgImg" class="text-in" placeholder="none — URL or file" value="${esc(s.bgImage)}">
          <button id="setBgPick" class="btn-line sm" title="Pick an image">🖼️</button>
          <button id="setBgClear" class="btn-line sm" title="Remove background">✕</button>
        </span></div>
      <div class="set-row"><label>Background blur</label><input type="range" id="setBgBlur" min="0" max="40" value="${s.bgBlur}"></div>
      <div class="set-row"><label>Background darkness</label><input type="range" id="setBgDim" min="0" max="90" value="${s.bgDim}"></div>
      <div class="set-row"><label>Text on wallpaper</label>
        <select id="setBgText" class="sel sm-sel wide">
          <option value="auto" ${s.bgTextMode === "auto" ? "selected" : ""}>Auto (detect)</option>
          <option value="light" ${s.bgTextMode === "light" ? "selected" : ""}>Light text</option>
          <option value="dark" ${s.bgTextMode === "dark" ? "selected" : ""}>Dark text</option>
        </select></div>
      <div class="set-row"><label>Panel opacity</label><input type="range" id="setPanelA" min="35" max="100" value="${s.panelAlpha}"></div>
      <div class="set-hint">Blur / darkness / opacity apply live when a background image is set — mix them with any theme + accent.</div>
      <div class="set-row"><label>Show album art</label><input type="checkbox" id="setArt" ${s.showArt ? "checked" : ""}></div>
      <div class="set-row"><label>Compact rows</label><input type="checkbox" id="setCompact" ${s.compactRows ? "checked" : ""}></div>
      <div class="set-row"><label>Animations</label><input type="checkbox" id="setAnim" ${s.animations ? "checked" : ""}></div>
    </div>
    <div class="set-group"><div class="set-title">Interface</div>
      <div class="set-row"><label>Sources section</label><input type="checkbox" id="setUiSources" ${s.uiSources ? "checked" : ""}></div>
      <div class="set-row"><label>“Add folder” buttons</label><input type="checkbox" id="setUiSrcBtns" ${s.uiSrcButtons ? "checked" : ""}></div>
      <div class="set-row"><label>Playlists section</label><input type="checkbox" id="setUiPlaylists" ${s.uiPlaylists ? "checked" : ""}></div>
      <div class="set-row"><label>“YouTube playlists” button</label><input type="checkbox" id="setUiImport" ${s.uiImportBtn ? "checked" : ""}></div>
      <div class="set-row"><label>Sort selector</label><input type="checkbox" id="setUiSort" ${s.uiSortSel ? "checked" : ""}></div>
      <div class="set-row"><label>Dock the “Now playing / Up next” panel</label><input type="checkbox" id="setUiDock" ${s.npDocked ? "checked" : ""}></div>
      <div class="set-hint">Tip: the sidebar section titles (Sources / Playlists) collapse on click, and the 📌 in the “Now playing” panel docks it as a side column.</div>
    </div>
    <div class="set-group"><div class="set-title">Playback</div>
      <div class="set-row"><label>Default volume</label><input type="range" id="setVol" min="0" max="100" value="${s.defaultVolume}"></div>
      <div class="set-row"><label>Keep all tracks at the same volume</label><input type="checkbox" id="setNorm" ${s.normalizeDefault ? "checked" : ""}></div>
      <div class="set-hint">Automatic gain control evens out quiet/loud tracks (works for streams and YouTube mp3s without tags). Applies from the next track.</div>
      <div class="set-row"><label>Shuffle by default</label><input type="checkbox" id="setShuf" ${s.shuffleDefault ? "checked" : ""}></div>
      <div class="set-row"><label>Preload next track (gapless)</label><input type="checkbox" id="setPreload" ${s.preloadNext ? "checked" : ""}></div>
    </div>
    <div class="set-group"><div class="set-title">YouTube</div>
      <div class="set-row"><label>yt-dlp binary</label>
        <span class="dir-pick">
          <input type="text" id="setYtPath" class="text-in" placeholder="auto-detect" value="${esc(s.ytdlpPath)}">
          <button id="setYtPick" class="btn-line sm" title="Pick the binary">🗂️</button>
          <button id="setYtTest" class="btn-line sm" title="Test">Test</button>
        </span></div>
      <div class="set-hint" id="setYtStatus">Empty = auto-detect (PATH, Desktop folders, external drives, linuxbrew).</div>
      <div class="set-row"><label>Cookies from browser</label>
        <select id="setCookies" class="sel sm-sel wide">${["", "firefox", "chrome", "chromium", "brave", "edge", "opera", "vivaldi"].map(b => `<option value="${b}" ${s.cookiesBrowser === b ? "selected" : ""}>${b || "None"}</option>`).join("")}</select></div>
      <div class="set-hint">⚠ A logged-in YouTube session often gets blocked (“format not available”) — keep <b>None</b> unless needed. Failed calls retry without cookies automatically.</div>
      <div class="set-row"><label>Search results</label>
        <select id="setLimit" class="sel sm-sel">${[10, 20, 30, 50, 75, 100].map(n => `<option value="${n}" ${Number(s.searchLimit) === n ? "selected" : ""}>${n}</option>`).join("")}</select></div>
      <div class="set-row"><label>Prefer local file when downloaded</label><input type="checkbox" id="setPrefLocal" ${s.preferLocal ? "checked" : ""}></div>
      <div class="set-hint">When a track has been saved locally (file named “… [id].mp3”), play the local file instead of streaming from YouTube.</div>
      <div class="set-row"><label>Unavailable tracks remembered</label><button id="setDlBlock" class="btn-line sm">Forget ${Object.keys(dlBlock).length}</button></div>
      <div class="set-hint">Premium-only / deleted / private videos are never re-attempted. “Forget” lets them be tried once again.</div>
      <div class="set-row"><label>First-run setup</label><button id="setRerun" class="btn-line sm">Run again…</button></div>
    </div>
    <div class="set-group"><div class="set-title">Downloads</div>
      <div class="set-row"><label>Download folder</label>
        <span class="dir-pick">
          <input type="text" id="setDlDir" class="text-in" placeholder="~/Music/MusicPlayer" value="${esc(s.downloadDir)}">
          <button id="setDlPick" class="btn-line sm" title="Choose a folder (any disk)">📂</button>
        </span></div>
      <div class="set-row"><label>Tick “Save locally” by default when importing</label><input type="checkbox" id="setAutoSave" ${s.autoSaveImports ? "checked" : ""}></div>
      <div class="set-hint">Where “📥 Download locally” saves mp3 files (via yt-dlp). Pick any folder on any disk with the folder picker. Empty = <b>~/Music/MusicPlayer</b>. The folder is added as a source automatically after a download.</div>
    </div>
    <div class="set-group"><div class="set-title">Notifications</div>
      <div class="set-row"><label>Desktop notification on track change</label><input type="checkbox" id="setNotify" ${s.notifyOnChange ? "checked" : ""}></div>
      <div class="set-hint">Tip: your desktop's media widget already shows the track (MPRIS) — turn this off if you see two popups.</div>
    </div>
    <div class="set-group"><div class="set-title">Discord Rich Presence</div>
      <div class="set-row"><label>Show what I'm listening to</label><input type="checkbox" id="setRpc" ${s.rpcEnabled ? "checked" : ""}></div>
      <div class="set-row"><label>Discord Application ID</label><input type="text" id="setRpcId" class="text-in" placeholder="Discord app client id" value="${esc(s.rpcClientId)}"></div>
      <div class="set-hint">Create an app at <b>discord.com/developers</b> → copy its <b>Application ID</b>. Requires the Discord desktop app running.</div>
    </div>
    <div class="set-group"><div class="set-title">Followed playlists</div>
      <div class="set-row"><label>Check for new tracks</label>
        <select id="setFollowIv" class="sel sm-sel wide">
          <option value="launch" ${s.followInterval === "launch" ? "selected" : ""}>On launch only</option>
          <option value="1h" ${s.followInterval === "1h" ? "selected" : ""}>Every hour</option>
          <option value="6h" ${s.followInterval === "6h" ? "selected" : ""}>Every 6 hours</option>
          <option value="24h" ${s.followInterval === "24h" ? "selected" : ""}>Every day</option>
        </select></div>
      <div id="setFollowList"></div>
      <div class="set-row"><label></label><button id="setFollowCheck" class="btn-line sm">🔁 Check all now</button></div>
      <div class="set-hint">Follow a playlist from <b>🔗 Import from URL…</b> (tick “🔁 Follow”). New upstream tracks land in the linked playlist; with ⬇ they are also downloaded to the library. Checks also run on launch.</div>
    </div>
    <div class="set-group"><div class="set-title">Updates</div>
      <div class="set-row"><label>When a new version is available</label>
        <select id="setUpdMode" class="sel sm-sel wide">
          <option value="ask" ${s.updateMode === "ask" ? "selected" : ""}>Propose it</option>
          <option value="auto" ${s.updateMode === "auto" ? "selected" : ""}>Build automatically</option>
          <option value="off" ${s.updateMode === "off" ? "selected" : ""}>Don't check</option>
        </select></div>
      <div class="set-row"><label>Version <b id="setCurVer">…</b></label><button id="setUpdCheck" class="btn-line sm">Check now</button></div>
      <div class="set-hint">The app is built from the local source tree (mirrored on the private GitHub repo). “Update” rebuilds it; you then restart the app.</div>
    </div>
    <div class="set-actions"><button id="setReset" class="btn-line">↺ Reset to defaults</button></div>`;
  const body = $("#settingsBody");
  body.querySelectorAll("[data-accent]").forEach(b => b.addEventListener("click", () => { SETTINGS.setSetting("accent", b.dataset.accent); applyAccent(); body.querySelectorAll(".swatch").forEach(x => x.classList.toggle("on", x === b)); }));
  $("#setTheme").addEventListener("change", e => { SETTINGS.setSetting("theme", e.target.value); applyTheme(); });
  for (const [id, key] of [["setCustBg", "customBg"], ["setCustPanel", "customPanel"], ["setCustText", "customText"]]) {
    $("#" + id).addEventListener("input", e => {
      SETTINGS.setSetting(key, e.target.value);
      if (S().theme !== "custom") { SETTINGS.setSetting("theme", "custom"); $("#setTheme").value = "custom"; }
      applyTheme();
    });
  }
  $("#setRadius").addEventListener("input", e => { SETTINGS.setSetting("radius", Number(e.target.value)); applyTheme(); });
  $("#setScale").addEventListener("input", e => { SETTINGS.setSetting("uiScale", Number(e.target.value)); applyTheme(); });
  $("#setBgImg").addEventListener("change", e => { SETTINGS.setSetting("bgImage", e.target.value.trim()); applyTheme(); });
  $("#setBgPick").addEventListener("click", async () => {
    try {
      const p = await T.core.invoke("plugin:dialog|open", { options: { directory: false, multiple: false, title: "Choose a background image", filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "webp", "gif", "bmp", "avif"] }] } });
      if (p) { SETTINGS.setSetting("bgImage", p); $("#setBgImg").value = p; applyTheme(); }
    } catch (e) { console.error("[bg pick]", e); }
  });
  $("#setBgClear").addEventListener("click", () => { SETTINGS.setSetting("bgImage", ""); $("#setBgImg").value = ""; applyTheme(); });
  $("#setBgBlur").addEventListener("input", e => { SETTINGS.setSetting("bgBlur", Number(e.target.value)); applyTheme(); });
  $("#setBgDim").addEventListener("input", e => { SETTINGS.setSetting("bgDim", Number(e.target.value)); applyTheme(); });
  $("#setPanelA").addEventListener("input", e => { SETTINGS.setSetting("panelAlpha", Number(e.target.value)); applyTheme(); });
  $("#setBgText").addEventListener("change", e => { SETTINGS.setSetting("bgTextMode", e.target.value); applyTheme(); });
  for (const [id, key] of [["setUiSources", "uiSources"], ["setUiSrcBtns", "uiSrcButtons"], ["setUiPlaylists", "uiPlaylists"], ["setUiImport", "uiImportBtn"], ["setUiSort", "uiSortSel"], ["setUiDock", "npDocked"]]) {
    $("#" + id).addEventListener("change", e => { SETTINGS.setSetting(key, e.target.checked); applyUiPrefs(); });
  }
  $("#setArt").addEventListener("change", e => { SETTINGS.setSetting("showArt", e.target.checked); refreshView(); });
  $("#setCompact").addEventListener("change", e => { SETTINGS.setSetting("compactRows", e.target.checked); document.body.classList.toggle("compact", e.target.checked); });
  $("#setAnim").addEventListener("change", e => { SETTINGS.setSetting("animations", e.target.checked); document.body.classList.toggle("no-anim", !e.target.checked); });
  $("#setVol").addEventListener("change", e => { SETTINGS.setSetting("defaultVolume", Number(e.target.value)); $("#volume").value = e.target.value; invoke("set_volume", { level: Number(e.target.value) / 100 }); });
  $("#setNorm").addEventListener("change", e => { SETTINGS.setSetting("normalizeDefault", e.target.checked); normalize = e.target.checked; invoke("set_agc", { on: normalize }).catch(() => {}); });
  $("#setShuf").addEventListener("change", e => { SETTINGS.setSetting("shuffleDefault", e.target.checked); shuffle = e.target.checked; $("#shuffleBtn").classList.toggle("active", shuffle); if (curIndex >= 0) schedulePreload(); });
  $("#setNotify").addEventListener("change", e => SETTINGS.setSetting("notifyOnChange", e.target.checked));
  $("#setPreload").addEventListener("change", e => { SETTINGS.setSetting("preloadNext", e.target.checked); if (curIndex >= 0) schedulePreload(); });
  const ytStatus = (msg, ok) => { const el = $("#setYtStatus"); el.textContent = msg; el.style.color = ok ? "#34d399" : (ok === false ? "#f59e0b" : ""); };
  const ytTest = async () => {
    ytStatus("Testing…");
    try { ytStatus(`✔ ${await ytConfigPush()}`, true); }
    catch (e) { ytStatus(`✘ ${e}`, false); }
  };
  $("#setYtPath").addEventListener("change", e => { SETTINGS.setSetting("ytdlpPath", e.target.value.trim()); ytTest(); });
  $("#setYtTest").addEventListener("click", ytTest);
  $("#setYtPick").addEventListener("click", async () => {
    try {
      const p = await T.core.invoke("plugin:dialog|open", { options: { directory: false, multiple: false, title: "Pick the yt-dlp binary" } });
      if (p) { SETTINGS.setSetting("ytdlpPath", p); $("#setYtPath").value = p; ytTest(); }
    } catch (e) { console.error("[yt pick]", e); }
  });
  $("#setCookies").addEventListener("change", async e => {
    const prev = S().cookiesBrowser;
    const v = e.target.value;
    if (!v) { SETTINGS.setSetting("cookiesBrowser", ""); ytConfigPush().catch(() => {}); return; }
    const chosen = await askCookieConsent(v);
    if (chosen) { SETTINGS.setSetting("cookiesBrowser", chosen); ytConfigPush().catch(() => {}); flash(`Cookies: ${chosen}`); }
    else { e.target.value = prev.split(":")[0] || ""; }
  });
  $("#setDlBlock").addEventListener("click", () => { dlBlock = {}; saveDlBlock(); $("#setDlBlock").textContent = "Forget 0"; flash("Unavailable-track list cleared"); });
  $("#setRerun").addEventListener("click", () => { $("#settingsModal").hidden = true; openSetup(); });
  $("#setLimit").addEventListener("change", e => SETTINGS.setSetting("searchLimit", Number(e.target.value)));
  $("#setPrefLocal").addEventListener("change", e => SETTINGS.setSetting("preferLocal", e.target.checked));
  $("#setAutoSave").addEventListener("change", e => SETTINGS.setSetting("autoSaveImports", e.target.checked));
  $("#setDlDir").addEventListener("change", e => SETTINGS.setSetting("downloadDir", e.target.value.trim()));
  $("#setDlPick").addEventListener("click", async () => {
    if (!IS_NATIVE) { flash("Folder picker needs the native app"); return; }
    try {
      const path = await T.core.invoke("plugin:dialog|open", { options: { directory: true, multiple: false, title: "Choose the download folder" } });
      if (path) { SETTINGS.setSetting("downloadDir", path); $("#setDlDir").value = path; }
    } catch (e) { console.error("[dl dir]", e); }
  });
  $("#setRpc").addEventListener("change", e => { SETTINGS.setSetting("rpcEnabled", e.target.checked); if (e.target.checked) updateRPC(trackByPath(queue[curIndex]), playing); else clearRPC(); });
  $("#setRpcId").addEventListener("change", e => { SETTINGS.setSetting("rpcClientId", e.target.value.trim()); if (S().rpcEnabled) updateRPC(trackByPath(queue[curIndex]), playing); });
  $("#setFollowIv").addEventListener("change", e => SETTINGS.setSetting("followInterval", e.target.value));
  $("#setFollowCheck").addEventListener("click", () => checkFollows(true));
  renderFollowList();
  $("#setUpdMode").addEventListener("change", e => SETTINGS.setSetting("updateMode", e.target.value));
  $("#setUpdCheck").addEventListener("click", () => checkUpdate(true));
  currentVersion().then(v => { const el = $("#setCurVer"); if (el) el.textContent = v ? `v${v}` : "?"; });
  $("#setReset").addEventListener("click", () => { SETTINGS.resetSettings(); applySettings(); refreshView(); openSettings(); flash("Settings reset to defaults"); });
  $("#settingsModal").hidden = false;
}

// ─── Followed playlists: periodically re-fetch an external playlist and
// auto-add its NEW tracks to a local playlist (and optionally auto-download
// them to the library). Persisted in store "follows". ───
let follows = []; // {id, url, title, playlistId, autoDownload, enabled, knownIds[], lastChecked}
let _followsBusy = false;
const FOLLOW_IVALS = { launch: 0, "1h": 3600e3, "6h": 6 * 3600e3, "24h": 24 * 3600e3 };

async function loadFollows() {
  const raw = await storeLoad("follows");
  if (raw) { try { follows = JSON.parse(raw); } catch {} }
  if (!Array.isArray(follows)) follows = [];
}
function saveFollows() { storeSave("follows", JSON.stringify(follows)); }
function followFor(playlistId) { return follows.find(f => f.playlistId === playlistId && f.enabled !== false); }
function addFollow({ url, title, playlistId, autoDownload, knownIds }) {
  const dup = follows.find(f => f.url === url);
  if (dup) { // re-following the same URL updates the existing follow
    Object.assign(dup, { title: title || dup.title, playlistId, autoDownload, enabled: true });
    dup.knownIds = [...new Set([...(dup.knownIds || []), ...knownIds])];
  } else {
    follows.push({ id: crypto.randomUUID(), url, title: title || "Playlist", playlistId, autoDownload: !!autoDownload, enabled: true, knownIds, lastChecked: Date.now() });
  }
  saveFollows();
}

async function checkFollow(f, manual = false) {
  let res;
  try { res = await invoke("yt_playlist", { url: f.url }); }
  catch (e) { console.warn("[follow]", f.title, e); if (manual) flash(`“${f.title}”: check failed — ${e}`); return 0; }
  f.lastChecked = Date.now();
  if (res.title) f.title = res.title;
  const tracks = (res.tracks || []).map(onlineFromResult);
  const known = new Set(f.knownIds || []);
  const fresh = tracks.filter(t => !known.has(ytId(t.path)));
  // Union: a track removed upstream then re-added must not come back as "new".
  f.knownIds = [...new Set([...(f.knownIds || []), ...tracks.map(t => ytId(t.path))])];
  if (!fresh.length) { if (manual) flash(`“${f.title}” — no new tracks`); return 0; }
  fresh.forEach(t => onlineIndex.set(t.path, t));
  const pl = PL.getPlaylists().find(p => p.id === f.playlistId);
  if (pl) fresh.forEach(t => PL.addToPlaylist(f.playlistId, t.path));
  await saveOnline();
  renderPlaylists(); refreshView();
  if (f.autoDownload) downloadTracks(fresh.map(t => t.path));
  flash(`🔁 ${fresh.length} new track${fresh.length === 1 ? "" : "s"} from “${f.title}”${pl ? ` → “${pl.name}”` : ""}${f.autoDownload ? " · downloading" : ""}`);
  return fresh.length;
}

async function checkFollows(manual = false, respectDue = false) {
  if (!IS_NATIVE || _followsBusy) return;
  _followsBusy = true;
  try {
    const ivMs = FOLLOW_IVALS[S().followInterval] ?? FOLLOW_IVALS["6h"];
    let total = 0, ran = 0;
    for (const f of [...follows]) {
      if (f.enabled === false) continue;
      if (respectDue && (ivMs === 0 || Date.now() - (f.lastChecked || 0) < ivMs)) continue;
      total += await checkFollow(f, manual);
      ran++;
      await sleep(1500); // pacing between yt-dlp calls
    }
    saveFollows();
    if (manual) flash(!ran ? "No followed playlists to check" : total ? `🔁 ${total} new track${total === 1 ? "" : "s"} added` : "Follows are up to date");
  } finally { _followsBusy = false; }
}

// ─── Self-update (binary vs. source-tree version; repo mirrored on GitHub) ───
let updateBusy = false, updateReady = false, availableVersion = "";
async function currentVersion() {
  try { return await T.app.getVersion(); } catch { return ""; }
}
async function checkUpdate(manual = false) {
  if (!IS_NATIVE) return;
  if (!manual && S().updateMode === "off") return;
  const [cur, src] = [await currentVersion(), await invoke("source_version").catch(() => "")];
  const btn = $("#updateBtn");
  if (src && cur && src !== cur) {
    availableVersion = src;
    if (S().updateMode === "auto" && !manual) { runUpdate(); return; }
    btn.hidden = false;
    btn.textContent = `⬆ Update to v${src}`;
    if (manual) flash(`Update available: v${cur} → v${src}`);
  } else {
    availableVersion = "";
    btn.hidden = true;
    if (manual) flash(src ? `Up to date (v${cur})` : "Source tree not found — cannot check");
  }
}
async function runUpdate() {
  if (updateBusy || !IS_NATIVE) return;
  updateBusy = true;
  const btn = $("#updateBtn");
  btn.hidden = false; btn.disabled = true; btn.textContent = "⏳ Building update…";
  try {
    await invoke("self_update");
    updateReady = true;
    btn.textContent = `✅ v${availableVersion} ready — click to restart`;
    flash(`Update v${availableVersion} built — click the button to restart`);
    notifyTrack({ title: "Music Player update ready", artist: `Click the update button to restart into v${availableVersion}`, album: "" });
  } catch (e) {
    btn.textContent = "⚠ Update failed — retry";
    btn.disabled = false; updateBusy = false;
    console.error("[update]", e);
    flash("Update failed — see console/log");
    return;
  }
  btn.disabled = false; updateBusy = false;
}

// ─── Cookies consent: explicit accept with a countdown + detected accounts ───
let _ckResolve = null, _ckTimer = null;
function closeCookieConsent(val) {
  clearInterval(_ckTimer); _ckTimer = null;
  $("#cookieModal").hidden = true;
  const r = _ckResolve; _ckResolve = null;
  r?.(val);
}
// Returns the chosen "browser" / "browser:Profile" or null if declined.
async function askCookieConsent(browser) {
  const host = $("#ckList");
  host.innerHTML = `<div class="nx-note">Looking for installed browsers…</div>`;
  $("#cookieModal").hidden = false;
  const ok = $("#ckOk");
  ok.disabled = true;
  let left = 5;
  ok.textContent = `Accept (${left})`;
  clearInterval(_ckTimer);
  _ckTimer = setInterval(() => {
    left--;
    if (left <= 0) { clearInterval(_ckTimer); ok.disabled = false; ok.textContent = "Accept"; }
    else ok.textContent = `Accept (${left})`;
  }, 1000);
  let infos = [];
  try { infos = await invoke("detect_browsers") || []; } catch {}
  const options = [];
  for (const b of infos) {
    if (browser && b.browser !== browser) continue;
    for (const prof of b.profiles) {
      options.push({ value: b.profiles.length > 1 || prof !== "Default" ? `${b.browser}:${prof}` : b.browser, label: `${b.browser} — ${prof} (${b.source})` });
    }
  }
  if (!options.length) options.push({ value: browser || "firefox", label: `${browser || "firefox"} — no profile found on disk (may fail)` });
  host.innerHTML = `<div class="ck-title">Detected accounts/profiles — pick which one yt-dlp will use:</div>` +
    options.map((o, i) => `<label class="ck-opt"><input type="radio" name="ckopt" value="${esc(o.value)}" ${i === 0 ? "checked" : ""}> ${esc(o.label)}</label>`).join("");
  return new Promise(res => { _ckResolve = res; });
}
function wireCookieConsent() {
  $("#ckOk").addEventListener("click", () => closeCookieConsent(document.querySelector("input[name=ckopt]:checked")?.value || null));
  $("#ckCancel").addEventListener("click", () => closeCookieConsent(null));
  $("#cookieModal").addEventListener("click", e => { if (e.target.id === "cookieModal") closeCookieConsent(null); });
}

// ─── yt-dlp configuration + first-run setup wizard ───
// Pushes the saved yt-dlp path + cookies browser to the backend; empty path =
// auto-detect (PATH, ~/Desktop/*/bin, removable drives, linuxbrew).
async function ytConfigPush() {
  if (!IS_NATIVE) return "";
  try { return await invoke("yt_config", { path: S().ytdlpPath || "", cookies: S().cookiesBrowser || "" }); }
  catch (e) { console.warn("[yt config]", e); throw e; }
}
function setupStep(n) {
  document.querySelectorAll("#setupModal .setup-step").forEach(el => el.hidden = el.dataset.step !== String(n));
  $("#setupTitle").textContent = n === 0 ? "Welcome 🎧" : "Setup";
}
async function setupDetect() {
  const st = $("#suYtStatus");
  st.className = "setup-status"; st.textContent = "Detecting yt-dlp…";
  try {
    const r = await ytConfigPush();
    st.classList.add("ok"); st.textContent = `✔ Found: ${r}`;
  } catch (e) {
    st.classList.add("bad"); st.textContent = `✘ ${e}`;
  }
}
function finishSetup() {
  SETTINGS.setSetting("setupDone", true);
  $("#setupModal").hidden = true;
  flash("Setup saved — enjoy!");
}
function openSetup() {
  $("#suCookies").value = S().cookiesBrowser || "";
  $("#suDlDir").value = S().downloadDir || "";
  $("#suPrefLocal").checked = S().preferLocal;
  $("#suAutoSave").checked = S().autoSaveImports;
  $("#suNotify").checked = S().notifyOnChange;
  setupStep(0);
  $("#setupModal").hidden = false;
}
function wireSetup() {
  $("#suDefaults").addEventListener("click", () => { finishSetup(); ytConfigPush().catch(() => {}); });
  $("#suConfigure").addEventListener("click", () => { setupStep(1); setupDetect(); });
  $("#suYtRetry").addEventListener("click", () => { SETTINGS.setSetting("ytdlpPath", ""); setupDetect(); });
  $("#suYtPick").addEventListener("click", async () => {
    try {
      const p = await T.core.invoke("plugin:dialog|open", { options: { directory: false, multiple: false, title: "Pick the yt-dlp binary" } });
      if (p) { SETTINGS.setSetting("ytdlpPath", p); setupDetect(); }
    } catch (e) { console.error("[setup pick]", e); }
  });
  document.querySelectorAll("#setupModal .su-next").forEach(b => b.addEventListener("click", async () => {
    const cur = Number(b.closest(".setup-step").dataset.step);
    if (cur === 2) {
      const v = $("#suCookies").value;
      if (v) {
        const chosen = await askCookieConsent(v);
        if (!chosen) { $("#suCookies").value = ""; SETTINGS.setSetting("cookiesBrowser", ""); setupStep(cur + 1); return; }
        SETTINGS.setSetting("cookiesBrowser", chosen);
      } else SETTINGS.setSetting("cookiesBrowser", "");
    }
    setupStep(cur + 1);
  }));
  $("#suDlPick").addEventListener("click", async () => {
    try {
      const p = await T.core.invoke("plugin:dialog|open", { options: { directory: true, multiple: false, title: "Choose the download folder" } });
      if (p) $("#suDlDir").value = p;
    } catch (e) { console.error("[setup dir]", e); }
  });
  $("#suFinish").addEventListener("click", () => {
    SETTINGS.setSetting("cookiesBrowser", $("#suCookies").value);
    SETTINGS.setSetting("downloadDir", $("#suDlDir").value.trim());
    SETTINGS.setSetting("preferLocal", $("#suPrefLocal").checked);
    SETTINGS.setSetting("autoSaveImports", $("#suAutoSave").checked);
    SETTINGS.setSetting("notifyOnChange", $("#suNotify").checked);
    finishSetup();
    ytConfigPush().catch(() => {});
  });
}

// Follow management rows inside the Settings modal.
function renderFollowList() {
  const host = $("#setFollowList");
  if (!host) return;
  if (!follows.length) { host.innerHTML = `<div class="set-hint">No followed playlists yet.</div>`; return; }
  const pls = PL.getPlaylists();
  host.innerHTML = follows.map(f => `
    <div class="fl-row" title="${esc(f.url)}">
      <label class="fl-on" title="Enabled"><input type="checkbox" data-fl-on="${f.id}" ${f.enabled !== false ? "checked" : ""}></label>
      <span class="fl-name">${esc(f.title)}</span>
      <select class="sel fl-target" data-fl-target="${f.id}" title="Add new tracks to this playlist">
        ${pls.map(p => `<option value="${p.id}" ${f.playlistId === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("")}
        ${pls.some(p => p.id === f.playlistId) ? "" : `<option value="" selected>(playlist deleted)</option>`}
      </select>
      <label class="fl-dl" title="Auto-download new tracks to the library"><input type="checkbox" data-fl-dl="${f.id}" ${f.autoDownload ? "checked" : ""}> ⬇</label>
      <button class="fl-x" data-fl-x="${f.id}" title="Unfollow">✕</button>
    </div>`).join("");
  const byId = (id) => follows.find(f => f.id === id);
  host.querySelectorAll("[data-fl-on]").forEach(el => el.addEventListener("change", e => { const f = byId(el.dataset.flOn); if (f) { f.enabled = e.target.checked; saveFollows(); renderPlaylists(); } }));
  host.querySelectorAll("[data-fl-target]").forEach(el => el.addEventListener("change", e => { const f = byId(el.dataset.flTarget); if (f && e.target.value) { f.playlistId = e.target.value; saveFollows(); renderPlaylists(); } }));
  host.querySelectorAll("[data-fl-dl]").forEach(el => el.addEventListener("change", e => { const f = byId(el.dataset.flDl); if (f) { f.autoDownload = e.target.checked; saveFollows(); } }));
  host.querySelectorAll("[data-fl-x]").forEach(el => el.addEventListener("click", async () => {
    if (!await askConfirm("Unfollow this playlist?", "Already-added tracks are kept.", "Unfollow")) return;
    follows = follows.filter(f => f.id !== el.dataset.flX);
    saveFollows(); renderFollowList(); renderPlaylists();
  }));
}

// ─── Wire up ───
async function init() {
  hydrateIcons();
  await Promise.all([PL.initPlaylists(), SETTINGS.loadSettings(), loadOnline(), loadFollows(), loadDlBlock()]);
  await loadLibrary();
  if (enrichLibrary()) saveLibrary();

  if (!IS_NATIVE) {
    const banner = document.createElement("div");
    banner.className = "mock-banner";
    banner.textContent = "Browser preview (mock data, no audio). Run the app for real playback.";
    $(".main").prepend(banner);
    if (!library.length) { library = MOCK_TRACKS; folders = ["/demo"]; }
  }

  wireTrackList();
  $("#pickBtn").addEventListener("click", pickFolder);
  $("#manualBtn").addEventListener("click", addManual);
  $("#rescanBtn").addEventListener("click", rescanAll);
  $("#navLibrary").addEventListener("click", showLibrary);

  $("#playBtn").addEventListener("click", togglePlay);
  $("#nextBtn").addEventListener("click", next);
  $("#prevBtn").addEventListener("click", prev);
  $("#shuffleBtn").addEventListener("click", () => { shuffle = !shuffle; $("#shuffleBtn").classList.toggle("active", shuffle); if (curIndex >= 0) schedulePreload(); flash(shuffle ? "Shuffle on" : "Shuffle off"); });
  $("#repeatBtn").addEventListener("click", () => {
    repeatMode = repeatMode === "off" ? "all" : repeatMode === "all" ? "one" : "off";
    SETTINGS.setSetting("repeatDefault", repeatMode);
    updateRepeatBtn();
    if (curIndex >= 0) schedulePreload();
    flash(repeatMode === "off" ? "Repeat off" : repeatMode === "all" ? "Repeat all" : "Repeat one");
  });
  let _volT = null;
  $("#volume").addEventListener("input", e => {
    invoke("set_volume", { level: Number(e.target.value) / 100 });
    e.target.style.setProperty("--fill", `${e.target.value}%`);
    clearTimeout(_volT); _volT = setTimeout(() => SETTINGS.setSetting("defaultVolume", Number(e.target.value)), 400);
  });

  $("#seek").addEventListener("input", () => { seeking = true; $("#curTime").textContent = fmtDur(Number($("#seek").value)); });
  $("#seek").addEventListener("change", async () => { const s = Number($("#seek").value); await invoke("seek", { secs: s }); wallSeek(s); seeking = false; mediaPlayback(); updateRPC(trackByPath(effectivePath(queue[curIndex]) || "") || trackByPath(queue[curIndex]), playing); });

  $("#search").addEventListener("input", e => {
    const q = e.target.value.trim().toLowerCase();
    selected.clear();
    if (!q) { showLibrary(); return; }
    setViewHead({ icon: IC.search, title: "Search", subtitle: `“${e.target.value.trim()}” — press Enter to search YouTube` });
    renderTracks(library.filter(t => t.title.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q) || t.album.toLowerCase().includes(q)));
  });
  $("#search").addEventListener("keydown", e => { if (e.key === "Enter") searchOnline(e.target.value.trim()); });

  $("#importBtn").addEventListener("click", openImport);
  $("#importClose").addEventListener("click", () => $("#importModal").hidden = true);
  $("#importModal").addEventListener("click", e => { if (e.target.id === "importModal") $("#importModal").hidden = true; });
  $("#impFetch").addEventListener("click", impFetch);
  $("#impUrl").addEventListener("keydown", e => { if (e.key === "Enter") impFetch(); });
  $("#impSearch").addEventListener("click", impSearchGo);
  $("#impQuery").addEventListener("keydown", e => { if (e.key === "Enter") impSearchGo(); });

  $("#sideFilter").addEventListener("input", e => {
    const q = e.target.value.trim().toLowerCase();
    document.querySelectorAll("#sourcesList .src-row, #playlistsList .pl-row[data-pl]").forEach(el => {
      el.hidden = !!q && !el.textContent.toLowerCase().includes(q);
    });
  });
  $("#impAll").addEventListener("click", () => { document.querySelectorAll("#impList [data-imp]").forEach(c => c.checked = true); updateImpCount(); });
  $("#impNone").addEventListener("click", () => { document.querySelectorAll("#impList [data-imp]").forEach(c => c.checked = false); updateImpCount(); });
  $("#impList").addEventListener("change", updateImpCount);
  $("#impFollow").addEventListener("change", updateImpCount);
  $("#impGo").addEventListener("click", impGo);
  $("#dlAction").addEventListener("click", dlStop);
  $("#dlRetry").addEventListener("click", dlRetry);
  $("#dlToggle").addEventListener("click", () => { dlOpen = !dlOpen; if (dlOpen && npOpen) toggleNpPanel(false); dlRender(); });
  $("#dlClose").addEventListener("click", () => { dlOpen = false; dlRender(); });

  sortMode = S().sortMode || "default";
  $("#sortSel").value = sortMode;
  $("#sortSel").addEventListener("change", e => { sortMode = e.target.value; SETTINGS.setSetting("sortMode", sortMode); refreshView(); });

  document.querySelector(".now").addEventListener("click", () => toggleNpPanel());
  $("#npClose").addEventListener("click", () => toggleNpPanel(false));
  $("#npPin").addEventListener("click", () => { SETTINGS.setSetting("npDocked", !S().npDocked); applyUiPrefs(); });
  document.querySelectorAll(".ss-toggle").forEach(el => el.addEventListener("click", () => {
    const key = el.dataset.coll;
    SETTINGS.setSetting(key, !S()[key]);
    applyUiPrefs();
  }));
  wireDialogs();
  wireCookieConsent();

  $("#settingsBtn").addEventListener("click", openSettings);
  $("#settingsClose").addEventListener("click", () => $("#settingsModal").hidden = true);
  $("#settingsModal").addEventListener("click", e => { if (e.target.id === "settingsModal") $("#settingsModal").hidden = true; });

  window.addEventListener("blur", () => document.body.classList.add("win-blur"));
  window.addEventListener("focus", () => document.body.classList.remove("win-blur"));

  // Never show the WebView's native right-click menu (Reload etc.) — custom
  // menus only; text fields keep their native copy/paste menu.
  document.addEventListener("contextmenu", e => { if (!e.target.closest("input, textarea")) e.preventDefault(); });

  document.addEventListener("click", e => { if (!e.target.closest("#ctxMenu") && e.target.dataset.more === undefined) closeCtx(); });
  document.addEventListener("scroll", closeCtx, true);
  document.addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    if (_dlgResolve) { dlgClose(_dlgHasInput ? null : false); return; }
    closeCtx(); $("#settingsModal").hidden = true; $("#importModal").hidden = true;
    if (dlOpen) { dlOpen = false; dlRender(); }
    if (npOpen) toggleNpPanel(false);
  });

  renderPlaylists();
  applySettings();
  listenMediaEvents();
  listenDlEvents();
  startPolling();
  startProgressLoop();
  showLibrary();

  $("#updateBtn").addEventListener("click", () => {
    if (updateReady) { invoke("restart_app").catch(e => { console.error("[restart]", e); flash("Restart failed — relaunch manually"); }); return; }
    if (!updateBusy && availableVersion) runUpdate();
  });

  wireSetup();
  if (IS_NATIVE && !S().setupDone) openSetup();
  else ytConfigPush().catch(() => {}); // warm up detection with saved prefs
  checkUpdate();

  if (S().uiNpOpen) toggleNpPanel(true); // restore the up-next panel

  // Followed playlists: one check shortly after launch (let the app settle),
  // then periodically according to the configured interval.
  setTimeout(() => checkFollows(), 20000);
  setInterval(() => checkFollows(false, true), 15 * 60 * 1000);
}

init().catch(e => console.error("[init] failed:", e));
