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
    // Drawn in strips, the same pixels as all at once.
    const grid = plane(.3, -.1), whole = hillshade(grid), strips = [hillshade(grid, 45, 1, 0, 2), hillshade(grid, 45, 1, 2, 3)];
    expect([...strips[0], ...strips[1]]).toEqual([...whole]);
    // Steep ground is darker whichever way it faces (lit across its slope).
    expect(centre(hillshade(plane(1.5, -1.5)))).toBeLessThan(flat);
    // Image rows run north first: the south-west node is the bottom-left pixel.
    const ramp = hillshade({ width: 2, height: 2, step: 1, heights: Float32Array.from([0, 0, NaN, NaN]) });
    expect([ramp[0], ramp[4]]).toEqual([255, 255]); // north row (first in the image) without data: white
    expect(ramp[8]).toBe(flat); // south row: flat ground
  });

  it('puts the image over the grid cells and into Therion as a bitmap', async () => {
    const { dmrTherion, imagePlace, imagePlan, imageSize, RELIEF_IMAGE } = await import('../src/dmr');
    const pc = { maxPixels: Infinity, maxSide: Infinity }, phone = { maxPixels: 16e6, maxSide: 8192 };
    // Within 7.7–179 million pixels and 1 000–15 000 px a side: the file's own 1 m cells.
    expect(imagePlan({ width: 7335, height: 2717 }, pc)).toMatchObject({ factor: 1, upscale: 1 });
    // A phone: cells averaged straight to its 16 million pixels (1.115 cells a pixel).
    const onPhone = imagePlan({ width: 7335, height: 2717 }, phone);
    expect(onPhone.upscale).toBe(1); expect(7335 * 2717 / onPhone.factor ** 2).toBeCloseTo(16e6, -5);
    // 21.2 × 15.4 km at 1 m (Demänovské vrchy): 15 000 px wide, 1.41 m a pixel, about 64 MB.
    const wide = imagePlan({ width: 21160, height: 15396 }, pc);
    expect(wide.upscale).toBe(1); expect(Math.floor(21160 / wide.factor)).toBe(15000); expect(wide.factor).toBeCloseTo(1.41, 2);
    // 20 × 20 km (MAPKA's largest export): 179 million pixels, about 70 MB (13 400 px a side).
    const square = imagePlan({ width: 20000, height: 20000 }, pc);
    expect((20000 / square.factor) ** 2 * RELIEF_IMAGE.bytesPerPixel).toBeCloseTo(70e6, -6);
    // 30 × 2 km: the 15 000 px side decides.
    const long = imagePlan({ width: 30000, height: 2000 }, pc);
    expect(long).toMatchObject({ factor: 2, upscale: 1 }); // 15 000 × 1 000 px
    // A computer that says it has 4 GB: 88 million pixels at most.
    const four = imagePlan({ width: 21160, height: 15396 }, { maxPixels: 88e6, maxSide: Infinity });
    expect(21160 * 15396 / four.factor ** 2).toBeCloseTo(88e6, -6);
    // 1 × 1 km: drawn larger to about 3 MB (2 774 px a side).
    const small = imagePlan({ width: 1000, height: 1000 }, pc);
    expect(small.factor).toBe(1); expect(imageSize({ width: 1000, height: 1000 }, small.upscale)).toEqual({ width: 2774, height: 2774 });
    // 600 × 300 m: still about 3 MB.
    const strip = imagePlan({ width: 600, height: 300 }, pc), size = imageSize({ width: 600, height: 300 }, strip.upscale);
    expect(size.width * size.height * RELIEF_IMAGE.bytesPerPixel).toBeCloseTo(3e6, -5);
    expect(imagePlace({ origin: [0.5, 0.5], step: 1, width: 600, height: 300 }, size).pixel).toBeCloseTo(600 / size.width, 9);
    // The image covers the grid's cells exactly, east and north, after rounding its size.
    const odd = imagePlace({ origin: [1, 1], step: 2, width: 3556, height: 1177 }, imageSize({ width: 3556, height: 1177 }, 1.955));
    expect(odd.west + odd.width * odd.pixel).toBeCloseTo(3556 * 2, 6);
    expect(odd.south + odd.height * (odd.pixelY ?? odd.pixel)).toBeCloseTo(1177 * 2, 6);
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


describe('relief image resampling', () => {
  it('shares cells by area for a factor that is not whole, so a plane stays a plane (no grid pattern)', async () => {
    const file = fixture('dmr-lzw.tif'), { tiff, epsg } = await inspectDmr(file);
    const factor = 1.41, dmr = await resampleDmr(file, tiff, epsg, factor, 'dmr.tif');
    let worst = 0, checked = 0;
    for (let r = 0; r < dmr.height; r++) for (let c = 0; c < dmr.width; c++) {
      const h = dmr.heights[r * dmr.width + c];
      if (h !== h) continue;
      // The node's centre in the file's cells (columns east, rows down from the top).
      const east = dmr.origin[0] + c * dmr.step, north = dmr.origin[1] + r * dmr.step;
      const column = east - tiff.left - .5, row = tiff.top - north - .5;
      // Skip nodes touching the empty rows or the hole (their means lean to one side).
      if (row < 21.5 || (row > 98 && row < 111 && column > 48 && column < 61)) continue;
      worst = Math.max(worst, Math.abs(h - expected(row, column))); checked++;
    }
    expect(checked).toBeGreaterThan(10000);
    // Box shares of cell values lean towards whole cells: within a tenth of a cell's slope.
    expect(worst).toBeLessThan(.1);
  });

  it('shades the relief from the file’s own cells, then reduces it: a plane stays one even grey', async () => {
    const { reliefFromFile, wholeFile } = await import('../src/dmr');
    const file = fixture('dmr-deflate.tif'), { tiff } = await inspectDmr(file);
    const relief = await reliefFromFile(file, tiff, wholeFile(tiff), 1.41);
    expect([relief.width, relief.height]).toEqual([184, 106]);
    expect(relief.west).toBe(-359129); expect(relief.south).toBeCloseTo(-1176215 - 106 * 1.41, 6); expect(relief.pixel).toBeCloseTo(1.41, 9);
    const rgba = relief.rows(0, relief.height), greys: number[] = [];
    // Away from the empty rows at the top, the hole and the edges.
    for (let r = 20; r < relief.height - 2; r++) for (let c = 2; c < relief.width - 2; c++) {
      const row = r * 1.41, column = c * 1.41;
      if (row > 96 && row < 113 && column > 46 && column < 63) continue;
      greys.push(rgba[(r * relief.width + c) * 4]);
    }
    expect(Math.max(...greys) - Math.min(...greys)).toBeLessThanOrEqual(2);
    // The empty rows come out white.
    expect(rgba[(2 * relief.width + 50) * 4]).toBe(255);
  });
});

describe('relief image styles', () => {
  it('shades classic from the north-west only, and colours by altitude over the shading', async () => {
    const { hillshade, altitudeTint, reliefColour } = await import('../src/dmr');
    const plane = (dx: number, dy: number) => ({ width: 5, height: 5, step: 1, heights: Float32Array.from({ length: 25 }, (_, i) => 1000 + dx * (i % 5) + dy * Math.floor(i / 5)) });
    const centre = (rgba: Uint8ClampedArray) => Array.from(rgba.slice((2 * 5 + 2) * 4, (2 * 5 + 2) * 4 + 3));
    // A slope facing north-east, across the classic light: lit from the west and north in the multidirectional style.
    const ne = plane(-.8, -.8);
    expect(centre(hillshade(ne, 45, 1, 0, 5, 'classic'))[0]).toBeLessThan(centre(hillshade(ne, 45, 1, 0, 5, 'multidirectional'))[0] + 1);
    // Facing the north-west light, classic is brighter than flat ground.
    const nw = plane(.5, -.5), flat = plane(0, 0);
    expect(centre(hillshade(nw, 45, 1, 0, 5, 'classic'))[0]).toBeGreaterThan(centre(hillshade(flat, 45, 1, 0, 5, 'classic'))[0]);
    // Altitude: blue low, white high, the same tone on flat ground keeping the tint.
    expect(altitudeTint(0)).toEqual([18, 52, 140]); expect(altitudeTint(1)).toEqual([255, 255, 255]);
    const low = centre(hillshade(flat, 45, 1, 0, 5, 'altitude', [1000, 2000])), high = centre(hillshade({ ...flat, heights: flat.heights.map(h => h + 1000) }, 45, 1, 0, 5, 'altitude', [1000, 2000]));
    expect(low[2]).toBeGreaterThan(low[0]); expect(low[2]).toBeGreaterThan(low[1]); // blue
    expect(Math.min(...high)).toBeGreaterThan(200); // near white
    expect(reliefColour(100, 'multidirectional', 1500, [1000, 2000])).toEqual([100, 100, 100]);
  });

  it('shades every style the same in strips as at once (the sky-view factor looks 15 m beyond each strip)', async () => {
    const { reliefFromFile, wholeFile } = await import('../src/dmr');
    const file = fixture('dmr-lzw.tif'), { tiff } = await inspectDmr(file);
    for (const style of ['sky', 'composite', 'contours', 'swiss', 'slope'] as const) {
      const once = await reliefFromFile(file, tiff, wholeFile(tiff), 1, undefined, style, [1200, 1400], 4096);
      const strips = await reliefFromFile(file, tiff, wholeFile(tiff), 1, undefined, style, [1200, 1400], 1);
      expect(Array.from(strips.rows(0, strips.height))).toEqual(Array.from(once.rows(0, once.height)));
    }
  });

  it('darkens hollows in the sky-view factor, slopes in the slope style, and draws contours', async () => {
    const { hillshade } = await import('../src/dmr');
    // A 40 × 40 m bowl, 8 m deep in the middle.
    const bowl = { width: 41, height: 41, step: 1, heights: Float32Array.from({ length: 41 * 41 }, (_, i) => 1000 + Math.min(8, Math.hypot(i % 41 - 20, Math.floor(i / 41) - 20) * .5) - 8) };
    const at = (rgba: Uint8ClampedArray, r: number, c: number) => rgba[(r * 41 + c) * 4];
    const sky = hillshade(bowl, 45, 1, 0, 41, 'sky');
    expect(at(sky, 20, 20)).toBeLessThan(at(sky, 2, 2));
    const slope = hillshade(bowl, 45, 1, 0, 41, 'slope');
    expect(at(slope, 20, 30)).toBeLessThan(at(slope, 2, 2)); // the bowl's side darker than the flat rim
    const contours = hillshade(bowl, 45, 1, 0, 41, 'contours'), plain = hillshade(bowl, 45, 1, 0, 41, 'multidirectional');
    let coloured = 0;
    for (let i = 0; i < 41 * 41; i++) if (contours[i * 4] !== contours[i * 4 + 2]) coloured++;
    expect(coloured).toBeGreaterThan(0); // brown lines (the 1000 m contour is a ring round the bottom)
    expect(Array.from(plain.slice(0, 4))).toEqual([plain[0], plain[0], plain[0], 255]);
  });

  it('crops a preview grid to the chosen corners', async () => {
    const { cropGrid } = await import('../src/dmr');
    const grid = { width: 4, height: 3, step: 2, origin: [100, 200] as [number, number], heights: Float32Array.from({ length: 12 }, (_, i) => i) };
    const part = cropGrid(grid, [101, 201, 105, 205]); // nodes at x 102, 104 and y 202, 204
    expect([part.width, part.height, ...part.origin]).toEqual([2, 2, 102, 202]);
    expect(Array.from(part.heights)).toEqual([5, 6, 9, 10]);
    expect(cropGrid(grid, [0, 0, 1000, 1000])).toBe(grid);
    expect(cropGrid(grid, [500, 500, 600, 600])).toBe(grid);
  });

  it('makes the coloured relief from the file, a mean height a pixel', async () => {
    const { reliefFromFile, wholeFile } = await import('../src/dmr');
    const file = fixture('dmr-lzw.tif'), { tiff } = await inspectDmr(file);
    const relief = await reliefFromFile(file, tiff, wholeFile(tiff), 2, undefined, 'altitude', [1200, 1400]);
    const rgba = relief.rows(70, 1), [r, g, b] = rgba.slice(40 * 4, 40 * 4 + 3);
    expect(r === g && g === b).toBe(false); // coloured
    expect(Array.from(relief.rows(2, 1).slice(0, 3))).toEqual([255, 255, 255]); // no data: white
  });
});
