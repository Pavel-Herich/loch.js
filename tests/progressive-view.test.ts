import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { LargeScene } from '../src/large-scene';
import { ProgressiveView } from '../src/progressive-view';
import type { LargeModel } from '../src/large-lox';

describe('stationary view refinement', () => {
  it('draws every batch once into persistent color/depth storage and releases each GPU batch', () => {
    const scene = new THREE.Scene(), group = new THREE.Group();
    scene.add(group); scene.background = new THREE.Color('#09131c');
    const background = scene.background;
    const model: LargeModel = { min: [-1, -1, 0], max: [1, 1, 0], origin: [0, 0, 0], minZ: 0, maxZ: 0, scraps: 1, triangles: 3, points: 9, shots: [] };
    const walls = new LargeScene(group, new THREE.MeshBasicMaterial(), model);
    for (let i = 0; i < 3; i++) walls.add({ positions: new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]), triangles: 1 });
    const meshes = group.children.filter(child => child instanceof THREE.Mesh);
    let disposed = 0;
    for (const mesh of meshes) mesh.geometry.addEventListener('dispose', () => disposed++);
    const camera = new THREE.PerspectiveCamera(45, 1, .1, 100);
    camera.position.z = 5; camera.lookAt(0, 0, 0);
    const passes: { target: THREE.WebGLRenderTarget | null; clear: boolean; background: THREE.Scene['background']; meshes: THREE.Object3D[] }[] = [];
    let target: THREE.WebGLRenderTarget | null = null;
    const renderer = {
      autoClear: true,
      getDrawingBufferSize(size: THREE.Vector2) { return size.set(100, 100); },
      getRenderTarget() { return target; },
      setRenderTarget(value: THREE.WebGLRenderTarget | null) { target = value; },
      render(value: THREE.Scene) {
        value.updateMatrixWorld(true);
        const visible: THREE.Object3D[] = [];
        value.traverseVisible(child => { if (child instanceof THREE.Mesh) visible.push(child); });
        passes.push({ target, clear: this.autoClear, background: value.background, meshes: visible });
      },
    };
    const view = new ProgressiveView(renderer as unknown as THREE.WebGLRenderer, scene, camera, walls);
    expect(view.progress).toBe(0);
    while (!view.complete) view.step();
    view.step(); // Completion must not schedule another pass.
    expect(view.progress).toBe(1);
    const accumulated = passes.filter(pass => pass.target !== null);
    expect(accumulated).toHaveLength(4);
    expect(accumulated[0].clear).toBe(true);
    expect(accumulated[0].meshes).toHaveLength(0);
    for (const pass of accumulated.slice(1)) {
      expect(pass.target).toBe(accumulated[0].target);
      expect(pass.clear).toBe(false);
      expect(pass.background).toBeNull();
      expect(pass.meshes).toHaveLength(1);
    }
    expect(new Set(accumulated.slice(1).map(pass => pass.meshes[0]))).toEqual(new Set(meshes));
    expect(disposed).toBe(3);
    expect(scene.background).toBe(background);
    expect(renderer.autoClear).toBe(true);
    expect(target).toBeNull();
    view.dispose();
  });
});
