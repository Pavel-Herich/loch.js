import { describe, expect, it } from 'vitest';
import {
  BoxGeometry, BufferGeometry, Float32BufferAttribute, Group, LineBasicMaterial, LineSegments, Mesh, MeshBasicMaterial,
  OrthographicCamera, PerspectiveCamera, Vector2, Vector3,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { pickModelPoint, RotationCentrePicker, setRotationCentre } from '../src/pivot';

class Canvas extends EventTarget {
  style = { touchAction: '', cursor: '' };
  clientWidth = 800;
  clientHeight = 600;
  getRootNode() { return this; }
  getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; }
  setPointerCapture() {}
  releasePointerCapture() {}
}

function box(x: number, y: number, z: number, size = 2) {
  const mesh = new Mesh(new BoxGeometry(size, size, size), new MeshBasicMaterial());
  mesh.position.set(x, y, z); mesh.updateMatrixWorld();
  const group = new Group(); group.add(mesh); return group;
}

function shot(a: number[], b: number[]) {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute([...a, ...b], 3));
  const group = new Group(); group.add(new LineSegments(geometry, new LineBasicMaterial())); return group;
}

/** Camera above the model looking straight down, as in a plan view. */
function planView(camera: PerspectiveCamera | OrthographicCamera, canvas = new Canvas()) {
  camera.up.set(0, 0, 1);
  camera.position.set(0, -1e-4, 50);
  const controls = new OrbitControls(camera, canvas as unknown as HTMLElement);
  controls.target.set(0, 0, 0); controls.update();
  return { controls, canvas };
}

function pointer(canvas: Canvas, type: string, x: number, y: number, extra: Record<string, unknown> = {}) {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, { pointerId: 1, pointerType: 'mouse', clientX: x, clientY: y, button: 0, ...extra });
  canvas.dispatchEvent(event);
  return event;
}

describe('rotation centre picking', () => {
  it('picks the top of the surface under the cursor from above', () => {
    const camera = new PerspectiveCamera(45, 4 / 3, .01, 1e4);
    planView(camera);
    const point = pickModelPoint(camera, [box(0, 0, 3)], new Vector2(0, 0), 600);
    expect(point?.z).toBeCloseTo(4, 5);
  });

  it('takes the nearest hit across walls, surface and centreline groups', () => {
    const camera = new PerspectiveCamera(45, 4 / 3, .01, 1e4);
    planView(camera);
    const point = pickModelPoint(camera, [box(0, 0, -10), box(0, 0, 5)], new Vector2(0, 0), 600);
    expect(point?.z).toBeCloseTo(6, 5);
  });

  it('ignores hidden geometry', () => {
    const camera = new PerspectiveCamera(45, 4 / 3, .01, 1e4);
    planView(camera);
    const top = box(0, 0, 5), bottom = box(0, 0, -10);
    top.visible = false;
    expect(pickModelPoint(camera, [top, bottom], new Vector2(0, 0), 600)?.z).toBeCloseTo(-9, 5);
    bottom.children[0].visible = false;
    expect(pickModelPoint(camera, [top, bottom], new Vector2(0, 0), 600)).toBeUndefined();
  });

  it('picks a centreline shot within a few pixels and lands on the clicked ray', () => {
    const camera = new OrthographicCamera(-40, 40, 30, -30, .01, 1e4);
    planView(camera);
    const lines = shot([.05, -10, 2], [.05, 10, 2]);
    const point = pickModelPoint(camera, [lines], new Vector2(0, 0), 600, new Vector3());
    expect(point?.z).toBeCloseTo(2, 4);
    expect(point?.x).toBeCloseTo(0, 6);
    expect(pickModelPoint(camera, [lines], new Vector2(.5, 0), 600, new Vector3())).toBeUndefined();
  });

  it('pans the picked point to the view centre without turning the camera', () => {
    const camera = new PerspectiveCamera(45, 4 / 3, .01, 1e4);
    const { controls } = planView(camera);
    const quaternion = camera.quaternion.clone(), distance = camera.position.distanceTo(controls.target);
    setRotationCentre(camera, controls, new Vector3(7, -3, 4));
    expect(controls.target.toArray()).toEqual([7, -3, 4]);
    expect(camera.quaternion.angleTo(quaternion)).toBeLessThan(1e-6);
    expect(camera.position.distanceTo(controls.target)).toBeCloseTo(distance, 9);
  });

  it('keeps tilt lock while recentring', () => {
    const camera = new PerspectiveCamera(45, 4 / 3, .01, 1e4);
    const { controls } = planView(camera);
    const angle = controls.getPolarAngle();
    controls.minPolarAngle = controls.maxPolarAngle = angle;
    setRotationCentre(camera, controls, new Vector3(3, 2, 1));
    expect(controls.getPolarAngle()).toBeCloseTo(angle, 9);
  });

  it('enters pick mode, ignores drags, sets the centre on a click and leaves the mode', () => {
    const camera = new PerspectiveCamera(45, 4 / 3, .01, 1e4);
    const { controls, canvas } = planView(camera);
    const frames: ((time: number) => void)[] = [];
    let time = 0, misses = 0;
    const modes: boolean[] = [];
    const picker = new RotationCentrePicker({
      canvas: canvas as unknown as HTMLElement, controls, getCamera: () => camera,
      getRoots: () => [box(200, 0, 3, 20)], onModeChange: active => modes.push(active), onMiss: () => misses++,
      now: () => time, animate: step => frames.push(step),
    });
    picker.enabled = true;
    expect(controls.enabled).toBe(false); expect(canvas.style.cursor).toBe('crosshair');
    // A drag does not pick; a click on empty space reports a miss and stays in the mode.
    pointer(canvas, 'pointerdown', 400, 300); pointer(canvas, 'pointerup', 460, 300);
    pointer(canvas, 'pointerdown', 400, 300); pointer(canvas, 'pointerup', 401, 300);
    expect(misses).toBe(1); expect(picker.enabled).toBe(true); expect(frames).toHaveLength(0);
    // Clicking the box projects to its top face.
    const box2 = new Vector3(200, 0, 13).project(camera);
    const x = (box2.x + 1) / 2 * 800, y = (1 - box2.y) / 2 * 600;
    pointer(canvas, 'pointerdown', x, y); pointer(canvas, 'pointerup', x, y);
    expect(picker.enabled).toBe(false); expect(controls.enabled).toBe(true);
    while (frames.length) { time += 50; frames.shift()!(time); }
    expect(controls.target.x).toBeCloseTo(200, 3);
    expect(controls.target.z).toBeCloseTo(13, 3);
    expect(modes).toEqual([true, false]);
    picker.dispose();
  });

  it('cancels with Escape and restores the previous control state', () => {
    const camera = new PerspectiveCamera(45, 4 / 3, .01, 1e4);
    const { controls, canvas } = planView(camera);
    const keys = new EventTarget();
    const picker = new RotationCentrePicker({ canvas: canvas as unknown as HTMLElement, controls, getCamera: () => camera, getRoots: () => [], keyTarget: keys });
    controls.enabled = false;
    picker.enabled = true; expect(controls.enabled).toBe(false);
    keys.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' }));
    expect(picker.enabled).toBe(false); expect(controls.enabled).toBe(false);
    picker.dispose();
  });
});
