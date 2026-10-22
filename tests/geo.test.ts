import { describe, expect, it } from 'vitest';
import { looksLikeSJTSK, sjtskToWgs84, wgs84ToSJTSK } from '../src/geo';

// Reference values from PROJ 9 (pyproj), EPSG "S-JTSK to WGS 84 (4)" + Krovak East North.
const REFERENCE: [number, number, number, number][] = [
  [48.985971893, 19.741300668, -372234.807, -1203810.66],
  [48.984322976, 19.716895019, -374029.241, -1203874.678],
  [48.912181927, 19.511936352, -389552, -1210856],
  [49.062469934, 19.775460443, -369179, -1195488],
  [48.200560219, 22.139731963, -200000, -1300000],
];

describe('WGS 84 to S-JTSK', () => {
  it('matches PROJ within a centimetre across Slovakia', () => {
    for (const [lat, lon, east, north] of REFERENCE) {
      const [x, y] = wgs84ToSJTSK(lat, lon);
      expect(Math.abs(x - east)).toBeLessThan(.01);
      expect(Math.abs(y - north)).toBeLessThan(.01);
    }
  });

  it('recognizes S-JTSK model centres and rejects local survey coordinates', () => {
    expect(looksLikeSJTSK(-378000, -1201000)).toBe(true);
    expect(looksLikeSJTSK(120, -45)).toBe(false);
    expect(looksLikeSJTSK(378000, 1201000)).toBe(false);
  });

  it('converts S-JTSK back to WGS 84 matching PROJ and round-trips within a centimetre', () => {
    for (const [lat, lon, east, north] of REFERENCE) {
      const [latitude, longitude] = sjtskToWgs84(east, north);
      // 1e-7° is about 1 cm.
      expect(Math.abs(latitude - lat)).toBeLessThan(2e-7);
      expect(Math.abs(longitude - lon)).toBeLessThan(2e-7);
      const [x, y] = wgs84ToSJTSK(latitude, longitude);
      // The small-angle Helmert rotation is not exactly self-inverse (PROJ shows the same ~5 mm).
      expect(Math.abs(x - east)).toBeLessThan(.01); expect(Math.abs(y - north)).toBeLessThan(.01);
    }
  });
});
