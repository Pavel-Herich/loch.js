import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseLox } from '../src/lox';
const fixture = readFileSync('public/sample/demo.lox');
const array = fixture.buffer.slice(fixture.byteOffset, fixture.byteOffset + fixture.byteLength);
describe('Therion LOX parser', () => {
  it('parses native chunk format stations, shots and triangles', () => {
    const model = parseLox(array);
    expect(model.stations.size).toBe(4);
    expect(model.shots).toHaveLength(3);
    expect(model.scraps).toHaveLength(1);
    expect(model.scraps[0].points).toHaveLength(32);
    expect(model.scraps[0].triangles).toHaveLength(48);
    expect(model.maxZ).toBeGreaterThan(model.minZ);
  });
  it('rejects truncated chunks', () => expect(() => parseLox(array.slice(0, array.byteLength-2))).toThrow());
  it('rejects unrecognized chunks', () => {
    const broken = array.slice(0); new DataView(broken).setUint32(0, 99, true);
    expect(() => parseLox(broken)).toThrow('Unsupported');
  });
  it('rejects invalid triangle indices', () => {
    const broken = array.slice(0); const bytes = new Uint8Array(broken);
    const view = new DataView(broken);
    // Last triangle index is at last 4 bytes.
    view.setUint32(bytes.length - 4, 999999, true);
    expect(() => parseLox(broken)).toThrow('outside point array');
  });
});
