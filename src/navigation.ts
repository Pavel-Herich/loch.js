/** Where a target lies from the device: distances, height difference and directions. */
export type Navigation = {
  distance: number; horizontal: number; dz: number;
  /** Clockwise from S-JTSK grid north. */
  gridBearing: number;
  /** Clockwise from true north (grid bearing less the meridian convergence at the device). */
  trueBearing: number;
  /** Turn from where the phone points (true heading) to the target, −180…180; undefined without a compass. */
  turn?: number;
};

const wrap = (degrees: number) => ((degrees % 360) + 360) % 360;

export function navigate(from: { east: number; north: number; height: number; trueNorth: number },
  to: { east: number; north: number; z: number }, heading?: number): Navigation {
  const dx = to.east - from.east, dy = to.north - from.north, dz = to.z - from.height;
  const horizontal = Math.hypot(dx, dy);
  const gridBearing = wrap(Math.atan2(dx, dy) * 180 / Math.PI);
  // trueNorth is the grid bearing of true north here, so true = grid − trueNorth.
  const trueBearing = wrap(gridBearing - from.trueNorth);
  const result: Navigation = { distance: Math.hypot(horizontal, dz), horizontal, dz, gridBearing, trueBearing };
  if (heading !== undefined) result.turn = wrap(trueBearing - heading + 180) - 180;
  return result;
}

/** “245 m”, “1.3 km”. */
export function formatDistance(metres: number) {
  return metres >= 1000 ? `${(metres / 1000).toFixed(metres >= 10000 ? 0 : 1)} km` : `${Math.round(metres)} m`;
}

/**
 * Distance over the terrain along the straight line (in plan) from one place to another: the
 * terrain profile sampled about every `step` metres, each piece counted with its rise or fall.
 * Where the terrain does not reach, the pieces run straight between the ends' heights; with no
 * terrain at all this is the slope distance.
 */
export function surfaceDistance(from: { east: number; north: number; height: number }, to: { east: number; north: number; z: number },
  heightAt: (east: number, north: number) => number | undefined, step = 2) {
  const dx = to.east - from.east, dy = to.north - from.north, horizontal = Math.hypot(dx, dy);
  const pieces = Math.max(1, Math.min(4000, Math.ceil(horizontal / step)));
  let total = 0, previous = from.height;
  for (let i = 1; i <= pieces; i++) {
    const t = i / pieces;
    const height = i === pieces ? to.z : heightAt(from.east + dx * t, from.north + dy * t) ?? from.height + (to.z - from.height) * t;
    total += Math.hypot(horizontal / pieces, height - previous);
    previous = height;
  }
  return total;
}
