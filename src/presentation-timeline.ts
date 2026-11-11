import { MathUtils, Matrix4, OrthographicCamera, PerspectiveCamera, Vector3 } from 'three';
import type { ViewCamera } from './camera';
import type { LxaCamera, LxaView } from './presentation';
export type PresentationPose = LxaCamera & { walker: boolean; sceneIndex: number };
type Segment = { start: number; duration: number; from: number; to: number; rotation: boolean };
type Velocity = { facing: number; tilt: number; distance: number; focus: number; center: number[]; position: Vector3 };
const radians = MathUtils.degToRad;
const lerp = MathUtils.lerp;
const angleDelta = (from: number, to: number) => {
  const delta = ((to - from + 180) % 360 + 360) % 360 - 180;
  return delta === -180 && to - from > 0 ? 180 : delta;
};
const hermite = (from: number, to: number, startVelocity: number, endVelocity: number, t: number, duration: number) =>
  lerp(from, to, t * t * (3 - 2 * t)) + duration * ((t ** 3 - 2 * t * t + t) * startVelocity + (t ** 3 - t * t) * endVelocity);
const polar = (distance: number, bearing: number, tilt: number) => new Vector3(Math.sin(radians(bearing)) * Math.cos(radians(tilt)), Math.cos(radians(bearing)) * Math.cos(radians(tilt)), Math.sin(radians(tilt))).multiplyScalar(distance);
export const presentationPosition = (view: LxaCamera) => new Vector3(...view.center).add(polar(view.distance, view.facing + 180, view.tilt));
export function transitionProgress(t: number, from: boolean, to: boolean) {
  return (t ** 3 - 2 * t * t + t) * Number(from) + (-2 * t ** 3 + 3 * t * t) + (t ** 3 - t * t) * Number(to);
}
export class PresentationTimeline {
  readonly segments: Segment[] = [];
  readonly viewTimes: number[];
  readonly duration: number;
  private velocities: Velocity[];
  constructor(readonly views: LxaView[], readonly loop: boolean, readonly sceneChanges = false) {
    this.viewTimes = views.map(() => 0); let time = 0;
    if (views.length === 1) this.segments.push({ start: 0, duration: 15, from: 0, to: 0, rotation: true });
    else for (let from = 0; from < (loop ? views.length : views.length - 1); from++) {
      const to = (from + 1) % views.length, view = views[from];
      this.viewTimes[from] = time;
      const rotation = Math.abs(view.rotations) * view.rotationDuration;
      if (rotation) { this.segments.push({ start: time, duration: rotation, from, to: from, rotation: true }); time += rotation; }
      this.segments.push({ start: time, duration: views[to].duration, from, to, rotation: false }); time += views[to].duration;
      if (to !== 0) this.viewTimes[to] = time;
    }
    this.duration = views.length === 1 ? 15 : time;
    this.velocities = views.map((_, index) => ({ facing: this.velocity(index, view => view.facing, true),
      tilt: this.velocity(index, view => view.tilt, false, true), distance: this.velocity(index, view => view.distance, false, true),
      focus: this.velocity(index, view => view.focus, false, true), center: [0, 1, 2].map(axis => this.velocity(index, view => view.center[axis])), position: new Vector3() }));
    views.forEach((view, index) => {
      const previous = index > 0 || loop ? views[(index + views.length - 1) % views.length] : undefined;
      const next = index < views.length - 1 || loop ? views[(index + 1) % views.length] : undefined;
      const velocity = this.velocities[index];
      if ((!previous || view.walker) && (!next || next.walker)) {
        velocity.position.fromArray([0, 1, 2].map(axis => this.velocity(index, view => presentationPosition(view).getComponent(axis))));
      } else {
        // An orbit's camera velocity includes the changing pivot, heading,
        // tilt and distance. Use it on an adjoining Walker segment too.
        const facing = radians(view.facing), tilt = radians(view.tilt), distance = view.distance;
        velocity.position.fromArray(velocity.center)
          .addScaledVector(polar(1, view.facing + 180, view.tilt), velocity.distance)
          .addScaledVector(new Vector3(-Math.cos(facing) * Math.cos(tilt), Math.sin(facing) * Math.cos(tilt), 0), distance * radians(velocity.facing))
          .addScaledVector(new Vector3(Math.sin(facing) * Math.sin(tilt), Math.cos(facing) * Math.sin(tilt), Math.cos(tilt)), distance * radians(velocity.tilt));
      }
    });
  }
  private velocity(index: number, value: (view: LxaView) => number, angle = false, bounded = false) {
    const view = this.views[index];
    // Explicit orbit phases ease to/from rest, so transitions must meet them at rest.
    if (!view.transition || view.rotations || this.views.length < 2) return 0;
    const previous = index > 0 || this.loop ? this.views[(index + this.views.length - 1) % this.views.length] : undefined;
    const next = index < this.views.length - 1 || this.loop ? this.views[(index + 1) % this.views.length] : undefined;
    const delta = (a: LxaView, b: LxaView) => angle ? angleDelta(value(a), value(b)) : value(b) - value(a);
    const incoming = previous ? delta(previous, view) / view.duration : undefined;
    const outgoing = next ? delta(view, next) / next.duration : undefined;
    if (incoming === undefined) return outgoing ?? 0;
    if (outgoing === undefined) return incoming;
    const slope = (incoming * next!.duration + outgoing * view.duration) / (view.duration + next!.duration);
    // Avoid overshoot in inclination, lens and positive camera distance.
    if (bounded) return incoming * outgoing <= 0 ? 0 : Math.sign(slope) * Math.min(Math.abs(slope), 3 * Math.min(Math.abs(incoming), Math.abs(outgoing)));
    return slope;
  }
  frames(fps: number) {
    if (!Number.isInteger(fps) || fps < 1 || fps > 120) throw new Error('Invalid animation FPS');
    if (this.views.length === 1) return { count: 15 * fps, time: (frame: number) => frame / fps };
    let count = 1;
    const parts = this.segments.map((segment, index) => {
      const steps = Math.max(segment.rotation ? 0 : 1, Math.round(segment.duration * fps));
      const length = steps - (this.loop && index === this.segments.length - 1 ? 1 : 0);
      const part = { first: count, length, steps, segment }; count += length; return part;
    });
    if (!Number.isSafeInteger(count) || count < 1) throw new Error('Invalid animation duration');
    return { count, time(frame: number) {
      if (frame === 0) return 0;
      const part = parts.find(item => frame >= item.first && frame < item.first + item.length)!;
      return part.segment.start + part.segment.duration * (frame - part.first + 1) / part.steps;
    } };
  }
  sample(seconds: number): PresentationPose {
    if (!this.views.length) throw new Error('Animation has no views');
    if (!this.loop && seconds >= this.duration) {
      const last = this.views.length - 1;
      return { ...this.views[last], center: [...this.views[last].center], walker: this.views[last].walker, sceneIndex: last };
    }
    const time = this.loop ? ((seconds % this.duration) + this.duration) % this.duration : Math.max(0, seconds);
    const segment = this.segments.find(part => time < part.start + part.duration) ?? this.segments[this.segments.length - 1];
    return this.interpolate(segment, (time - segment.start) / segment.duration);
  }
  sampleSegment(index: number, progress: number) { return this.interpolate(this.segments[index], progress); }
  private interpolate(segment: Segment, progress: number): PresentationPose {
    const from = this.views[segment.from], to = this.views[segment.to];
    let t = Math.max(0, Math.min(1, progress));
    if (segment.rotation) {
      const angle = this.views.length === 1 ? t * 360 : transitionProgress(t, false, false) * 360 * from.rotations;
      return { ...from, center: [...from.center], facing: from.facing + angle, walker: from.walker, sceneIndex: segment.from };
    }
    const start = this.velocities[segment.from], end = this.velocities[segment.to];
    const interpolate = (a: number, b: number, va: number, vb: number) => hermite(a, b, va, vb, t, segment.duration);
    const pose: PresentationPose = { facing: interpolate(from.facing, from.facing + angleDelta(from.facing, to.facing), start.facing, end.facing),
      tilt: interpolate(from.tilt, to.tilt, start.tilt, end.tilt),
      center: from.center.map((value, axis) => interpolate(value, to.center[axis], start.center[axis], end.center[axis])) as [number, number, number],
      distance: interpolate(from.distance, to.distance, start.distance, end.distance), focus: interpolate(from.focus, to.focus, start.focus, end.focus),
      perspective: transitionProgress(t, from.transition, to.transition) <= .5 ? from.perspective : to.perspective,
      walker: to.walker, sceneIndex: segment.from };
    if (to.walker) {
      const a = presentationPosition(from), b = presentationPosition(to);
      pose.center = [0, 1, 2].map(axis => interpolate(a.getComponent(axis), b.getComponent(axis), start.position.getComponent(axis), end.position.getComponent(axis))) as [number, number, number];
      new Vector3(...pose.center).sub(polar(pose.distance, pose.facing + 180, pose.tilt)).toArray(pose.center);
    }
    return pose;
  }
}
export function presentationCamera(view: LxaCamera, origin: Vector3, aspect: number, clip: ViewCamera): ViewCamera {
  const focus = Math.max(20, Math.min(2000, view.focus)), halfHeight = view.distance * 12 / focus;
  const near = Math.min(clip.near, .1, view.distance * .01);
  const camera = view.perspective ? new PerspectiveCamera(2 * MathUtils.radToDeg(Math.atan(12 / focus)), aspect, near, clip.far)
    : new OrthographicCamera(-halfHeight * aspect, halfHeight * aspect, halfHeight, -halfHeight, near, clip.far);
  camera.up.set(0, 0, 1); camera.position.copy(presentationPosition(view)).sub(origin);
  const bearing = radians(view.facing), tilt = radians(view.tilt);
  const right = new Vector3(Math.cos(bearing), -Math.sin(bearing), 0);
  const up = new Vector3(Math.sin(tilt) * Math.sin(bearing), Math.sin(tilt) * Math.cos(bearing), Math.cos(tilt));
  const backward = new Vector3(-Math.cos(tilt) * Math.sin(bearing), -Math.cos(tilt) * Math.cos(bearing), Math.sin(tilt));
  camera.quaternion.setFromRotationMatrix(new Matrix4().makeBasis(right, up, backward)); camera.updateMatrixWorld(); return camera;
}
export function capturePresentationCamera(camera: ViewCamera, target: Vector3, origin: Vector3): LxaCamera {
  camera.updateMatrixWorld();
  const right = new Vector3().setFromMatrixColumn(camera.matrixWorld, 0), direction = camera.getWorldDirection(new Vector3());
  const distance = Math.max(.0001, camera.position.distanceTo(target));
  const focus = camera instanceof PerspectiveCamera ? 12 / Math.tan(radians(camera.getEffectiveFOV()) / 2) : 12 * distance / ((camera.top - camera.bottom) / (2 * camera.zoom));
  return { facing: (MathUtils.radToDeg(Math.atan2(-right.y, right.x)) + 360) % 360, tilt: -MathUtils.radToDeg(Math.asin(MathUtils.clamp(direction.z, -1, 1))),
    center: target.clone().add(origin).toArray(), distance, focus: Math.max(20, Math.min(2000, focus)), perspective: camera instanceof PerspectiveCamera };
}
