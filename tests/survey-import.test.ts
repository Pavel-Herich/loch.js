import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSurvex } from '../src/survex';
import { parseCompass } from '../src/compass';
import { modelFileFormat, parseModelFile } from '../src/model-file';
import { SHOT_DUPLICATE, SHOT_SPLAY, SHOT_SURFACE } from '../src/lox-shots';
import { stationLabel } from '../src/lox-stations';
import { displayProjectTitle } from '../src/lox-title';

// Binary fixtures were generated from fixtures/import.svx using Cavern 1.4.4
// with --3d-version=3 through --3d-version=8. No Survex installation is needed to run these tests.
function fixture(name: string) {
  const bytes = readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}
function bytes(...parts: (number[] | Uint8Array | string)[]) {
  const chunks = parts.map(part => typeof part === 'string' ? new TextEncoder().encode(part) : new Uint8Array(part));
  const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let p = 0; for (const chunk of chunks) { result.set(chunk, p); p += chunk.length; } return result.buffer;
}
function point(x: number, y = 0, z = 0) {
  const b = new Uint8Array(12), v = new DataView(b.buffer);
  [x, y, z].forEach((value, i) => v.setInt32(i * 4, Math.round(value * 100), true)); return b;
}
const header = 'Survex 3D Image File\nv8\nUTF-8 cave\0EPSG:32633\0/\n@0\n\x00';

describe('Survex .3d import', () => {
  it.each([3, 4, 5, 6, 7, 8])('reads a Cavern-generated v%s export including dates and passage records', version => {
    const model = parseSurvex(fixture(`import-v${version}.3d`));
    expect(model.title).toBe('Import test cave');
    expect(model.shots).toHaveLength(4);
    expect(model.shots.map(shot => shot.flags)).toEqual([0, SHOT_SURFACE, SHOT_DUPLICATE, SHOT_SPLAY]);
    expect(model.shots[0]).toEqual({ from: [1000, 2000, 100], to: [1010, 2000, 95], flags: 0 });
    expect([model.minZ, model.maxZ]).toEqual([87, version >= 5 ? 103 : 100]);
    const stations = model.stationDetails;
    for (const station of stations) expect(model.stations.get(station.id)).toEqual(station.position);
    expect(stations).toHaveLength(5);
    const one = stations.find(station => station.name === '1')!;
    expect(one.flags).toBe(4); expect(one.survey).toBe('branch'); expect(one.fullSurvey).toBe('branch.root');
    expect(stationLabel(one, 'full')).toBe('1@branch.root');
    expect(stations.find(station => station.name === '3')!.flags).toBe(1);
    expect(stations.find(station => station.name === '2')!.flags).toBe(0);
    expect(stations.some(station => station.name === '-')).toBe(true);
    expect(model.scraps).toHaveLength(version >= 5 ? 1 : 0); expect(model.surfaces).toEqual([]);
  });

  it('decodes byte-based UTF-8 prefix compression, extended lengths and custom hierarchy separators', () => {
    const first = new TextEncoder().encode('root/ž1'), second = new TextEncoder().encode('ž2');
    const buffer = bytes(header, [0, 15], point(-5, 2, -10),
      [0x82, 0, 0, first.length], first, point(-5, 2, -10),
      [0x82, (3 << 4) | second.length], second, point(-4, 2, -9),
      [0x64], point(-4, 2, -9), [0]);
    const model = parseSurvex(buffer);
    expect(model.stationDetails.map(station => station.name)).toEqual(['ž1', '-']);
    expect(model.stationDetails[0].fullSurvey).toBe('root');
    expect(model.shots[0].flags).toBe(SHOT_SPLAY);
  });

  it('does not change the drawing position when a station label appears within a traverse', () => {
    const buffer = bytes(header, [0, 15], point(1), [0x60], point(2), [0x82, 1], 'a', point(99), [0x60], point(3), [0]);
    expect(parseSurvex(buffer).shots.map(shot => [shot.from[0], shot.to[0]])).toEqual([[1, 2], [2, 3]]);
  });

  it('rejects missing headers, unsupported versions, truncated records and corrupt label prefixes', () => {
    expect(() => parseSurvex(bytes('not a 3d file\n'))).toThrow('Not a Survex');
    expect(() => parseSurvex(bytes('Survex 3D Image File\nv9\n'))).toThrow('Unsupported');
    const valid = fixture('import-v8.3d'); expect(() => parseSurvex(valid.slice(0, -1))).toThrow('Truncated');
    expect(() => parseSurvex(bytes(header, [0, 0x82, 0xf1], 'x', point(0), [0]))).toThrow('prefix');
    expect(() => parseSurvex(bytes(header, [0, 0x60], point(0), [0]))).toThrow('MOVE');
    expect(() => parseSurvex(bytes(header, [0, 15], [1, 2, 3]))).toThrow('Truncated');
  });
});

describe('Compass .plt import', () => {
  it('converts North/East/Up feet into East/North/Up metres and keeps flags, names and survey groups', () => {
    const model = parseCompass(fixture('import.plt'));
    expect(model.title).toBe('Compass import cave'); expect(model.shots).toHaveLength(5);
    expect(model.shots.map(shot => shot.flags)).toEqual([0, SHOT_SURFACE, SHOT_DUPLICATE, SHOT_SPLAY, 0]);
    [60.96, 30.48, 91.44].forEach((value, axis) => expect(model.shots[0].from[axis]).toBeCloseTo(value));
    expect(model.minZ).toBeCloseTo(250 * .3048); expect(model.maxZ).toBeCloseTo(302 * .3048);
    const one = model.stationDetails.find(station => station.name === '1')!;
    for (const station of model.stationDetails) expect(model.stations.get(station.id)).toEqual(station.position);
    expect(stationLabel(one, 'short')).toBe('1@main'); expect(stationLabel(one, 'full')).toBe('1@main.Compass import cave');
    expect(model.stationDetails.find(station => station.name === '3')!.flags).toBe(1);
    expect(model.stationDetails.filter(station => station.name === '2')).toHaveLength(1);
    expect(model.stationDetails.some(station => station.name === 'wall')).toBe(false);
    expect(model.stationDetails.some(station => station.name.startsWith('feature'))).toBe(false);
  });

  it('accepts CRLF, scientific notation, legacy text, control-Z and traverses crossing survey boundaries', () => {
    const buffer = bytes('S', [0xe9], ' cave\r\nNone\r\nM 1e2 2e2 -3e1 S0\r\nNtwo\r\nD 1.1e2 2.2e2 -4e1 S1\r\n', [26], 'ignored trailing text');
    const model = parseCompass(buffer);
    expect(model.title).toBe('é cave'); expect(model.shots).toHaveLength(1);
    expect(model.shots[0].to[2]).toBeCloseTo(-12.192);
  });

  it('keeps disconnected traverses disconnected and accepts a first draw as a move', () => {
    const model = parseCompass(bytes('Ntest\nD 0 0 0 S1\nD 1 1 1 S2\nM 9 9 9 S9\nD 10 10 10 S10\n'));
    expect(model.shots).toHaveLength(2);
    expect(model.shots[1].from[0]).toBeCloseTo(9 * .3048);
  });

  it('rejects empty files, malformed coordinates, missing names and unknown commands with useful errors', () => {
    expect(() => parseCompass(bytes(''))).toThrow('No survey geometry');
    expect(() => parseCompass(bytes('Ntest\nM invalid S1'))).toThrow('line 2');
    expect(() => parseCompass(bytes('M 1 2 3'))).toThrow('station name');
    expect(() => parseCompass(bytes('M 1e999 0 0 S1'))).toThrow('coordinate');
    expect(() => parseCompass(bytes('this is not a plot file'))).toThrow('command');
  });
});

describe('model file selection', () => {
  it('dispatches all supported extensions case-insensitively and reports unsupported formats', () => {
    expect(modelFileFormat('cave.3D')).toBe('3d'); expect(modelFileFormat('cave.PLT')).toBe('plt');
    expect(modelFileFormat('cave.LOX')).toBe('lox'); expect(modelFileFormat('cave.txt')).toBeUndefined();
    expect(parseModelFile(fixture('import-v8.3d'), 'cave.3D').shots).toHaveLength(4);
    expect(parseModelFile(fixture('import.plt'), 'cave.PLT').shots).toHaveLength(5);
    expect(() => parseModelFile(bytes(''), 'file.txt')).toThrow('Unsupported file type');
    expect(displayProjectTitle(undefined, 'cave.3D')).toBe('cave'); expect(displayProjectTitle(undefined, 'cave.PLT')).toBe('cave');
  });
});
