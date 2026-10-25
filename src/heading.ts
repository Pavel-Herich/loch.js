/**
 * Which way the phone points. Compasses give magnetic headings; the app adds the
 * magnetic declination for Slovakia to get true north. DeviceLocation adds the
 * S-JTSK grid convergence on top of that.
 */
export const MAGNETIC_DECLINATION = 5.5;

type OrientationLike = { alpha: number | null; absolute?: boolean; webkitCompassHeading?: number };

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

type Permission = { requestPermission?: () => Promise<'granted' | 'denied'> };

export class DeviceHeading {
  heading: number | undefined;
  private listening: string | undefined;
  private readonly handle = (event: Event) => {
    const angle = (typeof screen !== 'undefined' && screen.orientation?.angle) || (window as { orientation?: number }).orientation || 0;
    const next = headingFromEvent(event as unknown as OrientationLike, Number(angle));
    if (next === undefined) return;
    if (this.heading !== undefined && Math.abs(((next - this.heading + 540) % 360) - 180) < .5) return;
    this.heading = next;
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
    this.listening = undefined; this.heading = undefined;
    this.onChange();
  }
}
