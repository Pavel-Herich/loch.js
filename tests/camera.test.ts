import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { createCameraControls } from '../src/camera';

class Canvas extends EventTarget {
  style = { touchAction: '' };
  clientWidth = 800;
  clientHeight = 600;
  getRootNode() { return this; }
  setPointerCapture() {}
  releasePointerCapture() {}
}

function pointer(canvas: Canvas, type: string, x: number, y: number, button = 0) {
  const event = new Event(type);
  Object.assign(event, { pointerId: 1, pointerType: 'mouse', clientX: x, clientY: y, button });
  canvas.dispatchEvent(event);
}

function expectUpright(camera: PerspectiveCamera) {
  const right = new Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  const up = new Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
  expect(right.z).toBeCloseTo(0, 10);
  expect(up.z).toBeGreaterThan(0.08);
}

describe('Z-up camera controls', () => {
  it('keeps Z vertical during diagonal orbits and damping', () => {
    const canvas = new Canvas(), camera = new PerspectiveCamera();
    const controls = createCameraControls(camera, canvas as unknown as HTMLElement);
    expectUpright(camera);
    pointer(canvas, 'pointerdown', 400, 300);
    for (let step = 1; step <= 40; step++) {
      pointer(canvas, 'pointermove', 400 + step * 37, 300 + Math.sin(step) * 90);
      controls.update();
      expectUpright(camera);
    }
    pointer(canvas, 'pointerup', 1880, 300);
    for (let frame = 0; frame < 100; frame++) {
      controls.update();
      expectUpright(camera);
    }
    controls.dispose();
  });

  it.each([-10000, 10000])('stops vertical drags before the pole (%s)', y => {
    const canvas = new Canvas(), camera = new PerspectiveCamera();
    const controls = createCameraControls(camera, canvas as unknown as HTMLElement);
    pointer(canvas, 'pointerdown', 400, 300);
    pointer(canvas, 'pointermove', 400, y);
    for (let frame = 0; frame < 200; frame++) controls.update();
    expectUpright(camera);
    const angle = controls.getPolarAngle();
    expect(angle).toBeGreaterThanOrEqual(Math.PI / 36 - 1e-10);
    expect(angle).toBeLessThanOrEqual(Math.PI * 35 / 36 + 1e-10);
    const position = camera.position.clone();
    pointer(canvas, 'pointermove', 500, y);
    controls.update();
    expect(camera.position.distanceTo(position)).toBeGreaterThan(0);
    expectUpright(camera);
    pointer(canvas, 'pointerup', 500, y);
    controls.dispose();
  });
});
