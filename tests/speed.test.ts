import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { PresentationTimeline } from '../src/presentation-timeline';
import { animationCamera } from '../src/save-animation';
import type { LxaView } from '../src/presentation';

const view = (name: string, x: number): LxaView => ({ name, facing: 0, tilt: 0, center: [x, 0, 0], distance: 10, focus: 50, perspective: true,
  duration: 3, rotations: 0, rotationDuration: 15, walker: false, transition: false, scene: {} });

describe('speed of rotation and animation', () => {
  it('turns a single view once in 15 s divided by the speed', () => {
    const timeline = new PresentationTimeline([view('a', 0)], true, false, 7.5);
    expect(timeline.duration).toBe(7.5);
    expect(timeline.frames(10).count).toBe(75);
  });
  it('turns the 360° film once in the given period', () => {
    const camera = new PerspectiveCamera(); camera.position.set(10, 0, 0); camera.up.set(0, 0, 1);
    const target = new Vector3(), size = { width: 64, height: 36 };
    const half = animationCamera(camera, target, size, 15, 1, 10, 3); // 15 frames of a 3 s turn at 10 fps: half a turn
    expect(half.position.x).toBeCloseTo(-10, 6);
  });
});
