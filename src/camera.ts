import { Box3, PerspectiveCamera, Vector3 } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export function createCameraControls(camera: PerspectiveCamera, canvas: HTMLElement): OrbitControls {
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

export function setTiltLocked(controls: OrbitControls, locked: boolean) {
  const angle = controls.getPolarAngle();
  controls.minPolarAngle = locked ? angle : 0;
  controls.maxPolarAngle = locked ? angle : Math.PI;
  controls.update();
}

export function setCameraView(camera: PerspectiveCamera, controls: OrbitControls, box: Box3, view: ModelView) {
  if (box.isEmpty()) return;
  const tiltLocked = controls.minPolarAngle === controls.maxPolarAngle;
  setTiltLocked(controls, false);
  const radius = Math.max(box.getSize(new Vector3()).length() / 2, 1);
  const halfFov = camera.fov * Math.PI / 360;
  const limitingFov = Math.min(halfFov, Math.atan(Math.tan(halfFov) * camera.aspect));
  const distance = radius / Math.sin(limitingFov) * 1.1;
  const direction = view === 'plan' ? new Vector3(0, -1e-6, 1)
    : view === 'profile' ? new Vector3(0, -1, 0) : new Vector3(1.25, -1.8, 1.1);
  // Flush orbit inertia before setting a fixed view so it cannot drift afterwards.
  const damping = controls.enableDamping;
  controls.enableDamping = false;
  controls.update();
  controls.target.copy(box.getCenter(new Vector3()));
  camera.position.copy(controls.target).add(direction.normalize().multiplyScalar(distance));
  camera.near = Math.max(radius / 10000, .001);
  camera.far = Math.max(radius * 100, distance + radius * 2);
  camera.updateProjectionMatrix();
  controls.update();
  controls.enableDamping = damping;
  setTiltLocked(controls, tiltLocked || view === 'plan' || view === 'profile');
}
