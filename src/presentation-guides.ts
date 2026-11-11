import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { presentationCamera, presentationPosition, type PresentationTimeline } from './presentation-timeline';
import type { PositionLabel } from './station-labels';

export function presentationPath(timeline: PresentationTimeline, origin: THREE.Vector3) {
  const points: number[] = [], previous = new THREE.Vector3(Infinity, Infinity, Infinity);
  const resolution = Math.max(8, Math.min(144, Math.floor(262144 / Math.max(1, timeline.segments.length))));
  timeline.segments.forEach((segment, index) => {
    const steps = segment.rotation ? resolution : Math.min(64, resolution);
    const from = timeline.views[segment.from];
    for (let step = 0; step <= steps; step++) {
      // Repeated turns trace the same circle; draw it once with uniform spacing.
      const pose = segment.rotation ? { ...from, facing: from.facing + 360 * step / steps } : timeline.sampleSegment(index, step / steps);
      const point = presentationPosition(pose).sub(origin);
      if (point.distanceToSquared(previous) < 1e-16) continue;
      points.push(...point.toArray()); previous.copy(point);
    }
  });
  return points;
}

function cameraGeometry() {
  // The lens faces local -Z. Keep the 50 cm body behind the viewpoint so a
  // camera viewed from its own position does not cover the model.
  const parts = [new THREE.BoxGeometry(.3, .22, .28).translate(0, 0, .36),
    new THREE.CylinderGeometry(.085, .11, .22, 12).rotateX(Math.PI / 2).translate(0, 0, .11),
    new THREE.BoxGeometry(.13, .08, .15).translate(0, .15, .36)];
  const geometry = mergeGeometries(parts)!;
  for (const part of parts) part.dispose();
  // Keep the camera's 3D shape readable even outside a Headlight beam.
  const normals = geometry.getAttribute('normal'), colors = new Float32Array(normals.count * 3);
  const light = new THREE.Vector3(.4, .7, .6).normalize(), normal = new THREE.Vector3();
  for (let vertex = 0; vertex < normals.count; vertex++) {
    const shade = .55 + .45 * Math.max(0, normal.fromBufferAttribute(normals, vertex).dot(light));
    colors.set([shade, shade, shade], vertex * 3);
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  return geometry;
}

export class PresentationGuides {
  readonly group = new THREE.Group();
  labels: PositionLabel[] = [];
  private timeline?: PresentationTimeline;
  private origin = new THREE.Vector3(Infinity, Infinity, Infinity);
  constructor() { this.group.name = 'Animation viewpoints and path'; this.group.visible = false; }

  update(timeline: PresentationTimeline, origin: THREE.Vector3, visible: boolean) {
    const rebuild = this.timeline !== timeline || !this.origin.equals(origin);
    if (rebuild) {
      this.clear(); this.timeline = timeline; this.origin.copy(origin);
      this.labels = timeline.views.map(view => ({ name: view.name, position: presentationPosition(view).toArray() }));
      if (timeline.views.length) {
        const markers = new THREE.InstancedMesh(cameraGeometry(), new THREE.MeshBasicMaterial({ color: 0xff2222, vertexColors: true }), timeline.views.length);
        markers.name = 'Animation cameras';
        const clip = new THREE.PerspectiveCamera(), matrix = new THREE.Matrix4();
        timeline.views.forEach((view, index) => {
          const camera = presentationCamera(view, origin, 1, clip);
          matrix.compose(camera.position, camera.quaternion, new THREE.Vector3(1, 1, 1)); markers.setMatrixAt(index, matrix);
        });
        markers.instanceMatrix.needsUpdate = true; markers.computeBoundingSphere(); this.group.add(markers);
        const points = presentationPath(timeline, origin);
        if (points.length >= 6) {
          const path = new Line2(new LineGeometry().setPositions(points), new LineMaterial({ color: 0xffff00, linewidth: 3, toneMapped: false }));
          path.name = 'Animation camera path'; this.group.add(path);
        }
      }
    }
    const show = visible && timeline.views.length > 0, changed = this.group.visible !== show;
    this.group.visible = show; return rebuild || changed;
  }

  private clear() {
    this.labels = [];
    for (const child of [...this.group.children]) {
      const mesh = child as THREE.Mesh;
      mesh.geometry.dispose();
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) material.dispose();
      if (child instanceof THREE.InstancedMesh) child.dispose();
      this.group.remove(child);
    }
  }
  dispose() { this.clear(); this.group.visible = false; this.timeline = undefined; }
}
