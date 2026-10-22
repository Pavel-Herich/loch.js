/**
 * WGS 84 → S-JTSK / Krovak East North (EPSG:5514).
 *
 * EPSG:5514 is the same axis order and sign as Therion's `cs ijtsk`, so LOX
 * files exported from such projects already hold these coordinates.
 * Datum shift: EPSG "S-JTSK to WGS 84 (4)" for Slovakia (about 1 m), applied
 * in reverse; projection: EPSG method 9819 (Krovak) on the Bessel 1841 ellipsoid.
 */

const DEG = Math.PI / 180;
const ARCSEC = DEG / 3600;

const WGS84 = { a: 6378137, f: 1 / 298.257223563 };
const BESSEL = { a: 6377397.155, f: 1 / 299.1528128 };

/** S-JTSK → WGS 84, position-vector convention (metres, arc-seconds, ppm). */
const HELMERT = { tx: 485, ty: 169.5, tz: 483.8, rx: 7.786, ry: 4.398, rz: 4.103, s: 0 };

const KROVAK = {
  latC: 49.5 * DEG,
  lon0: 24.8333333333333 * DEG,
  alphaC: 30.2881397527778 * DEG,
  latP: 78.5 * DEG,
  kP: .9999,
};

type Ellipsoid = { a: number; f: number };

function toCartesian(lat: number, lon: number, h: number, { a, f }: Ellipsoid): [number, number, number] {
  const e2 = f * (2 - f), sinLat = Math.sin(lat), n = a / Math.sqrt(1 - e2 * sinLat * sinLat);
  return [(n + h) * Math.cos(lat) * Math.cos(lon), (n + h) * Math.cos(lat) * Math.sin(lon), (n * (1 - e2) + h) * sinLat];
}

function toGeodetic([x, y, z]: [number, number, number], { a, f }: Ellipsoid): [number, number] {
  const e2 = f * (2 - f), p = Math.hypot(x, y);
  let lat = Math.atan2(z, p * (1 - e2));
  for (let i = 0; i < 8; i++) {
    const sinLat = Math.sin(lat), n = a / Math.sqrt(1 - e2 * sinLat * sinLat);
    lat = Math.atan2(z + e2 * n * sinLat, p);
  }
  return [lat, Math.atan2(y, x)];
}

/** Inverse of the S-JTSK → WGS 84 Helmert shift (transposed small-angle rotation). */
function wgs84ToBesselCartesian([x, y, z]: [number, number, number]): [number, number, number] {
  const { tx, ty, tz, s } = HELMERT;
  const rx = HELMERT.rx * ARCSEC, ry = HELMERT.ry * ARCSEC, rz = HELMERT.rz * ARCSEC;
  const scale = 1 + s * 1e-6;
  const dx = (x - tx) / scale, dy = (y - ty) / scale, dz = (z - tz) / scale;
  // Position vector R = [[1,-rz,ry],[rz,1,-rx],[-ry,rx,1]]; apply Rᵀ.
  return [dx + rz * dy - ry * dz, -rz * dx + dy + rx * dz, ry * dx - rx * dy + dz];
}

const krovak = (() => {
  const { a, f } = BESSEL, e2 = f * (2 - f), e = Math.sqrt(e2);
  const { latC, latP, kP } = KROVAK;
  const sinC = Math.sin(latC);
  const A = a * Math.sqrt(1 - e2) / (1 - e2 * sinC * sinC);
  const B = Math.sqrt(1 + e2 * Math.cos(latC) ** 4 / (1 - e2));
  const gamma0 = Math.asin(sinC / B);
  const t0 = Math.tan(Math.PI / 4 + gamma0 / 2) * ((1 + e * sinC) / (1 - e * sinC)) ** (e * B / 2) / Math.tan(Math.PI / 4 + latC / 2) ** B;
  const n = Math.sin(latP);
  const r0 = kP * A / Math.tan(latP);
  return { e, B, t0, n, r0, rP: r0 * Math.tan(Math.PI / 4 + latP / 2) ** n };
})();

/** Bessel latitude/longitude (radians) → Krovak southing/westing (metres). */
function krovakForward(lat: number, lon: number): [number, number] {
  const { e, B, t0, n, rP } = krovak;
  const sinLat = Math.sin(lat);
  const U = 2 * (Math.atan(t0 * Math.tan(lat / 2 + Math.PI / 4) ** B / ((1 + e * sinLat) / (1 - e * sinLat)) ** (e * B / 2)) - Math.PI / 4);
  const V = B * (KROVAK.lon0 - lon);
  const T = Math.asin(Math.cos(KROVAK.alphaC) * Math.sin(U) + Math.sin(KROVAK.alphaC) * Math.cos(U) * Math.cos(V));
  const D = Math.asin(Math.cos(U) * Math.sin(V) / Math.cos(T));
  const theta = n * D;
  const r = rP / Math.tan(T / 2 + Math.PI / 4) ** n;
  return [r * Math.cos(theta), r * Math.sin(theta)];
}

/** WGS 84 latitude/longitude in degrees → EPSG:5514 / Therion ijtsk [east, north] in metres. */
export function wgs84ToSJTSK(latitude: number, longitude: number, height = 0): [number, number] {
  const bessel = toGeodetic(wgs84ToBesselCartesian(toCartesian(latitude * DEG, longitude * DEG, height, WGS84)), BESSEL);
  const [southing, westing] = krovakForward(bessel[0], bessel[1]);
  return [-westing, -southing];
}

/**
 * True when a model centre lies in the EPSG:5514 / ijtsk range used across
 * Czechia and Slovakia. Local survey coordinates fall far outside it.
 */
export function looksLikeSJTSK(east: number, north: number) {
  return east > -1_000_000 && east < -100_000 && north > -1_400_000 && north < -900_000;
}

function fromCartesian([x, y, z]: [number, number, number], ellipsoid: Ellipsoid): [number, number] {
  return toGeodetic([x, y, z], ellipsoid);
}

/** S-JTSK → WGS 84 Helmert shift (position-vector convention, small-angle rotation). */
function besselToWgs84Cartesian([x, y, z]: [number, number, number]): [number, number, number] {
  const { tx, ty, tz, s } = HELMERT;
  const rx = HELMERT.rx * ARCSEC, ry = HELMERT.ry * ARCSEC, rz = HELMERT.rz * ARCSEC, scale = 1 + s * 1e-6;
  return [tx + scale * (x - rz * y + ry * z), ty + scale * (rz * x + y - rx * z), tz + scale * (-ry * x + rx * y + z)];
}

/** Krovak southing/westing (metres) → Bessel latitude/longitude (radians), EPSG method 9819 reversed. */
function krovakInverse(southing: number, westing: number): [number, number] {
  const { e, B, t0, n, rP } = krovak;
  const r = Math.hypot(southing, westing), theta = Math.atan2(westing, southing);
  const D = theta / n;
  const T = 2 * (Math.atan((rP / r) ** (1 / n)) - Math.PI / 4);
  const U = Math.asin(Math.cos(KROVAK.alphaC) * Math.sin(T) - Math.sin(KROVAK.alphaC) * Math.cos(T) * Math.cos(D));
  const V = Math.asin(Math.cos(T) * Math.sin(D) / Math.cos(U));
  let lat = U;
  for (let i = 0; i < 10; i++) {
    const sinLat = Math.sin(lat);
    lat = 2 * (Math.atan(t0 ** (-1 / B) * Math.tan(U / 2 + Math.PI / 4) ** (1 / B) * ((1 + e * sinLat) / (1 - e * sinLat)) ** (e / 2)) - Math.PI / 4);
  }
  return [lat, KROVAK.lon0 - V / B];
}

/** EPSG:5514 / Therion ijtsk [east, north] (metres) → WGS 84 latitude/longitude in degrees. */
export function sjtskToWgs84(east: number, north: number, height = 0): [number, number] {
  const [lat, lon] = krovakInverse(-north, -east);
  const [latitude, longitude] = fromCartesian(besselToWgs84Cartesian(toCartesian(lat, lon, height, BESSEL)), WGS84);
  return [latitude / DEG, longitude / DEG];
}
