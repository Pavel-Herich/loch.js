import { describe, expect, it } from 'vitest';
import { degrees, nearestHorizontalSurfacePoint, nearestSurfacePoint, segment, signedMetres } from '../src/measure';

const point = (east: number, north: number, z: number) => ({ name: '', east, north, z });

describe('segment', () => {
  it('gives slope and horizontal distance, height difference, bearing and inclination', () => {
    const s = segment(point(0, 0, 0), point(30, 40, -50));
    expect(s.horizontal).toBeCloseTo(50);
    expect(s.slope).toBeCloseTo(Math.hypot(50, 50));
    expect(s.dz).toBe(-50);
    expect(s.bearing).toBeCloseTo(Math.atan2(30, 40) * 180 / Math.PI);
    expect(s.inclination).toBeCloseTo(-45);
    expect(s.trueBearing).toBeUndefined();
  });
  it('adds a true bearing in S-JTSK, turned by the meridian convergence', () => {
    const s = segment(point(-380238, -1204398, 1556), point(-380238, -1203398, 1556));
    expect(s.bearing).toBeCloseTo(0);
    // True north lies a few degrees clockwise of grid north here, so grid north reads west of it.
    expect(s.trueBearing!).toBeGreaterThan(350);
    expect(s.trueBearing!).toBeLessThan(358);
  });
  it('formats whole metres and degrees', () => {
    expect(signedMetres(12.6)).toBe('+13 m');
    expect(signedMetres(-0.2)).toBe('0 m');
    expect(degrees(359.7)).toBe('0°');
  });
});

describe('nearestSurfacePoint', () => {
  // 21 × 21 grid, 10 m cells, a 45° slope rising to the east: z = x.
  const width = 21, height = 21, heights = new Float64Array(width * height);
  for (let r = 0; r < height; r++) for (let c = 0; c < width; c++) heights[r * width + c] = c * 10;
  const grid = { width, height, calibration: [0, 0, 10, 0, 0, 10] as [number, number, number, number, number, number], heights };

  it('finds the perpendicular foot on a slope, nearer than the vertical overburden', () => {
    // 100 m below the terrain at x = 100.
    const result = nearestSurfacePoint(grid, 100, 100, 0, 100)!;
    expect(result.distance).toBeCloseTo(100 / Math.SQRT2, 3);
    expect(result.east).toBeCloseTo(50, 3);
    expect(result.z).toBeCloseTo(50, 3);
    expect(result.north).toBeCloseTo(100, 3);
  });
  it('goes out sideways to where the slope passes the point\'s height', () => {
    // z = x: at height 40 the terrain is at x = 40, 60 m west of x = 100.
    const result = nearestHorizontalSurfacePoint(grid, 100, 100, 40)!;
    expect(result.distance).toBeCloseTo(60, 6);
    expect(result.east).toBeCloseTo(40, 6); expect(result.north).toBeCloseTo(100, 6); expect(result.z).toBe(40);
    // Below the whole terrain there is no way out sideways.
    expect(nearestHorizontalSurfacePoint(grid, 100, 100, -5)).toBeUndefined();
  });
  it('is the vertical distance under flat terrain', () => {
    const flat = { ...grid, heights: new Float64Array(width * height).fill(500) };
    const result = nearestSurfacePoint(flat, 55, 75, 420, 500)!;
    expect(result.distance).toBeCloseTo(80);
    expect(result.east).toBeCloseTo(55); expect(result.north).toBeCloseTo(75);
  });
});
