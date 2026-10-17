import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { LargeScene, largeWallMaterial } from '../src/large-scene';
import { WallPreparation } from '../src/wall-preparation';
import type { LargeModel } from '../src/large-lox';

function setup(full = true) {
  const model: LargeModel = { min: [0, 0, 0], max: [1, 1, 1], origin: [0, 0, 0], minZ: 0, maxZ: 1, scraps: 1, triangles: 2, points: 6, shots: [] };
  const scene = new THREE.Scene(), group = new THREE.Group(); scene.add(group);
  const large = new LargeScene(group, largeWallMaterial(model), model);
  for (let i = 0; i < 2; i++) large.add({ positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), triangles: 1 });
  const camera = new THREE.PerspectiveCamera(); camera.position.z = full ? 5 : 1000;
  let resolveCompile!: () => void;
  const compile = new Promise<void>(resolve => { resolveCompile = resolve; });
  const gl = {
    SYNC_GPU_COMMANDS_COMPLETE: 1, WAIT_FAILED: 2, ALREADY_SIGNALED: 3, CONDITION_SATISFIED: 4,
    fenceSync: vi.fn(() => ({})), isContextLost: () => false, flush: vi.fn(), finish: vi.fn(),
    clientWaitSync: vi.fn(() => 5), deleteSync: vi.fn(),
  };
  let target: THREE.WebGLRenderTarget | null = null;
  const draws: { target: THREE.WebGLRenderTarget | null; objects: THREE.Object3D[]; counts: number[] }[] = [];
  const renderer = {
    compileAsync: vi.fn(() => compile), getContext: () => gl,
    getRenderTarget: () => target, setRenderTarget: (value: typeof target) => { target = value; },
    render: vi.fn(() => {
      const objects = group.children.filter(object => object.visible) as THREE.Mesh[];
      draws.push({ target, objects, counts: objects.map(object => object.geometry.drawRange.count) });
    }),
  };
  const task = new WallPreparation(renderer as unknown as THREE.WebGLRenderer, scene, camera, large, full);
  return { task, large, group, renderer, gl, draws, resolveCompile };
}

async function prepareUpload(s: ReturnType<typeof setup>) {
  while (s.task.phase === 'Preparing geometry') s.task.step();
  s.task.step();
  expect(s.renderer.compileAsync).toHaveBeenCalledOnce();
  s.task.step();
  expect(s.task.phase).toBe('Compiling wall shaders');
  expect(s.draws).toHaveLength(0);
  s.resolveCompile(); await Promise.resolve(); s.task.step();
  expect(s.task.phase).toBe('Uploading geometry');
}

describe('wall preparation progress', () => {
  it('prepares bounds, uploads without drawing triangles, then waits for the final GPU frame', async () => {
    const s = setup();
    await prepareUpload(s);
    expect(s.large.geometryBatches().every(mesh => mesh.geometry.boundingSphere !== null)).toBe(true);
    while (s.task.phase === 'Uploading geometry') s.task.step();
    expect(s.draws).toHaveLength(2);
    for (const draw of s.draws) {
      expect(draw.target?.width).toBe(1); expect(draw.target?.height).toBe(1);
      expect(draw.objects).toHaveLength(1); expect(draw.counts).toEqual([0]);
    }
    expect(s.renderer.getRenderTarget()).toBeNull();
    expect(s.large.geometryBatches().every(mesh => mesh.geometry.drawRange.count === Infinity && mesh.frustumCulled)).toBe(true);
    expect(s.task.phase).toBe('Rendering walls'); expect(s.task.progress).toBeNull();
    s.task.step();
    expect(s.draws.at(-1)?.target).toBeNull(); expect(s.draws.at(-1)?.counts).toEqual([Infinity, Infinity]);
    s.task.step(); expect(s.task.complete).toBe(false);
    s.gl.clientWaitSync.mockReturnValue(s.gl.CONDITION_SATISFIED);
    s.task.step(); expect(s.task.complete).toBe(true); expect(s.gl.deleteSync).toHaveBeenCalledOnce();
    const dispose = vi.fn(); s.large.geometryBatches()[0].geometry.addEventListener('dispose', dispose);
    s.task.dispose(); expect(dispose).not.toHaveBeenCalled();
  });

  it('uploads only point previews for distant automatic batches', async () => {
    const s = setup(false); await prepareUpload(s);
    while (s.task.phase === 'Uploading geometry') s.task.step();
    expect(s.draws.flatMap(draw => draw.objects).every(object => object instanceof THREE.Points)).toBe(true);
    s.task.dispose();
  });

  it('releases the outstanding fence when cancelled without discarding source geometry', async () => {
    const s = setup(); await prepareUpload(s);
    while (s.task.phase === 'Uploading geometry') s.task.step();
    s.task.step(); expect(s.task.complete).toBe(false);
    const disposed = vi.fn();
    s.large.geometryBatches().forEach(mesh => mesh.geometry.addEventListener('dispose', disposed));
    s.task.dispose();
    expect(s.gl.deleteSync).toHaveBeenCalledOnce(); expect(disposed).not.toHaveBeenCalled();
  });

  it('restores rendering state after an upload error', async () => {
    const s = setup(); await prepareUpload(s);
    s.renderer.render.mockImplementationOnce(() => { throw new Error('GPU upload failed'); });
    expect(() => s.task.step()).toThrow('GPU upload failed');
    expect(s.renderer.getRenderTarget()).toBeNull();
    expect(s.group.children.every(object => !object.visible)).toBe(true);
    expect(s.large.geometryBatches().every(mesh => mesh.geometry.drawRange.count === Infinity && mesh.frustumCulled)).toBe(true);
    s.task.dispose();
  });
});
