import { afterEach, describe, expect, it } from 'vitest';
import { altitudeFraction, colourRange, customAltitudeRange, setCustomAltitudeRange } from '../src/altitude-range';
import { centrelineColor } from '../src/centreline';

describe('altitude colour range', () => {
  afterEach(() => setCustomAltitudeRange(undefined));
  it('uses the model range until the user sets one', () => {
    expect(colourRange({ minZ: 700, maxZ: 1200 })).toEqual({ minZ: 700, maxZ: 1200 });
    setCustomAltitudeRange({ minZ: 800, maxZ: 1000 });
    expect(colourRange({ minZ: 700, maxZ: 1200 })).toEqual({ minZ: 800, maxZ: 1000 });
  });
  it('turns everything above the top red and below the bottom blue', () => {
    const range = { minZ: 800, maxZ: 1000 };
    expect(altitudeFraction(1150, range)).toBe(1); expect(altitudeFraction(750, range)).toBe(0);
    expect(altitudeFraction(900, range)).toBe(.5);
  });
  it('ignores empty or reversed ranges', () => {
    setCustomAltitudeRange({ minZ: 1000, maxZ: 800 }); expect(customAltitudeRange()).toBeUndefined();
    setCustomAltitudeRange({ minZ: 900, maxZ: 900 }); expect(customAltitudeRange()).toBeUndefined();
  });
  it('colours the centreline above the range red', () => {
    const red = centrelineColor(1100, 0, { minZ: 800, maxZ: 1000 }, 'altitude');
    expect(red.r).toBeGreaterThan(3 * red.g); expect(red.g).toBeCloseTo(red.b, 6);
    expect(centrelineColor(1100, 0, { minZ: 800, maxZ: 1000 }, "altitude")).toEqual(centrelineColor(1000, 0, { minZ: 800, maxZ: 1000 }, "altitude"));
  });
});
