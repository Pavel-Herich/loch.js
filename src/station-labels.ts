import { Matrix4, type Camera, type Vector3 } from 'three';
import { stationLabel, type Station, type StationLabel } from './lox-stations';
import { claimSymbol, symbolHidden } from './declutter';

const CELL = 4;
const HEIGHT = 20;
const MAX_TEXT_WIDTH = 360;

export type StationMarker = 'entrance' | 'fixed' | 'continuation';
const markerScale = (marker: StationMarker) => marker === 'fixed' ? 1 / 3 : .7;

/** Smallest symbol size (entrances, field objects, SHP points), as a fraction of full size. */
export const SYMBOL_MIN_SIZE = .25;
/** Full size from this zoom on: a 140 px scale bar reads 100 m. */
export const FULL_SIZE_METRES_PER_PIXEL = 100 / 140;

/**
 * Zoom part of the symbol size, relative to the model: 25 % when the whole model
 * fills the view, 100 % from a 100 m scale bar on, logarithmic in between.
 */
export function symbolScale(metresPerPixel: number, fitMetresPerPixel: number) {
  if (!(metresPerPixel > 0) || !(fitMetresPerPixel > FULL_SIZE_METRES_PER_PIXEL)) return 1;
  const t = Math.log(fitMetresPerPixel / metresPerPixel) / Math.log(fitMetresPerPixel / FULL_SIZE_METRES_PER_PIXEL);
  return SYMBOL_MIN_SIZE + (1 - SYMBOL_MIN_SIZE) * Math.min(1, Math.max(0, t));
}

/**
 * The same rule per symbol, from the screen scale at the symbol's own real distance:
 * in perspective a nearer symbol has fewer metres per pixel and so is larger. It does
 * not depend on the rotation centre, which may sit right in front of the camera
 * after zooming in.
 */
let view = { fit: 0, metresPerPixel: 1, perDepth: undefined as number | undefined };
/**
 * Set once per frame. `perDepth` (perspective) is metres per pixel per metre of distance;
 * orthographic views pass their single `metresPerPixel` instead.
 */
export function setSymbolView(fitMetresPerPixel: number, metresPerPixel: number, perDepth?: number) {
  view = { fit: fitMetresPerPixel, metresPerPixel, perDepth };
}
let symbolFilter: ((east: number, north: number) => boolean) | undefined;
/** Hide symbols outside a vertical section (file coordinates); undefined shows all. */
export function setSymbolFilter(filter: ((east: number, north: number) => boolean) | undefined) { symbolFilter = filter; }
export function symbolShown(east: number, north: number) { return !symbolFilter || symbolFilter(east, north); }
/** Size for a symbol at this depth in front of the camera, 25–100 %. */
export function symbolSizeAt(depth: number) {
  const metresPerPixel = view.perDepth !== undefined && depth > 0 ? depth * view.perDepth : view.metresPerPixel;
  return symbolScale(metresPerPixel, view.fit);
}
const OMEGA_SCALE = .18;


/** Symbols drawn directly on the shared overlay, centred on the station; `size` scales them (1 = full). */
export function drawStationMarker(context: CanvasRenderingContext2D, marker: StationMarker, x: number, y: number, size = 1) {
  context.save(); context.translate(x, y);
  const scale = markerScale(marker) * size; context.scale(scale, scale);
  context.lineWidth = 1.5; context.strokeStyle = '#09131c';
  if (marker === 'entrance') {
    // Omega outline of public/icon.svg in white, edged by a thin (1 px) black line.
    context.transform(OMEGA_SCALE, 0, 0, OMEGA_SCALE, -64.5 * OMEGA_SCALE, -62 * OMEGA_SCALE);
    context.lineCap = 'round'; context.lineJoin = 'round';
    context.beginPath(); context.moveTo(20, 102); context.lineTo(48, 102);
    context.bezierCurveTo(48, 90, 29, 84, 29, 63);
    context.bezierCurveTo(29, 38, 49, 22, 69, 22);
    context.bezierCurveTo(91, 22, 104, 39, 102, 60);
    context.bezierCurveTo(100, 79, 90, 90, 80, 99);
    context.lineTo(80, 102); context.lineTo(109, 102);
    context.strokeStyle = '#000000'; context.lineWidth = 16 + 2 / (scale * OMEGA_SCALE); context.stroke();
    context.strokeStyle = '#ffffff'; context.lineWidth = 16; context.stroke();
  } else if (marker === 'fixed') {
    context.beginPath(); context.moveTo(0, -9); context.lineTo(8, 7); context.lineTo(-8, 7); context.closePath();
    context.fillStyle = '#ff3030'; context.fill(); context.stroke();
  } else {
    context.font = 'bold 20px system-ui, sans-serif'; context.textAlign = 'center'; context.textBaseline = 'middle';
    context.lineWidth = 3; context.fillStyle = '#ffffff';
    context.strokeText('?', 0, 0); context.fillText('?', 0, 0);
  }
  context.restore();
}

/** Conservative screen-space occupancy, bounded by viewport size rather than station count. */
export class LabelOccupancy {
  private cells = new Uint8Array(0);
  private columns = 0;
  reset(width: number, height: number) {
    this.columns = Math.ceil(width / CELL);
    const size = this.columns * Math.ceil(height / CELL);
    if (this.cells.length !== size) this.cells = new Uint8Array(size); else this.cells.fill(0);
  }
  overlaps(x: number, y: number, width: number, height: number) {
    for (let row = Math.floor(y / CELL); row < Math.ceil((y + height) / CELL); row++) {
      for (let col = Math.floor(x / CELL); col < Math.ceil((x + width) / CELL); col++) {
        if (this.cells[row * this.columns + col]) return true;
      }
    }
    return false;
  }
  reserve(x: number, y: number, width: number, height: number) {
    for (let row = Math.floor(y / CELL); row < Math.ceil((y + height) / CELL); row++) {
      this.cells.fill(1, row * this.columns + Math.floor(x / CELL), row * this.columns + Math.ceil((x + width) / CELL));
    }
  }
}

/** One viewport-sized canvas; allocate no label textures or text geometry. */
export class StationLabels {
  private commented: Station[] = [];
  private ordinary: Station[] = [];
  private occupancy = new LabelOccupancy();
  private matrix = new Matrix4();
  constructor(private canvas?: HTMLCanvasElement) {}

  setStations(stations: Station[]) {
    this.commented = []; this.ordinary = [];
    for (const station of stations) (station.comment?.trim() ? this.commented : this.ordinary).push(station);
  }
  setVisible(visible: boolean) { if (this.canvas) this.canvas.hidden = !visible; }

  draw(camera: Camera, width: number, height: number, origin: Vector3, mode: StationLabel | ((station: Station) => StationLabel), visible: (station: Station) => boolean, marker?: (station: Station) => StationMarker | undefined) {
    const canvas = this.canvas;
    if (!canvas || canvas.hidden || width <= 0 || height <= 0) return;
    const ratio = Math.min(globalThis.devicePixelRatio || 1, 2, Math.sqrt(8_388_608 / (width * height)));
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
    }
    const context = canvas.getContext('2d');
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, width, height);
    context.font = '12px system-ui, sans-serif'; context.textBaseline = 'middle';
    context.lineWidth = 3; context.strokeStyle = '#09131c'; context.lineJoin = 'round';
    this.occupancy.reset(width, height);
    camera.updateMatrixWorld();
    const m = this.matrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).elements;
    let screenX = 0, screenY = 0, screenDepth = 1;
    const project = (station: Station) => {
      if (symbolFilter && !symbolFilter(station.position[0], station.position[1])) return false;
      const x = station.position[0] - origin.x, y = station.position[1] - origin.y, z = station.position[2] - origin.z;
      const w = m[3] * x + m[7] * y + m[11] * z + m[15];
      if (w <= 0) return false;
      const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
      const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
      const cz = m[2] * x + m[6] * y + m[10] * z + m[14];
      if (Math.abs(cx) > w || Math.abs(cy) > w || Math.abs(cz) > w) return false;
      screenX = (cx / w + 1) * width / 2; screenY = (1 - cy / w) * height / 2; screenDepth = w;
      return true;
    };
    if (marker) {
      const mark = (station: Station) => {
        const symbol = marker(station);
        if (!symbol || !visible(station) || !project(station)) return;
        const size = symbol === 'entrance' ? symbolSizeAt(screenDepth) : 1;
        // Small entrances that would touch one already drawn hide behind it.
        if (symbol === 'entrance' && !claimSymbol(station, screenX, screenY, 7 * size, size)) return;
        drawStationMarker(context, symbol, screenX, screenY, size);
        const radius = 10 * markerScale(symbol) * size;
        const x = Math.max(0, screenX - radius), y = Math.max(0, screenY - radius);
        this.occupancy.reserve(x, y, Math.min(width, screenX + radius) - x, Math.min(height, screenY + radius) - y);
      };
      for (const station of this.commented) mark(station);
      for (const station of this.ordinary) mark(station);
    }
    if (mode === 'none') return;
    const modeFor = typeof mode === 'function' ? mode : () => mode;
    const draw = (station: Station) => {
      const labelMode = modeFor(station);
      if (labelMode === 'none' || symbolHidden(station) || !visible(station) || !project(station)) return;
      const symbol = marker?.(station);
      const size = symbol === 'entrance' ? symbolSizeAt(screenDepth) : 1;
      const left = screenX + (symbol ? 10 * markerScale(symbol) * size + 4 : 3), top = screenY - HEIGHT / 2;
      if (left < 0 || top < 0 || left + 10 > width || top + HEIGHT > height
        || this.occupancy.overlaps(left, top, 10, HEIGHT)) return;
      let text = stationLabel(station, labelMode);
      if (!text) return;
      // Bound measurement work for long survey paths and comments.
      if (text.length > 256) text = text.slice(0, 255).replace(/[\uD800-\uDBFF]$/, '') + '…';
      text = text.replace(/\s+/g, ' ');
      const maximum = Math.min(MAX_TEXT_WIDTH, width - left - 5);
      let textWidth = context.measureText(text).width;
      if (textWidth > maximum) {
        let low = 0, high = text.length;
        while (low < high) {
          const mid = Math.ceil((low + high) / 2);
          if (context.measureText(text.slice(0, mid) + '…').width <= maximum) low = mid; else high = mid - 1;
        }
        text = text.slice(0, low).replace(/[\uD800-\uDBFF]$/, '') + '…'; textWidth = context.measureText(text).width;
      }
      const labelWidth = Math.max(10, textWidth + 5);
      if (left + labelWidth > width || this.occupancy.overlaps(left, top, labelWidth, HEIGHT)) return;
      this.occupancy.reserve(left, top, labelWidth, HEIGHT);
      context.fillStyle = '#ffffff';
      const textX = left + (symbol ? 0 : 2);
      context.strokeText(text, textX, top + HEIGHT / 2); context.fillText(text, textX, top + HEIGHT / 2);
    };
    for (const station of this.commented) draw(station);
    // Ordinary stations have no comment text, so a fixed comments mode can skip them.
    if (mode !== 'comments') for (const station of this.ordinary) draw(station);
  }
  clear() {
    this.commented = []; this.ordinary = [];
    if (this.canvas) { this.canvas.hidden = true; this.canvas.width = 0; this.canvas.height = 0; }
  }
}
