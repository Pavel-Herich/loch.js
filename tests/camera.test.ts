import { describe, expect, it } from 'vitest';
import { Box3, PerspectiveCamera, Vector3 } from 'three';
import { createCameraControls, setCameraView, setTiltLocked } from '../src/camera';

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
  expect(up.z).toBeGreaterThan(0);
}

describe('Z-up camera controls', () => {
  it.each([0, 2])('stops moving when an orbit or pan is released (button %s)', button => {
    const canvas = new Canvas(), camera = new PerspectiveCamera();
    const controls = createCameraControls(camera, canvas as unknown as HTMLElement);
    const initial = camera.position.clone();
    pointer(canvas, 'pointerdown', 400, 300, button);
    pointer(canvas, 'pointermove', 520, 340, button);
    pointer(canvas, 'pointerup', 520, 340, button);
    expect(camera.position.distanceTo(initial)).toBeGreaterThan(0);
    const position = camera.position.clone(), target = controls.target.clone();
    const orientation = camera.quaternion.clone();
    let changes = 0;
    controls.addEventListener('change', () => changes++);
    for (let frame = 0; frame < 300; frame++) controls.update();
    expect(camera.position.distanceTo(position)).toBeLessThan(1e-10);
    expect(controls.target.distanceTo(target)).toBeLessThan(1e-10);
    expect(camera.quaternion.angleTo(orientation)).toBeLessThan(1e-7);
    expect(changes).toBe(0);
    controls.dispose();
  });

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

  it.each([-10000, 10000])('allows a vertical view and heading rotation (%s)', y => {
    const canvas = new Canvas(), camera = new PerspectiveCamera();
    const controls = createCameraControls(camera, canvas as unknown as HTMLElement);
    pointer(canvas, 'pointerdown', 400, 300);
    pointer(canvas, 'pointermove', 400, y);
    for (let frame = 0; frame < 200; frame++) controls.update();
    expectUpright(camera);
    const direction = camera.getWorldDirection(new Vector3());
    expect(direction.z).toBeCloseTo(y < 0 ? 1 : -1, 10);
    const orientation = camera.quaternion.clone();
    const distance = controls.getDistance();
    pointer(canvas, 'pointermove', 500, y);
    for (let frame = 0; frame < 200; frame++) controls.update();
    expect(camera.quaternion.angleTo(orientation)).toBeGreaterThan(0.1);
    expect(camera.getWorldDirection(new Vector3()).z).toBeCloseTo(direction.z, 10);
    expect(controls.getDistance()).toBeCloseTo(distance, 10);
    expectUpright(camera);
    pointer(canvas, 'pointerup', 500, y);
    controls.dispose();
  });
});

describe('model views', () => {
  it.each(['plan', 'profile'] as const)('locks tilt in %s while allowing heading changes, then unlocks', view => {
    const canvas = new Canvas(), camera = new PerspectiveCamera();
    const controls = createCameraControls(camera, canvas as unknown as HTMLElement);
    const box = new Box3(new Vector3(-10, -10, -10), new Vector3(10, 10, 10));
    setCameraView(camera, controls, box, view);
    const angle = controls.getPolarAngle(), orientation = camera.quaternion.clone();
    expect(controls.minPolarAngle).toBe(controls.maxPolarAngle);
    pointer(canvas, 'pointerdown', 400, 300);
    pointer(canvas, 'pointermove', 500, 400);
    pointer(canvas, 'pointerup', 500, 400);
    expect(controls.getPolarAngle()).toBeCloseTo(angle, 10);
    expect(camera.quaternion.angleTo(orientation)).toBeGreaterThan(.1);
    setTiltLocked(controls, false);
    pointer(canvas, 'pointerdown', 400, 300);
    pointer(canvas, 'pointermove', 400, 200);
    pointer(canvas, 'pointerup', 400, 200);
    expect(Math.abs(controls.getPolarAngle() - angle)).toBeGreaterThan(.1);
    setTiltLocked(controls, true);
    const arbitraryAngle = controls.getPolarAngle();
    pointer(canvas, 'pointerdown', 400, 300);
    pointer(canvas, 'pointermove', 400, 200);
    pointer(canvas, 'pointerup', 400, 200);
    expect(controls.getPolarAngle()).toBeCloseTo(arbitraryAngle, 10);
    // A locked preset must not constrain the next preset's new tilt.
    setCameraView(camera, controls, box, view === 'plan' ? 'profile' : 'plan');
    expect(controls.getPolarAngle()).toBeCloseTo(view === 'plan' ? Math.PI / 2 : 1e-6, 5);
    expect(controls.minPolarAngle).toBe(controls.maxPolarAngle);
    controls.dispose();
  });

  it.each(['plan', 'profile', 'fit'] as const)('fits %s on wide and narrow screens without orbit drift', view => {
    for (const aspect of [1.8, 0.5]) {
      const canvas = new Canvas(), camera = new PerspectiveCamera(45, aspect);
      const controls = createCameraControls(camera, canvas as unknown as HTMLElement);
      const box = new Box3(new Vector3(10, 20, -5), new Vector3(110, 40, 15));
      pointer(canvas, 'pointerdown', 400, 300);
      pointer(canvas, 'pointermove', 600, 400);
      pointer(canvas, 'pointerup', 600, 400);
      setCameraView(camera, controls, box, view);
      const position = camera.position.clone(), orientation = camera.quaternion.clone();
      for (let frame = 0; frame < 100; frame++) controls.update();
      expect(camera.position.distanceTo(position)).toBeLessThan(1e-8);
      expect(camera.quaternion.angleTo(orientation)).toBeLessThan(1e-7);
      expect(controls.target.distanceTo(box.getCenter(new Vector3()))).toBeLessThan(1e-8);
      const direction = camera.getWorldDirection(new Vector3());
      if (view === 'plan') expect(direction.z).toBeCloseTo(-1, 10);
      if (view === 'profile') expect(direction.y).toBeCloseTo(1, 10);
      camera.updateMatrixWorld();
      for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
        const projected = new Vector3(x, y, z).project(camera);
        expect(Math.abs(projected.x)).toBeLessThan(1);
        expect(Math.abs(projected.y)).toBeLessThan(1);
        expect(Math.abs(projected.z)).toBeLessThan(1);
      }
      controls.dispose();
    }
  });
});
