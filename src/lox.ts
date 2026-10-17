import { resolveShots, SHOT_NOT_VISIBLE, type Shot, type ShotReference } from './lox-shots';
import { bitmapRecord, surfaceRecord, type Surface, type SurfaceBitmap } from './lox-surface';
/** Therion lxFile chunks, matching loch/lxFile.{h,cxx} (little endian). */
export type Point = [number, number, number];
export type Scrap = { points: Point[]; triangles: [number, number, number][] };
export type Model = { scraps: Scrap[]; stations: Map<number, Point>; shots: Shot[]; minZ: number; maxZ: number; surfaces: Surface[] };
const LIMIT = 50_000_000;
export function parseLox(buffer: ArrayBuffer): Model {
  const d = new DataView(buffer); let p = 0;
  const stations = new Map<number, Point>();
  const shotIds: ShotReference[] = []; const scraps: Scrap[] = [];
  const check = (n: number, end = d.byteLength) => { if (n < 0 || p + n > end) throw new Error('Truncated or corrupt LOX record'); };
  const u = (end?: number) => { check(4, end); const v = d.getUint32(p, true); p += 4; return v; };
  const f = (end?: number) => { check(8, end); const v = d.getFloat64(p, true); p += 8; if (!Number.isFinite(v)) throw new Error('Invalid coordinate'); return v; };
  const point = (end?: number): Point => [f(end), f(end), f(end)];
  const ptr = (end: number): [number, number] => [u(end), u(end)];
  const slice = (start: number, length: number, dataStart: number, dataSize: number) => {
    if (start > dataSize || length > dataSize - start) throw new Error('Invalid LOX data pointer');
    return new DataView(buffer, dataStart + start, length);
  };
  const surfaces: Surface[] = [], bitmaps = new Map<number, SurfaceBitmap>();
  let chunks = 0;
  while (p < d.byteLength) {
    check(16); const kind = u(), recordBytes = u(), count = u(), dataSize = u();
    if (++chunks > 100000 || count > LIMIT || recordBytes > d.byteLength || dataSize > d.byteLength) throw new Error('LOX limits exceeded');
    check(recordBytes + dataSize);
    const recordsStart = p, recordsEnd = p + recordBytes, dataStart = recordsEnd;
    if (kind === 2) {
      // id, surveyId, namePtr, commentPtr, flags, xyz (52 bytes)
      if (recordBytes !== count * 52) throw new Error('Invalid station chunk');
      for (let i = 0; i < count; i++) {
        const id = u(recordsEnd); u(recordsEnd); ptr(recordsEnd); ptr(recordsEnd); u(recordsEnd);
        stations.set(id, point(recordsEnd));
      }
    } else if (kind === 3) {
      // from, to, 8 LRUD doubles, flags, section type, surveyId, threshold = 92 bytes
      if (recordBytes !== count * 92) throw new Error('Invalid shot chunk');
      for (let i = 0; i < count; i++) {
        const from = u(recordsEnd), to = u(recordsEnd);
        for (let j = 0; j < 8; j++) f(recordsEnd);
        const flags = u(recordsEnd); u(recordsEnd); u(recordsEnd); f(recordsEnd);
        if (!(flags & SHOT_NOT_VISIBLE)) shotIds.push({ from, to, flags });
      }
    } else if (kind === 4) {
      // id, surveyId, numPoints, pointDataPtr, numTriangles, triangleDataPtr = 36 bytes
      if (recordBytes !== count * 32) throw new Error('Invalid scrap chunk');
      for (let i = 0; i < count; i++) {
        u(recordsEnd); u(recordsEnd); const nPoints = u(recordsEnd), [po, ps] = ptr(recordsEnd);
        const nTris = u(recordsEnd), [to, ts] = ptr(recordsEnd);
        if (nPoints > LIMIT || nTris > LIMIT || ps !== nPoints * 24 || ts !== nTris * 12) throw new Error('Invalid scrap geometry lengths');
        const pv = slice(po, ps, dataStart, dataSize), tv = slice(to, ts, dataStart, dataSize);
        const points: Point[] = [];
        for (let j = 0; j < nPoints; j++) points.push([pv.getFloat64(j * 24, true), pv.getFloat64(j * 24 + 8, true), pv.getFloat64(j * 24 + 16, true)]);
        const triangles: [number, number, number][] = [];
        for (let j = 0; j < nTris; j++) {
          const a = tv.getUint32(j * 12, true), b = tv.getUint32(j * 12 + 4, true), c = tv.getUint32(j * 12 + 8, true);
          if (a >= nPoints || b >= nPoints || c >= nPoints) throw new Error('Scrap triangle outside point array');
          triangles.push([a, b, c]);
        }
        scraps.push({ points, triangles });
      }
    } else if (kind === 5 || kind === 6) {
      const width = kind === 5 ? 68 : 64;
      if (recordBytes !== count * width) throw new Error('Invalid surface chunk');
      for (let i = 0; i < count; i++) {
        const start = recordsStart + i * width;
        if (kind === 5) {
          const record = surfaceRecord(d, start, dataSize);
          const heights = new Float64Array(record.width * record.height);
          const source = slice(record.offset, record.size, dataStart, dataSize);
          for (let j = 0; j < heights.length; j++) {
            heights[j] = source.getFloat64(j * 8, true);
            if (!Number.isFinite(heights[j])) throw new Error('Invalid surface elevation');
          }
          surfaces.push({ id: record.id, width: record.width, height: record.height, calibration: record.calibration, heights });
        } else {
          const record = bitmapRecord(d, start, dataSize);
          const data = new Uint8Array(buffer.slice(dataStart + record.offset, dataStart + record.offset + record.size));
          bitmaps.set(record.id, { mime: record.mime, calibration: record.calibration, data });
        }
      }
    } else if (kind !== 1) throw new Error(`Unsupported LOX chunk ${kind}`);
    p = dataStart + dataSize;
  }
  const shots = resolveShots(shotIds, stations);
  let minZ = Infinity, maxZ = -Infinity;
  const addHeight = (z: number) => { if (!Number.isFinite(z)) throw new Error('Invalid geometry coordinate'); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); };
  for (const point of stations.values()) addHeight(point[2]);
  for (const s of scraps) for (const point of s.points) addHeight(point[2]);
  for (const surface of surfaces) surface.bitmap = bitmaps.get(surface.id);
  if (!Number.isFinite(minZ)) for (const surface of surfaces) for (let i = 0; i < surface.heights.length; i++) {
    addHeight(surface.heights[i]);
  }
  if (!Number.isFinite(minZ)) throw new Error('No cave geometry in LOX file');
  return { scraps, stations, shots, minZ, maxZ, surfaces };
}
