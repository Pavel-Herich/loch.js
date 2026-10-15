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

/** Change projection without moving the camera or changing scale at its target. */
export function setPerspective(camera: ViewCamera, controls: OrbitControls, enabled: boolean): ViewCamera {
  if ((camera instanceof PerspectiveCamera) === enabled) return camera;
  const distance = camera.position.distanceTo(controls.target);
  let next: ViewCamera;
  if (camera instanceof PerspectiveCamera) {
    const halfHeight = distance * Math.tan(camera.getEffectiveFOV() * Math.PI / 360);
    next = new OrthographicCamera(-halfHeight * camera.aspect, halfHeight * camera.aspect, halfHeight, -halfHeight, camera.near, camera.far);
    next.userData.perspectiveFov = camera.fov;
  } else {
    const fov = camera.userData.perspectiveFov ?? 45;
    next = new PerspectiveCamera(fov, (camera.right - camera.left) / (camera.top - camera.bottom), camera.near, camera.far);
    next.zoom = distance * Math.tan(fov * Math.PI / 360) / ((camera.top - camera.bottom) / (2 * camera.zoom));
  }
  next.position.copy(camera.position); next.quaternion.copy(camera.quaternion); next.up.copy(camera.up);
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
