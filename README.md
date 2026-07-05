# 🎵 Music Player

A **native, local-first** desktop music player (Tauri + Rust audio engine).
Independent project — lives next to `moonbot-src/` but shares nothing with it.

## What it does

- Plays your **local audio files** (mp3, flac, wav, ogg/opus, m4a, aac) through a
  real native audio engine (Rust `rodio` → system audio device), not a WebView `<audio>`.
- Manages **playlists** (create / edit / reorder / import / export).
- Optionally **syncs YouTube Music library metadata** (playlists, likes) read-only via
  Google OAuth2 — as organizational reference only. See `docs/oauth-sync.md`.

## What it deliberately does NOT do

This project **does not download or extract audio/video streams from YouTube**
(no yt-dlp, no lavalink `youtube-source`). That path violates YouTube's Terms of
Service and isn't "compliant" no matter how it's framed. The compliance boundary
is documented in [`docs/COMPLIANCE.md`](docs/COMPLIANCE.md) — read it before adding
any "download from YouTube" feature.

Playback of YouTube tracks, if ever wanted, is only possible through the **official
embedded YouTube player** (shows the video + ads) — that would be a separate, opt-in
provider, never the local audio engine.

## Architecture

```
music-player/
├── src/                    Frontend (static, no bundler — uses window.__TAURI__)
│   ├── index.html          Layout: library · playlists · player bar
│   ├── main.js             IPC to the Rust core + UI wiring (browser-mock fallback)
│   ├── playlists.js        Playlist CRUD (localStorage in this scaffold)
│   └── style.css
├── src-tauri/              Native core (Rust)
│   ├── src/
│   │   ├── main.rs         Tauri app + command handlers
│   │   ├── audio.rs        Audio engine: dedicated thread + mpsc + rodio Sink
│   │   └── library.rs      Filesystem scan + tag reading (lofty)
│   ├── Cargo.toml
│   ├── build.rs
│   └── tauri.conf.json
└── docs/
    ├── COMPLIANCE.md       The hard boundary (no stream extraction) + why
    └── oauth-sync.md       Google OAuth2 read-only metadata sync design
```

Module boundaries (each folder = one responsibility):
- **audio** — decode + output only. No knowledge of the library or UI.
- **library** — filesystem + tags only. Returns plain `Track` structs.
- **frontend** — rendering + user intent. Talks to the core via `invoke(...)`.
- **sync** (docs, not yet wired) — read-only metadata bridge, isolated from playback.

## Prerequisites

- **Rust** (stable) + Cargo — <https://rustup.rs>
- **Node.js** ≥ 18 (only for the Tauri CLI)
- Tauri v2 system deps — see <https://tauri.app/start/prerequisites/>
  (Linux: `libwebkit2gtk-4.1-dev`, `libasound2-dev` for audio, `build-essential`, etc.)

## Run

```bash
npm install          # installs @tauri-apps/cli only
npm run dev          # tauri dev — launches the native window
npm run build        # tauri build — produces a native binary/installer
```

> ⚠️ **Reviewed scaffold, not yet compiled in this environment.** The architecture and
> logic are the deliverable; `cargo build` may need minor dependency-version nits
> aligned (noted inline in `library.rs`). Run `npm run dev` and I'll fix any that surface.

## Roadmap (opt-in, in order)

1. Native folder picker (`tauri-plugin-dialog`) — scaffold uses a path input for now.
2. Playlist persistence to app-data JSON (scaffold uses localStorage).
3. Gapless playback + crossfade + ReplayGain (rodio queue / `symphonia`).
4. Google OAuth2 read-only metadata sync (`docs/oauth-sync.md`).
5. Optional official YouTube IFrame provider (separate, opt-in — see COMPLIANCE).

## Versioning / GitHub

Standard private-repo workflow for a desktop app (releases + CI) — **not** MoonBot's
VPS `tar → integrity → pm2` pipeline, which is bot-server-specific. The repo is
initialized locally; create the private remote with:

```bash
gh repo create music-player --private --source=. --remote=origin --push
```
