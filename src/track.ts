import { Matrix4, type Camera, type Vector3 } from 'three';
import { removeDiacritics } from './objects';

/** One recorded GPS fix: WGS 84 position, S-JTSK (cs ijtsk) position and sea-level height. */
export type TrackPoint = { time: string; latitude: number; longitude: number; east: number; north: number; height: number | null; accuracy: number };

/** A recorded track: its points, a name, and whether it is drawn on the model. */
export type Track = { id: string; name: string; created: string; color: string; visible: boolean; points: TrackPoint[] };

/** Fixes closer than this to the last kept one are skipped, and so are vague ones. */
const MIN_STEP = 3, MAX_ACCURACY = 50;
const COLORS = ['#ff7a3d', '#ffd84d', '#ff5ad1', '#5ae0ff', '#9cff5a', '#c49bff'];

/** Horizontal length of a track in metres. */
export function trackLength(track: Pick<Track, 'points'>) {
  let total = 0;
  for (let i = 1; i < track.points.length; i++) total += Math.hypot(track.points[i].east - track.points[i - 1].east, track.points[i].north - track.points[i - 1].north);
  return total;
}

/** Saves and loads tracks; IndexedDB in the app, a map in tests. */
export type TrackPersistence = { list(): Promise<Track[]>; put(track: Track): Promise<unknown>; delete(id: string): Promise<unknown> };

/** All recorded tracks, and the one being recorded; kept on the device. */
export class TrackStore {
  tracks: Track[] = [];
  recording: Track | undefined;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  constructor(private persistence: TrackPersistence | undefined = indexedDbTracks()) {}

  async load() {
    try { this.tracks = (await this.persistence?.list() ?? []).sort((a, b) => a.created.localeCompare(b.created)); } catch { this.tracks = []; }
    // A track from the single-track version is kept as the first one.
    try {
      const old = globalThis.localStorage?.getItem('loch.js-track');
      if (old) {
        const points = JSON.parse(old) as TrackPoint[];
        if (Array.isArray(points) && points.length) { const track = this.create(points[0].time); track.points = points; this.save(track); }
        globalThis.localStorage.removeItem('loch.js-track');
      }
    } catch { /* Nothing to bring over. */ }
  }
  private create(time = new Date().toISOString()) {
    const date = new Date(time), pad = (n: number) => String(n).padStart(2, '0');
    const track: Track = { id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}`, created: date.toISOString(),
      name: `Track ${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`,
      color: COLORS[this.tracks.length % COLORS.length], visible: true, points: [] };
    this.tracks.push(track);
    return track;
  }
  /** Start a new track; it records every precise fix that moved. */
  start() { this.recording = this.create(); this.save(this.recording, true); return this.recording; }
  stop() { if (this.recording) this.save(this.recording, true); this.recording = undefined; }
  /** Adds the fix to the track being recorded when it is precise enough and has moved. */
  add(point: TrackPoint) {
    const track = this.recording;
    if (!track || !(point.accuracy <= MAX_ACCURACY)) return false;
    const last = track.points.at(-1);
    if (last && Math.hypot(point.east - last.east, point.north - last.north) < MIN_STEP) return false;
    track.points.push(point); this.save(track);
    return true;
  }
  setVisible(id: string, visible: boolean) { const track = this.find(id); if (track) { track.visible = visible; this.save(track, true); } }
  rename(id: string, name: string) { const track = this.find(id); if (track && name.trim()) { track.name = removeDiacritics(name.trim()); this.save(track, true); } }
  remove(id: string) {
    if (this.recording?.id === id) this.recording = undefined;
    this.tracks = this.tracks.filter(track => track.id !== id);
    void this.persistence?.delete(id).catch(() => undefined);
  }
  find(id: string) { return this.tracks.find(track => track.id === id); }
  /** Saved at once for changes, at most every few seconds while recording. */
  private save(track: Track, now = false) {
    const write = () => { this.saveTimer = undefined; void this.persistence?.put(structuredClone(track)).catch(() => undefined); };
    if (now) { if (this.saveTimer) clearTimeout(this.saveTimer); write(); return; }
    this.saveTimer ??= setTimeout(write, 3000);
  }
}

function indexedDbTracks(): TrackPersistence | undefined {
  const factory = globalThis.indexedDB;
  if (!factory) return undefined;
  const open = () => new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open('loch.js-tracks', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('tracks', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const run = <T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>) => open().then(db => new Promise<T>((resolve, reject) => {
    const transaction = db.transaction('tracks', mode), request = action(transaction.objectStore('tracks'));
    transaction.oncomplete = () => { db.close(); resolve(request.result); };
    transaction.onerror = transaction.onabort = () => { db.close(); reject(transaction.error ?? new Error('Track storage failed.')); };
  }));
  return {
    list: () => run<Track[]>('readonly', store => store.getAll() as IDBRequest<Track[]>),
    put: track => run('readwrite', store => store.put(track)),
    delete: id => run('readwrite', store => store.delete(id)),
  };
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

/** Visible tracks as lines over the model, each in its colour. */
export function drawTracks(canvas: HTMLCanvasElement, tracks: Track[], camera: Camera, width: number, height: number,
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
  for (const track of tracks) {
    if (!track.visible || track.points.length < 1) continue;
    context.beginPath();
    let open = false;
    for (const point of track.points) {
      const z = heightAt(point.east, point.north) ?? point.height ?? origin.z;
      const x = point.east - origin.x, y = point.north - origin.y, h = z - origin.z;
      const w = m[3] * x + m[7] * y + m[11] * h + m[15];
      if (w <= 0) { open = false; continue; }
      const sx = ((m[0] * x + m[4] * y + m[8] * h + m[12]) / w + 1) / 2 * width, sy = (1 - (m[1] * x + m[5] * y + m[9] * h + m[13]) / w) / 2 * height;
      if (open) context.lineTo(sx, sy); else { context.moveTo(sx, sy); open = true; }
    }
    context.lineWidth = 5; context.strokeStyle = '#09131c'; context.stroke();
    context.lineWidth = 2.5; context.strokeStyle = track.color; context.stroke();
  }
}
