import { Matrix4, type Camera, type Vector3 } from 'three';
import { guessCoordinates, layerPoints, nameField, parseDbf, parseShp, type CoordinateGuess, type LayerPoint } from './shapefile';
import { LabelOccupancy, symbolSizeAt } from './station-labels';

export type PointLayer = { id: string; name: string; color: string; source: string; points: LayerPoint[] };

const COLORS = ['#ff5ad1', '#5ae0ff', '#ffe14d', '#9cff5a', '#c49bff', '#ff7a7a'];
/** Full-size ring radius in CSS pixels: with its edges 13 px across, like a full-size entrance Ω. */
const RADIUS = 3.9;

const COORDINATE_TEXT: Record<CoordinateGuess, string> = {
  sjtsk: 'S-JTSK', 'jtsk-positive': 'S-JTSK (positive Y/X, flipped)', wgs84: 'WGS 84 → S-JTSK', unknown: 'unknown coordinates, used as they are',
};

/**
 * Build a layer from the files picked together: the .shp, and optionally its
 * .dbf (point names), .prj (coordinate system) and .cpg (text encoding).
 */
export async function readShapefileLayer(files: File[], index: number): Promise<{ layer: PointLayer; summary: string }> {
  const byExtension = (extension: string) => files.find(file => file.name.toLowerCase().endsWith(extension));
  const shp = byExtension('.shp');
  if (!shp) throw new Error('Pick the .shp file (with its .dbf and .prj if you have them).');
  const { type, points } = parseShp(await shp.arrayBuffer());
  if (!points.length) throw new Error(`${shp.name} has no points.`);
  const prj = await byExtension('.prj')?.text();
  const cpg = (await byExtension('.cpg')?.text())?.trim();
  const dbfFile = byExtension('.dbf');
  const encoding = cpg ? (/1250/.test(cpg) ? 'windows-1250' : /8859-2/i.test(cpg) ? 'iso-8859-2' : cpg) : 'utf-8';
  const records = dbfFile ? parseDbf(await dbfFile.arrayBuffer(), encoding) : [];
  const field = nameField(records);
  const guess = guessCoordinates(points, prj);
  const layer: PointLayer = {
    id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${index}`,
    name: shp.name.replace(/\.shp$/i, ''), color: COLORS[index % COLORS.length], source: `${type}, ${COORDINATE_TEXT[guess]}`,
    points: layerPoints(points, guess, record => field ? records[record]?.[field] ?? '' : '', record => records[record]),
  };
  const named = field ? `, names from ${field}` : dbfFile ? '' : ', no .dbf (no names)';
  return { layer, summary: `${shp.name} · ${layer.points.length} points (${layer.source}${named}) at their own heights${points.some(point => point.z === null) ? ' (terrain where missing)' : ''}` };
}

/** Imported point layers, kept on the device and drawn on one overlay canvas. */
export class LayerStore {
  private db?: Promise<IDBDatabase>;
  constructor(private factory: IDBFactory | undefined = globalThis.indexedDB) {}
  private open() {
    this.db ??= new Promise((resolve, reject) => {
      if (!this.factory) { reject(new Error('IndexedDB unavailable.')); return; }
      const request = this.factory.open('loch.js-layers', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('layers', { keyPath: 'id' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return this.db;
  }
  private async run<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>) {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      const transaction = db.transaction('layers', mode), request = action(transaction.objectStore('layers'));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error('Layer storage failed.'));
    });
  }
  list() { return this.run<PointLayer[]>('readonly', store => store.getAll() as IDBRequest<PointLayer[]>); }
  put(layer: PointLayer) { return this.run('readwrite', store => store.put(layer)); }
  clear() { return this.run('readwrite', store => store.clear()); }
  delete(id: string) { return this.run('readwrite', store => store.delete(id)); }
}

const occupancy = new LabelOccupancy();

/** Labels follow the entrance label button: names, altitudes (terrain height) or none. */
export function drawLayers(canvas: HTMLCanvasElement, layers: PointLayer[], camera: Camera, width: number, height: number,
  origin: Vector3, heightAt: (east: number, north: number) => number | undefined, label: string = 'none') {
  const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
    canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
  }
  const context = canvas.getContext('2d');
  if (!context) return;
  context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, width, height);
  camera.updateMatrixWorld();
  const m = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).elements;
  context.font = '11px system-ui, sans-serif'; context.textBaseline = 'middle'; context.lineJoin = 'round';
  occupancy.reset(width, height);
  for (const layer of layers) for (let index = 0; index < layer.points.length; index++) {
    const point = layer.points[index];
    // The file's own height when it has one; otherwise pinned to the model's terrain (or the model centre).
    const z = point.z ?? heightAt(point.east, point.north) ?? origin.z;
    const x = point.east - origin.x, y = point.north - origin.y, h = z - origin.z;
    const w = m[3] * x + m[7] * y + m[11] * h + m[15];
    if (w <= 0) continue;
    const cx = (m[0] * x + m[4] * y + m[8] * h + m[12]) / w, cy = (m[1] * x + m[5] * y + m[9] * h + m[13]) / w;
    const cz = (m[2] * x + m[6] * y + m[10] * h + m[14]) / w;
    if (Math.abs(cx) > 1.02 || Math.abs(cy) > 1.02 || Math.abs(cz) > 1) continue;
    const sx = (cx + 1) / 2 * width, sy = (1 - cy) / 2 * height;
    const size = symbolSizeAt(w), radius = Math.max(RADIUS * size, 1.5);
    // Hollow ring: black edge outside, the layer colour, and the terrain showing through the middle.
    const ring = Math.max(RADIUS * size, 1.6);
    context.beginPath(); context.arc(sx, sy, ring + 1.9, 0, Math.PI * 2);
    context.lineWidth = 1.4; context.strokeStyle = '#09131c'; context.stroke();
    context.beginPath(); context.arc(sx, sy, ring, 0, Math.PI * 2);
    context.lineWidth = 2.6; context.strokeStyle = layer.color; context.stroke();
    const text = label === 'name' ? point.label : label === 'altitude' ? `${Math.round(z)} m` : '';
    if (!text) continue;
    // Skip labels that would overlap ones already drawn, as for station labels.
    const left = sx + radius + 3, top = sy - 8, textWidth = context.measureText(text).width + 4;
    if (left < 0 || top < 0 || left + textWidth > width || top + 16 > height || occupancy.overlaps(left, top, textWidth, 16)) continue;
    occupancy.reserve(left, top, textWidth, 16);
    context.lineWidth = 3; context.strokeStyle = '#09131c'; context.fillStyle = layer.color;
    context.strokeText(text, left, sy); context.fillText(text, left, sy);
  }
}
