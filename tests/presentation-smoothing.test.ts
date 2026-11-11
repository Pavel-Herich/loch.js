import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import type { LxaView } from '../src/presentation';
import { PresentationTimeline, presentationPosition } from '../src/presentation-timeline';

const view = (changes: Partial<LxaView> = {}): LxaView => ({ name: 'View', center: [0, 0, 0], facing: 0, tilt: 0, distance: 3,
  focus: 50, perspective: true, duration: 3, rotationDuration: 15, rotations: 0, walker: false, transition: true, scene: {}, ...changes });
const epsilon = 1e-6;
function velocities(timeline: PresentationTimeline, time: number) {
  const at = presentationPosition(timeline.sample(time));
  return [at.clone().sub(presentationPosition(timeline.sample(time - epsilon))).divideScalar(epsilon),
    presentationPosition(timeline.sample(time + epsilon)).sub(at).divideScalar(epsilon)];
}
const angleDelta = (from: number, to: number) => ((to - from + 180) % 360 + 360) % 360 - 180;

describe('continuous animation transitions', () => {
  it.each([[true, true], [false, false], [true, false], [false, true]])('joins actual camera velocity across unequal durations (Walker in %s, out %s)', (incoming, outgoing) => {
    const timeline = new PresentationTimeline([view({ facing: 350, tilt: 10, focus: 40 }),
      view({ center: [10, 0, 2], distance: 5, facing: 10, tilt: 30, focus: 100, duration: 2, walker: incoming }),
      view({ center: [10, 20, 1], distance: 2, facing: 80, tilt: -20, focus: 60, duration: 5, walker: outgoing })], false);
    const [before, after] = velocities(timeline, 2);
    expect(before.length()).toBeGreaterThan(.1); expect(before.distanceTo(after)).toBeLessThan(.0001);
    const a = timeline.sample(2 - epsilon), b = timeline.sample(2), c = timeline.sample(2 + epsilon);
    for (const field of ['facing', 'tilt', 'distance', 'focus'] as const) {
      const delta = field === 'facing' ? angleDelta : (from: number, to: number) => to - from;
      expect(Math.abs(delta(a[field], b[field]) / epsilon - delta(b[field], c[field]) / epsilon)).toBeLessThan(.001);
    }
    expect(presentationPosition(b).distanceTo(presentationPosition(timeline.views[1]))).toBeLessThan(1e-9);
  });
  it('rounds a Walker corner rather than stopping or changing direction abruptly', () => {
    const timeline = new PresentationTimeline([view({ walker: true }), view({ center: [10, 0, 0], walker: true, duration: 2 }),
      view({ center: [10, 10, 0], walker: true, duration: 2 })], false);
    const [before, after] = velocities(timeline, 2);
    expect(before.x).toBeCloseTo(2.5, 4); expect(before.y).toBeCloseTo(2.5, 4);
    expect(before.distanceTo(after)).toBeLessThan(.0001);
    expect(presentationPosition(timeline.sample(1)).y).not.toBeCloseTo(-3);
  });
  it('preserves the pivot and orbit radius while smoothing angular speed', () => {
    const timeline = new PresentationTimeline([view(), view({ facing: 60, duration: 2 }), view({ facing: 120, duration: 4 })], false);
    for (let t = 0; t < timeline.duration; t += .1) {
      const pose = timeline.sample(t); expect(pose.center).toEqual([0, 0, 0]); expect(presentationPosition(pose).length()).toBeCloseTo(3);
    }
    const [before, after] = velocities(timeline, 2); expect(before.distanceTo(after)).toBeLessThan(.0001);
  });
  it('keeps ordinary views and both boundaries of explicit rotations at rest', () => {
    for (const rotations of [0, -1]) {
      const timeline = new PresentationTimeline([view(), view({ center: [5, 2, 0], transition: rotations !== 0, rotations, rotationDuration: 2, duration: 2 }),
        view({ center: [10, 5, 0], facing: 90 })], false);
      for (const time of rotations ? [2, 4] : [2]) for (const velocity of velocities(timeline, time)) expect(velocity.length()).toBeLessThan(.0001);
    }
  });
  it('joins looping camera motion and heading at the first view', () => {
    const timeline = new PresentationTimeline([view({ duration: 1 }), view({ facing: 90, duration: 2 }),
      view({ facing: 180, duration: 3 }), view({ facing: 270, duration: 4 })], true);
    const [before, after] = velocities(timeline, 0); expect(before.length()).toBeGreaterThan(.1); expect(before.distanceTo(after)).toBeLessThan(.0001);
    expect(presentationPosition(timeline.sample(timeline.duration)).distanceTo(presentationPosition(timeline.sample(0)))).toBeLessThan(1e-9);
  });
  it('keeps distance positive and lens/tilt in range despite sharply differing durations', () => {
    const timeline = new PresentationTimeline([view({ distance: .001, focus: 20, tilt: -90, duration: .1 }),
      view({ distance: 100, focus: 2000, tilt: 90, duration: 10 }), view({ distance: .01, focus: 25, tilt: -89, duration: .1 }),
      view({ distance: 80, focus: 1500, tilt: 50, duration: 5 })], true);
    timeline.segments.forEach((_, index) => {
      for (let sample = 0; sample <= 100; sample++) {
        const pose = timeline.sampleSegment(index, sample / 100);
        expect(pose.distance).toBeGreaterThan(0); expect(pose.focus).toBeGreaterThanOrEqual(20 - 1e-9); expect(pose.focus).toBeLessThanOrEqual(2000 + 1e-9);
        expect(Math.abs(pose.tilt)).toBeLessThanOrEqual(90 + 1e-9); expect(new Vector3(...pose.center).length()).toBe(0);
      }
    });
  });
});
