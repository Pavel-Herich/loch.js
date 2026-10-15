import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { createCameraControls, setPerspective, setTiltLocked } from '../src/camera';
import { WalkerControls } from '../src/walker';

class Canvas extends EventTarget {
  style = { touchAction: '' };
  clientWidth = 800;
  clientHeight = 600;
  getRootNode() { return this; }
  setPointerCapture() {}
  releasePointerCapture() {}
}

function pointer(canvas: Canvas, type: string, x: number, y: number, button = 0) {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, { pointerId: 1, pointerType: 'mouse', clientX: x, clientY: y, button });
  canvas.dispatchEvent(event);
}

function touch(canvas: Canvas, type: string, id: number, x: number, y: number) {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, pageX: x, pageY: y, button: 0 });
  canvas.dispatchEvent(event);
}

function setup(distance = 10) {
  const canvas = new Canvas(), camera = new PerspectiveCamera();
  const orbit = createCameraControls(camera, canvas as unknown as HTMLElement);
  camera.position.set(0, -distance, 0); orbit.target.set(0, 0, 0); orbit.update();
  const walker = new WalkerControls(orbit, canvas as unknown as HTMLElement);
  walker.enabled = true;
  return { canvas, camera, orbit, walker, dispose() { walker.dispose(); orbit.dispose(); } };
}

function drag(canvas: Canvas, button: number, dx: number, dy: number) {
  pointer(canvas, 'pointerdown', 400, 300, button);
  pointer(canvas, 'pointermove', 400 + dx, 300 + dy, button);
  pointer(canvas, 'pointerup', 400 + dx, 300 + dy, button);
}

describe('Walker camera', () => {
  it.each([1, 1000])('pans and pinches with two fingers without rotating, independent of target distance %s', distance => {
    const s = setup(distance), position = s.camera.position.clone(), orientation = s.camera.quaternion.clone();
    touch(s.canvas, 'pointerdown', 1, 300, 300);
    touch(s.canvas, 'pointerdown', 2, 500, 300);
    touch(s.canvas, 'pointermove', 1, 340, 320);
    touch(s.canvas, 'pointermove', 2, 540, 320);
    expect(s.camera.position.clone().sub(position).distanceTo(new Vector3(-2, 0, 1))).toBeLessThan(1e-8);
    const beforePinch = s.camera.position.clone();
    touch(s.canvas, 'pointermove', 1, 290, 320);
    touch(s.canvas, 'pointermove', 2, 590, 320);
    expect(s.camera.position.clone().sub(beforePinch).distanceTo(new Vector3(0, 10, 0))).toBeLessThan(1e-8);
    expect(s.camera.quaternion.angleTo(orientation)).toBeLessThan(1e-7);
    expect(s.orbit.getDistance()).toBeCloseTo(distance, 8);
    // Pinching back returns to the previous position.
    touch(s.canvas, 'pointermove', 1, 340, 320);
    touch(s.canvas, 'pointermove', 2, 540, 320);
    expect(s.camera.position.distanceTo(beforePinch)).toBeLessThan(1e-8);
    touch(s.canvas, 'pointerup', 2, 540, 320);
    expect(s.camera.quaternion.angleTo(orientation)).toBeLessThan(1e-7);
    // The remaining finger resumes looking from its current location, without a jump.
    touch(s.canvas, 'pointermove', 1, 340, 340);
    expect(s.camera.position.distanceTo(beforePinch)).toBeLessThan(1e-8);
    expect(s.camera.getWorldDirection(new Vector3()).z).toBeGreaterThan(0);
    touch(s.canvas, 'pointerup', 1, 340, 340);
    s.dispose();
  });

  it('cancels all touch movement and supports pinch walking after changing projection', () => {
    const s = setup();
    const camera = setPerspective(s.camera, s.orbit, false), zoom = camera.zoom;
    touch(s.canvas, 'pointerdown', 1, 300, 300);
    touch(s.canvas, 'pointerdown', 2, 500, 300);
    const position = camera.position.clone();
    touch(s.canvas, 'pointermove', 1, 280, 300);
    touch(s.canvas, 'pointermove', 2, 520, 300);
    expect(camera.position.distanceTo(position)).toBeCloseTo(4, 8);
    expect(camera.zoom).toBe(zoom);
    touch(s.canvas, 'pointercancel', 1, 280, 300);
    const cancelled = camera.position.clone();
    touch(s.canvas, 'pointermove', 2, 600, 300);
    expect(camera.position.distanceTo(cancelled)).toBe(0);
    s.dispose();
  });

  it('looks around from a fixed position, keeps Z up, and stops immediately', () => {
    const s = setup(), position = s.camera.position.clone(), initial = s.camera.quaternion.clone();
    drag(s.canvas, 0, 80, -40);
    expect(s.camera.position.distanceTo(position)).toBeLessThan(1e-8);
    expect(s.camera.quaternion.angleTo(initial)).toBeGreaterThan(.1);
    const direction = s.camera.getWorldDirection(new Vector3());
    expect(direction.x).toBeLessThan(0); // Drag right looks left.
    expect(direction.z).toBeLessThan(0); // Drag up looks down.
    expect(new Vector3(1, 0, 0).applyQuaternion(s.camera.quaternion).z).toBeCloseTo(0, 10);
    const orientation = s.camera.quaternion.clone();
    for (let i = 0; i < 100; i++) s.orbit.update();
    expect(s.camera.position.distanceTo(position)).toBeLessThan(1e-8);
    expect(s.camera.quaternion.angleTo(orientation)).toBeLessThan(1e-7);
    s.dispose();
  });

  it.each([1, 1000])('walks and pans at a fixed speed with target distance %s', distance => {
    const s = setup(distance), position = s.camera.position.clone(), orientation = s.camera.quaternion.clone();
    drag(s.canvas, 1, 0, -100);
    expect(s.camera.position.distanceTo(position)).toBeCloseTo(10, 8);
    expect(s.orbit.getDistance()).toBeCloseTo(distance, 8);
    expect(s.camera.quaternion.angleTo(orientation)).toBeLessThan(1e-7);
    drag(s.canvas, 1, 0, 100);
    expect(s.camera.position.distanceTo(position)).toBeLessThan(1e-8);
    const wheel = new Event('wheel', { cancelable: true });
    Object.assign(wheel, { deltaY: -100, deltaMode: 0 }); s.canvas.dispatchEvent(wheel);
    expect(s.camera.position.clone().sub(position).distanceTo(new Vector3(0, 2, 0))).toBeLessThan(1e-8);
    const beforePan = s.camera.position.clone();
    drag(s.canvas, 2, 40, 20);
    expect(s.camera.position.clone().sub(beforePan).distanceTo(new Vector3(-2, 0, 1))).toBeLessThan(1e-8);
    expect(s.camera.quaternion.angleTo(orientation)).toBeLessThan(1e-7);
    s.dispose();
  });

  it('preserves tilt lock, switches projection, and restores orbit controls without moving the camera', () => {
    const s = setup();
    setTiltLocked(s.orbit, true);
    drag(s.canvas, 0, 50, -50);
    expect(s.camera.getWorldDirection(new Vector3()).z).toBeCloseTo(0, 10);
    const camera = setPerspective(s.camera, s.orbit, false);
    const position = camera.position.clone(), zoom = camera.zoom;
    drag(s.canvas, 1, 0, -20);
    expect(camera.position.distanceTo(position)).toBeCloseTo(2, 8);
    expect(camera.zoom).toBe(zoom);
    const before = camera.position.clone(), orientation = camera.quaternion.clone();
    s.walker.enabled = false;
    expect(s.orbit.enabled).toBe(true);
    expect(camera.position.distanceTo(before)).toBe(0);
    expect(camera.quaternion.angleTo(orientation)).toBeLessThan(1e-7);
    drag(s.canvas, 0, 50, 0);
    expect(camera.position.distanceTo(before)).toBeGreaterThan(.1);
    s.dispose();
  });

  it('ends a cancelled gesture without further movement', () => {
    const s = setup();
    pointer(s.canvas, 'pointerdown', 400, 300, 1);
    pointer(s.canvas, 'pointermove', 400, 280, 1);
    pointer(s.canvas, 'pointercancel', 400, 280, 1);
    const position = s.camera.position.clone();
    pointer(s.canvas, 'pointermove', 400, 200, 1);
    expect(s.camera.position.distanceTo(position)).toBe(0);
    s.dispose();
  });
});
