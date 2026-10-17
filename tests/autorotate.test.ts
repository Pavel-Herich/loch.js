import { describe, expect, it } from 'vitest';
import { Vector3, PerspectiveCamera, MathUtils } from 'three';
import { createCameraControls, setPerspective, setTiltLocked } from '../src/camera';
import { AutoRotation } from '../src/autorotate';

class Canvas extends EventTarget {
  style = { touchAction: '' };
  clientWidth = 800;
  clientHeight = 600;
  getRootNode() { return this; }
}
function setup() {
  const camera = new PerspectiveCamera(45, 4 / 3, .1, 1000);
  const controls = createCameraControls(camera, new Canvas() as unknown as HTMLElement);
  const target = new Vector3(10, 20, 30);
  camera.position.add(target); controls.target.copy(target); controls.update();
  const rotation = new AutoRotation(controls);
  return { camera, controls, rotation, target };
}
function angleDifference(a: number, b: number) { return Math.atan2(Math.sin(a - b), Math.cos(a - b)); }

describe('automatic rotation', () => {
  it.each([20, 60, 144])('makes one turn in 15 seconds at %s FPS, preserving tilt, distance, centre and Z-up', fps => {
    const { camera, controls, rotation, target } = setup();
    const distance = controls.getDistance(), tilt = controls.getPolarAngle();
    setTiltLocked(controls, true); rotation.enabled = true; rotation.update(0);
    let previous = controls.getAzimuthalAngle(), total = 0;
    for (let frame = 1; frame <= fps * 15; frame++) {
      rotation.update(frame * 1000 / fps);
      const angle = controls.getAzimuthalAngle(); total += angleDifference(angle, previous); previous = angle;
    }
    expect(Math.abs(total)).toBeCloseTo(2 * Math.PI, 9);
    expect(controls.getDistance()).toBeCloseTo(distance, 9); expect(controls.getPolarAngle()).toBeCloseTo(tilt, 9);
    expect(controls.target.distanceTo(target)).toBeLessThan(1e-9);
    expect(new Vector3(1, 0, 0).applyQuaternion(camera.quaternion).z).toBeCloseTo(0, 9);
    rotation.dispose(); controls.dispose();
  });

  it('starts paused, stops immediately, and resumes without counting the paused time', () => {
    const { camera, controls, rotation } = setup(), initial = camera.position.clone();
    rotation.update(0); rotation.update(50000); expect(camera.position.distanceTo(initial)).toBeLessThan(1e-10);
    rotation.enabled = true; rotation.update(50001);
    const firstAngle = controls.getAzimuthalAngle(); rotation.update(53751);
    expect(Math.abs(angleDifference(controls.getAzimuthalAngle(), firstAngle))).toBeCloseTo(Math.PI / 2);
    rotation.enabled = false; const paused = camera.position.clone(); rotation.update(100000);
    expect(camera.position.distanceTo(paused)).toBeLessThan(1e-10);
    rotation.enabled = true; rotation.update(200000); expect(camera.position.distanceTo(paused)).toBeLessThan(1e-10);
    rotation.update(203750); expect(camera.position.distanceTo(paused)).toBeGreaterThan(1);
    rotation.dispose(); controls.dispose();
  });

  it('does not add rotation during extra control updates or a projection switch', () => {
    const { controls, rotation } = setup(); rotation.enabled = true; rotation.update(0); rotation.update(1000);
    const angle = controls.getAzimuthalAngle();
    for (let i = 0; i < 10; i++) controls.update();
    expect(controls.getAzimuthalAngle()).toBeCloseTo(angle, 10); expect(controls.autoRotate).toBe(false);
    setPerspective(controls.object as PerspectiveCamera, controls, false);
    expect(controls.getAzimuthalAngle()).toBeCloseTo(angle, 10);
    rotation.update(4750);
    expect(Math.abs(angleDifference(controls.getAzimuthalAngle(), angle))).toBeCloseTo(Math.PI / 2);
    rotation.dispose(); controls.dispose();
  });

  it('pauses during preparation or hidden frames and never catches up skipped time', () => {
    const { controls, rotation } = setup(); rotation.enabled = true; rotation.update(0); rotation.update(1000);
    const angle = controls.getAzimuthalAngle();
    rotation.update(10000, true); rotation.update(15000, true); rotation.update(30000);
    expect(controls.getAzimuthalAngle()).toBeCloseTo(angle, 10);
    rotation.update(31000); expect(Math.abs(angleDifference(controls.getAzimuthalAngle(), angle))).toBeCloseTo(MathUtils.degToRad(24));
    const beforeHidden = controls.getAzimuthalAngle(); rotation.resetTime(); rotation.update(100000);
    expect(controls.getAzimuthalAngle()).toBeCloseTo(beforeHidden, 10);
    rotation.dispose(); controls.dispose();
  });

  it('works with Walker enabled and pauses for its interaction events', () => {
    const { controls, rotation } = setup(); controls.enabled = false; rotation.enabled = true;
    rotation.update(0); const angle = controls.getAzimuthalAngle(); rotation.update(3750);
    expect(Math.abs(angleDifference(controls.getAzimuthalAngle(), angle))).toBeCloseTo(Math.PI / 2);
    controls.dispatchEvent({ type: 'start' }); const paused = controls.getAzimuthalAngle();
    rotation.update(8000); expect(controls.getAzimuthalAngle()).toBeCloseTo(paused);
    controls.dispatchEvent({ type: 'end' }); rotation.update(10000); rotation.update(13750);
    expect(Math.abs(angleDifference(controls.getAzimuthalAngle(), paused))).toBeCloseTo(Math.PI / 2);
    expect(controls.enabled).toBe(false); rotation.dispose(); controls.dispose();
  });
});
