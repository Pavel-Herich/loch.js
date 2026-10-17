import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { parseLox } from '../src/lox';
import { streamLargeLox } from '../src/large-lox';
import { SHOT_SURFACE, SHOT_DUPLICATE, SHOT_NOT_VISIBLE, SHOT_SPLAY, type Shot } from '../src/lox-shots';
import { CentrelineScene, DEFAULT_CENTRELINE_OPTIONS, centrelineColor, centrelineVisible } from '../src/centreline';

const range = { minZ: 100, maxZ: 110 };
const flags = [0, SHOT_SURFACE, SHOT_DUPLICATE, SHOT_SPLAY, SHOT_SURFACE | SHOT_DUPLICATE,
  SHOT_SURFACE | SHOT_SPLAY, SHOT_DUPLICATE | SHOT_SPLAY, SHOT_NOT_VISIBLE, SHOT_NOT_VISIBLE | SHOT_SURFACE];
function fixture() {
  const stationBytes = 4 * 52, shotBytes = (flags.length + 1) * 92;
  const data = new ArrayBuffer(16 + stationBytes + 16 + shotBytes), view = new DataView(data);
  [2, stationBytes, 4, 0].forEach((v, i) => view.setUint32(i * 4, v, true));
  for (let i = 0; i < 4; i++) {
    const p = 16 + i * 52;
    view.setUint32(p, i, true);
    [1000 + i * 10, 2000, 100 + i * 3].forEach((v, axis) => view.setFloat64(p + 28 + axis * 8, v, true));
  }
  const start = 16 + stationBytes;
  [3, shotBytes, flags.length + 1, 0].forEach((v, i) => view.setUint32(start + i * 4, v, true));
  for (let i = 0; i <= flags.length; i++) {
    const p = start + 16 + i * 92;
    view.setUint32(p, 0, true); view.setUint32(p + 4, i === flags.length ? 999 : 1, true);
    view.setUint32(p + 72, flags[i] ?? 0, true);
  }
  return data;
}
const shots: Shot[] = flags.filter(flag => !(flag & SHOT_NOT_VISIBLE)).map(flags => ({ from: [1000, 2000, 100], to: [1010, 2020, 110], flags }));

describe('centreline shot types and colours', () => {
  it('preserves visible shot flags in both loaders, including surface/splay combinations, and skips missing stations', async () => {
    const data = fixture(), small = parseLox(data);
    const large = await streamLargeLox(new Blob([data]), { progress() {}, async ready() {}, async batch() {} });
    expect(small.shots.map(shot => shot.flags)).toEqual(flags.filter(flag => !(flag & SHOT_NOT_VISIBLE)));
    expect(large.shots).toEqual(small.shots);
    expect(small.shots[0].from).toEqual([1000, 2000, 100]);
  });

  it('shows all types by default and combines surface/underground and splay/duplicate filters', () => {
    const defaults = { ...DEFAULT_CENTRELINE_OPTIONS };
    expect(defaults).toEqual({ surface: true, underground: true, splay: true, duplicate: true, color: 'altitude', stations: false, label: 'none' });
    expect(shots.every(shot => centrelineVisible(shot.flags, defaults))).toBe(true);
    for (const shot of shots) {
      expect(centrelineVisible(shot.flags, { ...defaults, surface: false })).toBe(!(shot.flags & SHOT_SURFACE));
      expect(centrelineVisible(shot.flags, { ...defaults, underground: false })).toBe(Boolean(shot.flags & SHOT_SURFACE));
      expect(centrelineVisible(shot.flags, { ...defaults, splay: false })).toBe(!(shot.flags & SHOT_SPLAY));
      expect(centrelineVisible(shot.flags, { ...defaults, duplicate: false })).toBe(!(shot.flags & SHOT_DUPLICATE));
    }
  });

  it.each(['altitude', 'default'] as const)('keeps every surface shot gray and duplicate colours identical to ordinary shots (%s)', mode => {
    const gray = new THREE.Color(0x808080);
    for (const z of [100, 105, 110]) {
      for (const flags of [SHOT_SURFACE, SHOT_SURFACE | SHOT_SPLAY, SHOT_SURFACE | SHOT_DUPLICATE]) {
        expect(centrelineColor(z, flags, range, mode)).toEqual(gray);
      }
      expect(centrelineColor(z, SHOT_DUPLICATE, range, mode)).toEqual(centrelineColor(z, 0, range, mode));
    }
  });

  it('uses pure white in default mode and half saturation with darker altitude splays', () => {
    expect(centrelineColor(105, 0, range, 'default')).toEqual(new THREE.Color(1, 1, 1));
    const ordinary = centrelineColor(105, 0, range, 'altitude').getHSL({ h: 0, s: 0, l: 0 });
    const splay = centrelineColor(105, SHOT_SPLAY, range, 'altitude').getHSL({ h: 0, s: 0, l: 0 });
    expect(splay.h).toBeCloseTo(ordinary.h); expect(splay.s).toBeCloseTo(ordinary.s / 2);
    expect(splay.l).toBeLessThan(ordinary.l);
    const defaultSplay = centrelineColor(105, SHOT_SPLAY, range, 'default');
    expect(defaultSplay.r).toBeLessThan(1); expect(defaultSplay.r).toBe(defaultSplay.g); expect(defaultSplay.g).toBe(defaultSplay.b);
    expect(centrelineColor(105, 0, { minZ: 105, maxZ: 105 }, 'altitude').toArray().every(Number.isFinite)).toBe(true);
  });

  it('updates visibility and colours in place, preserves choices across files, and keeps the master visibility independent', () => {
    const group = new THREE.Group(), onChange = vi.fn(), scene = new CentrelineScene(group, onChange);
    const model = { ...range, shots }; scene.setModel(model, new THREE.Vector3(1000, 2000, 100));
    expect(group.children).toHaveLength(7);
    const lines = group.children[0] as THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial>;
    const geometry = lines.geometry;
    expect(Array.from(geometry.getAttribute('position').array)).toEqual([0, 0, 0, 10, 20, 10]);
    group.visible = false;
    scene.setOptions({ ...scene.options, surface: false, splay: false, color: 'default' });
    expect(group.visible).toBe(false); expect(lines.geometry).toBe(geometry);
    expect(Array.from(geometry.getAttribute('color').array)).toEqual([1, 1, 1, 1, 1, 1]);
    expect((group.children.find(child => child.name === `Centreline ${SHOT_SURFACE}`))?.visible).toBe(false);
    const dispose = vi.fn(); geometry.addEventListener('dispose', dispose);
    scene.setModel(model, new THREE.Vector3()); expect(dispose).toHaveBeenCalledOnce();
    expect(scene.options.surface).toBe(false); expect(scene.options.splay).toBe(false); expect(scene.options.color).toBe('default');
    expect(group.children.filter(child => child.visible)).toHaveLength(2);
    expect(group.visible).toBe(false); expect(onChange).toHaveBeenCalledOnce();
    scene.clear(); expect(group.children).toHaveLength(0);
  });
});
