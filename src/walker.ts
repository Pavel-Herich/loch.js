import { MathUtils, Vector3 } from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

// LOX coordinates are metres. These speeds do not depend on the orbit target.
const WALK_METRES_PER_PIXEL = .1;
const PAN_METRES_PER_PIXEL = .05;
const WHEEL_METRES_PER_PIXEL = .02;
const LOOK_RADIANS_PER_PIXEL = .003;

export class WalkerControls {
  private active = false;
  private pointer?: { id: number; button: number; x: number; y: number };
  private abort = new AbortController();

  constructor(private orbit: OrbitControls, private canvas: HTMLElement) {
    const options = { signal: this.abort.signal };
    canvas.addEventListener('pointerdown', this.down, options);
    canvas.addEventListener('pointermove', this.move, options);
    canvas.addEventListener('pointerup', this.up, options);
    canvas.addEventListener('pointercancel', this.up, options);
    canvas.addEventListener('lostpointercapture', this.up, options);
    canvas.addEventListener('wheel', this.wheel, { ...options, passive: false });
    canvas.addEventListener('contextmenu', event => { if (this.active) event.preventDefault(); }, options);
  }

  get enabled() { return this.active; }
  set enabled(value: boolean) {
    this.endDrag(); this.active = value; this.orbit.enabled = !value;
  }

  private endDrag() {
    if (!this.pointer) return;
    const id = this.pointer.id; this.pointer = undefined;
    this.canvas.releasePointerCapture(id);
    this.orbit.dispatchEvent({ type: 'end' });
  }

  private down = (event: PointerEvent) => {
    if (!this.active || this.pointer || event.button < 0 || event.button > 2) return;
    event.preventDefault();
    this.pointer = { id: event.pointerId, button: event.button, x: event.clientX, y: event.clientY };
    this.canvas.setPointerCapture(event.pointerId);
    this.orbit.dispatchEvent({ type: 'start' });
  };

  private move = (event: PointerEvent) => {
    const pointer = this.pointer;
    if (!this.active || !pointer || pointer.id !== event.pointerId) return;
    const dx = event.clientX - pointer.x, dy = event.clientY - pointer.y;
    pointer.x = event.clientX; pointer.y = event.clientY;
    if (!dx && !dy) return;
    event.preventDefault();
    if (pointer.button === 0) this.look(dx, dy);
    else if (pointer.button === 1) this.walk(-dy * WALK_METRES_PER_PIXEL);
    else {
      const camera = this.orbit.object;
      const right = new Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
      const up = new Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
      this.translate(right.multiplyScalar(-dx * PAN_METRES_PER_PIXEL).addScaledVector(up, dy * PAN_METRES_PER_PIXEL));
    }
  };

  private up = (event: PointerEvent) => {
    if (this.pointer?.id === event.pointerId) this.endDrag();
  };

  private wheel = (event: WheelEvent) => {
    if (!this.active) return;
    event.preventDefault();
    const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? this.canvas.clientHeight : 1);
    this.walk(-pixels * WHEEL_METRES_PER_PIXEL);
  };

  private look(dx: number, dy: number) {
    const camera = this.orbit.object, direction = camera.getWorldDirection(new Vector3());
    const yaw = Math.atan2(direction.y, direction.x) + dx * LOOK_RADIANS_PER_PIXEL;
    const elevation = MathUtils.clamp(Math.asin(MathUtils.clamp(direction.z, -1, 1)) + dy * LOOK_RADIANS_PER_PIXEL,
      Math.max(-Math.PI / 2 + 1e-6, this.orbit.minPolarAngle - Math.PI / 2),
      Math.min(Math.PI / 2 - 1e-6, this.orbit.maxPolarAngle - Math.PI / 2));
    direction.set(Math.cos(yaw) * Math.cos(elevation), Math.sin(yaw) * Math.cos(elevation), Math.sin(elevation));
    const distance = Math.max(camera.position.distanceTo(this.orbit.target), .001);
    this.orbit.target.copy(camera.position).addScaledVector(direction, distance);
    this.orbit.update();
  }

  private walk(distance: number) {
    this.translate(this.orbit.object.getWorldDirection(new Vector3()).multiplyScalar(distance));
  }

  private translate(offset: Vector3) {
    this.orbit.object.position.add(offset); this.orbit.target.add(offset);
    this.orbit.update();
  }

  dispose() { this.enabled = false; this.abort.abort(); }
}
