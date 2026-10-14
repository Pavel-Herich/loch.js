import { MathUtils, PerspectiveCamera } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export function createCameraControls(camera: PerspectiveCamera, canvas: HTMLElement): OrbitControls {
  camera.up.set(0, 0, 1);
  // Start away from the target so the first lookAt has a defined orientation.
  camera.position.set(1.25, -1.8, 1.1);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.screenSpacePanning = true;
  // At the poles, turning around Z becomes a rotation around the viewing axis.
  // Keep a visible vertical reference instead of allowing that apparent roll.
  controls.minPolarAngle = MathUtils.degToRad(5);
  controls.maxPolarAngle = MathUtils.degToRad(175);
  controls.update();
  return controls;
}
