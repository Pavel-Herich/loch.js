import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { PresentationGuides, presentationPath } from '../src/presentation-guides';
import { PresentationTimeline, presentationCamera, presentationPosition } from '../src/presentation-timeline';
import type { LxaView } from '../src/presentation';

const view = (changes: Partial<LxaView> = {}): LxaView => ({ name: 'View', facing: 0, tilt: 0, center: [100, 200, 300], distance: 2,
  focus: 50, perspective: true, duration: 3, rotationDuration: 15, rotations: 0, walker: false, transition: true, scene: {}, ...changes });
const origin = new THREE.Vector3(100, 200, 300);
const vectors = (points: number[]) => Array.from({ length: points.length / 3 }, (_, index) => new THREE.Vector3().fromArray(points, index * 3));

describe('animation viewpoint guides', () => {
  it('places 50 cm red cameras at original-coordinate viewpoints with the saved orientation, including poles', () => {
    const timeline = new PresentationTimeline([view(), view({ facing: 123, tilt: 90 }), view({ tilt: -90, perspective: false })], false);
    const guides = new PresentationGuides(); guides.update(timeline, origin, true);
    const markers = guides.group.children[0] as THREE.InstancedMesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
    expect(markers.count).toBe(3); expect(markers.material.color.getHex()).toBe(0xff2222);
    markers.geometry.computeBoundingBox();
    expect(markers.geometry.boundingBox!.getSize(new THREE.Vector3()).z).toBeCloseTo(.5);
    expect(markers.geometry.boundingBox!.min.z).toBeCloseTo(0);
    timeline.views.forEach((view, index) => {
      expect(guides.labels[index]).toEqual({ name: view.name, position: presentationPosition(view).toArray() });
      const expected = presentationCamera(view, origin, 1, new THREE.PerspectiveCamera()), matrix = new THREE.Matrix4();
      markers.getMatrixAt(index, matrix);
      const position = new THREE.Vector3(), orientation = new THREE.Quaternion(), scale = new THREE.Vector3(); matrix.decompose(position, orientation, scale);
      expect(position.distanceTo(expected.position)).toBeLessThan(1e-6);
      expect(Math.abs(orientation.dot(expected.quaternion))).toBeCloseTo(1, 6);
    });
    guides.dispose();
  });
  it('includes complete orbit circles, including the single-view rotation fallback', () => {
    for (const timeline of [new PresentationTimeline([view()], false), new PresentationTimeline([view({ rotations: -2 }), view({ facing: 90 })], false)]) {
      const points = vectors(presentationPath(timeline, origin)).slice(0, 145);
      expect(points).toHaveLength(145);
      for (const point of points) { expect(point.length()).toBeCloseTo(2); expect(point.z).toBeCloseTo(0); }
      expect(points[0].distanceTo(points.at(-1)!)).toBeLessThan(1e-9);
      expect(Math.max(...points.map(point => point.x))).toBeCloseTo(2);
      expect(Math.min(...points.map(point => point.x))).toBeCloseTo(-2);
    }
  });
  it('samples the actual walker movement and includes the closing transition only for looping timelines', () => {
    const views = [view(), view({ center: [104, 201, 300], facing: 90, distance: 1, walker: true })];
    const once = new PresentationTimeline(views, false), points = vectors(presentationPath(once, origin));
    const start = presentationPosition(views[0]).sub(origin), end = presentationPosition(views[1]).sub(origin);
    expect(points[0].distanceTo(start)).toBeLessThan(1e-9); expect(points.at(-1)!.distanceTo(end)).toBeLessThan(1e-9);
    expect(points[32].distanceTo(start.clone().lerp(end, .5))).toBeLessThan(1e-9);
    const loop = vectors(presentationPath(new PresentationTimeline(views, true), origin));
    expect(loop.at(-1)!.distanceTo(start)).toBeLessThan(1e-9); expect(loop.length).toBeGreaterThan(points.length);
  });
  it('hides during playback, reuses unchanged geometry, and releases replaced guides', () => {
    const guides = new PresentationGuides(), timeline = new PresentationTimeline([view()], true);
    expect(guides.update(timeline, origin, true)).toBe(true); const marker = guides.group.children[0] as THREE.InstancedMesh;
    const disposed = vi.fn(); marker.geometry.addEventListener('dispose', disposed);
    expect(guides.update(timeline, origin, true)).toBe(false); expect(guides.group.children[0]).toBe(marker);
    expect(guides.update(timeline, origin, false)).toBe(true); expect(guides.group.visible).toBe(false); expect(disposed).not.toHaveBeenCalled();
    guides.update(timeline, origin.clone().addScalar(10), true); expect(disposed).toHaveBeenCalledTimes(1);
    guides.update(new PresentationTimeline([], true), origin, true); expect(guides.group.children).toHaveLength(0); expect(guides.group.visible).toBe(false); expect(guides.labels).toHaveLength(0);
    guides.dispose();
  });
});
