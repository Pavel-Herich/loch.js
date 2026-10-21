import { Matrix4, type Camera, type Vector3 } from 'three';
import { stationLabel, type Station, type StationLabel } from './lox-stations';

const CELL = 4;
const HEIGHT = 20;
const MAX_TEXT_WIDTH = 360;

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

  draw(camera: Camera, width: number, height: number, origin: Vector3, mode: StationLabel, visible: (station: Station) => boolean) {
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
    const draw = (station: Station) => {
      if (!visible(station)) return;
      const x = station.position[0] - origin.x, y = station.position[1] - origin.y, z = station.position[2] - origin.z;
      const w = m[3] * x + m[7] * y + m[11] * z + m[15];
      if (w <= 0) return;
      const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
      const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
      const cz = m[2] * x + m[6] * y + m[10] * z + m[14];
      if (Math.abs(cx) > w || Math.abs(cy) > w || Math.abs(cz) > w) return;
      const left = (cx / w + 1) * width / 2 + 3, top = (1 - cy / w) * height / 2 - HEIGHT / 2;
      if (left < 0 || top < 0 || left + 10 > width || top + HEIGHT > height
        || this.occupancy.overlaps(left, top, 10, HEIGHT)) return;
      let text = stationLabel(station, mode);
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
      context.strokeText(text, left + 2, top + HEIGHT / 2); context.fillText(text, left + 2, top + HEIGHT / 2);
    };
    for (const station of this.commented) draw(station);
    if (mode !== 'comments') for (const station of this.ordinary) draw(station);
  }
  clear() {
    this.commented = []; this.ordinary = [];
    if (this.canvas) { this.canvas.hidden = true; this.canvas.width = 0; this.canvas.height = 0; }
  }
}
