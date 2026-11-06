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
    expect(lines).toContain('surface'); expect(lines).toContain('  cs ijtsk03');
    expect(lines).toContain('  grid -359128.50 -1176364.50 1 1 260 130');
    expect(text).toContain('Zdroj produktov LLS: UGKK SR');
    // Rows from north to south: the first value is the north-west node.
    const data = lines.slice(lines.indexOf('  grid -359128.50 -1176364.50 1 1 260 130') + 1, lines.indexOf('endsurface')).join(' ').trim().split(/\s+/).map(Number);
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
