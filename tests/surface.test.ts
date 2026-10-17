import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { parseLox } from '../src/lox';
import { READ_BYTES, streamLargeLox } from '../src/large-lox';
import { type Calibration, type Surface } from '../src/lox-surface';
import { DEFAULT_SURFACE_OPACITY, SurfaceScene, surfaceGeometry, surfaceUV } from '../src/surface';

function fixture(width = 2, height = 2) {
  const data = new ArrayBuffer(16 + 68 + width * height * 8), view = new DataView(data);
  [5, 68, 1, width * height * 8, 7, width, height, 0, width * height * 8].forEach((v, i) => view.setUint32(i * 4, v, true));
  [1000, 2000, 2, -1, 1, 3].forEach((v, i) => view.setFloat64(36 + i * 8, v, true));
  for (let i = 0; i < width * height; i++) view.setFloat64(84 + i * 8, 10 + i % 4, true);
  return data;
}
function bitmap(id = 7) {
  const bytes = Uint8Array.from([137, 80, 78, 71]);
  const data = new ArrayBuffer(80 + bytes.length), view = new DataView(data);
  [6, 64, 1, bytes.length, id, 1, 0, bytes.length].forEach((v, i) => view.setUint32(i * 4, v, true));
  [1000, 2000, 2, -1, 1, 3].forEach((v, i) => view.setFloat64(32 + i * 8, v, true));
  new Uint8Array(data, 80).set(bytes); return data;
}
function combine(...parts: ArrayBuffer[]) {
  const result = new Uint8Array(parts.reduce((n, part) => n + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) { result.set(new Uint8Array(part), offset); offset += part.byteLength; }
  return result.buffer;
}

describe('LOX terrain surfaces', () => {
  it('reads a surface-only file and associates the embedded image by ID, independent of chunk order', () => {
    const model = parseLox(combine(bitmap(99), bitmap(), fixture()));
    expect(model.surfaces).toHaveLength(1);
    const surface = model.surfaces[0];
    expect(surface.id).toBe(7); expect(surface.width).toBe(2); expect(surface.height).toBe(2);
    expect(Array.from(surface.heights)).toEqual([10, 11, 12, 13]);
    expect(surface.bitmap?.mime).toBe('image/png');
    expect(Array.from(surface.bitmap!.data)).toEqual([137, 80, 78, 71]);
    expect([model.minZ, model.maxZ]).toEqual([10, 13]);
  });

  it('maps rotated grid coordinates, recenters before Float32 conversion, and triangulates each cell', () => {
    const surface = parseLox(fixture()).surfaces[0];
    const geometry = surfaceGeometry(surface, new THREE.Vector3(1000, 2000, 10));
    expect(Array.from(geometry.getAttribute('position').array)).toEqual([0, 0, 0, 2, 1, 1, -1, 3, 2, 1, 4, 3]);
    expect(Array.from(geometry.index!.array)).toEqual([0, 1, 3, 0, 3, 2]);
    expect(geometry.getAttribute('normal')).toBeUndefined();
    const uv = surfaceUV(surface, { calibration: surface.calibration, data: new Uint8Array(), mime: 'image/png' }, 2, 2, 0, 0, 1, 1);
    expect(Array.from(uv.array)).toEqual([0, 1, .5, 1, 0, .5, .5, .5]);
  });

  it('uses the bitmap calibration independently of the terrain grid', () => {
    const surface = parseLox(fixture()).surfaces[0];
    const calibration: Calibration = [1000, 2000, 1, 0, 0, -1];
    const uv = surfaceUV(surface, { calibration, data: new Uint8Array(), mime: 'image/jpeg' }, 10, 10, 0, 0, 1, 1);
    expect(Array.from(uv.array)).toEqual([0, 1, expect.closeTo(.2), expect.closeTo(1.1), expect.closeTo(-.1), expect.closeTo(1.3), expect.closeTo(.1), expect.closeTo(1.4)]);
  });

  it.each(['dimensions', 'pointer', 'calibration', 'elevation', 'truncated'])('rejects corrupt surface %s in both loading paths', async failure => {
    let data = fixture(); const view = new DataView(data);
    if (failure === 'dimensions') view.setUint32(20, 999, true);
    if (failure === 'pointer') view.setUint32(28, 999, true);
    if (failure === 'calibration') view.setFloat64(52, NaN, true);
    if (failure === 'elevation') view.setFloat64(84, NaN, true);
    if (failure === 'truncated') data = data.slice(0, -1);
    expect(() => parseLox(data)).toThrow();
    await expect(streamLargeLox(new Blob([data]), { progress() {}, async ready() {}, async batch() {}, async surface() {} })).rejects.toThrow();
  });

  it('streams surface grids and bitmaps with bounded reads and includes terrain in the fitted bounds', async () => {
    const data = combine(bitmap(), fixture(1025, 1025));
    const blob = new Blob([data]), reads: number[] = [], surfaces: Surface[] = [];
    const model = await streamLargeLox({ size: blob.size, slice(start = 0, end = blob.size) { reads.push(end - start); return blob.slice(start, end); } }, {
      progress() {}, async ready() {}, async batch() {}, async surface(value) { surfaces.push(value); },
    });
    expect(Math.max(...reads)).toBeLessThanOrEqual(READ_BYTES);
    expect(surfaces).toHaveLength(1);
    expect(surfaces[0].heights.length).toBe(1025 * 1025);
    for (const index of [0, 1, READ_BYTES / 8 - 1, READ_BYTES / 8, 1025 * 1025 - 1]) {
      expect(surfaces[0].heights[index]).toBe(10 + index % 4);
    }
    expect(surfaces[0].bitmap?.data).toEqual(new Uint8Array([137, 80, 78, 71]));
    expect(model.min).toEqual([-24, 2000, 10]); expect(model.max).toEqual([3048, 6096, 13]);
  });

  it('discards late texture loads after another model replaces the surface', () => {
    const texture = new THREE.Texture();
    let complete: ((texture: THREE.Texture) => void) | undefined;
    const loader = vi.spyOn(THREE.TextureLoader.prototype, 'load').mockImplementation((_url, onLoad) => {
      complete = onLoad; return texture;
    });
    try {
      const group = new THREE.Group(), onChange = vi.fn(), onError = vi.fn();
      const scene = new SurfaceScene(group, onChange, onError);
      scene.add(parseLox(combine(fixture(), bitmap())).surfaces[0], new THREE.Vector3());
      const dispose = vi.fn(); texture.addEventListener('dispose', dispose);
      scene.clear();
      complete!(texture);
      expect(group.children).toHaveLength(0); expect(dispose).toHaveBeenCalled();
      expect(onChange).not.toHaveBeenCalled(); expect(onError).not.toHaveBeenCalled();
    } finally { loader.mockRestore(); }
  });

  it('defaults to 50% opacity, preserves opacity when transparency is disabled, and disposes replaced geometry', () => {
    const group = new THREE.Group(), scene = new SurfaceScene(group, vi.fn(), vi.fn());
    scene.add(parseLox(fixture(258, 2)).surfaces[0], new THREE.Vector3());
    expect(group.children).toHaveLength(2); // A shared edge spans the two bounded tiles.
    const meshes = group.children as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>[];
    const material = meshes[0].material;
    expect(DEFAULT_SURFACE_OPACITY).toBe(.5); expect(material.opacity).toBe(.5);
    expect(material.transparent).toBe(true); expect(material.depthWrite).toBe(false);
    scene.setAppearance(false, .25);
    expect(material.opacity).toBe(1); expect(material.transparent).toBe(false); expect(material.depthWrite).toBe(true);
    scene.setAppearance(true, .25); expect(material.opacity).toBe(.25); expect(material.transparent).toBe(true);
    const dispose = vi.fn(); meshes.forEach(mesh => mesh.geometry.addEventListener('dispose', dispose));
    scene.clear(); expect(dispose).toHaveBeenCalledTimes(2); expect(group.children).toHaveLength(0);
    scene.add(parseLox(fixture()).surfaces[0], new THREE.Vector3());
    expect((group.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>).material.opacity).toBe(.25);
  });
});
