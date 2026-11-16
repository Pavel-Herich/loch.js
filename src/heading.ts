/**
 * Which way the phone points. Compasses give magnetic headings; the app adds the
 * magnetic declination for Slovakia to get true north. DeviceLocation adds the
 * S-JTSK grid convergence on top of that.
 */
export const MAGNETIC_DECLINATION = 5.5;

type OrientationLike = { alpha: number | null; beta?: number | null; gamma?: number | null; absolute?: boolean; webkitCompassHeading?: number };

/** True-north heading in degrees (0–360, clockwise), or undefined when the event has none. */
export function headingFromEvent(event: OrientationLike, screenAngle = 0, declination = MAGNETIC_DECLINATION) {
  let magnetic: number | undefined;
  // Safari: compass heading of the top of the phone.
  if (typeof event.webkitCompassHeading === 'number' && Number.isFinite(event.webkitCompassHeading) && event.webkitCompassHeading >= 0) magnetic = event.webkitCompassHeading;
  // Chrome/Android: alpha counter-clockwise from north, only meaningful when absolute.
  else if (event.absolute && event.alpha !== null) magnetic = 360 - event.alpha;
  if (magnetic === undefined) return undefined;
  // In landscape the top of the screen is a side of the phone.
  return ((magnetic + screenAngle + declination) % 360 + 360) % 360;
}

/**
 * Where the phone's back camera looks, with the top of the screen as up: a true-north bearing
 * (clockwise) and a tilt (0° level, −90° straight down, as with the phone lying face up).
 * `heading` is headingFromEvent's heading of the top of the screen; beta and gamma are the
 * DeviceOrientation tilts. Lying flat, the bearing is where the top of the screen points; held
 * upright, where the camera looks.
 */
export function phoneView(heading: number, beta: number, gamma: number, screenAngle = 0) {
  const rad = Math.PI / 180;
  // Device → earth (east, north, up): Rz(alpha)·Rx(beta)·Ry(gamma), alpha counter-clockwise from true north.
  const a = (screenAngle - heading) * rad, b = beta * rad, g = gamma * rad;
  const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cg = Math.cos(g), sg = Math.sin(g);
  const rotate = (x: number, y: number, z: number) => {
    const x1 = x * cg + z * sg, z1 = -x * sg + z * cg; // Ry(gamma)
    const y2 = y * cb - z1 * sb, z2 = y * sb + z1 * cb; // Rx(beta)
    return [x1 * ca - y2 * sa, x1 * sa + y2 * ca, z2]; // Rz(alpha)
  };
  const forward = rotate(0, 0, -1), up = rotate(Math.sin(screenAngle * rad), Math.cos(screenAngle * rad), 0);
  const tilt = Math.asin(Math.max(-1, Math.min(1, forward[2]))) / rad;
  // Looking down, the screen's top gives the bearing where the camera direction fades out.
  const lean = forward[2] < 0 ? 1 : 0;
  const east = forward[0] + up[0] * lean, north = forward[1] + up[1] * lean;
  return { bearing: ((Math.atan2(east, north) / rad) % 360 + 360) % 360, tilt };
}

type Permission = { requestPermission?: () => Promise<'granted' | 'denied'> };

export class DeviceHeading {
  heading: number | undefined;
  /** Front-to-back and left-to-right tilts of the phone (DeviceOrientation beta, gamma). */
  beta: number | undefined;
  gamma: number | undefined;
  screenAngle = 0;
  private listening: string | undefined;
  private readonly handle = (event: Event) => {
    const angle = (typeof screen !== 'undefined' && screen.orientation?.angle) || (window as { orientation?: number }).orientation || 0;
    const next = headingFromEvent(event as unknown as OrientationLike, Number(angle));
    if (next === undefined) return;
    const { beta, gamma } = event as unknown as OrientationLike;
    const tilted = typeof beta === 'number' && typeof gamma === 'number'
      && (this.beta === undefined || this.gamma === undefined || Math.abs(beta - this.beta) >= .5 || Math.abs(gamma - this.gamma) >= .5);
    if (!tilted && this.heading !== undefined && Math.abs(((next - this.heading + 540) % 360) - 180) < .5) return;
    this.heading = next; this.screenAngle = Number(angle);
    if (typeof beta === 'number' && typeof gamma === 'number') { this.beta = beta; this.gamma = gamma; }
    this.onChange();
  };

  constructor(private onChange: () => void) {}

  /** Call from a tap: iPhone asks for motion and orientation access only during a user gesture. */
  start() {
    if (this.listening || typeof window === 'undefined' || !('DeviceOrientationEvent' in window)) return;
    const type = 'ondeviceorientationabsolute' in window ? 'deviceorientationabsolute' : 'deviceorientation';
    const listen = () => { if (this.listening) return; this.listening = type; window.addEventListener(type, this.handle); };
    const permission = (DeviceOrientationEvent as unknown as Permission).requestPermission;
    if (typeof permission === 'function') {
      permission.call(DeviceOrientationEvent).then(result => { if (result === 'granted') listen(); }).catch(() => { /* No arrow then. */ });
    } else listen();
  }

  stop() {
    if (this.listening) window.removeEventListener(this.listening, this.handle);
    this.listening = undefined; this.heading = undefined; this.beta = undefined; this.gamma = undefined;
    this.onChange();
  }
}
