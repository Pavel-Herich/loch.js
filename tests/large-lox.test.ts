import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseLox } from '../src/lox';
import { BATCH_TRIANGLES, READ_BYTES, streamLargeLox, type GeometryBatch } from '../src/large-lox';

const fixture = readFileSync('public/sample/demo.lox');
function source(blob: Blob) {
  const reads: number[] = [];
  return { size: blob.size, reads, slice(start = 0, end = blob.size) { reads.push(end - start); return blob.slice(start, end); } };
}
async function load(blob: Pick<Blob, 'size' | 'slice'>) {
  const batches: GeometryBatch[] = [];
  const model = await streamLargeLox(blob, { progress() {}, async ready() {}, async batch(batch) { batches.push(batch); } });
  return { model, batches };
}

function scrap(points: number, triangles: number, point: (i: number) => number[], triangle: (i: number) => number[]) {
  const buffer = new ArrayBuffer(48 + points * 24 + triangles * 12), d = new DataView(buffer);
  [4, 32, 1, points * 24 + triangles * 12].forEach((n, i) => d.setUint32(i * 4, n, true));
  [0, 0, points, 0, points * 24, triangles, points * 24, triangles * 12].forEach((n, i) => d.setUint32(16 + i * 4, n, true));
  for (let i = 0; i < points; i++) point(i).forEach((n, axis) => d.setFloat64(48 + i * 24 + axis * 8, n, true));
  for (let i = 0; i < triangles; i++) triangle(i).forEach((n, axis) => d.setUint32(48 + points * 24 + i * 12 + axis * 4, n, true));
  return buffer;
}

describe('bounded full-detail LOX loading', () => {
  it('matches the existing parser without changing triangles', async () => {
    const expected = parseLox(fixture.buffer.slice(fixture.byteOffset, fixture.byteOffset + fixture.byteLength));
    const { model, batches } = await load(new Blob([fixture]));
    expect(model.shots).toEqual(expected.shots);
    expect([model.minZ, model.maxZ]).toEqual([expected.minZ, expected.maxZ]);
    const original = expected.scraps.flatMap(s => s.triangles.flatMap(t => t.flatMap(i => s.points[i])));
    const decoded = batches.flatMap(b => Array.from(b.indices || Uint32Array.from({ length: b.positions.length / 3 }, (_, i) => i))
      .flatMap(i => Array.from(b.positions.subarray(i * 3, i * 3 + 3), (v, axis) => v + model.origin[axis])));
    expect(decoded).toHaveLength(original.length);
    for (let i = 0; i < original.length; i++) expect(decoded[i]).toBeCloseTo(original[i], 5);
  });

  it('handles offsets above 2 GiB without reading a complete file or ignored blobs', async () => {
    const gap = 0x80000100, start = 16 + gap;
    const header = new ArrayBuffer(16); const d = new DataView(header);
    d.setUint32(0, 1, true); d.setUint32(12, gap, true);
    const reads: [number, number][] = [];
    const file = {
      size: start + fixture.length,
      slice(from = 0, to = start + fixture.length) {
        reads.push([from, to]);
        if (from === 0 && to === 16) return new Blob([header]);
        if (from < start) throw new Error('Attempted to read ignored blob');
        return new Blob([fixture.subarray(from - start, to - start)]);
      },
    };
    const { model } = await load(file);
    expect(model.triangles).toBe(48);
    expect(reads.some(([from]) => from > 0x80000000)).toBe(true);
    expect(reads.every(([from, to]) => to - from <= READ_BYTES)).toBe(true);
  });

  it('splits triangle soup into bounded batches with no redundant index buffers', async () => {
    const count = BATCH_TRIANGLES + 1;
    const file = source(new Blob([scrap(count * 3, count, i => [10000000 + i * .01, i % 7, i % 11], i => [i * 3, i * 3 + 1, i * 3 + 2])]));
    const { model, batches } = await load(file);
    expect(model.triangles).toBe(count);
    expect(batches.map(b => b.triangles)).toEqual([BATCH_TRIANGLES, 1]);
    expect(batches.every(b => !b.indices && b.positions.length === b.triangles * 9)).toBe(true);
    expect(Math.max(...file.reads)).toBeLessThanOrEqual(READ_BYTES);
    expect(batches[0].positions[0]).toBeCloseTo(10000000 - model.origin[0], 3);
  });

  it('preserves winding and shared, unsorted vertex references', async () => {
    const { batches } = await load(new Blob([scrap(4, 2, i => [i, i * 2, i * 3], i => i ? [2, 1, 3] : [2, 0, 1])]));
    expect(Array.from(batches[0].indices!)).toEqual([2, 0, 1, 2, 1, 3]);
    expect(batches[0].positions.length).toBe(12);
  });

  it('reads widely separated indexed vertices in bounded source ranges', async () => {
    const last = Math.floor(READ_BYTES / 24) + 1;
    const file = source(new Blob([scrap(last + 1, 1, i => [i, i % 3, 0], () => [0, last, 10])]));
    const { model, batches } = await load(file);
    expect(Array.from(batches[0].indices!)).toEqual([0, 2, 1]);
    expect(batches[0].positions[6] + model.origin[0]).toBe(last);
    expect(Math.max(...file.reads)).toBeLessThanOrEqual(READ_BYTES);
  });

  it('rejects bad pointers, indices, coordinates, and truncated files', async () => {
    const good = scrap(3, 1, i => [i, i, i], () => [0, 1, 2]);
    const pointer = good.slice(0); new DataView(pointer).setUint32(28, 1000000, true);
    await expect(load(new Blob([pointer]))).rejects.toThrow('pointer');
    const index = good.slice(0); new DataView(index).setUint32(index.byteLength - 4, 3, true);
    await expect(load(new Blob([index]))).rejects.toThrow('outside point array');
    const coordinate = good.slice(0); new DataView(coordinate).setFloat64(48, NaN, true);
    await expect(load(new Blob([coordinate]))).rejects.toThrow('coordinate');
    await expect(load(new Blob([good.slice(0, -1)]))).rejects.toThrow('Truncated');
  });
});
