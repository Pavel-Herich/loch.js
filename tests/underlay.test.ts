import { describe, expect, it } from 'vitest';
import { wmsTileUrl, downloadEstimate, extentGap, offlineTiles, tilesFor, retinaScale, tileGround, tileTemplate, type XyzService, nearestPointGap, getMapUrl, imageComplete, mercatorPixel, planPieces, split, UNDERLAY_SERVICES, zoomFor, type Extent, type WmsService } from '../src/underlay';
import { tileCells } from '../src/surface';

describe('map underlays', () => {
  it('stacks imagery, outdoor maps and the geological map over the LOX image', () => {
    expect(UNDERLAY_SERVICES.map(s => s.id)).toEqual(['zbgis-ortho', 'mapy-aerial', 'freemap', 'mapy-outdoor', 'geology']);
    // Imagery and maps are draped in pieces; the geological map is one image at half opacity.
    expect(UNDERLAY_SERVICES.filter(s => s.levels).map(s => s.id)).toEqual(['zbgis-ortho', 'mapy-aerial', 'freemap', 'mapy-outdoor']);
    expect(UNDERLAY_SERVICES.find(s => s.id === 'geology')!.opacity).toBe(.5);
    const geology = UNDERLAY_SERVICES.find(s => s.id === 'geology') as WmsService;
    expect(getMapUrl(geology, '0', [0, 0, 10, 10], 10, 10)).toContain('TRANSPARENT=TRUE');
  });

  it('asks Freemap as its terms say: zoom 5–18, tiles for the pixel ratio, on demand, credited', () => {
    const freemap = UNDERLAY_SERVICES.find(s => s.id === 'freemap') as XyzService;
    expect(freemap).toMatchObject({ minZoom: 5, maxZoom: 18, onDemand: true });
    expect(tileTemplate(freemap, 1)).toEqual({ size: 256, url: 'https://outdoor.tiles.freemap.sk/{z}/{x}/{y}' });
    expect(tileTemplate(freemap, 2)).toEqual({ size: 512, url: 'https://outdoor.tiles.freemap.sk/{z}/{x}/{y}@2x' });
    expect(tileTemplate(freemap, 3).url.endsWith('@3x')).toBe(true);
    expect([1, 1.5, 2.7, 5].map(r => retinaScale(r))).toEqual([1, 2, 3, 4]);
    expect(freemap.credits.map(c => c.href)).toEqual(['https://www.freemap.sk/', 'https://www.openstreetmap.org/copyright', 'https://www.freemap.sk/']);
    expect(tileGround(49, 512, 16)).toBeCloseTo(.78, 2);
  });

  it('shows Mapy.com on demand from tiles saved on the device, sharpest near the stations', () => {
    for (const id of ['mapy-aerial', 'mapy-outdoor']) expect(UNDERLAY_SERVICES.find(s => s.id === id)).toMatchObject({ onDemand: true, offline: true, minZoom: 5, maxZoom: 19, apiKey: 'mapy' });
    const aerial = UNDERLAY_SERVICES.find(s => s.id === 'mapy-aerial') as XyzService;
    // A 1 km piece at the Low Tatras covers a few tiles at zoom 14 and many at 18.
    const piece: Extent = [-389000, -1206000, -388000, -1205000];
    expect(tilesFor(piece, 14, 256).length).toBeLessThanOrEqual(4);
    expect(tilesFor(piece, 18, 256).length).toBeGreaterThan(100);
    // Stations in the middle of the piece: zoom 18 kept near them, the base (zoom 15) everywhere.
    const stations = new Float64Array([-388500, -1205500]);
    const plan = offlineTiles(aerial, [{ key: 'p', extent: piece }], stations, 12, 48.95);
    expect(plan.highest.get('p')).toBe(18);
    const byZoom = (z: number) => plan.tiles.filter(t => t[0] === z).length;
    expect(byZoom(15)).toBe(tilesFor(piece, 15, 256).length);
    expect(byZoom(18)).toBeGreaterThan(0); expect(byZoom(18)).toBeLessThan(tilesFor(piece, 18, 256).length / 4);
    expect(plan.tiles[0][0]).toBe(12); // lowest zooms first
    expect(new Set(plan.tiles.map(t => t.join('/'))).size).toBe(plan.tiles.length);
    expect(offlineTiles(aerial, [{ key: 'p', extent: piece }], new Float64Array(), 12, 48.95).highest.get('p')).toBe(15);
  });

  it('asks a WMS for the area of a Web Mercator tile (ZBGIS orthophoto)', () => {
    const ortho = UNDERLAY_SERVICES.find(s => s.id === 'zbgis-ortho') as XyzService;
    expect(ortho).toMatchObject({ offline: true, exclusive: true, tileSize: 512 });
    const wms = { url: 'https://example.sk/wms', layers: '1', format: 'image/jpeg' };
    const ll = new URL(wmsTileUrl(wms, 512, 1, 1, 0)).searchParams;
    expect(ll.get('SRS')).toBe('EPSG:4326');
    expect(ll.get('BBOX')!.split(',').map(Number)).toEqual([0, 0, 180, expect.closeTo(85.0511288, 6)]);
    const merc = new URL(wmsTileUrl({ ...wms, srs: 'EPSG:3857' }, 512, 1, 0, 1)).searchParams;
    expect(merc.get('BBOX')!.split(',').map(Number).map(v => Math.round(v))).toEqual([-20037508, -20037508, 0, 0]);
    expect(merc.get('WIDTH')).toBe('512'); expect(merc.get('LAYERS')).toBe('1');
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
    expect(downloadEstimate(UNDERLAY_SERVICES[1], [{ width: 1000, height: 1000 }])).toBe(300_000); // Mapy.com aerial
  });

  it('measures pieces against the survey stations', () => {
    const gap = nearestPointGap(new Float64Array([500, 500, 5000, 300]));
    expect(gap([0, 0, 1000, 1000])).toBe(0);
    expect(gap([1000, 0, 2000, 1000])).toBe(500);
    expect(planPieces([{ key: 'a', extent: [1000, 0, 2000, 1000] }, { key: 'b', extent: [2000, 0, 3000, 1000] }], gap, [.5, 2, 6], Infinity, 4096).map(p => p.width)).toEqual([500, 500]);
  });

  it('splits requests evenly and tells cut-off images', () => {
    expect(split(1286, 1024)).toEqual([643, 643]);
    expect(split(2049, 1024)).toEqual([683, 683, 683]);
    expect(split(500, 1024)).toEqual([500]);
    const jpeg = new Uint8Array([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]);
    expect(imageComplete(jpeg, 'image/jpeg')).toBe(true);
    expect(imageComplete(jpeg.subarray(0, 5), 'image/jpeg')).toBe(false);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
    expect(imageComplete(png, 'image/png')).toBe(true);
    expect(imageComplete(png.subarray(0, 10), 'image/png')).toBe(false);
  });

  it('cuts surfaces into pieces of about a kilometre', () => {
    expect(tileCells([0, 0, 17, 0, 0, 17])).toBe(59);
    expect(tileCells([0, 0, 1, 0, 0, 1])).toBe(255);
    expect(tileCells([0, 0, 100, 0, 0, 100])).toBe(16);
  });
});
