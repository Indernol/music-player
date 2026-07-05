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
  defaultVolume: 80,
  normalizeDefault: true,
  shuffleDefault: false,
  notifyOnChange: true,
  rpcEnabled: false,
  rpcClientId: "",
};

let _s = { ...DEFAULTS };

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
