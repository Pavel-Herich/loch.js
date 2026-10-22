import { Object3D, PerspectiveCamera, Raycaster, Vector2, Vector3, type OrthographicCamera } from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export type PivotCamera = PerspectiveCamera | OrthographicCamera;

/** Pick tolerance for centreline shots and point previews, in screen pixels. */
export const PICK_TOLERANCE_PIXELS = 6;
/** A press that moves farther than this is a drag, not a pick. */
const CLICK_SLOP_PIXELS = 6;
const RECENTER_MS = 250;

function visibleInScene(object: Object3D) {
  for (let node: Object3D | null = object; node; node = node.parent) if (!node.visible) return false;
  return true;
}

/** World size of one screen pixel at the given depth in front of the camera. */
function worldPerPixel(camera: PivotCamera, depth: number, height: number) {
  if (camera instanceof PerspectiveCamera) return 2 * Math.max(depth, camera.near) * Math.tan(camera.getEffectiveFOV() * Math.PI / 360) / height;
  return (camera.top - camera.bottom) / camera.zoom / height;
}

/**
 * Return the nearest visible model point under a viewport position in normalized
 * device coordinates: walls and surface first-hit, centreline within a few pixels.
 */
export function pickModelPoint(camera: PivotCamera, roots: Object3D[], ndc: Vector2, viewportHeight: number, target?: Vector3): Vector3 | undefined {
  camera.updateMatrixWorld();
  const raycaster = new Raycaster();
  raycaster.setFromCamera(ndc, camera);
  // Size line and point tolerance from the depth of the current rotation centre.
  const reference = target ? target.clone().sub(raycaster.ray.origin).dot(raycaster.ray.direction) : camera.near;
  const tolerance = worldPerPixel(camera, Math.max(reference, camera.near), viewportHeight) * PICK_TOLERANCE_PIXELS;
  raycaster.params.Line = { threshold: tolerance };
  raycaster.params.Points = { threshold: tolerance };
  let best: { distance: number; point: Vector3 } | undefined;
  for (const root of roots) {
    if (!visibleInScene(root)) continue;
    for (const hit of raycaster.intersectObject(root, true)) {
      if (!visibleInScene(hit.object) || hit.distance < camera.near) continue;
      // Use the point on the ray, so a shot picked a few pixels off still centres where clicked.
      const point = (hit.object as Object3D & { isMesh?: boolean }).isMesh ? hit.point.clone()
        : raycaster.ray.at(hit.point.clone().sub(raycaster.ray.origin).dot(raycaster.ray.direction), new Vector3());
      if (!best || hit.distance < best.distance) best = { distance: hit.distance, point };
      break;
    }
  }
  return best?.point;
}

/**
 * Make a point the rotation centre by panning it to the middle of the view.
 * The camera keeps its orientation, distance to the new centre and tilt lock.
 */
export function setRotationCentre(camera: PivotCamera, controls: OrbitControls, point: Vector3) {
  const offset = point.clone().sub(controls.target);
  camera.position.add(offset);
  controls.target.add(offset);
  controls.update();
}

type PickerOptions = {
  canvas: HTMLElement;
  controls: OrbitControls;
  getCamera: () => PivotCamera;
  getRoots: () => Object3D[];
  onModeChange?: (active: boolean) => void;
  onPicked?: (point: Vector3) => void;
  onMiss?: () => void;
  now?: () => number;
  animate?: (step: (time: number) => void) => void;
  /** Receives Escape to cancel; defaults to the window. */
  keyTarget?: EventTarget;
  /** Pan the picked point to the view centre (rotation centre); false only reports it. */
  recenter?: boolean;
};

/** One-shot mode: the next click on the model becomes the rotation centre (or is just reported). */
export class RotationCentrePicker {
  private active = false;
  private press?: { id: number; x: number; y: number };
  private controlsWereEnabled = true;
  private abort = new AbortController();

  constructor(private options: PickerOptions) {
    const signal = this.abort.signal;
    // Capture phase keeps OrbitControls from starting a drag while picking.
    options.canvas.addEventListener('pointerdown', this.down, { capture: true, signal });
    options.canvas.addEventListener('pointerup', this.up, { capture: true, signal });
    options.canvas.addEventListener('pointercancel', this.cancelPress, { capture: true, signal });
    (options.keyTarget ?? globalThis.window)?.addEventListener('keydown', this.key as EventListener, { signal });
  }

  get enabled() { return this.active; }
  set enabled(value: boolean) {
    if (value === this.active) return;
    this.active = value; this.press = undefined;
    if (value) { this.controlsWereEnabled = this.options.controls.enabled; this.options.controls.enabled = false; }
    else this.options.controls.enabled = this.controlsWereEnabled;
    this.options.canvas.style.cursor = value ? 'crosshair' : '';
    this.options.onModeChange?.(value);
  }

  dispose() { this.enabled = false; this.abort.abort(); }

  private key = (event: KeyboardEvent) => { if (this.active && event.key === 'Escape') this.enabled = false; };
  private cancelPress = () => { this.press = undefined; };

  private down = (event: PointerEvent) => {
    if (!this.active) return;
    event.stopImmediatePropagation(); event.preventDefault();
    if (event.pointerType !== 'touch' && event.button !== 0) return;
    this.press = { id: event.pointerId, x: event.clientX, y: event.clientY };
  };

  private up = (event: PointerEvent) => {
    if (!this.active) return;
    event.stopImmediatePropagation();
    const press = this.press; this.press = undefined;
    if (!press || press.id !== event.pointerId) return;
    if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > CLICK_SLOP_PIXELS) return;
    const { canvas, controls, getCamera, getRoots } = this.options;
    const rect = canvas.getBoundingClientRect();
    const width = rect.width || canvas.clientWidth || 1, height = rect.height || canvas.clientHeight || 1;
    const ndc = new Vector2(((event.clientX - rect.left) / width) * 2 - 1, -((event.clientY - rect.top) / height) * 2 + 1);
    const camera = getCamera();
    const point = pickModelPoint(camera, getRoots(), ndc, height, controls.target);
    if (!point) { this.options.onMiss?.(); return; }
    this.enabled = false;
    if (this.options.recenter !== false) this.recenter(camera, point);
    this.options.onPicked?.(point);
  };

  private recenter(camera: PivotCamera, point: Vector3) {
    animateRotationCentre(camera, this.options.controls, point, this.options);
  }

}

let animation = 0;
/** Pan smoothly until a point is the rotation centre in the middle of the view. */
export function animateRotationCentre(camera: PivotCamera, controls: OrbitControls, point: Vector3,
  { now = () => performance.now(), animate = (step: (time: number) => void) => { requestAnimationFrame(step); } }:
  { now?: () => number; animate?: (step: (time: number) => void) => void } = {}) {
  const start = now(), from = controls.target.clone(), id = ++animation;
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) { setRotationCentre(camera, controls, point); return; }
  const step = (time: number) => {
    if (id !== animation) return;
    const t = Math.min(1, (time - start) / RECENTER_MS), eased = 1 - (1 - t) ** 3;
    // Move from the original centre each frame so rounding cannot accumulate.
    setRotationCentre(camera, controls, from.clone().lerp(point, eased));
    if (t < 1) animate(step);
  };
  animate(step);
}
