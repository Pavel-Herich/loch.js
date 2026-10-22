import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { createCameraControls } from '../src/camera';
import { viewOrientation } from '../src/indicators';
import { orbitTo, ViewLocks, type ViewLockState } from '../src/view-locks';

class Canvas extends EventTarget {
  style = { touchAction: '' }; clientWidth = 800; clientHeight = 600;
  getRootNode() { return this; } setPointerCapture() {} releasePointerCapture() {}
}
function drag(canvas: Canvas, dx: number, dy: number) {
  for (const [type, x, y] of [['pointerdown', 400, 300], ['pointermove', 400 + dx, 300 + dy], ['pointerup', 400 + dx, 300 + dy]] as const) {
    const event = new Event(type); Object.assign(event, { pointerId: 1, pointerType: 'mouse', clientX: x, clientY: y, button: 0 });
    canvas.dispatchEvent(event);
  }
}
function setup() {
  const canvas = new Canvas(), camera = new PerspectiveCamera(45, 4 / 3, .1, 1e5);
  const controls = createCameraControls(camera, canvas as unknown as HTMLElement);
  controls.target.set(100, 200, 50); camera.position.set(100, 100, 150); controls.update();
  orbitTo(camera, controls, 120, -30);
  const states: ViewLockState[] = [];
  return { canvas, camera, controls, states, locks: new ViewLocks(() => camera, controls, state => states.push(state)) };
}
const angles = (camera: PerspectiveCamera) => viewOrientation(camera);

describe('compass and tilt toggles', () => {
  it('orbits to a bearing and tilt around the target at the same distance', () => {
    const { camera, controls } = setup();
    expect(angles(camera).bearing).toBeCloseTo(120, 6); expect(angles(camera).tilt).toBeCloseTo(-30, 6);
    expect(camera.position.distanceTo(controls.target)).toBeCloseTo(Math.hypot(100, 100), 6);
  });

  it('faces north with the heading held, then returns to the previous heading', () => {
    const { canvas, camera, controls, locks, states } = setup();
    locks.toggleNorth();
    expect(angles(camera).bearing % 360).toBeCloseTo(0, 6); expect(angles(camera).tilt).toBeCloseTo(-30, 6);
    drag(canvas, 200, 60);
    expect(Math.min(angles(camera).bearing, 360 - angles(camera).bearing)).toBeLessThan(1e-6);
    expect(angles(camera).tilt).not.toBeCloseTo(-30, 1);
    locks.toggleNorth();
    expect(angles(camera).bearing).toBeCloseTo(120, 6);
    expect(controls.minAzimuthAngle).toBe(-Infinity);
    expect(states.map(state => state.north)).toEqual([true, false]);
  });

  it('levels to a side view with tilt locked, then restores tilt and the earlier lock', () => {
    const { canvas, camera, controls, locks, states } = setup();
    locks.toggleSide();
    expect(angles(camera).tilt).toBeCloseTo(0, 6); expect(angles(camera).bearing).toBeCloseTo(120, 6);
    expect(states.at(-1)).toEqual({ north: false, side: true, tiltLocked: true });
    drag(canvas, 120, 80);
    expect(angles(camera).tilt).toBeCloseTo(0, 6);
    const bearing = angles(camera).bearing;
    locks.toggleSide();
    expect(angles(camera).tilt).toBeCloseTo(-30, 6); expect(angles(camera).bearing).toBeCloseTo(bearing, 6);
    expect(controls.minPolarAngle).toBe(0); expect(states.at(-1)?.tiltLocked).toBe(false);
  });

  it('combines both toggles and each restores only its own angle', () => {
    const { camera, locks } = setup();
    locks.toggleNorth(); locks.toggleSide();
    expect(angles(camera).bearing % 360).toBeCloseTo(0, 6); expect(angles(camera).tilt).toBeCloseTo(0, 6);
    locks.toggleNorth();
    expect(angles(camera).bearing).toBeCloseTo(120, 6); expect(angles(camera).tilt).toBeCloseTo(0, 6);
    locks.toggleSide();
    expect(angles(camera).bearing).toBeCloseTo(120, 6); expect(angles(camera).tilt).toBeCloseTo(-30, 6);
    locks.toggleNorth(); locks.reset();
    expect(locks.state.north).toBe(false);
    expect(new Vector3(1, 0, 0).applyQuaternion(camera.quaternion).z).toBeCloseTo(0, 9);
  });
});
