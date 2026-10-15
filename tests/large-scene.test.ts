import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { LargeScene, LOD_TRIANGLE_BUDGET, largeWallMaterial } from '../src/large-scene';
import { BATCH_TRIANGLES, type LargeModel } from '../src/large-lox';

const model: LargeModel = { min: [0, 0, 0], max: [1, 1, 1], origin: [0, 0, 0], minZ: 0, maxZ: 1, scraps: 1, triangles: 0, points: 0, shots: [] };

describe('large-scene detail control', () => {
  it('keeps full geometry while bounding automatic triangle rendering and releasing distant GPU buffers', () => {
    const group = new THREE.Group(), material = largeWallMaterial(model);
    const scene = new LargeScene(group, material, model);
    const arrays: Float32Array[] = [];
    for (let i = 0; i < 6; i++) {
      const positions = new Float32Array(BATCH_TRIANGLES * 9);
      for (let p = 0; p < positions.length; p += 9) positions.set([0, 0, 0, 1, 0, 0, 0, 1, 1], p);
      arrays.push(positions); scene.add({ positions, triangles: BATCH_TRIANGLES });
    }
    const meshes = group.children.filter(child => child instanceof THREE.Mesh) as THREE.Mesh[];
    const samples = group.children.filter(child => child instanceof THREE.Points) as THREE.Points[];
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0, 0, 1000); scene.update(camera, false);
    expect(scene.renderedTriangles).toBe(0);
    expect(samples.every(sample => sample.visible && sample.geometry.getAttribute('position').count <= 512)).toBe(true);
    camera.position.set(0, 0, 1); scene.update(camera, false);
    expect(scene.renderedTriangles).toBe(LOD_TRIANGLE_BUDGET);
    scene.update(camera, true);
    expect(scene.renderedTriangles).toBe(BATCH_TRIANGLES * 6);
    let evicted = 0;
    for (const mesh of meshes) mesh.geometry.addEventListener('dispose', () => evicted++);
    camera.position.set(0, 0, 1000); scene.update(camera, false);
    expect(evicted).toBe(6);
    expect(scene.renderedTriangles).toBe(0);
    meshes.forEach((mesh, i) => {
      expect(mesh.geometry.getAttribute('position').array).toBe(arrays[i]);
      expect(mesh.geometry.getAttribute('normal')).toBeUndefined();
      expect(mesh.geometry.getAttribute('color')).toBeUndefined();
    });
  });
});
