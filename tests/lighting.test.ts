import { describe, expect, it } from 'vitest';
import { lightDirection } from '../src/lighting';

describe('Z-up light direction', () => {
  it.each([
    [0, 0, 0, 1, 0], [90, 0, 1, 0, 0], [180, 0, 0, -1, 0], [270, 0, -1, 0, 0], [360, 0, 0, 1, 0],
    [37, 90, 0, 0, 1], [230, -90, 0, 0, -1],
  ])('uses bearing %s° and clino %s° as the direction the light comes from', (bearing, clino, x, y, z) => {
    const direction = lightDirection(bearing, clino);
    expect(direction.x).toBeCloseTo(x, 10);
    expect(direction.y).toBeCloseTo(y, 10);
    expect(direction.z).toBeCloseTo(z, 10);
    expect(direction.length()).toBeCloseTo(1, 10);
  });
});
