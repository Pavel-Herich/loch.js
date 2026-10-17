import { describe, expect, it } from 'vitest';
import { parseLox } from '../src/lox';
import { streamLargeLox } from '../src/large-lox';
import { SHOT_SURFACE, SHOT_SPLAY, SHOT_DUPLICATE, SHOT_NOT_VISIBLE } from '../src/lox-shots';

function chunk(kind: number, records: Uint8Array, count: number, data = new Uint8Array(0)) {
  const bytes = new Uint8Array(16 + records.length + data.length), view = new DataView(bytes.buffer);
  [kind, records.length, count, data.length].forEach((value, index) => view.setUint32(index * 4, value, true));
  bytes.set(records, 16); bytes.set(data, 16 + records.length); return bytes;
}
function combine(parts: Uint8Array[]) {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes.buffer;
}
function fixture(walls = true, underground = true) {
  const heights = [-10000, 10000, 100, 200, 80, 220, 90000, -90000, 50000];
  const stations = new Uint8Array(heights.length * 52), sv = new DataView(stations.buffer);
  heights.forEach((z, index) => {
    sv.setUint32(index * 52, index, true);
    sv.setFloat64(index * 52 + 28, index, true); sv.setFloat64(index * 52 + 44, z, true);
  });
  const refs = [[0, 1, SHOT_SURFACE], [3, 6, SHOT_SURFACE | SHOT_SPLAY], [2, 7, SHOT_NOT_VISIBLE],
    ...(underground ? [[2, 3, 0], [2, 4, SHOT_SPLAY], [3, 5, SHOT_DUPLICATE]] : [])];
  const shots = new Uint8Array(refs.length * 92), sh = new DataView(shots.buffer);
  refs.forEach(([from, to, flags], index) => {
    sh.setUint32(index * 92, from, true); sh.setUint32(index * 92 + 4, to, true); sh.setUint32(index * 92 + 72, flags, true);
  });
  const parts = [chunk(2, stations, heights.length), chunk(3, shots, refs.length)];
  if (walls) {
    const records = new Uint8Array(32), data = new Uint8Array(84), r = new DataView(records.buffer), d = new DataView(data.buffer);
    [0, 0, 3, 0, 72, 1, 72, 12].forEach((value, index) => r.setUint32(index * 4, value, true));
    [70, 230, 150].forEach((z, index) => {
      d.setFloat64(index * 24, index, true); d.setFloat64(index * 24 + 8, index % 2, true); d.setFloat64(index * 24 + 16, z, true);
      d.setUint32(72 + index * 4, index, true);
    });
    parts.push(chunk(4, records, 1, data));
  }
  const surface = new Uint8Array(68), terrain = new Uint8Array(32), sf = new DataView(surface.buffer), td = new DataView(terrain.buffer);
  [1, 2, 2, 0, 32].forEach((value, index) => sf.setUint32(index * 4, value, true));
  [0, 0, 1, 0, 0, 1].forEach((value, index) => sf.setFloat64(20 + index * 8, value, true));
  for (let i = 0; i < 4; i++) td.setFloat64(i * 8, 100000 + i, true);
  parts.push(chunk(5, surface, 1, terrain));
  return combine(parts);
}

describe('cave color scale range', () => {
  it.each([[true, true, 70, 230], [false, true, 80, 220], [true, false, 70, 230], [false, false, 0, 0]])(
    'uses underground shots and walls only (walls=%s, underground=%s)', async (walls, underground, low, high) => {
      const data = fixture(Boolean(walls), Boolean(underground));
      const small = parseLox(data), large = await streamLargeLox(new Blob([data]), { progress() {}, async ready() {}, async batch() {} });
      expect([small.minZ, small.maxZ]).toEqual([low, high]);
      expect([large.minZ, large.maxZ]).toEqual([low, high]);
      // Surface, isolated, and hidden-shot stations still affect fitting, not colors.
      expect(large.min[2]).toBe(-90000); expect(large.max[2]).toBe(100003);
      expect(small.surfaces).toHaveLength(1); expect(small.stations.size).toBe(9);
    },
  );
});
