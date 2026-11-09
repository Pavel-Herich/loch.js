import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dmrSteps, dmrSurface, dmrTherion, filledHeights, inspectDmr, resampleDmr, tiffFromZip } from '../src/dmr';
import { readBlock } from '../src/geotiff';
import { jtsk03Shift } from '../src/jtsk03';
import { surfaceHeightAt } from '../src/lox-surface';

const fixture = (name: string) => new Blob([readFileSync(new URL(`./fixtures/${name}`, import.meta.url))]);
/** The fixture: 260 × 150 cells of 1 m from -359129, -1176215 (JTSK03); height 1200 + 0.5 column + 0.25 row, the top 20 rows and a 10 × 10 hole empty. */
const expected = (row: number, column: number) => 1200 + .5 * column + .25 * row;

describe('elevation GeoTIFFs (DMR 5.0)', () => {
  it('reads tiled LZW, deflated strips with the float predictor and 16-bit integers alike', async () => {
    for (const name of ['dmr-lzw.tif', 'dmr-deflate.tif', 'dmr-int16.tif']) {
      const file = fixture(name), { tiff, epsg } = await inspectDmr(file);
      expect([epsg, tiff.width, tiff.height, tiff.left, tiff.top, tiff.pixelWidth]).toEqual([8353, 260, 150, -359129, -1176215, 1]);
      const dmr = await resampleDmr(file, tiff, epsg, 1, name);
      expect([dmr.width, dmr.height]).toEqual([260, 130]); // empty rows at the top trimmed
      expect(dmr.origin).toEqual([-359128.5, -1176364.5]);
      const tolerance = name.includes('int16') ? .51 : .05;
      expect(Math.abs(dmr.heights[0] - expected(149, 0))).toBeLessThan(tolerance); // south-west node
      expect(Math.abs(dmr.heights[129 * 260 + 259] - expected(20, 259))).toBeLessThan(tolerance); // north-east node
      expect(Number.isNaN(dmr.heights[(149 - 105) * 260 + 55])).toBe(true); // the hole
    }
  });

  it('averages cells onto a coarser grid', async () => {
    const file = fixture('dmr-lzw.tif'), { tiff, epsg } = await inspectDmr(file);
    expect(dmrSteps(tiff).map(s => [s.step, s.nodes])).toEqual([[1, 39000], [2, 9750], [5, 1560], [10, 390], [20, 91]]);
    const dmr = await resampleDmr(file, tiff, epsg, 2, 'dmr.tif');
    expect([dmr.width, dmr.height, dmr.step]).toEqual([130, 65, 2]);
    expect(dmr.origin).toEqual([-359128, -1176364]);
    expect(dmr.heights[0]).toBeCloseTo(1200 + .5 * .5 + .25 * 148.5, 1);
  });

  it('moves JTSK03 into JTSK with the GKÚ grid (as PROJ does)', () => {
    const near = (a: [number, number], b: [number, number]) => expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThan(.01);
    near(jtsk03Shift(-355000, -1177500), [-.424, -.087]);
    near(jtsk03Shift(-389000, -1206000), [-.263, .016]);
    near(jtsk03Shift(-550000, -1300000), [1.278, .183]);
    expect(jtsk03Shift(0, 0)).toEqual([0, 0]);
  });

  it('becomes a surface of the model with holes, and a full Therion surface', async () => {
    const file = fixture('dmr-lzw.tif'), { tiff, epsg } = await inspectDmr(file);
    const dmr = await resampleDmr(file, tiff, epsg, 1, 'dmr.tif', undefined, jtsk03Shift);
    expect(dmr.shift[0]).toBeCloseTo(-.42, 1);
    const surface = dmrSurface(dmr);
    expect(surface.calibration).toEqual([-359128.5 + dmr.shift[0], -1176364.5 + dmr.shift[1], 1, 0, 0, 1]);
    // File row 60, column 10 lies 89 rows north of the south-west node.
    expect(surfaceHeightAt(surface, surface.calibration[0] + 10, surface.calibration[1] + 89)).toBeCloseTo(expected(60, 10), 1);
    expect(surfaceHeightAt(surface, surface.calibration[0] + 55, surface.calibration[1] + 44)).toBeUndefined();
    expect(filledHeights(dmr).every(Number.isFinite)).toBe(true);
    const text = dmrTherion(dmr), lines = text.split('\n');
    // In JTSK, moved here from JTSK03 (Therion then needs no grid of its own).
    const grid = `  grid ${(-359128.5 + dmr.shift[0]).toFixed(2)} ${(-1176364.5 + dmr.shift[1]).toFixed(2)} 1 1 260 130`;
    expect(lines).toContain('surface'); expect(lines).toContain('  cs ijtsk'); expect(lines).toContain(grid);
    expect(text).toContain(`Moved from S-JTSK [JTSK03] into JTSK by ${dmr.shift[0].toFixed(2)} m east`); expect(dmr.shift[0]).toBeCloseTo(-.42, 1);
    expect(text).toContain('Zdroj produktov LLS: UGKK SR');
    // Rows from north to south: the first value is the north-west node.
    const data = lines.slice(lines.indexOf(grid) + 1, lines.indexOf('endsurface')).join(' ').trim().split(/\s+/).map(Number);
    expect(data.length).toBe(260 * 130);
    expect(data[0]).toBeCloseTo(expected(20, 0), 1);
    expect(data[data.length - 1]).toBeCloseTo(expected(149, 259), 1);
  });

  it('finds the GeoTIFF in a ZIP from ZBGIS', async () => {
    const { name, blob } = await tiffFromZip(fixture('dmr.zip'));
    expect(name).toBe('dmr.tif');
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array(await fixture('dmr-lzw.tif').arrayBuffer()));
  });

  it('reads blocks the same whatever the compression', async () => {
    const a = fixture('dmr-lzw.tif'), b = fixture('dmr-deflate.tif');
    const ta = (await inspectDmr(a)).tiff, tb = (await inspectDmr(b)).tiff;
    const first = await readBlock(a, ta, 0), strip = await readBlock(b, tb, 2); // rows 32–47
    for (let r = 32; r < 48; r++) for (let c = 0; c < 64; c++) {
      const x = first[r * 64 + c], y = strip[(r - 32) * 260 + c];
      expect(Number.isNaN(x) ? Number.isNaN(y) : Math.abs(x - y) < 1e-9).toBe(true);
    }
  });
});

describe('terrain holes', () => {
  it('leaves out triangles that touch nodes without a height', async () => {
    const { surfaceGeometry } = await import('../src/surface');
    const { Vector3 } = await import('three');
    const heights = Float64Array.from([1, 1, 1, 1, NaN, 1, 1, 1, 1]);
    const geometry = surfaceGeometry({ id: -1, width: 3, height: 3, calibration: [0, 0, 1, 0, 0, 1], heights }, new Vector3());
    expect(geometry.index!.count).toBe(4 * 3); // one triangle left in each of the four cells
    const full = surfaceGeometry({ id: -1, width: 3, height: 3, calibration: [0, 0, 1, 0, 0, 1], heights: new Float64Array(9) }, new Vector3());
    expect(full.index!.count).toBe(8 * 3);
  });
});

describe('terrain relief image', () => {
  it('shades slopes facing the north-west light brighter, flat ground light grey', async () => {
    const { hillshade } = await import('../src/dmr');
    // Rows go north; a plane falling to the north-west (rising to the south-east) and its opposite.
    const plane = (dx: number, dy: number) => ({ width: 5, height: 5, step: 1, heights: Float32Array.from({ length: 25 }, (_, i) => dx * (i % 5) + dy * Math.floor(i / 5)) });
    const centre = (rgba: Uint8ClampedArray) => rgba[(2 * 5 + 2) * 4];
    const towardsLight = centre(hillshade(plane(.2, -.2))), away = centre(hillshade(plane(-.2, .2))), flat = centre(hillshade(plane(0, 0)));
    expect(towardsLight).toBeGreaterThan(flat); expect(flat).toBeGreaterThan(away);
    expect(flat).toBeGreaterThan(200);
    // Steep ground is darker whichever way it faces (lit across its slope).
    expect(centre(hillshade(plane(1.5, -1.5)))).toBeLessThan(flat);
    // Image rows run north first: the south-west node is the bottom-left pixel.
    const ramp = hillshade({ width: 2, height: 2, step: 1, heights: Float32Array.from([0, 0, NaN, NaN]) });
    expect([ramp[0], ramp[4]]).toEqual([255, 255]); // north row (first in the image) without data: white
    expect(ramp[8]).toBe(flat); // south row: flat ground
  });

  it('puts the image over the grid cells and into Therion as a bitmap', async () => {
    const { dmrTherion, imageFactor, imagePlace } = await import('../src/dmr');
    expect(imageFactor({ width: 7335, height: 2717 }, 30e6, 16384)).toBe(1);
    expect(imageFactor({ width: 7335, height: 2717 }, 12e6, 8192)).toBe(2);
    expect(imageFactor({ width: 20000, height: 20000 }, 30e6, 16384)).toBe(4);
    const place = imagePlace({ origin: [-359128.5, -1176364.5], step: 1, width: 260, height: 130 });
    expect(place).toEqual({ west: -359129, south: -1176365, pixel: 1, width: 260, height: 130 });
    const dmr = { name: 'dmr.tif', step: 2, width: 2, height: 2, origin: [-359128, -1176364] as [number, number], shift: [0, 0] as [number, number], epsg: 8353, heights: new Float32Array(4), image: { ...place, data: new Uint8Array(1) } };
    expect(dmrTherion(dmr, 'cave-terrain.jpg')).toContain('  bitmap cave-terrain.jpg [0 0 -359129.00 -1176365.00 260 130 -358869.00 -1176235.00]');
  });

  it('gives a terrain smooth normals from its grid', async () => {
    const { gridNormals } = await import('../src/surface');
    const heights = Float64Array.from({ length: 64 }, (_, i) => .5 * (i % 8) * 2); // z = 0.5 x on a 2 m grid
    const normals = gridNormals({ width: 8, height: 8, heights, calibration: [0, 0, 2, 0, 0, 2] }, 3, 3, 1, 1);
    const length = Math.hypot(.5, 1);
    expect(Array.from(normals.slice(0, 3)).map(v => +v.toFixed(4))).toEqual([-.5 / length, 0, 1 / length].map(v => +v.toFixed(4)));
  });
});

describe('surface shading', () => {
  it('turns normals of a mirrored grid so they face where its cells face', async () => {
    const { gridNormals } = await import('../src/surface');
    const flat = { width: 3, height: 3, heights: new Float64Array(9) };
    expect(gridNormals({ ...flat, calibration: [0, 0, 1, 0, 0, 1] }, 0, 0, 0, 0)[2]).toBeCloseTo(1);
    expect(gridNormals({ ...flat, calibration: [0, 0, 1, 0, 0, -1] }, 0, 0, 0, 0)[2]).toBeCloseTo(-1);
  });
});

describe('terrain crop, thconfig and LOX', () => {
  it('crops to a rectangle of the file before averaging', async () => {
    const { cropWindow, windowCorners } = await import('../src/dmr');
    const file = fixture('dmr-lzw.tif'), { tiff, epsg } = await inspectDmr(file);
    // 100 × 50 m from 20 m east and 30 m north of the south-west corner.
    const window = cropWindow(tiff, -359129 + 20, -1176365 + 30, -359129 + 120, -1176365 + 80);
    expect(window).toEqual({ column: 20, row: 70, columns: 100, rows: 50 });
    expect(windowCorners(tiff, window)).toEqual([-359109, -1176335, -359009, -1176285]);
    expect(dmrSteps(tiff, window)[0].nodes).toBe(5000);
    const dmr = await resampleDmr(file, tiff, epsg, 1, 'dmr.tif', undefined, undefined, window);
    expect([dmr.width, dmr.height]).toEqual([100, 50]);
    expect(dmr.origin).toEqual([-359108.5, -1176334.5]);
    expect(dmr.heights[0]).toBeCloseTo(expected(119, 20), 1); // south-west node: file row 119, column 20
    expect(dmr.heights[49 * 100 + 99]).toBeCloseTo(expected(70, 119), 1);
  });

  it('writes a thconfig and a LOX that read back as the same surface and image', async () => {
    const { dmrLox, dmrThconfig } = await import('../src/dmr');
    const { parseLox } = await import('../src/lox');
    expect(dmrThconfig('cave-terrain')).toBe('encoding utf-8\nsource cave-terrain.th\n\ncs ijtsk\n\nexport model -output cave-terrain.lox\n');
    // Names with spaces in quotes, as Therion reads them.
    expect(dmrThconfig('Baranec juh')).toContain('source "Baranec juh.th"');
    expect(dmrThconfig('Baranec juh')).toContain('export model -output "Baranec juh.lox"');
    const file = fixture('dmr-lzw.tif'), { tiff, epsg } = await inspectDmr(file);
    const dmr = await resampleDmr(file, tiff, epsg, 2, 'dmr.tif', undefined, jtsk03Shift);
    dmr.image = { west: -359129, south: -1176365, pixel: 1, width: 260, height: 130, data: new Uint8Array([0xff, 0xd8, 1, 2, 0xff, 0xd9]) };
    const model = parseLox(await dmrLox(dmr, 'Štrbské pleso').arrayBuffer());
    expect(model.title).toBe('Strbske pleso');
    const [surface] = model.surfaces, ours = dmrSurface(dmr);
    expect([surface.width, surface.height]).toEqual([dmr.width, dmr.height]);
    expect(surface.calibration).toEqual(ours.calibration);
    expect(surface.heights[0]).toBeCloseTo(dmr.heights[0], 3);
    expect(surface.heights.every(Number.isFinite)).toBe(true); // holes filled, as Therion needs
    expect(surface.bitmap!.calibration).toEqual(ours.bitmap!.calibration);
    expect(Array.from(surface.bitmap!.data)).toEqual([0xff, 0xd8, 1, 2, 0xff, 0xd9]);
  });
});

