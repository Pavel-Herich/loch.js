import { Box3, OrthographicCamera, PerspectiveCamera, Vector3 } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export type ViewCamera = PerspectiveCamera | OrthographicCamera;

export function createCameraControls(camera: ViewCamera, canvas: HTMLElement): OrbitControls {
  camera.up.set(0, 0, 1);
  // Start away from the target so the first lookAt has a defined orientation.
  camera.position.set(1.25, -1.8, 1.1);
  const controls = new OrbitControls(camera, canvas);
  // Stop at the last input position so inertia cannot postpone stationary refinement.
  controls.enableDamping = false;
  controls.screenSpacePanning = true;
  const zoomSpeed = controls.zoomSpeed;
  const preventMiddleDefault = (event: MouseEvent) => { if (event.button === 1) event.preventDefault(); };
  const mouseOptions = { capture: true, passive: false };
  // WebView2/Windows can take middle-drag for native autoscroll. Cancel both
  // pointer and compatibility mouse defaults without stopping camera handlers.
  canvas.addEventListener('mousedown', preventMiddleDefault, mouseOptions);
  canvas.addEventListener('auxclick', preventMiddleDefault, mouseOptions);
  const pointerDown = (event: PointerEvent) => {
    if (event.pointerType !== 'touch') preventMiddleDefault(event);
    controls.zoomSpeed = event.pointerType !== 'touch' && event.button === 1 ? zoomSpeed * 10 : zoomSpeed;
  };
  const resetZoom = () => { controls.zoomSpeed = zoomSpeed; };
  canvas.addEventListener('pointerdown', pointerDown, { passive: false });
  controls.addEventListener('end', resetZoom);
  const dispose = controls.dispose.bind(controls);
  controls.dispose = () => {
    canvas.removeEventListener('mousedown', preventMiddleDefault, mouseOptions);
    canvas.removeEventListener('auxclick', preventMiddleDefault, mouseOptions);
    canvas.removeEventListener('pointerdown', pointerDown);
    controls.removeEventListener('end', resetZoom);
    dispose();
  };
  controls.update();
  return controls;
}

export type ModelView = 'plan' | 'profile' | 'fit';

export function resizeCamera(camera: ViewCamera, aspect: number) {
  if (camera instanceof PerspectiveCamera) camera.aspect = aspect;
  else {
    const halfHeight = (camera.top - camera.bottom) / 2;
    camera.left = -halfHeight * aspect; camera.right = halfHeight * aspect;
  }
  camera.updateProjectionMatrix();
}

/**
 * Change projection keeping orientation, target and scale at the target.
 * Perspective always keeps its natural field of view (zoom 1), so scale is
 * carried by the camera distance; an orthographic camera sits behind the whole
 * model, because ortho zoom does not move it and nearer geometry would be cut.
 */
export function setPerspective(camera: ViewCamera, controls: OrbitControls, enabled: boolean, box?: Box3): ViewCamera {
  if ((camera instanceof PerspectiveCamera) === enabled) return camera;
  const target = controls.target;
  const forward = camera.getWorldDirection(new Vector3());
  const distance = camera.position.distanceTo(target);
  // Keep the whole model between near and far, also after the rotation centre moves inside it.
  const radius = box && !box.isEmpty() ? box.getSize(new Vector3()).length() / 2 : distance;
  const offset = box && !box.isEmpty() ? target.distanceTo(box.getCenter(new Vector3())) : 0;
  let next: ViewCamera, nextDistance: number;
  if (camera instanceof PerspectiveCamera) {
    const halfHeight = distance * Math.tan(camera.getEffectiveFOV() * Math.PI / 360);
    next = new OrthographicCamera(-halfHeight * camera.aspect, halfHeight * camera.aspect, halfHeight, -halfHeight, camera.near, camera.far);
    next.userData.perspectiveFov = camera.fov;
    next.userData.perspectiveNear = camera.near;
    nextDistance = Math.max(distance, offset + radius * 2.2);
    // Orthographic depth is linear, so a tiny near plane costs no precision.
    next.near = 1e-3;
  } else {
    const fov = camera.userData.perspectiveFov ?? 45;
    const halfHeight = (camera.top - camera.bottom) / (2 * camera.zoom);
    next = new PerspectiveCamera(fov, (camera.right - camera.left) / (camera.top - camera.bottom), camera.near, camera.far);
    nextDistance = halfHeight / Math.tan(fov * Math.PI / 360);
    // Perspective depth precision depends on near; restore the model's own near plane.
    next.near = Math.max(Math.min(camera.userData.perspectiveNear ?? radius / 10000, nextDistance / 10), 1e-3);
  }
  next.far = Math.max(camera.far, nextDistance + offset + radius * 4.4);
  next.quaternion.copy(camera.quaternion); next.up.copy(camera.up);
  next.position.copy(target).addScaledVector(forward, -nextDistance);
  next.updateProjectionMatrix(); next.updateMatrixWorld();
  controls.object = next;
  controls.update();
  return next;
}

export function setTiltLocked(controls: OrbitControls, locked: boolean) {
  const angle = controls.getPolarAngle();
  controls.minPolarAngle = locked ? angle : 0;
  controls.maxPolarAngle = locked ? angle : Math.PI;
  controls.update();
}

export function setCameraView(camera: ViewCamera, controls: OrbitControls, box: Box3, view: ModelView) {
  if (box.isEmpty()) return;
  const tiltLocked = controls.minPolarAngle === controls.maxPolarAngle;
  setTiltLocked(controls, false);
  // Flush orbit inertia before setting a fixed view so it cannot drift afterwards.
  const damping = controls.enableDamping;
  controls.enableDamping = false;
  controls.update();
  const radius = Math.max(box.getSize(new Vector3()).length() / 2, 1);
  const direction = (view === 'plan' ? new Vector3(0, -1e-6, 1)
    : view === 'profile' ? new Vector3(0, -1, 0) : camera.getWorldDirection(new Vector3()).negate()).normalize();
  const right = new Vector3().crossVectors(camera.up, direction).normalize();
  const up = new Vector3().crossVectors(direction, right);
  const center = box.getCenter(new Vector3());
  const perspective = camera instanceof PerspectiveCamera;
  const aspect = perspective ? camera.aspect : (camera.right - camera.left) / (camera.top - camera.bottom);
  const tanVertical = perspective ? Math.tan(camera.getEffectiveFOV() * Math.PI / 360) : 1;
  const tanHorizontal = tanVertical * aspect;
  let distance = perspective ? 1 : Math.max(controls.getDistance(), radius * 2);
  let halfHeight = .01;
  // Fit all eight corners in the existing camera orientation, with 10% padding.
  for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) {
    const corner = new Vector3(x, y, z).sub(center);
    const depth = corner.dot(direction);
    if (perspective) distance = Math.max(distance, depth + radius * .01,
        depth + Math.abs(corner.dot(right)) / tanHorizontal * 1.1,
        depth + Math.abs(corner.dot(up)) / tanVertical * 1.1);
    else halfHeight = Math.max(halfHeight, Math.abs(corner.dot(right)) / aspect * 1.1, Math.abs(corner.dot(up)) * 1.1);
  }
  if (!perspective) {
    camera.top = halfHeight; camera.bottom = -halfHeight;
    camera.left = -halfHeight * aspect; camera.right = halfHeight * aspect; camera.zoom = 1;
  }
  controls.target.copy(center);
  camera.position.copy(center).addScaledVector(direction, distance);
  camera.near = Math.max(radius / 10000, .001);
  camera.far = Math.max(radius * 100, distance + radius * 2);
  camera.updateProjectionMatrix();
  controls.update();
  controls.enableDamping = damping;
  setTiltLocked(controls, view === 'fit' ? tiltLocked : view === 'plan' || view === 'profile');
}
