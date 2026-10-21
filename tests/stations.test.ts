import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { parseCompass } from '../src/compass';
import { parseLox } from '../src/lox';
import { streamLargeLox } from '../src/large-lox';
import { resolveStationSurveys, stationLabel, type Station, type StationLabel } from '../src/lox-stations';
import { StationScene, stationVisible, stationMarker, type StationOptions } from '../src/stations';

function chunk(kind: number, width: number, rows: ((view: DataView, p: number, text: (value: string) => [number, number]) => void)[]) {
  const strings: Uint8Array[] = []; let length = 0;
  const records = new Uint8Array(rows.length * width), view = new DataView(records.buffer);
  rows.forEach((row, index) => row(view, index * width, value => {
    const bytes = new TextEncoder().encode(value + '\0'), ref: [number, number] = [length, bytes.length];
    strings.push(bytes); length += bytes.length; return ref;
  }));
  const result = new Uint8Array(16 + records.length + length), header = new DataView(result.buffer);
  [kind, records.length, rows.length, length].forEach((value, index) => header.setUint32(index * 4, value, true));
  result.set(records, 16); let offset = 16 + records.length;
  for (const text of strings) { result.set(text, offset); offset += text.length; }
  return result;
}
function fixture(comments = false) {
  const surveys = chunk(1, 24, [[30, 20, 'branch'], [10, 10, 'world'], [20, 10, 'part']].map(([id, parent, name]) => (v, p, text) => {
    const [offset, size] = text(String(name));
    [Number(id), offset, size, Number(parent), 0, 0].forEach((value, index) => v.setUint32(p + index * 4, value, true));
  }));
  const stations = chunk(2, 52, ['1', 'ž2', '.', '-'].map((name, index) => (v, p, text) => {
    const [offset, size] = text(name);
    const [commentOffset, commentSize] = comments && index === 0 ? text('Entrance — waterfall') : [0, 0];
    [101 + index, 30, offset, size, commentOffset, commentSize, index === 1 ? 1 : 0].forEach((value, i) => v.setUint32(p + i * 4, value, true));
    [1000 + index * 10, 2000, 123.4 + index].forEach((value, axis) => v.setFloat64(p + 28 + axis * 8, value, true));
  }));
  // Stations may precede their survey records.
  const bytes = new Uint8Array(stations.length + surveys.length); bytes.set(stations); bytes.set(surveys, stations.length);
  return bytes.buffer;
}
async function large(data: ArrayBuffer) { return streamLargeLox(new Blob([data]), { progress() {}, async ready() {}, async batch() {} }); }
const options: StationOptions = { stations: true, entrance: false, fixed: false, continuation: false, label: 'none', surface: true, underground: true, splay: true };

describe('station metadata, dots and labels', () => {
  it('preserves station names, flags, elevations and nested survey paths identically in both loaders', async () => {
    const small = parseLox(fixture()), streamed = await large(fixture());
    expect(streamed.stationDetails).toEqual(small.stationDetails);
    expect(small.stationDetails[0]).toEqual({ id: 101, surveyId: 30, name: '1', flags: 0,
      position: [1000, 2000, 123.4], survey: 'branch', fullSurvey: 'branch.part.world' });
    expect(small.stationDetails[1].name).toBe('ž2'); expect(small.stationDetails[1].flags).toBe(1);
  });

  it('formats None/Number/Short/Full/Altitude and skips temporary station labels', () => {
    const stations = parseLox(fixture()).stationDetails;
    const modes: StationLabel[] = ['none', 'number', 'short', 'full', 'altitude'];
    expect(modes.map(mode => stationLabel(stations[0], mode))).toEqual(['', '1', '1@branch', '1@branch.part.world', '123 m']);
    for (const station of stations.slice(2)) expect(modes.map(mode => stationLabel(station, mode))).toEqual(['', '', '', '', '']);
    expect(stationLabel({ ...stations[0], name: '', survey: '', fullSurvey: '' }, 'full')).toBe('101');
  });

  it('rejects corrupt station name pointers in both loaders', async () => {
    const data = fixture(); new DataView(data).setUint32(16 + 8, 0xffffffff, true);
    expect(() => parseLox(data)).toThrow('station name pointer');
    await expect(large(data)).rejects.toThrow('station name pointer');
  });

  it('preserves comments in both LOX loaders and offers a comments-only label mode', async () => {
    const small = parseLox(fixture(true)), streamed = await large(fixture(true));
    expect(streamed.stationDetails).toEqual(small.stationDetails);
    expect(stationLabel(small.stationDetails[0], 'comments')).toBe('Entrance — waterfall');
    expect(stationLabel(small.stationDetails[1], 'comments')).toBe('');
    expect(stationLabel({ ...small.stationDetails[2], comment: 'temporary' }, 'comments')).toBe('');
  });

  it('rejects corrupt comment pointers in both LOX loaders', async () => {
    const data = fixture(true); new DataView(data).setUint32(16 + 16, 0xffffffff, true);
    expect(() => parseLox(data)).toThrow('station comment pointer');
    await expect(large(data)).rejects.toThrow('station comment pointer');
  });

  it('keeps a comment added on a repeated Compass station without treating its contents as shot flags', () => {
    const data = new TextEncoder().encode('Nsurvey\nM0 0 0 SA\nD1 0 0 SB\nM0 0 0 SA "Entrance FS"\n');
    const model = parseCompass(data.buffer);
    expect(model.stationDetails).toHaveLength(2);
    expect(model.stationDetails.find(station => station.name === 'A')?.comment).toBe('Entrance FS');
    expect(model.shots[0].flags).toBe(0);
  });

  it('handles missing surveys and cycles without looping or inventing a survey path', () => {
    const stations = parseLox(fixture()).stationDetails;
    const surveys = new Map([[30, { id: 30, parent: 20, name: 'child' }], [20, { id: 20, parent: 30, name: 'parent' }]]);
    expect(resolveStationSurveys(stations, surveys)[0].fullSurvey).toBe('child.parent');
    expect(resolveStationSurveys(stations, new Map())[0].fullSurvey).toBe('');
  });

  it('batches white fixed-size station dots, recenters coordinates and disposes old resources', () => {
    const group = new THREE.Group(), scene = new StationScene(group), stations = parseLox(fixture()).stationDetails;
    scene.setModel(stations, new THREE.Vector3(1000, 2000, 100));
    expect(group.children).toHaveLength(2);
    expect(group.children.every(point => !point.visible)).toBe(true);
    scene.setOptions(options);
    expect(group.children.reduce((count, child) => count + (child as THREE.Points).geometry.getAttribute('position').count, 0)).toBe(2);
    const underground = group.children.find(p => p.name === 'Stations 0') as THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
    const surface = group.children.find(p => p.name === 'Stations 1') as typeof underground;
    expect(Array.from(underground.geometry.getAttribute('position').array)).toEqual([0, 0, expect.closeTo(23.4)]);
    expect(underground.material.color.getHex()).toBe(0xffffff); expect(surface.material.color.getHex()).toBe(0xffffff);
    expect(underground.material.size).toBe(3); expect(underground.material.sizeAttenuation).toBe(false);
    scene.setOptions({ ...options, surface: false, splay: false });
    expect(group.children.filter(p => p.visible)).toEqual([underground, surface]);
    scene.setOptions({ ...options, stations: false }); expect(group.children.every(p => !p.visible)).toBe(true);
    const dispose = vi.fn(); underground.geometry.addEventListener('dispose', dispose); underground.material.addEventListener('dispose', dispose);
    scene.clear(); expect(dispose).toHaveBeenCalledTimes(2); expect(group.children).toHaveLength(0);
  });

  it('respects surface, underground, splay and station visibility', () => {
    const stations = parseLox(fixture()).stationDetails;
    expect(stations.map(station => stationVisible(station, options))).toEqual([true, true, false, false]);
    expect(stationVisible(stations[0], { ...options, underground: false })).toBe(false);
    expect(stationVisible(stations[1], { ...options, surface: false })).toBe(true);
    expect(stationVisible(stations[2], { ...options, splay: false })).toBe(false);
    expect(stationVisible(stations[3], { ...options, splay: true })).toBe(false);
    expect(stationVisible(stations[0], { ...options, splay: false })).toBe(true);
    expect(stations.some(station => stationVisible(station, { ...options, stations: false }))).toBe(false);
  });

  it('selects special stations without All and keeps surface, entrance and fixed markers independent of centreline filters', () => {
    const base = parseLox(fixture()).stationDetails[0];
    const hidden = { ...options, stations: false, surface: false, underground: false };
    const entrance = { ...base, flags: 2 }, fixed = { ...base, flags: 4 }, continuation = { ...base, flags: 8 };
    expect(stationVisible(entrance, hidden)).toBe(false);
    expect(stationMarker(entrance, { ...hidden, entrance: true })).toBe('entrance');
    expect(stationVisible(entrance, { ...hidden, entrance: true })).toBe(true);
    expect(stationMarker(fixed, { ...hidden, fixed: true })).toBe('fixed');
    expect(stationVisible(fixed, { ...hidden, fixed: true })).toBe(true);
    expect(stationVisible(continuation, { ...hidden, continuation: true })).toBe(false);
    expect(stationMarker(continuation, { ...hidden, continuation: true, underground: true })).toBe('continuation');
    expect(stationMarker({ ...continuation, flags: 9 }, { ...hidden, continuation: true })).toBe('continuation');
    for (const flags of [1, 2, 4, 3, 5, 7]) {
      expect(stationVisible({ ...base, flags }, { ...hidden, stations: true })).toBe(true);
    }
    expect(stationVisible(base, { ...hidden, stations: true })).toBe(false);
    expect(stationMarker({ ...base, flags: 14 }, { ...hidden, entrance: true, fixed: true, continuation: true })).toBe('entrance');
    expect(stationMarker({ ...base, flags: 14, name: '.' }, { ...options, entrance: true })).toBeUndefined();
  });

  it('projects labels with the camera, skips points behind it and hides them with master visibility', () => {
    const context = { setTransform: vi.fn(), clearRect: vi.fn(), strokeText: vi.fn(), fillText: vi.fn(), measureText: vi.fn((text: string) => ({ width: text.length * 7 })) };
    const canvas = { hidden: true, width: 0, height: 0, getContext: () => context } as unknown as HTMLCanvasElement;
    const group = new THREE.Group(), scene = new StationScene(group, canvas);
    const station: Station = { id: 1, surveyId: 0, name: '1', flags: 0, position: [0, 0, -10], survey: '', fullSurvey: '' };
    const camera = new THREE.PerspectiveCamera(45, 4 / 3, .1, 100);
    vi.stubGlobal('devicePixelRatio', 2);
    try {
      scene.setModel([station, { ...station, name: 'behind', position: [0, 0, 10] }], new THREE.Vector3());
      scene.setOptions({ ...options, label: 'number' }); scene.updateLabels(camera, 800, 600);
      expect(canvas.hidden).toBe(false); expect(canvas.width).toBe(1600);
      expect(context.fillText).toHaveBeenCalledExactlyOnceWith('1', 405, 300);
      group.visible = false; scene.updateLabels(camera, 800, 600); expect(canvas.hidden).toBe(true);
      group.visible = true; scene.setOptions({ ...options, label: 'none' }); expect(canvas.hidden).toBe(true);
      scene.clear();
    } finally { vi.unstubAllGlobals(); }
  });
});
