import { Triangle, Vector3 } from 'three';
import { looksLikeSJTSK, sjtskToWgs84, wgs84ToSJTSK } from './geo';
import type { Surface } from './lox-surface';

/** Model file coordinates: S-JTSK east, north (cs ijtsk) and height, or local model units. */
export type MeasurePoint = { name: string; east: number; north: number; z: number };

export type Segment = {
  slope: number; horizontal: number; dz: number;
  /** Clockwise from grid north (+Y), 0–360. */
  bearing: number;
  /** Clockwise from true north when the model is in S-JTSK. */
  trueBearing?: number;
  /** Degrees above (+) or below (−) the horizontal. */
  inclination: number;
};

const DEG = 180 / Math.PI;

/** Grid bearing of true north at an S-JTSK position (meridian convergence). */
export function trueNorthBearing(east: number, north: number) {
  const [latitude, longitude] = sjtskToWgs84(east, north);
  const [e, n] = wgs84ToSJTSK(latitude + .001, longitude);
  return Math.atan2(e - east, n - north) * DEG;
}

export function segment(a: MeasurePoint, b: MeasurePoint): Segment {
  const dx = b.east - a.east, dy = b.north - a.north, dz = b.z - a.z;
  const horizontal = Math.hypot(dx, dy), slope = Math.hypot(horizontal, dz);
  const bearing = horizontal ? (Math.atan2(dx, dy) * DEG + 360) % 360 : 0;
  const result: Segment = { slope, horizontal, dz, bearing, inclination: slope ? Math.atan2(dz, horizontal) * DEG : 0 };
  if (horizontal && looksLikeSJTSK(a.east, a.north)) result.trueBearing = ((bearing - trueNorthBearing(a.east, a.north)) % 360 + 360) % 360;
  return result;
}

type Grid = Pick<Surface, 'width' | 'height' | 'calibration' | 'heights'>;

/**
 * Closest point of the terrain grid (two triangles per cell) to a 3D point.
 * The vertical distance to the terrain bounds the answer, so only cells within
 * that horizontal radius are searched.
 */
export function nearestSurfacePoint(grid: Grid, east: number, north: number, z: number, terrainAbove?: number) {
  const [x0, y0, xx, xy, yx, yy] = grid.calibration;
  const determinant = xx * yy - xy * yx;
  const column = (yy * (east - x0) - xy * (north - y0)) / determinant, row = (xx * (north - y0) - yx * (east - x0)) / determinant;
  const cell = Math.min(Math.hypot(xx, yx), Math.hypot(xy, yy));
  // Without a height straight above or below (outside the grid), search the whole grid.
  const bound = terrainAbove === undefined ? Infinity : Math.abs(terrainAbove - z) + 2 * cell;
  const reach = Number.isFinite(bound) ? Math.ceil(bound / cell) + 1 : Math.max(grid.width, grid.height);
  const c0 = Math.max(0, Math.floor(column) - reach), c1 = Math.min(grid.width - 2, Math.floor(column) + reach);
  const r0 = Math.max(0, Math.floor(row) - reach), r1 = Math.min(grid.height - 2, Math.floor(row) + reach);
  if (c0 > c1 || r0 > r1) return undefined;
  const target = new Vector3(east, north, z), corner = (c: number, r: number, out: Vector3) =>
    out.set(x0 + xx * c + xy * r, y0 + yx * c + yy * r, grid.heights[r * grid.width + c]);
  const a = new Vector3(), b = new Vector3(), c = new Vector3(), d = new Vector3();
  const triangle = new Triangle(), closest = new Vector3(), best = new Vector3();
  let bestDistance = Infinity;
  for (let r = r0; r <= r1; r++) for (let col = c0; col <= c1; col++) {
    corner(col, r, a); corner(col + 1, r, b); corner(col, r + 1, c); corner(col + 1, r + 1, d);
    if (![a.z, b.z, c.z, d.z].every(Number.isFinite)) continue;
    // Skip cells that cannot beat the best so far.
    const cx = (a.x + d.x) / 2 - east, cy = (a.y + d.y) / 2 - north;
    if (Math.hypot(cx, cy) - 1.5 * cell > Math.min(bestDistance, bound)) continue;
    for (const [p, q, s] of [[a, b, c], [b, d, c]] as const) {
      triangle.set(p, q, s).closestPointToPoint(target, closest);
      const distance = closest.distanceTo(target);
      if (distance < bestDistance) { bestDistance = distance; best.copy(closest); }
    }
  }
  return Number.isFinite(bestDistance) ? { east: best.x, north: best.y, z: best.z, distance: bestDistance } : undefined;
}

/** Whole metres, as everywhere in the app's field values. */
export const metres = (value: number) => `${Math.round(value)} m`;
export const signedMetres = (value: number) => `${Math.round(value) > 0 ? '+' : ''}${Math.round(value)} m`;
export const degrees = (value: number) => `${Math.round(value) % 360}°`;
