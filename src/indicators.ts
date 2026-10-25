import { MathUtils, OrthographicCamera, Vector3 } from 'three';
import type { ViewCamera } from './camera';

/** Bearing is clockwise from +Y; tilt is positive above the horizontal. */
export function viewOrientation(camera: ViewCamera) {
  camera.updateMatrixWorld();
  const right = new Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
  const direction = camera.getWorldDirection(new Vector3());
  // Camera right stays defined looking straight up/down, unlike the horizontal
  // projection of the viewing direction. Z-up controls keep it horizontal.
  const bearing = (MathUtils.radToDeg(Math.atan2(-right.y, right.x)) + 360) % 360;
  const tilt = MathUtils.radToDeg(Math.asin(MathUtils.clamp(direction.z, -1, 1)));
  return { bearing, tilt };
}

export function formatScaleDistance(distance: number) {
  const [unit, divisor] = distance >= 1000 ? ['km', 1000] as const
    : distance >= 1 ? ['m', 1] as const : distance >= .01 ? ['cm', .01] as const : ['mm', .001] as const;
  return `${Number((distance / divisor).toPrecision(3))} ${unit}`;
}

/** Perspective scale is measured in the plane through the view's target. */
/** Metres per screen pixel in the plane through the view's target. */
export function metresPerPixel(camera: ViewCamera, target: Vector3, height: number) {
  camera.updateMatrixWorld();
  const depth = target.clone().sub(camera.getWorldPosition(new Vector3())).dot(camera.getWorldDirection(new Vector3()));
  return camera instanceof OrthographicCamera
    ? (camera.top - camera.bottom) / camera.zoom / height
    : 2 * depth * Math.tan(MathUtils.degToRad(camera.getEffectiveFOV()) / 2) / height;
}

export function viewScale(camera: ViewCamera, target: Vector3, height: number, maxPixels = 140) {
  if (height <= 0 || maxPixels <= 0) return null;
  const unitsPerPixel = metresPerPixel(camera, target, height);
  if (!Number.isFinite(unitsPerPixel) || unitsPerPixel <= 0) return null;
  const maximum = unitsPerPixel * maxPixels;
  const magnitude = 10 ** Math.floor(Math.log10(maximum));
  const fraction = maximum / magnitude;
  const distance = (fraction >= 5 ? 5 : fraction >= 2 ? 2 : 1) * magnitude;
  return { distance, pixels: distance / unitsPerPixel, label: formatScaleDistance(distance) };
}

export function initializeIndicators(canvas: HTMLCanvasElement, getCamera: () => ViewCamera, getTarget: () => Vector3) {
  const visible = document.querySelector<HTMLInputElement>('#indicators')!;
  const panel = document.querySelector<HTMLElement>('#model-indicators')!;
  const compass = document.querySelector<HTMLElement>('#compass-indicator')!;
  const rose = document.querySelector<SVGGElement>('#compass-rose')!;
  const bearingValue = document.querySelector<HTMLElement>('#bearing-value')!;
  const tilt = document.querySelector<HTMLElement>('#tilt-indicator')!;
  const arrow = document.querySelector<SVGGElement>('#tilt-arrow')!;
  const tiltValue = document.querySelector<HTMLElement>('#tilt-value')!;
  const scale = document.querySelector<HTMLElement>('#scale-indicator')!;
  const ruler = document.querySelector<HTMLElement>('#scale-ruler')!;
  const scaleValue = document.querySelector<HTMLElement>('#scale-value')!;
  let previous = '';
  visible.checked = true;
  function update() {
    if (!visible.checked) return;
    const camera = getCamera(), orientation = viewOrientation(camera);
    const size = viewScale(camera, getTarget(), canvas.clientHeight);
    scale.hidden = !size;
    const bearing = Math.round(orientation.bearing) % 360, angle = Math.round(orientation.tilt);
    const state = `${camera.type}:${orientation.bearing.toFixed(2)}:${orientation.tilt.toFixed(2)}:${size?.distance}:${size?.pixels.toFixed(2)}`;
    if (state === previous) return;
    previous = state;
    rose.setAttribute('transform', `rotate(${-orientation.bearing} 34 34)`);
    bearingValue.textContent = `${String(bearing).padStart(3, '0')}°`;
    compass.title = `Bearing ${bearing}° clockwise from north. ${compass.getAttribute('aria-pressed') === 'true' ? 'Click to return to the previous heading' : 'Click to face north and hold the heading'}`;
    compass.setAttribute('aria-label', compass.title);
    arrow.setAttribute('transform', `rotate(${-orientation.tilt} 34 34)`);
    tiltValue.textContent = `${angle > 0 ? '+' : ''}${angle}°`;
    tilt.title = `View tilt ${angle}°; 0° horizontal, +90° up, −90° down. ${tilt.getAttribute('aria-pressed') === 'true' ? 'Click to return to the previous tilt' : 'Click for a level side view with tilt locked'}`;
    tilt.setAttribute('aria-label', tilt.title);
    if (size) {
      // In perspective the scale holds only at the depth of the rotation centre.
      const approximate = !(camera instanceof OrthographicCamera);
      scale.classList.toggle('approximate', approximate);
      scaleValue.textContent = `${approximate ? '≈ ' : ''}${size.label}`; ruler.style.width = `${Math.round(size.pixels) + 1}px`; // whole pixels keep the ticks sharp; +1 for the end tick

      scale.title = approximate ? `About ${size.label} at the depth of the rotation centre (perspective)` : `${size.label} (orthographic)`;
      scale.setAttribute('aria-label', scale.title);
    }
  }
  visible.addEventListener('change', () => {
    panel.hidden = scale.hidden = !visible.checked;
    update();
  });
  return { update, refresh() { previous = ''; update(); } };
}
