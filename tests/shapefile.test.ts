import { describe, expect, it } from 'vitest';
import { guessCoordinates, layerPoints, nameField, parseDbf, parseShp } from '../src/shapefile';

function shp(type: number, records: number[][][], z = false) {
  const bodies = records.map(points => {
    if (type === 1 || type === 11) {
      const view = new DataView(new ArrayBuffer(type === 11 ? 36 : 20));
      view.setInt32(0, type, true); view.setFloat64(4, points[0][0], true); view.setFloat64(12, points[0][1], true);
      if (type === 11) view.setFloat64(20, points[0][2], true);
      return view;
    }
    // PolyLine(Z) with one part.
    const n = points.length, size = 44 + 4 + n * 16 + (z ? 16 + n * 8 : 0);
    const view = new DataView(new ArrayBuffer(size));
    view.setInt32(0, type, true); view.setInt32(36, 1, true); view.setInt32(40, n, true); view.setInt32(44, 0, true);
    points.forEach(([x, y], i) => { view.setFloat64(48 + i * 16, x, true); view.setFloat64(56 + i * 16, y, true); });
    if (z) points.forEach(([, , h], i) => view.setFloat64(48 + n * 16 + 16 + i * 8, h, true));
    return view;
  });
  const total = 100 + bodies.reduce((sum, body) => sum + 8 + body.byteLength, 0);
  const bytes = new Uint8Array(total), view = new DataView(bytes.buffer);
  view.setInt32(0, 9994, false); view.setInt32(24, total / 2, false); view.setInt32(28, 1000, true); view.setInt32(32, type, true);
  let offset = 100;
  bodies.forEach((body, i) => {
    view.setInt32(offset, i + 1, false); view.setInt32(offset + 4, body.byteLength / 2, false);
    bytes.set(new Uint8Array(body.buffer), offset + 8); offset += 8 + body.byteLength;
  });
  return bytes.buffer;
}

function dbf(fields: [string, number][], rows: string[][]) {
  const header = 32 + fields.length * 32 + 1, recordLength = 1 + fields.reduce((sum, [, length]) => sum + length, 0);
  const bytes = new Uint8Array(header + rows.length * recordLength + 1), view = new DataView(bytes.buffer), ascii = new TextEncoder();
  bytes[0] = 3; view.setUint32(4, rows.length, true); view.setUint16(8, header, true); view.setUint16(10, recordLength, true);
  fields.forEach(([name, length], i) => { bytes.set(ascii.encode(name), 32 + i * 32); bytes[32 + i * 32 + 11] = 67; bytes[32 + i * 32 + 16] = length; });
  bytes[header - 1] = 0x0d;
  rows.forEach((row, r) => {
    let at = header + r * recordLength; bytes[at++] = 32;
    row.forEach((value, i) => { const text = ascii.encode(value.padEnd(fields[i][1])); bytes.set(text.subarray(0, fields[i][1]), at); at += fields[i][1]; });
  });
  return bytes.buffer;
}

describe('SHP layers', () => {
  it('reads PointZ records in S-JTSK like the model', () => {
    const { type, points } = parseShp(shp(11, [[[-378181.05, -1201810.06, 1138.68]], [[-378781.56, -1201528.98, 1302.18]]]));
    expect(type).toBe('PointZ');
    expect(points).toEqual([{ x: -378181.05, y: -1201810.06, z: 1138.68, record: 0 }, { x: -378781.56, y: -1201528.98, z: 1302.18, record: 1 }]);
    expect(guessCoordinates(points)).toBe('sjtsk');
  });

  it('takes every line vertex, labels only the first, and flips positive JTSK', () => {
    const { points } = parseShp(shp(13, [[[378000, 1201000, 900], [378010, 1201020, 905]]], true));
    expect(points.map(p => p.z)).toEqual([900, 905]);
    const guess = guessCoordinates(points);
    expect(guess).toBe('jtsk-positive');
    expect(layerPoints(points, guess, () => 'Sindliarka', () => ({ ID: '7' }))).toEqual([
      { east: -378000, north: -1201000, z: 900, label: 'Sindliarka', record: 0, attributes: { ID: '7' } },
      { east: -378010, north: -1201020, z: 905, label: '', record: 0 }]);
  });

  it('converts WGS 84 points and recognises them from the .prj', () => {
    const { points } = parseShp(shp(1, [[[19.741300668, 48.985971893]]]));
    expect(guessCoordinates(points, 'GEOGCS["GCS_WGS_1984"]')).toBe('wgs84');
    const [point] = layerPoints(points, 'wgs84', () => '');
    expect(point.east).toBeCloseTo(-372234.807, 1); expect(point.north).toBeCloseTo(-1203810.66, 1); expect(point.z).toBeNull();
  });

  it('reads names from the .dbf', () => {
    const records = parseDbf(dbf([['ID', 4], ['NAZOV', 12]], [['1', 'Ponor A'], ['2', 'Zavrt B']]));
    expect(records).toEqual([{ ID: '1', NAZOV: 'Ponor A' }, { ID: '2', NAZOV: 'Zavrt B' }]);
    expect(nameField(records)).toBe('NAZOV');
  });
});

import { browsablePoints } from '../src/layers-ui';
describe('SHP browser', () => {
  it('lists each shape once: every point, and lines by their first vertex', () => {
    const point = (record?: number) => ({ east: 0, north: 0, z: null, label: '', record });
    expect(browsablePoints({ id: 'a', name: 'a', color: '#fff', source: '', points: [point(0), point(1), point(2)] })).toEqual([0, 1, 2]);
    expect(browsablePoints({ id: 'b', name: 'b', color: '#fff', source: '', points: [point(0), point(0), point(1), point(1), point(1)] })).toEqual([0, 2]);
    // Layers saved before records were kept list every vertex.
    expect(browsablePoints({ id: 'c', name: 'c', color: '#fff', source: '', points: [point(), point()] })).toEqual([0, 1]);
  });
});
