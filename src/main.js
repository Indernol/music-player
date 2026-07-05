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
  if (cmd === "scan") return MOCK_TRACKS;
  if (cmd === "status") return { position: 0, finished: false };
  return null;
}

// ─── State ───
let library = [];
let view = [];               // filtered library currently shown
let queue = [];              // paths in play order
let current = -1;            // index into queue
let playing = false;
let shuffle = false;
let history = [];            // played indices, for prev during shuffle
let trackStartedAt = 0;      // ms timestamp when the current track started
let lastPos = 0;             // last polled position (s)
let seeking = false;         // user is dragging the seek bar
const selected = new Set();  // selected track paths (multi-select)

const $ = (s) => document.querySelector(s);

// ─── helpers ───
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function escAttr(s) { return esc(s); }
function fmtDur(s) { s = Math.max(0, Math.floor(s || 0)); const m = Math.floor(s / 60), x = String(s % 60).padStart(2, "0"); return `${m}:${x}`; }
function curTrack() { const p = queue[current]; return library.find(t => t.path === p) || view.find(t => t.path === p) || null; }

function flash(msg) {
  let el = $("#toast");
  if (!el) { el = document.createElement("div"); el.id = "toast"; el.className = "toast"; document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), 1800);
}

// ─── Track list ───
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
    const sel = selected.has(t.path);
    return `<div class="track ${isNow ? "playing" : ""} ${sel ? "selected" : ""}" data-path="${escAttr(t.path)}" data-idx="${i}">
      <input type="checkbox" class="sel-cb" ${sel ? "checked" : ""} aria-label="Select">
      <span class="idx">${isNow && playing ? "♪" : i + 1}</span>
      <div class="meta">
        <div class="t">${esc(t.title)}</div>
        <div class="s">${esc(t.artist)} — ${esc(t.album)}</div>
      </div>
      <span class="dur">${fmtDur(t.duration_secs)}</span>
    </div>`;
  }).join("");

  host.querySelectorAll(".track").forEach(el => {
    el.addEventListener("click", (e) => {
      if (e.target.classList.contains("sel-cb")) return; // checkbox handles itself
      playFrom(Number(el.dataset.idx));
    });
  });
  host.querySelectorAll(".sel-cb").forEach(cb => {
    cb.addEventListener("click", (e) => e.stopPropagation());
    cb.addEventListener("change", (e) => {
      const row = e.target.closest(".track");
      const path = row.dataset.path;
      if (e.target.checked) selected.add(path); else selected.delete(path);
      row.classList.toggle("selected", e.target.checked);
      updateSelBar();
    });
  });
}

// ─── Multi-select bar ───
function updateSelBar() {
  const bar = $("#selBar");
  const n = selected.size;
  if (!n) { bar.hidden = true; return; }
  bar.hidden = false;
  $("#selCount").textContent = `${n} selected`;
  const sel = $("#selPlaylist");
  const keep = sel.value;
  const pls = PL.getPlaylists();
  sel.innerHTML = `<option value="">Choose playlist…</option>`
    + pls.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join("")
    + `<option value="__new">➕ New playlist…</option>`;
  if (keep && [...sel.options].some(o => o.value === keep)) sel.value = keep;
}

function wireSelBar() {
  $("#selPlaylist").addEventListener("change", (e) => {
    if (e.target.value === "__new") {
      const name = prompt("New playlist name:");
      e.target.value = "";
      if (name) { const pl = PL.createPlaylist(name); renderPlaylists(); updateSelBar(); $("#selPlaylist").value = pl.id; }
    }
  });
  $("#selAdd").addEventListener("click", () => {
    const id = $("#selPlaylist").value;
    if (!id || id === "__new") { flash("Pick a playlist first"); return; }
    let added = 0;
    for (const path of selected) { PL.addToPlaylist(id, path); added++; }
    const plName = PL.getPlaylists().find(p => p.id === id)?.name || "playlist";
    selected.clear();
    renderPlaylists();
    renderTracks(view);
    updateSelBar();
    flash(`Added ${added} track${added === 1 ? "" : "s"} to “${plName}”`);
  });
  $("#selClear").addEventListener("click", () => { selected.clear(); renderTracks(view); updateSelBar(); });
}

// ─── Playlists sidebar ───
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
      if (confirm("Delete this playlist?")) { PL.deletePlaylist(btn.dataset.del); renderPlaylists(); updateSelBar(); }
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

// ─── Playback ───
async function playFrom(viewIdx) {
  queue = view.map(t => t.path);
  history = [];
  await playIndex(viewIdx);
}

async function playIndex(i) {
  if (i < 0 || i >= queue.length) return;
  current = i;
  const path = queue[current];
  const t = curTrack();
  await invoke("play", { path });
  playing = true;
  trackStartedAt = Date.now();
  lastPos = 0;
  $("#playBtn").textContent = "⏸";
  $("#nowTitle").textContent = t ? t.title : path.split("/").pop();
  $("#nowSub").textContent = t ? `${t.artist} — ${t.album}` : "";
  const dur = t?.duration_secs || 0;
  $("#totTime").textContent = fmtDur(dur);
  $("#seek").max = dur > 0 ? dur : 1;
  $("#seek").value = 0;
  $("#curTime").textContent = "0:00";
  renderTracks(view);
}

async function togglePlay() {
  if (current < 0 && view.length) return playFrom(0);
  if (playing) { await invoke("pause"); playing = false; $("#playBtn").textContent = "▶"; }
  else { await invoke("resume"); playing = true; $("#playBtn").textContent = "⏸"; }
  renderTracks(view);
}

function nextIndex() {
  if (!queue.length) return -1;
  if (shuffle) {
    if (queue.length === 1) return current;
    let r; do { r = Math.floor(Math.random() * queue.length); } while (r === current);
    return r;
  }
  return current + 1 <= queue.length - 1 ? current + 1 : -1;
}

async function next() {
  const ni = nextIndex();
  if (ni < 0) { playing = false; $("#playBtn").textContent = "▶"; return; } // end of linear queue
  history.push(current);
  await playIndex(ni);
}

async function prev() {
  if (lastPos > 3) { await invoke("seek", { secs: 0 }); lastPos = 0; return; } // restart if >3s in
  if (history.length) { await playIndex(history.pop()); }
  else if (current > 0) { await playIndex(current - 1); }
  else { await invoke("seek", { secs: 0 }); }
}

// ─── Progress polling (position + auto-advance) ───
function startPolling() {
  setInterval(async () => {
    if (current < 0) return;
    const st = await invoke("status");
    if (!st) return;
    lastPos = st.position || 0;
    if (!seeking) {
      $("#seek").value = lastPos;
      $("#curTime").textContent = fmtDur(lastPos);
    }
    // Auto-advance when the track finished (guard against the false "empty" right
    // after starting: require ≥1.5s of playback before trusting `finished`).
    if (playing && st.finished && (Date.now() - trackStartedAt) > 1500) {
      next();
    }
  }, 500);
}

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

// Native folder picker (tauri-plugin-dialog via core.invoke — no bundler needed).
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
    document.querySelector(".manual")?.setAttribute("open", "");
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

// ─── Wire up ───
async function init() {
  await PL.initPlaylists(); // load persisted playlists before the first render

  if (!IS_NATIVE) {
    const banner = document.createElement("div");
    banner.className = "mock-banner";
    banner.textContent = "Browser preview (mock data, no audio). Run the app for real playback.";
    $(".main").prepend(banner);
  }

  $("#pickBtn").addEventListener("click", pickFolder);
  $("#scanBtn").addEventListener("click", scanFromInput);
  $("#folderInput").addEventListener("keydown", e => { if (e.key === "Enter") scanFromInput(); });

  $("#playBtn").addEventListener("click", togglePlay);
  $("#nextBtn").addEventListener("click", next);
  $("#prevBtn").addEventListener("click", prev);
  $("#shuffleBtn").addEventListener("click", () => {
    shuffle = !shuffle;
    $("#shuffleBtn").classList.toggle("active", shuffle);
    flash(shuffle ? "Shuffle on" : "Shuffle off");
  });
  $("#volume").addEventListener("input", e => invoke("set_volume", { level: Number(e.target.value) / 100 }));

  // Seek bar: preview while dragging, commit on release.
  $("#seek").addEventListener("input", () => { seeking = true; $("#curTime").textContent = fmtDur(Number($("#seek").value)); });
  $("#seek").addEventListener("change", async () => { await invoke("seek", { secs: Number($("#seek").value) }); seeking = false; });

  $("#search").addEventListener("input", e => {
    const q = e.target.value.trim().toLowerCase();
    renderTracks(!q ? library : library.filter(t =>
      t.title.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q) || t.album.toLowerCase().includes(q)));
  });

  document.querySelectorAll(".nav-item").forEach(b => b.addEventListener("click", () => {
    setActiveNav(b.dataset.view);
    if (b.dataset.view === "library") renderTracks(library);
  }));

  wireSelBar();
  renderPlaylists();
  startPolling();
  if (!IS_NATIVE) { library = MOCK_TRACKS; renderTracks(library); }
}

init().catch(e => console.error("[init] failed:", e));
