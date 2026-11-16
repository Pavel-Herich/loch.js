/**
 * The altitude colours run blue (low) to red (high) over the model's own height range, or over a
 * range the user sets from the legend: below it everything is blue, above it red.
 */
export type AltitudeRange = { minZ: number; maxZ: number };

let custom: AltitudeRange | undefined;

export function customAltitudeRange() { return custom; }

/** Undefined (or an empty range) goes back to the model's own range. */
export function setCustomAltitudeRange(range: AltitudeRange | undefined) {
  custom = range && Number.isFinite(range.minZ) && Number.isFinite(range.maxZ) && range.minZ < range.maxZ ? { ...range } : undefined;
}

/** The range the colours use. */
export function colourRange(natural: AltitudeRange): AltitudeRange { return custom ?? natural; }

/** 0 (blue) to 1 (red), clamped outside the range. */
export function altitudeFraction(z: number, range: AltitudeRange) {
  return range.maxZ === range.minZ ? .5 : Math.min(1, Math.max(0, (z - range.minZ) / (range.maxZ - range.minZ)));
}

// Remembered for each model (by file name and size).
const STORE = 'loch.js-altitude-ranges';
export function recallAltitudeRange(key: string): AltitudeRange | undefined {
  if (!key) return undefined;
  try {
    const range = (JSON.parse(localStorage.getItem(STORE) ?? '{}') as Record<string, AltitudeRange>)[key];
    return range && range.minZ < range.maxZ ? range : undefined;
  } catch { return undefined; }
}
export function rememberAltitudeRange(key: string, range: AltitudeRange | undefined) {
  if (!key) return;
  try {
    const all = JSON.parse(localStorage.getItem(STORE) ?? '{}') as Record<string, AltitudeRange>;
    if (range) all[key] = { minZ: range.minZ, maxZ: range.maxZ }; else delete all[key];
    localStorage.setItem(STORE, JSON.stringify(all));
  } catch { /* Not remembered (private mode). */ }
}
