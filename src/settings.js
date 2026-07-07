// App settings: an in-memory object persisted via the generic store ("settings").
// loadSettings() is awaited once at startup; setSetting() persists immediately.

import { storeLoad, storeSave } from "./store.js";

export const ACCENTS = {
  violet: ["#8B5CF6", "#A78BFA"],
  green:  ["#1DB954", "#1ED760"],
  blue:   ["#3B82F6", "#60A5FA"],
  pink:   ["#EC4899", "#F472B6"],
  orange: ["#F59E0B", "#FBBF24"],
  red:    ["#EF4444", "#F87171"],
  teal:   ["#14B8A6", "#2DD4BF"],
};

const DEFAULTS = {
  accent: "violet",
  showArt: true,
  compactRows: false,
  animations: true,
  defaultVolume: 80,
  normalizeDefault: true,
  shuffleDefault: false,
  repeatDefault: "off", // off | all | one — the repeat button persists here
  notifyOnChange: true,
  rpcEnabled: false,
  rpcClientId: "",
  preloadNext: true,     // gapless: pre-queue the next track
  downloadDir: "",       // empty = ~/Music/MusicPlayer (resolved by the backend)
  preferLocal: true,     // play the local file when an online track is downloaded
  autoSaveImports: false, // pre-tick "Save locally" in the import dialog
  searchLimit: 20,       // YouTube search result count
  ytdlpPath: "",         // explicit yt-dlp binary; empty = auto-detect
  cookiesBrowser: "",    // --cookies-from-browser value; empty = off
  setupDone: false,      // first-run wizard completed
  updateMode: "ask",     // ask (propose) | auto (build silently) | off
  followInterval: "6h",  // follow checks: launch (startup only) | 1h | 6h | 24h
};

let _s = { ...DEFAULTS };

export function resetSettings() {
  _s = { ...DEFAULTS };
  storeSave("settings", JSON.stringify(_s));
  return _s;
}

export async function loadSettings() {
  const raw = await storeLoad("settings");
  if (raw) { try { _s = { ...DEFAULTS, ...JSON.parse(raw) }; } catch {} }
  return _s;
}

export function getSettings() { return _s; }

export function setSetting(key, value) {
  _s[key] = value;
  storeSave("settings", JSON.stringify(_s));
}
