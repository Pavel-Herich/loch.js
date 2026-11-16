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

export type CompassMode = 'free' | 'north' | 'device';
export type TiltMode = 'free' | 'side' | 'plan' | 'phone';
export type ViewLockState = { north: boolean; side: boolean; compass: CompassMode; tilt: TiltMode; tiltLocked: boolean };

/**
 * Compass: face north looking down, then follow the phone's heading and tilt,
 * then return to the previous heading and tilt.
 * Tilt: level side view, then a plan view looking straight down (both with
 * tilt locked), then the previous tilt and lock.
 * Each toggle restores only its own angle, so they combine freely.
 */
export class ViewLocks {
  private north?: { bearing: number; tilt: number; locked: boolean };
  private device = false;
  /** While following the phone: whether its tilt steers too (else the tilt is dragged by hand). */
  private phoneTilt = true;
  private side?: { tilt: number; locked: boolean };
  private plan = false;

  constructor(private getCamera: () => ViewCamera, private controls: OrbitControls, private onChange: (state: ViewLockState) => void) {}

  get state(): ViewLockState {
    const compass: CompassMode = this.device ? 'device' : this.north ? 'north' : 'free';
    const tilt: TiltMode = this.device && this.phoneTilt ? 'phone' : this.plan ? 'plan' : this.side ? 'side' : 'free';
    return { north: compass !== 'free', side: tilt !== 'free', compass, tilt, tiltLocked: this.controls.minPolarAngle === this.controls.maxPolarAngle };
  }

  /**
   * Free → north looking straight down (a map; the heading held, tilt free) → following the
   * phone's heading and tilt → the previous heading, tilt and tilt lock.
   */
  toggleNorth() {
    const camera = this.getCamera(), { bearing, tilt } = viewOrientation(camera);
    if (this.device) {
      const previous = this.north!;
      lockHeading(this.controls, false); setTiltLocked(this.controls, false);
      orbitTo(camera, this.controls, previous.bearing, previous.tilt);
      setTiltLocked(this.controls, previous.locked);
      this.north = undefined; this.device = false;
    } else if (this.north) {
      this.device = true; this.phoneTilt = true;
    } else {
      // The compass takes over the tilt, so the tilt toggle's state ends here.
      this.north = this.side ? { bearing, tilt: this.side.tilt, locked: this.side.locked } : { bearing, tilt, locked: this.controls.minPolarAngle === this.controls.maxPolarAngle };
      this.side = undefined; this.plan = false;
      setTiltLocked(this.controls, false);
      orbitTo(camera, this.controls, 0, -90);
      lockHeading(this.controls, true);
    }
    this.onChange(this.state);
  }

  /**
   * While following the phone, turn the view to a bearing (clockwise from model north) and,
   * when given, a tilt, and hold both until the next reading.
   */
  face(bearing: number, tilt?: number) {
    if (!this.device) return;
    if (!this.phoneTilt) tilt = undefined;
    const camera = this.getCamera();
    if (tilt !== undefined) setTiltLocked(this.controls, false);
    orbitTo(camera, this.controls, bearing, tilt ?? viewOrientation(camera).tilt);
    lockHeading(this.controls, true);
    if (tilt !== undefined) setTiltLocked(this.controls, true);
  }

  /** Free → level side view → plan view → free. */
  toggleSide() {
    // Following the phone, the tilt toggle only switches the phone's tilt off (drag to tilt) and on.
    if (this.device) {
      this.phoneTilt = !this.phoneTilt;
      if (!this.phoneTilt) setTiltLocked(this.controls, false);
      this.onChange(this.state);
      return;
    }
    const camera = this.getCamera(), { bearing, tilt } = viewOrientation(camera);
    if (this.plan) {
      const previous = this.side!;
      setTiltLocked(this.controls, false);
      orbitTo(camera, this.controls, bearing, previous.tilt);
      setTiltLocked(this.controls, previous.locked);
      this.side = undefined; this.plan = false;
    } else if (this.side) {
      setTiltLocked(this.controls, false);
      orbitTo(camera, this.controls, bearing, -90);
      setTiltLocked(this.controls, true);
      this.plan = true;
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
    if (this.device) setTiltLocked(this.controls, false);
    this.north = undefined; this.device = false; this.side = undefined; this.plan = false;
    this.onChange(this.state);
  }
}
