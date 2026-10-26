import { Matrix4, type Camera, type Vector3 } from 'three';
import { removeDiacritics } from './objects';

/** One recorded GPS fix: WGS 84 position, S-JTSK (cs ijtsk) position and sea-level height. */
export type TrackPoint = { time: string; latitude: number; longitude: number; east: number; north: number; height: number | null; accuracy: number };

const STORAGE_KEY = 'loch.js-track';
/** Fixes closer than this to the last kept one are skipped, and so are vague ones. */
const MIN_STEP = 3, MAX_ACCURACY = 50;

/** The GPS track being recorded; kept in the browser so a reload does not lose it. */
export class TrackRecorder {
  points: TrackPoint[] = [];
  recording = false;
  constructor(private storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | undefined = globalThis.localStorage) {
    try { this.points = JSON.parse(this.storage?.getItem(STORAGE_KEY) ?? '[]'); } catch { this.points = []; }
    if (!Array.isArray(this.points)) this.points = [];
  }
  /** Adds the fix when it is precise enough and has moved; returns whether it was kept. */
  add(point: TrackPoint) {
    if (!this.recording || !(point.accuracy <= MAX_ACCURACY)) return false;
    const last = this.points.at(-1);
    if (last && Math.hypot(point.east - last.east, point.north - last.north) < MIN_STEP) return false;
    this.points.push(point); this.save();
    return true;
  }
  clear() { this.points = []; try { this.storage?.removeItem(STORAGE_KEY); } catch { /* Nothing stored. */ } }
  private save() { try { this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.points)); } catch { /* Full or blocked: kept in memory. */ } }
  /** Horizontal length in metres. */
  get length() {
    let total = 0;
    for (let i = 1; i < this.points.length; i++) total += Math.hypot(this.points[i].east - this.points[i - 1].east, this.points[i].north - this.points[i - 1].north);
    return total;
  }
}

/** GPX 1.1 track; elevations are the sea-level heights. */
export function trackGpx(points: TrackPoint[], name = 'loch.js track') {
  const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const rows = points.map(point => `      <trkpt lat="${point.latitude.toFixed(7)}" lon="${point.longitude.toFixed(7)}">${point.height === null ? '' : `<ele>${point.height.toFixed(1)}</ele>`}<time>${point.time}</time></trkpt>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="loch.js" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>${escape(name)}</name><trkseg>
${rows.join('\n')}
  </trkseg></trk>
</gpx>
`;
}

/**
 * Therion survey of the track: every point a station fixed in the model's system
 * (cs ijtsk, whole metres) and consecutive points joined as surface legs without measurements.
 */
export function trackTherion(points: TrackPoint[], survey: string) {
  const id = removeDiacritics(survey).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'track';
  const lines = [`survey ${id} -title "${id}"`, '  centreline', '    cs ijtsk', '    flags surface'];
  points.forEach((point, index) => lines.push(`    fix ${index + 1} ${Math.round(point.east)} ${Math.round(point.north)} ${point.height === null ? 0 : Math.round(point.height)}`));
  lines.push('    data nosurvey from to');
  for (let i = 1; i < points.length; i++) lines.push(`    ${i} ${i + 1}`);
  lines.push('  endcentreline', 'endsurvey', '');
  return lines.join('\r\n');
}

/** The track as a line over the model. */
export function drawTrack(canvas: HTMLCanvasElement, points: TrackPoint[], camera: Camera, width: number, height: number,
  origin: Vector3, heightAt: (east: number, north: number) => number | undefined) {
  const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
    canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
  }
  const context = canvas.getContext('2d');
  if (!context) return;
  context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, width, height);
  camera.updateMatrixWorld();
  const m = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).elements;
  context.lineJoin = 'round'; context.lineCap = 'round';
  context.beginPath();
  let open = false;
  for (const point of points) {
    const z = heightAt(point.east, point.north) ?? point.height ?? origin.z;
    const x = point.east - origin.x, y = point.north - origin.y, h = z - origin.z;
    const w = m[3] * x + m[7] * y + m[11] * h + m[15];
    if (w <= 0) { open = false; continue; }
    const sx = ((m[0] * x + m[4] * y + m[8] * h + m[12]) / w + 1) / 2 * width, sy = (1 - (m[1] * x + m[5] * y + m[9] * h + m[13]) / w) / 2 * height;
    if (open) context.lineTo(sx, sy); else { context.moveTo(sx, sy); open = true; }
  }
  context.lineWidth = 5; context.strokeStyle = '#09131c'; context.stroke();
  context.lineWidth = 2.5; context.strokeStyle = '#ff7a3d'; context.stroke();
}
