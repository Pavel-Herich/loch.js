import { describe, expect, it } from 'vitest';
import { generateLRUDWalls, LRUD_BATCH_LEGS, type LRUD, type LRUDLeg } from '../src/lrud';
import { parseLox, type Point, type Scrap } from '../src/lox';
import { BATCH_TRIANGLES, streamLargeLox, type GeometryBatch } from '../src/large-lox';
import { parseCompass } from '../src/compass';
import { parseSurvex } from '../src/survex';
import { readFileSync } from 'node:fs';
import { SurveyModel } from '../src/survey-model';

const dimensions: LRUD = [1, 2, 3, 4];
function leg(from: Point = [0, 0, 0], to: Point = [0, 10, 0], profile = 1): LRUDLeg {
  return { from, to, section: { from: dimensions, to: dimensions, profile, threshold: 60 } };
}
function bounds(mesh: Scrap) {
  return [0, 1, 2].map(axis => [Math.min(...mesh.points.map(p => p[axis])), Math.max(...mesh.points.map(p => p[axis]))]);
}
function manifold(mesh: Scrap) {
  const edges = new Map<string, number>();
  for (const triangle of mesh.triangles) for (let i = 0; i < 3; i++) {
    const key = [triangle[i], triangle[(i + 1) % 3]].sort((a, b) => a - b).join(','); edges.set(key, (edges.get(key) ?? 0) + 1);
  }
  expect([...edges.values()].every(count => count === 2)).toBe(true);
}
function lox(flags = 0, profile = 1) {
  const stationBytes = 104, bytes = new ArrayBuffer(16 + stationBytes + 16 + 92), data = new DataView(bytes);
  [2, stationBytes, 2, 0].forEach((v, i) => data.setUint32(i * 4, v, true));
  for (let i = 0; i < 2; i++) {
    const p = 16 + i * 52; data.setUint32(p, i, true);
    [1000000, 2000000 + i * 10, 100].forEach((v, axis) => data.setFloat64(p + 28 + axis * 8, v, true));
  }
  const p = 16 + stationBytes;
  [3, 92, 1, 0].forEach((v, i) => data.setUint32(p + i * 4, v, true));
  data.setUint32(p + 20, 1, true);
  [...dimensions, ...dimensions].forEach((v, i) => data.setFloat64(p + 24 + i * 8, v, true));
  data.setUint32(p + 88, flags, true); data.setUint32(p + 92, profile, true); data.setFloat64(p + 100, 60, true);
  return bytes;
}
function fixture(name: string) {
  const bytes = readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}
const text = (s: string) => new TextEncoder().encode(s).buffer;

describe('LRUD loft geometry', () => {
  it.each([1, 2, 3, 4])('honors left/right/up/down dimensions and outward winding for profile %s', profile => {
    const [mesh] = [...generateLRUDWalls([leg(undefined, undefined, profile)])];
    expect(bounds(mesh)).toEqual([[-1, 2], [0, 10], [-4, 3]]);
    expect(mesh.triangles).toHaveLength(32); manifold(mesh);
    for (const [a, b, c] of mesh.triangles) {
      const p = mesh.points[a], q = mesh.points[b], r = mesh.points[c];
      const u = q.map((v, i) => v - p[i]), v = r.map((v, i) => v - p[i]);
      const normal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const centre = p.map((v, i) => (v + q[i] + r[i]) / 3 - (i === 1 ? 5 : 0));
      expect(normal.reduce((sum, v, i) => sum + v * centre[i], 0)).toBeGreaterThan(0);
    }
  });

  it('welds shared cross-sections around a bend without an internal cap', () => {
    const [mesh] = [...generateLRUDWalls([leg([0, 0, 0], [0, 10, 0]), leg([0, 10, 0], [10, 10, 0])])];
    expect(mesh.points).toHaveLength(26); expect(mesh.triangles).toHaveLength(48); manifold(mesh);
  });

  it.each([10, -10])('handles vertical passages in either direction (%s)', height => {
    const [mesh] = [...generateLRUDWalls([leg([0, 0, 0], [0, 0, height])])];
    expect(mesh.points.flat().every(Number.isFinite)).toBe(true); manifold(mesh);
    expect(bounds(mesh)[2]).toEqual([Math.min(0, height), Math.max(0, height)]);
  });

  it('does not fabricate walls for missing/zero-size sections or zero-length legs', () => {
    const empty = leg(); empty.section.from = [-1, -1, -1, -1];
    const zero = leg(); zero.section.to = [0, 0, 0, 0];
    expect([...generateLRUDWalls([empty, zero, leg([0, 0, 0], [0, 0, 0])])]).toEqual([]);
    const partial = leg(); partial.section.from = [-1, 2, 3, 4]; partial.section.to = [-1, 2, 3, 4];
    expect(bounds([...generateLRUDWalls([partial])][0])[0]).toEqual([0, 2]);
  });

  it('bounds output batches for large surveys', () => {
    const legs = Array.from({ length: LRUD_BATCH_LEGS + 2 }, (_, i) => leg([0, i * 10, 0], [0, (i + 1) * 10, 0]));
    const meshes = [...generateLRUDWalls(legs)]; expect(meshes).toHaveLength(2);
    expect(meshes.every(mesh => mesh.triangles.length <= BATCH_TRIANGLES)).toBe(true);
    expect(meshes.reduce((sum, mesh) => sum + mesh.triangles.length, 0)).toBe(legs.length * 16 + 16);
  });
});

describe('LRUD file integration', () => {
  it('interpolates sparse cross-sections along bends instead of drawing a shortcut', () => {
    const model = new SurveyModel(), a: Point = [0, 0, 0], b: Point = [0, 10, 0], c: Point = [10, 10, 0];
    model.shot(a, b, 0); model.shot(b, c, 0); model.passage(a, c, dimensions, dimensions, 'passage');
    const walls = model.finish().scraps[0];
    expect(walls.points).toHaveLength(26); expect(walls.triangles).toHaveLength(48); manifold(walls);
  });

  it('does not model an explicitly excluded leg through an alternate underground route', () => {
    const model = new SurveyModel(), a: Point = [0, 0, 0], b: Point = [0, 10, 0], c: Point = [10, 10, 0];
    model.shot(a, b, 1); model.shot(a, c, 0); model.shot(c, b, 0); model.passage(a, b, dimensions, dimensions, 'passage');
    expect(model.finish().scraps).toEqual([]);
  });
  it('generates identical LOX wall triangles and bounds in the small and bounded worker loaders', async () => {
    const source = lox(), small = parseLox(source), batches: GeometryBatch[] = [];
    const large = await streamLargeLox(new Blob([source]), { progress() {}, async ready() {}, async batch(batch) { batches.push(batch); } });
    expect(small.scraps).toHaveLength(1); expect([small.minZ, small.maxZ]).toEqual([96, 103]);
    expect([large.minZ, large.maxZ]).toEqual([96, 103]);
    expect(large.min).toEqual([999999, 2000000, 96]); expect(large.max).toEqual([1000002, 2000010, 103]);
    expect(large.triangles).toBe(32); expect(large.scraps).toBe(1);
    const expected = small.scraps.flatMap(mesh => mesh.triangles.flatMap(triangle => triangle.flatMap(index => mesh.points[index])));
    const actual = batches.flatMap(batch => Array.from(batch.indices!).flatMap(index => Array.from(batch.positions.subarray(index * 3, index * 3 + 3), (value, axis) => value + large.origin[axis])));
    expect(actual).toHaveLength(expected.length);
    expected.forEach((value, i) => expect(actual[i]).toBeCloseTo(value, 5));
  });

  it.each([1, 2, 4, 8, 16])('omits LOX surface/duplicate/hidden/no-LRUD/splay legs (flag %s)', async flags => {
    const source = lox(flags); expect(parseLox(source).scraps).toEqual([]);
    const large = await streamLargeLox(new Blob([source]), { progress() {}, async ready() {}, async batch() { throw Error('Unexpected wall'); } });
    expect(large.triangles).toBe(0);
  });

  it('keeps existing LOX scraps and honors section None without duplicating sample walls', async () => {
    const sample = readFileSync('public/sample/demo.lox'), source = sample.buffer.slice(sample.byteOffset, sample.byteOffset + sample.byteLength);
    expect(parseLox(source).scraps).toHaveLength(1);
    expect(parseLox(lox(0, 0)).scraps).toEqual([]);
    const large = await streamLargeLox(new Blob([source]), { progress() {}, async ready() {}, async batch() {} });
    expect(large.triangles).toBe(48);
  });

  it('reads Survex passage dimensions and expands the cave color range to generated walls', () => {
    const model = parseSurvex(fixture('import-v8.3d'));
    expect(model.scraps).toHaveLength(1);
    expect(bounds(model.scraps[0])).toEqual([[1000, 1010], [1997, 2002], [90, 103]]);
    // The passage descends along X in this fixture; widths lie along Y.
  });

  it('maps Compass L,U,D,R feet to L,R,U,D metres and breaks on M or missing dimensions', () => {
    const model = parseCompass(text('Ntest\nM 0 0 0 S1 P 1 2 3 4\nD 10 0 0 S2 P 1 2 3 4\nM 20 0 0 S3 P 1 2 3 4\nD 30 0 0 S4\n'));
    expect(model.scraps).toHaveLength(1);
    const extents = bounds(model.scraps[0]);
    expect(extents[0][0]).toBeCloseTo(-.3048); expect(extents[0][1]).toBeCloseTo(4 * .3048);
    expect(extents[1]).toEqual([0, 10 * .3048]);
    expect(extents[2][0]).toBeCloseTo(-3 * .3048); expect(extents[2][1]).toBeCloseTo(2 * .3048);
    expect(parseCompass(text('Ntest\nM 0 0 0 S1 P -9999 999 -1 -1\nD 10 0 0 S2 P 1 2 3 4\n')).scraps).toEqual([]);
  });
});
