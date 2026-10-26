/**
 * Geoid height N (EGM96, metres above the WGS 84 ellipsoid) over Slovakia, 0.25° grid from
 * 47.5° N, 16.5° E, 11 rows × 27 columns (generated with egm96-universal). EGM96 differs from
 * the Slovak quasigeoid (Bpv) by far less than phone GPS height errors.
 */
const LAT0 = 47.5, LON0 = 16.5, STEP = 0.25, ROWS = 11, COLS = 27;
const N = [
  45.77, 45.24, 44.86, 44.66, 44.6, 44.61, 44.62, 44.56, 44.43, 44.2, 43.91, 43.57, 43.21, 42.87, 42.57, 42.32, 42.1, 41.88, 41.63, 41.37, 41.11, 40.84, 40.57, 40.28, 39.96, 39.64, 39.36,
  45.5, 44.89, 44.43, 44.14, 44.02, 44.01, 44.06, 44.13, 44.17, 44.13, 43.97, 43.69, 43.33, 42.94, 42.59, 42.28, 41.99, 41.68, 41.35, 41.03, 40.74, 40.48, 40.21, 39.9, 39.53, 39.16, 38.87,
  44.98, 44.41, 44, 43.75, 43.61, 43.56, 43.6, 43.7, 43.83, 43.92, 43.89, 43.71, 43.42, 43.07, 42.73, 42.41, 42.08, 41.71, 41.3, 40.9, 40.53, 40.22, 39.93, 39.6, 39.24, 38.89, 38.64,
  44.39, 43.92, 43.64, 43.5, 43.43, 43.4, 43.42, 43.51, 43.65, 43.78, 43.83, 43.74, 43.54, 43.26, 42.97, 42.67, 42.32, 41.89, 41.4, 40.89, 40.43, 40.04, 39.71, 39.4, 39.08, 38.79, 38.56,
  44.09, 43.64, 43.4, 43.32, 43.33, 43.36, 43.41, 43.49, 43.6, 43.71, 43.77, 43.74, 43.62, 43.43, 43.19, 42.9, 42.51, 42.01, 41.42, 40.82, 40.28, 39.84, 39.52, 39.25, 38.99, 38.73, 38.43,
  44.27, 43.68, 43.32, 43.17, 43.18, 43.25, 43.33, 43.39, 43.44, 43.49, 43.52, 43.51, 43.46, 43.35, 43.17, 42.89, 42.46, 41.89, 41.24, 40.58, 40.01, 39.59, 39.28, 39.02, 38.74, 38.38, 37.89,
  44.73, 43.99, 43.45, 43.17, 43.1, 43.13, 43.16, 43.15, 43.11, 43.06, 43.03, 43.01, 42.99, 42.93, 42.77, 42.48, 42.03, 41.44, 40.77, 40.13, 39.58, 39.15, 38.81, 38.47, 38.04, 37.45, 36.71,
  45.06, 44.35, 43.78, 43.44, 43.28, 43.2, 43.12, 42.99, 42.83, 42.67, 42.56, 42.48, 42.4, 42.28, 42.05, 41.69, 41.2, 40.6, 39.96, 39.36, 38.83, 38.37, 37.95, 37.47, 36.85, 36.07, 35.14,
  45.01, 44.54, 44.15, 43.87, 43.66, 43.46, 43.24, 42.98, 42.73, 42.52, 42.34, 42.17, 41.96, 41.66, 41.25, 40.74, 40.14, 39.51, 38.88, 38.28, 37.75, 37.26, 36.77, 36.22, 35.54, 34.72, 33.79,
  44.62, 44.46, 44.3, 44.1, 43.83, 43.52, 43.19, 42.88, 42.63, 42.44, 42.26, 42.02, 41.66, 41.18, 40.57, 39.89, 39.19, 38.5, 37.84, 37.23, 36.68, 36.18, 35.7, 35.19, 34.59, 33.88, 33.08,
  44.13, 44.12, 44.03, 43.79, 43.45, 43.04, 42.67, 42.4, 42.23, 42.12, 41.97, 41.7, 41.28, 40.7, 40.01, 39.28, 38.56, 37.86, 37.21, 36.61, 36.06, 35.59, 35.17, 34.74, 34.26, 33.65, 32.94,
];

/** Geoid height at a WGS 84 position, bilinear in the table; positions outside use its edge. */
export function geoidHeight(latitude: number, longitude: number) {
  const r = Math.min(Math.max((latitude - LAT0) / STEP, 0), ROWS - 1), c = Math.min(Math.max((longitude - LON0) / STEP, 0), COLS - 1);
  const r0 = Math.min(Math.floor(r), ROWS - 2), c0 = Math.min(Math.floor(c), COLS - 2), u = c - c0, v = r - r0;
  const at = (i: number, j: number) => N[(r0 + j) * COLS + c0 + i];
  return (at(0, 0) * (1 - u) + at(1, 0) * u) * (1 - v) + (at(0, 1) * (1 - u) + at(1, 1) * u) * v;
}

/**
 * Phone GPS height as a sea-level (≈ Bpv) height. Safari on Apple devices already reports
 * height above mean sea level (Core Location, EGM2008); Android reports height above the
 * WGS 84 ellipsoid, as the Geolocation standard says, so the geoid height is taken off there.
 */
export function seaLevelAltitude(altitude: number | null, latitude: number, longitude: number, userAgent = globalThis.navigator?.userAgent ?? '') {
  if (altitude === null || !Number.isFinite(altitude)) return null;
  return /Android/i.test(userAgent) ? altitude - geoidHeight(latitude, longitude) : altitude;
}
