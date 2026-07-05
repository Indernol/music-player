# Compliance boundary

This project is **local-first** by design. This file is the rule, not a preference.

## The line

> The app never extracts an audio or video **stream** from YouTube — neither to save
> it (download) nor to play it in our own engine (streaming rip). Those are the same
> act (fetching the underlying stream) and both violate YouTube's Terms of Service.

Rewording ("optimized streaming integration", "offline cache", "import the song I
like") does not change what it is. Do not add `yt-dlp`, `youtube-dl`, lavalink
`youtube-source`, `ytdl-core`, or any equivalent to this project.

## Why

- **YouTube ToS** prohibit accessing content except through the API / official player,
  and prohibit downloading except via a download button YouTube itself provides.
- **Google OAuth2** identity + stream extraction = using the user's real Google
  account to facilitate a ToS violation. That makes it worse, not "compliant".
- There is **no** third-party path to "audio-only, ad-free, max-quality, background"
  YouTube Music. That experience comes only from local files or a **licensed** SDK.

## What IS allowed

- Play the user's **own local files** (any format the engine decodes).
- Read YouTube Music **metadata** (playlist/like names) via OAuth2 **read-only** scopes,
  as reference for organizing the local library. No stream URLs are ever requested.
- Play a YouTube track **only** via the official embedded IFrame player (video + ads),
  as a separate opt-in provider — never through the native audio engine.
- Import from sources the user is licensed for (their own media, royalty-free banks,
  an official playback SDK like Spotify/Deezer if they hold entitlements).

## If someone asks to add YouTube download later

Point them here. The answer is no for this codebase.
