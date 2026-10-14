import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { createWallGeometry } from '../src/walls';

describe('LOX wall normals', () => {
  it('omits zero-area triangles with undefined normals', () => {
    const geometry = createWallGeometry({
      points: [[0, 0, 0], [1, 0, 0], [2, 0, 0]],
      triangles: [[0, 1, 2], [0, 0, 1]],
    }, new Vector3());
    expect(geometry.index!.count).toBe(0);
    expect(geometry.getAttribute('normal').count).toBe(0);
  });

  it('smooths duplicated vertices and corrects opposite winding on a planar wall', () => {
    const geometry = createWallGeometry({
      points: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0]],
      triangles: [[0, 1, 2], [3, 4, 5]],
    }, new Vector3());
    expect(geometry.getAttribute('position').count).toBe(4);
    expect(geometry.index!.count).toBe(6);
    const normals = geometry.getAttribute('normal');
    for (let i = 0; i < normals.count; i++) {
      expect([normals.getX(i), normals.getY(i), normals.getZ(i)]).toEqual([0, 0, -1]);
    }
  });

  it('preserves a sharp crease instead of averaging across it', () => {
    const geometry = createWallGeometry({
      points: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, Math.sqrt(3) / 2, 0.5]],
      triangles: [[0, 1, 2], [1, 0, 3]],
    }, new Vector3());
    expect(geometry.getAttribute('position').count).toBe(6);
    const normals = geometry.getAttribute('normal');
    const a = new Vector3().fromBufferAttribute(normals, 0);
    const b = new Vector3().fromBufferAttribute(normals, 3);
    expect(a.length()).toBeCloseTo(1);
    expect(b.length()).toBeCloseTo(1);
    expect(a.dot(b)).toBeCloseTo(-Math.sqrt(3) / 2);
  });

  it('keeps disconnected surfaces separate and subtracts the model origin', () => {
    const geometry = createWallGeometry({
      points: [[100, 200, 300], [101, 200, 300], [100, 201, 300], [100, 200, 301], [101, 200, 301]],
      triangles: [[0, 1, 2], [0, 3, 4]],
    }, new Vector3(100, 200, 300));
    expect(geometry.getAttribute('position').count).toBe(6);
    const position = geometry.getAttribute('position');
    expect([position.getX(0), position.getY(0), position.getZ(0)]).toEqual([0, 0, 0]);
  });
});
