import { MathUtils, Vector3 } from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { setTiltLocked, type ViewCamera } from './camera';
import { viewOrientation } from './indicators';

const LIMIT = 90 - 1e-4;

/**
 * Orbit around the current target to a bearing (clockwise from north, +Y) and
 * tilt (degrees above horizontal), keeping distance and any active locks.
 */
export function orbitTo(camera: ViewCamera, controls: OrbitControls, bearing: number, tilt: number) {
  const locks = [controls.minAzimuthAngle, controls.maxAzimuthAngle, controls.minPolarAngle, controls.maxPolarAngle] as const;
  controls.minAzimuthAngle = -Infinity; controls.maxAzimuthAngle = Infinity;
  controls.minPolarAngle = 0; controls.maxPolarAngle = Math.PI;
  const b = MathUtils.degToRad(bearing), t = MathUtils.degToRad(MathUtils.clamp(tilt, -LIMIT, LIMIT));
  const direction = new Vector3(Math.sin(b) * Math.cos(t), Math.cos(b) * Math.cos(t), Math.sin(t));
  const distance = camera.position.distanceTo(controls.target);
  camera.position.copy(controls.target).addScaledVector(direction, -distance);
  controls.update();
  [controls.minAzimuthAngle, controls.maxAzimuthAngle, controls.minPolarAngle, controls.maxPolarAngle] = locks;
}

function lockHeading(controls: OrbitControls, locked: boolean) {
  const angle = controls.getAzimuthalAngle();
  controls.minAzimuthAngle = locked ? angle : -Infinity;
  controls.maxAzimuthAngle = locked ? angle : Infinity;
}

export type ViewLockState = { north: boolean; side: boolean; tiltLocked: boolean };

/**
 * Compass: face north and hold the heading, or return to the previous heading.
 * Tilt: level side view with tilt locked, or return to the previous tilt and lock.
 * Each toggle restores only its own angle, so they combine freely.
 */
export class ViewLocks {
  private north?: { bearing: number };
  private side?: { tilt: number; locked: boolean };

  constructor(private getCamera: () => ViewCamera, private controls: OrbitControls, private onChange: (state: ViewLockState) => void) {}

  get state(): ViewLockState {
    return { north: Boolean(this.north), side: Boolean(this.side), tiltLocked: this.controls.minPolarAngle === this.controls.maxPolarAngle };
  }

  toggleNorth() {
    const camera = this.getCamera(), { bearing, tilt } = viewOrientation(camera);
    if (this.north) {
      lockHeading(this.controls, false);
      orbitTo(camera, this.controls, this.north.bearing, tilt);
      this.north = undefined;
    } else {
      this.north = { bearing };
      orbitTo(camera, this.controls, 0, tilt);
      lockHeading(this.controls, true);
    }
    this.onChange(this.state);
  }

  toggleSide() {
    const camera = this.getCamera(), { bearing, tilt } = viewOrientation(camera);
    if (this.side) {
      const previous = this.side;
      setTiltLocked(this.controls, false);
      orbitTo(camera, this.controls, bearing, previous.tilt);
      setTiltLocked(this.controls, previous.locked);
      this.side = undefined;
    } else {
      this.side = { tilt, locked: this.controls.minPolarAngle === this.controls.maxPolarAngle };
      setTiltLocked(this.controls, false);
      orbitTo(camera, this.controls, bearing, 0);
      setTiltLocked(this.controls, true);
    }
    this.onChange(this.state);
  }

  /** Forget both toggles, e.g. when a Plan, Profile or Fit view replaces the camera angles. */
  reset() {
    if (this.north) lockHeading(this.controls, false);
    this.north = undefined; this.side = undefined;
    this.onChange(this.state);
  }
}
