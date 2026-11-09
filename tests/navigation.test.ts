import { describe, expect, it } from 'vitest';
import { formatDistance, navigate } from '../src/navigation';

describe('navigate', () => {
  const here = { east: 0, north: 0, height: 1000, trueNorth: 4 };
  it('gives distance, height difference and bearings', () => {
    const way = navigate(here, { east: 300, north: 400, z: 1030 });
    expect(way.horizontal).toBeCloseTo(500); expect(way.dz).toBe(30);
    expect(way.gridBearing).toBeCloseTo(36.87, 1);
    // True north lies 4° clockwise of grid north, so the true bearing is 4° less.
    expect(way.trueBearing).toBeCloseTo(32.87, 1);
    expect(way.turn).toBeUndefined();
  });
  it('turns from where the phone points', () => {
    expect(navigate(here, { east: 0, north: 100, z: 1000 }, 350).turn).toBeCloseTo(6);
    expect(navigate(here, { east: 0, north: -100, z: 1000 }, 10).turn).toBeCloseTo(166);
  });
  it('formats distances', () => { expect(formatDistance(245.4)).toBe('245 m'); expect(formatDistance(1340)).toBe('1.3 km'); });
});
