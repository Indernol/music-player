// Frontend controller: renders the library/playlists and drives the native Rust
// core through Tauri IPC. Gapless playback: the engine pre-queues the next track
// into the same sink; the frontend watches the sink's queue length to know when a
// boundary was crossed. The progress bar runs off a wall clock (not the engine's
// per-source position, whose reset semantics across the gapless boundary are
// ambiguous) so it stays correct through transitions.
// Falls back to a mock when opened in a plain browser (no window.__TAURI__).

import * as PL from "./playlists.js";

const T = window.__TAURI__;
const IS_NATIVE = !!(T && T.core && typeof T.core.invoke === "function");

// ─── IPC layer (native) or mock (browser preview) ───
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
let view = [];                // filtered library currently shown
let queue = [];               // paths in play order
let curIndex = -1;            // index into queue of the playing track
let preIndex = -1;            // index of the pre-queued (gapless) next track
let expectedQueued = 0;       // how many sources the sink should hold right now
let queueSettled = false;     // sink has caught up with our last Play/Preload
let playing = false;
let shuffle = false;
let normalize = true;
let history = [];             // played indices, for Prev
let seeking = false;          // user dragging the seek bar
const selected = new Set();   // selected track paths (multi-select)

const $ = (s) => document.querySelector(s);

// ─── Wall clock (drives the progress bar independently of the engine) ───
const clock = { origin: 0, pausedAt: null };
function wallStart(atSec = 0) { clock.origin = performance.now() - atSec * 1000; clock.pausedAt = null; }
function wallPause() { if (clock.pausedAt === null) clock.pausedAt = performance.now(); }
function wallResume() { if (clock.pausedAt !== null) { clock.origin += performance.now() - clock.pausedAt; clock.pausedAt = null; } }
function wallSeek(sec) { clock.origin = performance.now() - sec * 1000; if (clock.pausedAt !== null) clock.pausedAt = performance.now(); }
function wallPos() { const now = clock.pausedAt !== null ? clock.pausedAt : performance.now(); return Math.max(0, (now - clock.origin) / 1000); }

// ─── helpers ───
function esc(s) { return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
function escAttr(s) { return esc(s); }
function fmtDur(s) { s = Math.max(0, Math.floor(s || 0)); const m = Math.floor(s / 60), x = String(s % 60).padStart(2, "0"); return `${m}:${x}`; }
function trackByPath(p) { return library.find(t => t.path === p) || view.find(t => t.path === p) || null; }
function gainFor(t) { if (!normalize) return 1.0; const g = t && Number(t.gain); return Number.isFinite(g) && g > 0 ? g : 1.0; }

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
  const nowPath = curIndex >= 0 ? queue[curIndex] : null;
  host.innerHTML = list.map((t, i) => {
    const isNow = nowPath === t.path;
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
      if (e.target.classList.contains("sel-cb")) return;
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

// ─── Playback (gapless) ───
function nextIndex(from) {
  if (!queue.length) return -1;
  if (shuffle) {
    if (queue.length === 1) return -1;
    let r; do { r = Math.floor(Math.random() * queue.length); } while (r === from);
    return r;
  }
  return from + 1 <= queue.length - 1 ? from + 1 : -1;
}

function updateNowPlaying(t, path) {
  $("#playBtn").textContent = "⏸";
  $("#nowTitle").textContent = t ? t.title : (path || "").split("/").pop();
  $("#nowSub").textContent = t ? `${t.artist} — ${t.album}` : "";
  const dur = t?.duration_secs || 0;
  $("#totTime").textContent = fmtDur(dur);
  $("#seek").max = dur > 0 ? dur : 1;
  $("#seek").value = 0;
  $("#curTime").textContent = "0:00";
}

async function playFrom(viewIdx) {
  queue = view.map(t => t.path);
  history = [];
  await hardPlay(viewIdx);
}

// Hard start: fresh sink (drops any pre-queued track), then pre-queue the next.
async function hardPlay(i) {
  if (i < 0 || i >= queue.length) return;
  curIndex = i;
  const t = trackByPath(queue[i]);
  await invoke("play", { path: queue[i], gain: gainFor(t) });
  playing = true;
  wallStart(0);
  updateNowPlaying(t, queue[i]);
  renderTracks(view);
  await schedulePreload();
}

// Pre-queue the next track into the same sink for a gapless transition.
async function schedulePreload() {
  const j = nextIndex(curIndex);
  if (j >= 0 && j !== curIndex) {
    const t = trackByPath(queue[j]);
    await invoke("preload", { path: queue[j], gain: gainFor(t) });
    preIndex = j;
    expectedQueued = 2;
  } else {
    preIndex = -1;
    expectedQueued = 1;
  }
  queueSettled = false;
}

async function togglePlay() {
  if (curIndex < 0 && view.length) return playFrom(0);
  if (playing) { await invoke("pause"); playing = false; wallPause(); $("#playBtn").textContent = "▶"; }
  else { await invoke("resume"); playing = true; wallResume(); $("#playBtn").textContent = "⏸"; }
  renderTracks(view);
}

async function next() {
  const j = nextIndex(curIndex);
  if (j < 0) { playing = false; $("#playBtn").textContent = "▶"; return; }
  history.push(curIndex);
  await hardPlay(j);
}

async function prev() {
  if (wallPos() > 3) { await invoke("seek", { secs: 0 }); wallSeek(0); return; }
  if (history.length) { await hardPlay(history.pop()); }
  else if (curIndex > 0) { await hardPlay(curIndex - 1); }
  else { await invoke("seek", { secs: 0 }); wallSeek(0); }
}

// ─── Poll: progress bar + gapless boundary / end detection ───
function startPolling() {
  setInterval(async () => {
    if (curIndex < 0) return;
    if (!seeking && playing) {
      const p = wallPos();
      $("#seek").value = p;
      $("#curTime").textContent = fmtDur(p);
    }
    const st = await invoke("status");
    if (!st) return;
    const queued = st.queued || 0;

    // Wait until the sink reflects our last Play/Preload before trusting deltas.
    if (!queueSettled) { if (queued >= expectedQueued) queueSettled = true; return; }

    if (queued < expectedQueued && queued >= 1 && preIndex >= 0) {
      // Boundary crossed: the pre-queued track is now the one playing.
      history.push(curIndex);
      curIndex = preIndex;
      const t = trackByPath(queue[curIndex]);
      wallStart(0);
      updateNowPlaying(t, queue[curIndex]);
      renderTracks(view);
      await schedulePreload();
    } else if (queued === 0 && playing) {
      playing = false;
      $("#playBtn").textContent = "▶";
    }
  }, 300);
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
  await PL.initPlaylists();

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
    // Re-target the pre-queued next track to match the new mode.
    if (curIndex >= 0) schedulePreload();
    flash(shuffle ? "Shuffle on" : "Shuffle off");
  });
  $("#normChk").addEventListener("change", e => {
    normalize = e.target.checked;
    flash(normalize ? "Loudness normalize on (next tracks)" : "Loudness normalize off");
  });
  $("#volume").addEventListener("input", e => invoke("set_volume", { level: Number(e.target.value) / 100 }));

  $("#seek").addEventListener("input", () => { seeking = true; $("#curTime").textContent = fmtDur(Number($("#seek").value)); });
  $("#seek").addEventListener("change", async () => {
    const s = Number($("#seek").value);
    await invoke("seek", { secs: s });
    wallSeek(s);
    seeking = false;
  });

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
