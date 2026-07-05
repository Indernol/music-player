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
- Tauri v2 system deps: `webkit2gtk4.1-devel`, `alsa-lib-devel` (audio), `gtk3`,
  `librsvg2-devel`, `libappindicator-gtk3-devel`, a C toolchain — see
  <https://tauri.app/start/prerequisites/>.

### On immutable/atomic distros (Bazzite, Silverblue, Kinoite…)

`dnf` is disabled on the host by design. **Do all dev inside a Distrobox container**
(mutable, rootless, no host password, shares your `$HOME` and display):

```bash
distrobox create --name mp-dev --image registry.fedoraproject.org/fedora:41 --yes
distrobox enter mp-dev -- sudo dnf install -y \
  webkit2gtk4.1-devel openssl-devel curl wget file librsvg2-devel \
  libappindicator-gtk3-devel alsa-lib-devel gcc gcc-c++ nodejs
distrobox enter mp-dev -- sudo dnf group install -y "c-development"
```

Rust lives in `~/.cargo` (shared home), so it's available inside the container too.

## Build & run

```bash
npm install          # installs @tauri-apps/cli (host is fine)

# Inside the dev container:
distrobox enter mp-dev -- bash -lc 'source ~/.cargo/env; \
  cd ~/Desktop/"for claude"/music-player/src-tauri && cargo build'

# Launch the native window (embeds the static frontend — no dev server needed):
distrobox enter mp-dev -- \
  "$HOME/Desktop/for claude/music-player/src-tauri/target/debug/music-player"
```

For hot-reload development instead of a one-off binary:
`distrobox enter mp-dev -- bash -lc 'source ~/.cargo/env; cd ~/Desktop/"for claude"/music-player && npm run dev'`.

> ✅ **Verified**: builds clean inside a Fedora 41 distrobox (rodio 0.19 / lofty 0.21 /
> tauri 2.11), `cargo build` → exit 0, all runtime libraries resolve.

## Roadmap (opt-in, in order)

1. ~~Native folder picker (`tauri-plugin-dialog`)~~ ✅ done.
2. ~~Playlist persistence to app-data JSON~~ ✅ done (`playlists.json` in the app data
   dir, written atomically by the Rust backend; localStorage only as browser fallback).
3. ~~Gapless playback + ReplayGain loudness~~ ✅ done (engine pre-queues the next
   track into the same sink; per-track `amplify()` from ReplayGain tags; 20 ms
   anti-click fade-in). True crossfade is out — it needs a mixing layer rodio's
   sequential `Sink` doesn't provide.
4. Google OAuth2 read-only metadata sync (`docs/oauth-sync.md`) — needs a
   user-provided Google Cloud Client ID.
5. Optional official YouTube IFrame provider (separate, opt-in — see COMPLIANCE).

## Versioning / GitHub

Standard private-repo workflow for a desktop app (releases + CI) — **not** MoonBot's
VPS `tar → integrity → pm2` pipeline, which is bot-server-specific. The repo is
initialized locally; create the private remote with:

```bash
gh repo create music-player --private --source=. --remote=origin --push
```
