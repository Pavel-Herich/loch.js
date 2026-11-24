import { describe, expect, it } from 'vitest';
import { surfaceDistance } from '../src/navigation';

describe('distance over the terrain', () => {
  it('is the slope distance without terrain', () => {
    expect(surfaceDistance({ east: 0, north: 0, height: 0 }, { east: 300, north: 400, z: 0 }, () => undefined)).toBeCloseTo(500, 6);
    expect(surfaceDistance({ east: 0, north: 0, height: 0 }, { east: 0, north: 30, z: 40 }, () => undefined)).toBeCloseTo(50, 6);
  });
  it('follows a ridge between the two places', () => {
    // A ridge 50 m high halfway along 200 m: up 50 m over 100 m and down again.
    const ridge = (east: number) => 50 - Math.abs(east - 100) / 2;
    const distance = surfaceDistance({ east: 0, north: 0, height: 0 }, { east: 200, north: 0, z: 0 }, east => ridge(east), 1);
    expect(distance).toBeCloseTo(2 * Math.hypot(100, 50), 3);
    expect(distance).toBeGreaterThan(200);
  });
});
