import { describe, expect, it } from 'vitest';
import { downloadEstimate, extentGap, getMapUrl, mercatorPixel, planPieces, UNDERLAY_SERVICES, zoomFor, type Extent, type WmsService } from '../src/underlay';
import { tileCells } from '../src/surface';

describe('map underlays', () => {
  it('offers the orthophoto and Freemap as bases and the geological map as an overlay', () => {
    expect(UNDERLAY_SERVICES.filter(s => s.role === 'base').map(s => s.id)).toEqual(['ortho', 'freemap']);
    expect(UNDERLAY_SERVICES.filter(s => s.role === 'overlay').map(s => s.id)).toEqual(['geology']);
    const geology = UNDERLAY_SERVICES.find(s => s.id === 'geology') as WmsService;
    expect(getMapUrl(geology, '0', [0, 0, 10, 10], 10, 10)).toContain('TRANSPARENT=TRUE');
  });

  it('measures the gap between extents', () => {
    expect(extentGap([0, 0, 10, 10], [5, 5, 20, 20])).toBe(0);
    expect(extentGap([0, 0, 10, 10], [13, 14, 20, 20])).toBe(5);
  });

  it('places WGS 84 points on Web Mercator tiles', () => {
    const [x, y] = mercatorPixel(0, 0, 1, 256);
    expect(x).toBeCloseTo(256); expect(y).toBeCloseTo(256);
    // 49° N, 19.6° E (Low Tatras) at zoom 14.
    const [mx, my] = mercatorPixel(49, 19.6, 14, 256);
    expect(Math.floor(mx / 256)).toBe(9084); expect(Math.floor(my / 256)).toBe(5626);
  });

  it('picks the lowest zoom at least as sharp as asked', () => {
    // At 49° N a 512 px tile at zoom 16 covers about 0.78 m per pixel.
    expect(zoomFor(1, 49, 512, 19)).toBe(16);
    expect(zoomFor(.5, 49, 512, 19)).toBe(17);
    expect(zoomFor(.01, 49, 512, 19)).toBe(19);
  });

  it('makes pieces near the cave sharpest and keeps within the pixel budget', () => {
    const pieces = Array.from({ length: 10 }, (_, i) => ({ key: String(i), extent: [i * 1000, 0, (i + 1) * 1000, 1000] as Extent }));
    const cave: Extent = [200, 200, 800, 800];
    const plan = planPieces(pieces, cave, [.5, 2, 6], Infinity, 4096);
    expect(plan[0].width).toBe(2000); // over the cave: 0.5 m/px
    expect(plan[1].width).toBe(2000); // 200 m away: still near
    expect(plan[2].width).toBe(500);  // 1.2 km away: 2 m/px
    expect(plan[3].width).toBe(167);  // 2.2 km away: 6 m/px
    const tight = planPieces(pieces, cave, [.5, 2, 6], 2e6, 4096);
    expect(tight.reduce((sum, p) => sum + p.width * p.height, 0)).toBeLessThanOrEqual(2e6);
    expect(tight[0].width).toBeGreaterThan(tight[2].width);
    expect(planPieces(pieces, cave, [.1, 2, 6], Infinity, 2048)[0].width).toBe(2048);
    expect(downloadEstimate(UNDERLAY_SERVICES[0], [{ width: 1000, height: 1000 }])).toBe(300_000);
  });

  it('cuts surfaces into pieces of about a kilometre', () => {
    expect(tileCells([0, 0, 17, 0, 0, 17])).toBe(59);
    expect(tileCells([0, 0, 1, 0, 0, 1])).toBe(255);
    expect(tileCells([0, 0, 100, 0, 0, 100])).toBe(16);
  });
});
