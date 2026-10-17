import { Camera, DirectionalLight, HemisphereLight, MathUtils, OrthographicCamera, PerspectiveCamera, SpotLight, Vector3 } from 'three';

export type LightingMode = 'static' | 'follow' | 'headlight';
export type SceneLights = { directional: DirectionalLight; fill: HemisphereLight; headlight: SpotLight };

export function createHeadlight() {
  // A fully soft cone, with stable brightness regardless of model scale/distance.
  const light = new SpotLight(0xffffff, 4, 0, Math.PI / 4, 1, 0);
  light.visible = false;
  return light;
}

export function setLightingMode(lights: SceneLights, mode: LightingMode) {
  lights.directional.visible = mode !== 'headlight';
  lights.fill.visible = mode !== 'headlight';
  lights.headlight.visible = mode === 'headlight';
}

export function updateHeadlight(light: SpotLight, camera: Camera, target: Vector3) {
  camera.getWorldPosition(light.position);
  light.target.position.copy(light.position).add(camera.getWorldDirection(new Vector3()));
  let halfDiagonal = Math.tan(Math.PI / 8);
  if (camera instanceof PerspectiveCamera) {
    halfDiagonal = Math.tan(MathUtils.degToRad(camera.getEffectiveFOV()) / 2) * Math.hypot(1, camera.aspect);
  } else if (camera instanceof OrthographicCamera) {
    halfDiagonal = Math.hypot(camera.right - camera.left, camera.top - camera.bottom)
      / (2 * camera.zoom * Math.max(light.position.distanceTo(target), .001));
  }
  light.angle = MathUtils.clamp(Math.atan(halfDiagonal), .001, Math.PI / 2 - .001);
}

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

export function initializeLightControls(lights: SceneLights, getCamera: () => Camera, getTarget: () => Vector3, onChange: () => void) {
  const bearing = document.querySelector<HTMLInputElement>('#light-bearing')!;
  const clino = document.querySelector<HTMLInputElement>('#light-clino')!;
  const bearingValue = document.querySelector<HTMLOutputElement>('#light-bearing-value')!;
  const clinoValue = document.querySelector<HTMLOutputElement>('#light-clino-value')!;
  const mode = document.querySelector<HTMLSelectElement>('#light-mode')!;
  mode.value = 'static';
  bearing.value = bearing.defaultValue; clino.value = clino.defaultValue;
  const angles = {
    static: { bearing: bearing.valueAsNumber, clino: clino.valueAsNumber },
    follow: { bearing: 0, clino: 0 },
  };
  function updateDirection() {
    if (mode.value === 'headlight') updateHeadlight(lights.headlight, getCamera(), getTarget());
    else setLightDirection(lights.directional, bearing.valueAsNumber, clino.valueAsNumber, mode.value === 'follow' ? getCamera() : undefined, getTarget());
  }
  function update() {
    const azimuth = bearing.valueAsNumber, elevation = clino.valueAsNumber;
    if (mode.value !== 'headlight') angles[mode.value as 'static' | 'follow'] = { bearing: azimuth, clino: elevation };
    bearingValue.value = `${azimuth}°`; clinoValue.value = `${elevation}°`;
    bearing.disabled = clino.disabled = mode.value === 'headlight';
    setLightingMode(lights, mode.value as LightingMode);
    bearing.title = mode.value === 'follow'
      ? 'Offset from camera: 0° toward camera, 90° right, 180° behind, 270° left'
      : 'Light from: 0° north, 90° east, 180° south, 270° west';
    clino.title = mode.value === 'follow' ? 'Offset from camera: −90° below to +90° above' : 'Light from: −90° below, 0° horizontal, +90° above';
    updateDirection();
    onChange();
  }
  bearing.addEventListener('input', update); clino.addEventListener('input', update);
  mode.addEventListener('change', () => {
    if (mode.value !== 'headlight') {
      const saved = angles[mode.value as 'static' | 'follow'];
      bearing.value = String(saved.bearing); clino.value = String(saved.clino);
    }
    update();
  });
  update();
  return { updateCamera() { if (mode.value !== 'static') updateDirection(); } };
}
