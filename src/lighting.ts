import { DirectionalLight, MathUtils, Vector3 } from 'three';

/** Bearing is clockwise from north (+Y); positive clino is above the XY plane. */
export function lightDirection(bearing: number, clino: number) {
  const azimuth = MathUtils.degToRad(bearing), elevation = MathUtils.degToRad(clino);
  const horizontal = Math.cos(elevation);
  return new Vector3(Math.sin(azimuth) * horizontal, Math.cos(azimuth) * horizontal, Math.sin(elevation));
}

export function initializeLightControls(light: DirectionalLight, onChange: () => void) {
  const bearing = document.querySelector<HTMLInputElement>('#light-bearing')!;
  const clino = document.querySelector<HTMLInputElement>('#light-clino')!;
  const bearingValue = document.querySelector<HTMLOutputElement>('#light-bearing-value')!;
  const clinoValue = document.querySelector<HTMLOutputElement>('#light-clino-value')!;
  bearing.value = bearing.defaultValue; clino.value = clino.defaultValue;
  function update() {
    const azimuth = bearing.valueAsNumber, elevation = clino.valueAsNumber;
    bearingValue.value = `${azimuth}°`; clinoValue.value = `${elevation}°`;
    light.position.copy(light.target.position).add(lightDirection(azimuth, elevation));
    onChange();
  }
  bearing.addEventListener('input', update); clino.addEventListener('input', update);
  update();
}
