import { describe, expect, it } from 'vitest';
import { geoidHeight, seaLevelAltitude } from '../src/geoid';

describe('geoid', () => {
  it('gives EGM96 geoid heights across Slovakia', () => {
    expect(geoidHeight(48.98, 19.63)).toBeCloseTo(43, 0); // Demänovská dolina
    expect(geoidHeight(48.15, 17.11)).toBeCloseTo(43.7, 0); // Bratislava
    expect(geoidHeight(48.72, 21.26)).toBeCloseTo(40.6, 0); // Košice
  });
  it('takes the geoid off Android heights (above the ellipsoid) only', () => {
    const android = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/130 Mobile';
    const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/604.1';
    expect(seaLevelAltitude(1600, 48.98, 19.63, android)!).toBeCloseTo(1557, 0);
    expect(seaLevelAltitude(1557, 48.98, 19.63, iphone)).toBe(1557);
    expect(seaLevelAltitude(null, 48.98, 19.63, android)).toBeNull();
  });
});
