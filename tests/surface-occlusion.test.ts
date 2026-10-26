import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { SurfaceScene } from '../src/surface';

function flatScene(height = 100) {
  const scene = new SurfaceScene(new THREE.Group(), () => undefined, () => undefined);
  const width = 21, rows = 21;
  scene.add({ id: 1, width, height: rows, calibration: [0, 0, 10, 0, 0, 10], heights: new Float64Array(width * rows).fill(height) } as never, new THREE.Vector3());
  return scene;
}

describe('SurfaceScene.hides', () => {
  it('hides a point well under the terrain from a camera above it', () => {
    expect(flatScene().hides(100, 100, 500, 100, 100, 50)).toBe(true);
  });
  it('keeps points on or just under the ground visible', () => {
    const scene = flatScene();
    expect(scene.hides(20, 20, 400, 150, 150, 100)).toBe(false);
    expect(scene.hides(20, 20, 400, 150, 150, 99)).toBe(false);
  });
  it('does not hide what lies on the same side as the camera', () => {
    expect(flatScene().hides(30, 30, 10, 150, 150, 50)).toBe(false);
  });
  it('lets symbols show through as much as the surface is transparent', () => {
    const scene = flatScene();
    scene.setAppearance(true, .5);
    expect(scene.seeThrough).toBeCloseTo(.5);
    scene.setAppearance(false, .5);
    expect(scene.seeThrough).toBe(0);
    scene.group.visible = false;
    expect(scene.seeThrough).toBe(1);
  });
});
