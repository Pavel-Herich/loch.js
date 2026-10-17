import { bitmapRecord, surfaceRecord, surfacePoint, type Surface, type SurfaceRecord, type BitmapRecord } from './lox-surface';
import type { Point } from './lox';

export const READ_BYTES = 8 * 1024 * 1024;
export const BATCH_TRIANGLES = 65_536;
type Source = Pick<Blob, 'size' | 'slice'>;
type Scrap = { points: number; triangles: number; pointOffset: number; triangleOffset: number };
export type LargeModel = {
  min: Point; max: Point; origin: Point; minZ: number; maxZ: number;
  scraps: number; triangles: number; points: number; shots: [Point, Point][];
};
export type GeometryBatch = { positions: Float32Array; indices?: Uint32Array; triangles: number };
export type LoadProgress = { phase: string; completed: number; total: number };
export type LargeLoadCallbacks = {
  progress(progress: LoadProgress): void;
  ready(model: LargeModel): Promise<void>;
  batch(batch: GeometryBatch): Promise<void>;
  surface?(surface: Surface): Promise<void>;
};

async function read(source: Source, offset: number, length: number): Promise<DataView> {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0
    || length > READ_BYTES || offset + length > source.size) throw new Error('Truncated or corrupt LOX record');
  const buffer = await source.slice(offset, offset + length).arrayBuffer();
  if (buffer.byteLength !== length) throw new Error('Truncated or corrupt LOX record');
  return new DataView(buffer);
}

export async function streamLargeLox(source: Source, callbacks: LargeLoadCallbacks): Promise<LargeModel> {
  const surfaces: SurfaceRecord[] = [], bitmaps = new Map<number, BitmapRecord>();
  const scraps: Scrap[] = [], stations = new Map<number, Point>(), shotIds: [number, number][] = [];
  const min: Point = [Infinity, Infinity, Infinity], max: Point = [-Infinity, -Infinity, -Infinity];
  function bounds(x: number, y: number, z: number) {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) throw new Error('Invalid geometry coordinate');
    min[0] = Math.min(min[0], x); min[1] = Math.min(min[1], y); min[2] = Math.min(min[2], z);
    max[0] = Math.max(max[0], x); max[1] = Math.max(max[1], y); max[2] = Math.max(max[2], z);
  }
  let offset = 0, chunks = 0, totalPoints = 0, totalTriangles = 0;
  while (offset < source.size) {
    const header = await read(source, offset, 16);
    const kind = header.getUint32(0, true), recordBytes = header.getUint32(4, true);
    const count = header.getUint32(8, true), dataBytes = header.getUint32(12, true);
    const recordStart = offset + 16, dataStart = recordStart + recordBytes;
    if (++chunks > 100000) throw new Error('LOX limits exceeded');
    if (dataStart + dataBytes > source.size) throw new Error('Truncated or corrupt LOX record');
    const width = kind === 2 ? 52 : kind === 3 ? 92 : kind === 4 ? 32 : kind === 5 ? 68 : kind === 6 ? 64 : 0;
    if (width && recordBytes !== count * width) throw new Error(`Invalid ${kind === 2 ? 'station' : kind === 3 ? 'shot' : kind === 4 ? 'scrap' : 'surface'} chunk`);
    if (![1, 2, 3, 4, 5, 6].includes(kind)) throw new Error(`Unsupported LOX chunk ${kind}`);
    if (width) {
      const recordsPerRead = Math.floor(READ_BYTES / width);
      for (let first = 0; first < count; first += recordsPerRead) {
        const n = Math.min(recordsPerRead, count - first);
        const records = await read(source, recordStart + first * width, n * width);
        for (let i = 0; i < n; i++) {
          const p = i * width;
          if (kind === 2) {
            const point: Point = [records.getFloat64(p + 28, true), records.getFloat64(p + 36, true), records.getFloat64(p + 44, true)];
            bounds(...point); stations.set(records.getUint32(p, true), point);
          } else if (kind === 3) {
            if (!(records.getUint32(p + 72, true) & (1 | 4 | 16))) shotIds.push([records.getUint32(p, true), records.getUint32(p + 4, true)]);
          } else if (kind === 4) {
            const points = records.getUint32(p + 8, true), po = records.getUint32(p + 12, true), ps = records.getUint32(p + 16, true);
            const triangles = records.getUint32(p + 20, true), to = records.getUint32(p + 24, true), ts = records.getUint32(p + 28, true);
            if (ps !== points * 24 || ts !== triangles * 12) throw new Error('Invalid scrap geometry lengths');
            if (po > dataBytes || ps > dataBytes - po || to > dataBytes || ts > dataBytes - to) throw new Error('Invalid LOX data pointer');
            scraps.push({ points, triangles, pointOffset: dataStart + po, triangleOffset: dataStart + to });
            totalPoints += points; totalTriangles += triangles;
          } else if (kind === 5) {
            const record = surfaceRecord(records, p, dataBytes);
            surfaces.push({ ...record, offset: dataStart + record.offset });
          } else {
            const record = bitmapRecord(records, p, dataBytes);
            bitmaps.set(record.id, { ...record, offset: dataStart + record.offset });
          }
        }
      }
    }
    offset = dataStart + dataBytes;
    callbacks.progress({ phase: 'Reading LOX directory', completed: offset, total: source.size });
  }

  // Scan coordinates without keeping the 64-bit source arrays. Recentering before
  // conversion to Float32 preserves detail at large survey coordinate offsets.
  const pointsPerRead = Math.floor(READ_BYTES / 24);
  let scanned = 0;
  for (const scrap of scraps) {
    for (let first = 0; first < scrap.points; first += pointsPerRead) {
      const count = Math.min(pointsPerRead, scrap.points - first);
      const data = await read(source, scrap.pointOffset + first * 24, count * 24);
      for (let i = 0; i < count; i++) bounds(data.getFloat64(i * 24, true), data.getFloat64(i * 24 + 8, true), data.getFloat64(i * 24 + 16, true));
      scanned += count;
      callbacks.progress({ phase: 'Scanning model bounds', completed: scanned, total: totalPoints });
    }
  }
  const caveMinZ = min[2], caveMaxZ = max[2];
  let scannedSurface = 0;
  const surfacePoints = surfaces.reduce((sum, surface) => sum + surface.width * surface.height, 0);
  for (const surface of surfaces) {
    for (let first = 0; first < surface.width * surface.height; first += READ_BYTES / 8) {
      const count = Math.min(READ_BYTES / 8, surface.width * surface.height - first);
      const data = await read(source, surface.offset + first * 8, count * 8);
      for (let i = 0; i < count; i++) bounds(...surfacePoint(surface, first + i, data.getFloat64(i * 8, true)));
      scannedSurface += count;
      callbacks.progress({ phase: 'Scanning surface bounds', completed: scannedSurface, total: surfacePoints });
    }
  }
  if (!Number.isFinite(min[0])) throw new Error('No cave geometry in LOX file');
  const origin = min.map((value, axis) => value + (max[axis] - value) / 2) as Point;
  const shots: [Point, Point][] = [];
  for (const [a, b] of shotIds) {
    const from = stations.get(a), to = stations.get(b);
    if (from && to) shots.push([from, to]);
  }
  const model: LargeModel = { min, max, origin, minZ: Number.isFinite(caveMinZ) ? caveMinZ : min[2], maxZ: Number.isFinite(caveMaxZ) ? caveMaxZ : max[2], scraps: scraps.length, triangles: totalTriangles, points: totalPoints, shots };
  await callbacks.ready(model);
  for (const surface of surfaces) {
    if (!callbacks.surface) break;
    const heights = new Float64Array(surface.width * surface.height);
    for (let first = 0; first < heights.length; first += READ_BYTES / 8) {
      const count = Math.min(READ_BYTES / 8, heights.length - first);
      const data = await read(source, surface.offset + first * 8, count * 8);
      for (let i = 0; i < count; i++) heights[first + i] = data.getFloat64(i * 8, true);
      callbacks.progress({ phase: 'Loading surface', completed: first + count, total: heights.length });
    }
    const bitmap = bitmaps.get(surface.id);
    let image: Uint8Array<ArrayBuffer> | undefined;
    if (bitmap) {
      image = new Uint8Array(bitmap.size);
      for (let first = 0; first < bitmap.size; first += READ_BYTES) {
        const count = Math.min(READ_BYTES, bitmap.size - first);
        const data = await read(source, bitmap.offset + first, count);
        image.set(new Uint8Array(data.buffer, data.byteOffset, count), first);
      }
    }
    await callbacks.surface({ id: surface.id, width: surface.width, height: surface.height, calibration: surface.calibration, heights,
      bitmap: bitmap && image ? { mime: bitmap.mime, calibration: bitmap.calibration, data: image } : undefined });
  }
  let decoded = 0;
  for (const scrap of scraps) {
    for (let first = 0; first < scrap.triangles; first += BATCH_TRIANGLES) {
      const count = Math.min(BATCH_TRIANGLES, scrap.triangles - first);
      const triangles = await read(source, scrap.triangleOffset + first * 12, count * 12);
      const sourceIndices = new Uint32Array(count * 3);
      let sequential = true;
      for (let i = 0; i < sourceIndices.length; i++) {
        const index = triangles.getUint32(i * 4, true);
        if (index >= scrap.points) throw new Error('Scrap triangle outside point array');
        sourceIndices[i] = index;
        if (index !== sourceIndices[0] + i) sequential = false;
      }
      let required: Uint32Array;
      if (sequential) required = sourceIndices;
      else {
        const sorted = sourceIndices.slice().sort();
        let unique = 0;
        for (let i = 0; i < sorted.length; i++) if (i === 0 || sorted[i] !== sorted[i - 1]) sorted[unique++] = sorted[i];
        required = sorted.subarray(0, unique);
      }
      const positions = new Float32Array(required.length * 3);
      // Group arbitrary references into bounded source ranges, including indices
      // shared across triangles or referring to points far apart in the file.
      for (let firstPoint = 0; firstPoint < required.length;) {
        const start = required[firstPoint];
        let endPoint = firstPoint + 1;
        while (endPoint < required.length && required[endPoint] - start < pointsPerRead) endPoint++;
        const length = required[endPoint - 1] - start + 1;
        const points = await read(source, scrap.pointOffset + start * 24, length * 24);
        for (let i = firstPoint; i < endPoint; i++) {
          const p = (required[i] - start) * 24;
          positions[i * 3] = points.getFloat64(p, true) - origin[0];
          positions[i * 3 + 1] = points.getFloat64(p + 8, true) - origin[1];
          positions[i * 3 + 2] = points.getFloat64(p + 16, true) - origin[2];
        }
        firstPoint = endPoint;
      }
      if (!sequential) {
        for (let i = 0; i < sourceIndices.length; i++) {
          const value = sourceIndices[i];
          let low = 0, high = required.length - 1;
          while (low < high) { const mid = (low + high) >>> 1; if (required[mid] < value) low = mid + 1; else high = mid; }
          sourceIndices[i] = low;
        }
      }
      await callbacks.batch({ positions, indices: sequential ? undefined : sourceIndices, triangles: count });
      decoded += count;
      callbacks.progress({ phase: 'Loading full-detail walls', completed: decoded, total: totalTriangles });
    }
  }
  return model;
}
