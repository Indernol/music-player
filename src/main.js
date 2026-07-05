// Frontend controller: renders the library/playlists and drives the native Rust
// core through Tauri IPC. Falls back to a small mock when opened in a plain browser
// (no window.__TAURI__), so the UI stays explorable without the toolchain.

import * as PL from "./playlists.js";

const T = window.__TAURI__;
const IS_NATIVE = !!(T && T.core && typeof T.core.invoke === "function");

// ─── IPC layer (native) or mock (browser preview) ───
const MOCK_TRACKS = [
  { path: "/demo/a.flac", title: "Aurora", artist: "Kioku", album: "Night Drive", duration_secs: 214 },
  { path: "/demo/b.mp3",  title: "Low Tide", artist: "Kioku", album: "Night Drive", duration_secs: 187 },
  { path: "/demo/c.opus", title: "Paper Planes", artist: "Halcyon", album: "Kites", duration_secs: 243 },
];

async function invoke(cmd, args) {
  if (IS_NATIVE) return T.core.invoke(cmd, args);
  // Browser mock — no audio, just UI feedback.
  if (cmd === "scan") return MOCK_TRACKS;
  console.info(`[mock] ${cmd}`, args || "");
  return null;
}

// ─── State ───
let library = [];
let view = [];        // filtered library currently shown
let queue = [];       // paths in play order
let current = -1;     // index into queue
let playing = false;

const $ = (s) => document.querySelector(s);

// ─── Rendering ───
function fmtDur(s) {
  if (!s) return "—";
  const m = Math.floor(s / 60), sec = String(s % 60).padStart(2, "0");
  return `${m}:${sec}`;
}

function renderTracks(list) {
  view = list;
  const host = $("#trackList");
  $("#count").textContent = `${list.length} track${list.length === 1 ? "" : "s"}`;
  if (!list.length) {
    host.innerHTML = `<div class="empty">No tracks. Add a music folder in the sidebar.</div>`;
    return;
  }
  host.innerHTML = list.map((t, i) => {
    const isNow = queue[current] === t.path;
    return `<div class="track ${isNow ? "playing" : ""}" data-path="${escAttr(t.path)}" data-idx="${i}">
      <span class="idx">${isNow && playing ? "♪" : i + 1}</span>
      <div class="meta">
        <div class="t">${esc(t.title)}</div>
        <div class="s">${esc(t.artist)} — ${esc(t.album)}</div>
      </div>
      <span class="dur">${fmtDur(t.duration_secs)}</span>
      <button class="add" title="Add to playlist" data-add="${escAttr(t.path)}">＋</button>
    </div>`;
  }).join("");

  host.querySelectorAll(".track").forEach(el => {
    el.addEventListener("click", (e) => {
      if (e.target.dataset.add !== undefined) return;
      playFrom(Number(el.dataset.idx));
    });
  });
  host.querySelectorAll("[data-add]").forEach(btn => {
    btn.addEventListener("click", (e) => { e.stopPropagation(); addToPlaylistPrompt(btn.dataset.add); });
  });
}

function renderPlaylists() {
  const host = $("#playlistsList");
  const pls = PL.getPlaylists();
  host.innerHTML =
    `<div class="pl-row" id="plNew">➕ New playlist</div>` +
    pls.map(p => `<div class="pl-row" data-pl="${p.id}">🎧 ${esc(p.name)} <span style="color:var(--tx-3);font-size:11px">${p.paths.length}</span>
      <button class="pl-del" data-del="${p.id}" title="Delete">✕</button></div>`).join("");

  host.querySelector("#plNew").addEventListener("click", () => {
    const name = prompt("Playlist name:");
    if (name !== null) { PL.createPlaylist(name); renderPlaylists(); }
  });
  host.querySelectorAll("[data-pl]").forEach(el => {
    el.addEventListener("click", (e) => {
      if (e.target.dataset.del !== undefined) return;
      openPlaylist(el.dataset.pl);
    });
  });
  host.querySelectorAll("[data-del]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (confirm("Delete this playlist?")) { PL.deletePlaylist(btn.dataset.del); renderPlaylists(); }
    });
  });
}

function openPlaylist(id) {
  const pl = PL.getPlaylists().find(p => p.id === id);
  if (!pl) return;
  const byPath = new Map(library.map(t => [t.path, t]));
  const tracks = pl.paths.map(p => byPath.get(p)).filter(Boolean);
  setActiveNav("playlists");
  renderTracks(tracks);
}

function addToPlaylistPrompt(path) {
  const pls = PL.getPlaylists();
  if (!pls.length) { alert("Create a playlist first (sidebar → New playlist)."); return; }
  const names = pls.map((p, i) => `${i + 1}. ${p.name}`).join("\n");
  const pick = prompt(`Add to which playlist?\n${names}`);
  const idx = Number(pick) - 1;
  if (pls[idx]) { PL.addToPlaylist(pls[idx].id, path); renderPlaylists(); }
}

// ─── Playback ───
async function playFrom(viewIdx) {
  queue = view.map(t => t.path);
  current = viewIdx;
  await playCurrent();
}

async function playCurrent() {
  const path = queue[current];
  if (!path) return;
  const t = library.find(x => x.path === path) || view.find(x => x.path === path);
  await invoke("play", { path });
  playing = true;
  $("#playBtn").textContent = "⏸";
  $("#nowTitle").textContent = t ? t.title : path.split("/").pop();
  $("#nowSub").textContent = t ? `${t.artist} — ${t.album}` : "";
  renderTracks(view);
}

async function togglePlay() {
  if (current < 0 && view.length) return playFrom(0);
  if (playing) { await invoke("pause"); playing = false; $("#playBtn").textContent = "▶"; }
  else { await invoke("resume"); playing = true; $("#playBtn").textContent = "⏸"; }
  renderTracks(view);
}

async function next() { if (current < queue.length - 1) { current++; await playCurrent(); } }
async function prev() { if (current > 0) { current--; await playCurrent(); } }

// ─── Library scan ───
async function scanPath(path, { merge = false } = {}) {
  if (!path) return;
  const tracks = await invoke("scan", { paths: [path] });
  const found = Array.isArray(tracks) ? tracks : [];
  if (merge) {
    const seen = new Set(library.map(t => t.path));
    library = library.concat(found.filter(t => !seen.has(t.path)));
  } else {
    library = found;
  }
  setActiveNav("library");
  renderTracks(library);
}

// Native folder picker (tauri-plugin-dialog, called directly via core.invoke so
// no bundler/plugin-JS is needed). Falls back to the manual input in a browser.
async function pickFolder() {
  if (!IS_NATIVE) { document.querySelector(".manual")?.setAttribute("open", ""); $("#folderInput")?.focus(); return; }
  const btn = $("#pickBtn");
  btn.disabled = true;
  try {
    const path = await T.core.invoke("plugin:dialog|open", {
      options: { directory: true, multiple: false, title: "Choose a music folder" },
    });
    if (path) await scanPath(path, { merge: true });
  } catch (e) {
    console.error("[dialog] open failed:", e);
    document.querySelector(".manual")?.setAttribute("open", ""); // reveal manual fallback
  } finally {
    btn.disabled = false;
  }
}

async function scanFromInput() {
  const path = $("#folderInput").value.trim();
  if (!path) return;
  $("#scanBtn").disabled = true;
  $("#scanBtn").textContent = "…";
  try { await scanPath(path, { merge: true }); }
  finally { $("#scanBtn").disabled = false; $("#scanBtn").textContent = "Scan"; }
}

function setActiveNav(v) {
  document.querySelectorAll(".nav-item").forEach(b => b.classList.toggle("active", b.dataset.view === v));
}

// ─── helpers ───
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function escAttr(s) { return esc(s); }

// ─── Wire up ───
function init() {
  if (!IS_NATIVE) {
    const banner = document.createElement("div");
    banner.className = "mock-banner";
    banner.textContent = "Browser preview (mock data, no audio). Run `npm run dev` for the native app.";
    $(".main").prepend(banner);
  }

  $("#pickBtn").addEventListener("click", pickFolder);
  $("#scanBtn").addEventListener("click", scanFromInput);
  $("#folderInput").addEventListener("keydown", e => { if (e.key === "Enter") scanFromInput(); });
  $("#playBtn").addEventListener("click", togglePlay);
  $("#nextBtn").addEventListener("click", next);
  $("#prevBtn").addEventListener("click", prev);
  $("#volume").addEventListener("input", e => invoke("set_volume", { level: Number(e.target.value) / 100 }));

  $("#search").addEventListener("input", e => {
    const q = e.target.value.trim().toLowerCase();
    renderTracks(!q ? library : library.filter(t =>
      t.title.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q) || t.album.toLowerCase().includes(q)));
  });

  document.querySelectorAll(".nav-item").forEach(b => b.addEventListener("click", () => {
    setActiveNav(b.dataset.view);
    if (b.dataset.view === "library") renderTracks(library);
  }));

  renderPlaylists();
  if (!IS_NATIVE) { library = MOCK_TRACKS; renderTracks(library); }
}

init();
