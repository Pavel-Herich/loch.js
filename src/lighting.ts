import { Camera, DirectionalLight, MathUtils, Vector3 } from 'three';

/** Bearing is clockwise from north (+Y); positive clino is above the XY plane. */
export function lightDirection(bearing: number, clino: number) {
  const azimuth = MathUtils.degToRad(bearing), elevation = MathUtils.degToRad(clino);
  const horizontal = Math.cos(elevation);
  return new Vector3(Math.sin(azimuth) * horizontal, Math.cos(azimuth) * horizontal, Math.sin(elevation));
}

export function setLightDirection(light: DirectionalLight, bearing: number, clino: number, camera?: Camera, target = new Vector3()) {
  const direction = lightDirection(bearing, clino);
  if (camera) {
    // Camera-local +Z points toward the viewer, +X right, and +Y up.
    direction.set(direction.x, direction.z, direction.y).applyQuaternion(camera.quaternion);
    light.target.position.copy(target);
    light.position.copy(target).addScaledVector(direction, camera.position.distanceTo(target));
  } else {
    light.target.position.set(0, 0, 0);
    light.position.copy(direction);
  }
}

export function initializeLightControls(light: DirectionalLight, getCamera: () => Camera, getTarget: () => Vector3, onChange: () => void) {
  const bearing = document.querySelector<HTMLInputElement>('#light-bearing')!;
  const clino = document.querySelector<HTMLInputElement>('#light-clino')!;
  const bearingValue = document.querySelector<HTMLOutputElement>('#light-bearing-value')!;
  const clinoValue = document.querySelector<HTMLOutputElement>('#light-clino-value')!;
  const followCamera = document.querySelector<HTMLInputElement>('#light-follow-camera')!;
  followCamera.checked = false;
  bearing.value = bearing.defaultValue; clino.value = clino.defaultValue;
  function updateDirection() {
    setLightDirection(light, bearing.valueAsNumber, clino.valueAsNumber, followCamera.checked ? getCamera() : undefined, getTarget());
  }
  function update() {
    const azimuth = bearing.valueAsNumber, elevation = clino.valueAsNumber;
    bearingValue.value = `${azimuth}°`; clinoValue.value = `${elevation}°`;
    bearing.title = followCamera.checked
      ? 'Offset from camera: 0° toward camera, 90° right, 180° behind, 270° left'
      : 'Light from: 0° north, 90° east, 180° south, 270° west';
    clino.title = followCamera.checked ? 'Offset from camera: −90° below to +90° above' : 'Light from: −90° below, 0° horizontal, +90° above';
    updateDirection();
    onChange();
  }
  bearing.addEventListener('input', update); clino.addEventListener('input', update);
  followCamera.addEventListener('change', update);
  update();
  return { updateCamera() { if (followCamera.checked) updateDirection(); } };
}
