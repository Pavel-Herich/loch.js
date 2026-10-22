import { looksLikeSJTSK, wgs84ToSJTSK } from './geo';

/** One vertex of a shapefile layer in file coordinates; z is null for 2D shapes. */
export type ShpPoint = { x: number; y: number; z: number | null; record: number };
export type LayerPoint = { east: number; north: number; z: number | null; label: string };

const SHAPE_NAMES: Record<number, string> = {
  1: 'Point', 3: 'PolyLine', 5: 'Polygon', 8: 'MultiPoint',
  11: 'PointZ', 13: 'PolyLineZ', 15: 'PolygonZ', 18: 'MultiPointZ',
  21: 'PointM', 23: 'PolyLineM', 25: 'PolygonM', 28: 'MultiPointM',
};

/**
 * Read every vertex of an ESRI shapefile (.shp): points as they are, and the
 * vertices of multipoints, lines and polygons, each tagged with its record.
 */
export function parseShp(buffer: ArrayBuffer): { type: string; points: ShpPoint[] } {
  const view = new DataView(buffer);
  if (buffer.byteLength < 100 || view.getInt32(0, false) !== 9994) throw new Error('Not an ESRI shapefile (.shp).');
  const shapeType = view.getInt32(32, true);
  const type = SHAPE_NAMES[shapeType] ?? `type ${shapeType}`;
  const points: ShpPoint[] = [];
  let offset = 100, record = 0;
  while (offset + 12 <= buffer.byteLength) {
    const length = view.getInt32(offset + 4, false) * 2, start = offset + 8, end = start + length;
    if (length < 4 || end > buffer.byteLength) break;
    const kind = view.getInt32(start, true);
    const hasZ = kind === 11 || kind === 13 || kind === 15 || kind === 18;
    if (kind === 1 || kind === 11 || kind === 21) {
      points.push({ x: view.getFloat64(start + 4, true), y: view.getFloat64(start + 12, true), z: kind === 11 ? view.getFloat64(start + 20, true) : null, record });
    } else if (kind === 8 || kind === 18 || kind === 28) {
      const count = view.getInt32(start + 36, true), xy = start + 40, z = xy + count * 16 + 16;
      for (let i = 0; i < count; i++) points.push({ x: view.getFloat64(xy + i * 16, true), y: view.getFloat64(xy + i * 16 + 8, true), z: hasZ ? view.getFloat64(z + i * 8, true) : null, record });
    } else if (kind !== 0) {
      // PolyLine/Polygon (+Z/M): box, parts, points, then optional z range and values.
      const parts = view.getInt32(start + 36, true), count = view.getInt32(start + 40, true);
      const xy = start + 44 + parts * 4, z = xy + count * 16 + 16;
      for (let i = 0; i < count; i++) points.push({ x: view.getFloat64(xy + i * 16, true), y: view.getFloat64(xy + i * 16 + 8, true), z: hasZ ? view.getFloat64(z + i * 8, true) : null, record });
    }
    offset = end; record++;
  }
  return { type, points };
}

/** Attribute table (.dbf) as strings, one object per record. */
export function parseDbf(buffer: ArrayBuffer, encoding = 'utf-8'): Record<string, string>[] {
  const view = new DataView(buffer), bytes = new Uint8Array(buffer);
  const count = view.getUint32(4, true), headerLength = view.getUint16(8, true), recordLength = view.getUint16(10, true);
  let decoder: TextDecoder;
  try { decoder = new TextDecoder(encoding); } catch { decoder = new TextDecoder('utf-8'); }
  const fields: { name: string; offset: number; length: number }[] = [];
  for (let at = 32, offset = 1; at + 32 <= headerLength && bytes[at] !== 0x0d; at += 32) {
    const name = new TextDecoder('ascii').decode(bytes.subarray(at, at + 11)).replace(/\0.*$/s, '').trim();
    const length = bytes[at + 16];
    fields.push({ name, offset, length }); offset += length;
  }
  const records: Record<string, string>[] = [];
  for (let i = 0; i < count; i++) {
    const start = headerLength + i * recordLength;
    if (start + recordLength > bytes.length) break;
    const record: Record<string, string> = {};
    for (const field of fields) record[field.name] = decoder.decode(bytes.subarray(start + field.offset, start + field.offset + field.length)).trim();
    records.push(record);
  }
  return records;
}

/** Field most likely to hold a point's name (NAME, NAZOV, ID…), else the first text field. */
export function nameField(records: Record<string, string>[]) {
  const keys = Object.keys(records[0] ?? {});
  const preferred = ['name', 'nazov', 'názov', 'nazev', 'label', 'popis', 'text', 'cislo', 'id'];
  return preferred.map(name => keys.find(key => key.toLowerCase() === name)).find(Boolean)
    ?? keys.find(key => records.some(record => /[A-Za-z]/.test(record[key] ?? '')));
}

export type CoordinateGuess = 'sjtsk' | 'jtsk-positive' | 'wgs84' | 'unknown';

/** Decide how file coordinates relate to the model's S-JTSK (cs ijtsk / EPSG:5514). */
export function guessCoordinates(points: ShpPoint[], prj?: string): CoordinateGuess {
  if (prj && /GEOGCS/i.test(prj) && !/PROJCS/i.test(prj)) return 'wgs84';
  const sample = points.slice(0, 50);
  if (!sample.length) return 'unknown';
  if (sample.every(p => looksLikeSJTSK(p.x, p.y))) return 'sjtsk';
  if (sample.every(p => looksLikeSJTSK(-p.x, -p.y))) return 'jtsk-positive';
  if (sample.every(p => Math.abs(p.x) <= 180 && Math.abs(p.y) <= 90)) return 'wgs84';
  return 'unknown';
}

/** Convert shapefile vertices to S-JTSK east/north (negative, like the model) with labels. */
export function layerPoints(points: ShpPoint[], guess: CoordinateGuess, labels: (record: number) => string): LayerPoint[] {
  let previous = -1;
  return points.map(point => {
    // A line or polygon labels only its first vertex.
    const first = point.record !== previous; previous = point.record;
    let east = point.x, north = point.y;
    if (guess === 'jtsk-positive') { east = -point.x; north = -point.y; }
    else if (guess === 'wgs84') [east, north] = wgs84ToSJTSK(point.y, point.x, point.z ?? 0);
    return { east, north, z: point.z, label: first ? labels(point.record) : '' };
  });
}
