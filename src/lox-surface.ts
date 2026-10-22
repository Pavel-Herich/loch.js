/** LOX chunks 5/6, matching lxFileSurface / lxFileSurfaceBitmap. */
export type Calibration = [number, number, number, number, number, number];
export type SurfaceBitmap = { calibration: Calibration; mime: 'image/jpeg' | 'image/png'; data: Uint8Array<ArrayBuffer> };
export type Surface = { id: number; width: number; height: number; calibration: Calibration; heights: Float64Array<ArrayBuffer>; bitmap?: SurfaceBitmap };
export type SurfaceRecord = Omit<Surface, 'heights' | 'bitmap'> & { offset: number; size: number };
export type BitmapRecord = Omit<SurfaceBitmap, 'data'> & { id: number; offset: number; size: number };

function calibration(data: DataView, start: number): Calibration {
  const values = Array.from({ length: 6 }, (_, i) => data.getFloat64(start + i * 8, true)) as Calibration;
  if (!values.every(Number.isFinite) || values[2] * values[5] - values[3] * values[4] === 0) throw new Error('Invalid surface calibration');
  return values;
}
function pointer(data: DataView, start: number, dataSize: number) {
  const offset = data.getUint32(start, true), size = data.getUint32(start + 4, true);
  if (offset > dataSize || size > dataSize - offset) throw new Error('Invalid surface data pointer');
  return { offset, size };
}
export function surfaceRecord(data: DataView, start: number, dataSize: number): SurfaceRecord {
  const id = data.getUint32(start, true), width = data.getUint32(start + 4, true), height = data.getUint32(start + 8, true);
  const ref = pointer(data, start + 12, dataSize);
  if (!width || !height || width * height > 50_000_000 || ref.size !== width * height * 8) throw new Error('Invalid surface grid dimensions');
  return { id, width, height, ...ref, calibration: calibration(data, start + 20) };
}
export function bitmapRecord(data: DataView, start: number, dataSize: number): BitmapRecord {
  const id = data.getUint32(start, true), type = data.getUint32(start + 4, true);
  if (type > 1) throw new Error('Unsupported surface bitmap format');
  const ref = pointer(data, start + 8, dataSize);
  if (!ref.size) throw new Error('Empty surface bitmap');
  return { id, mime: type === 0 ? 'image/jpeg' : 'image/png', ...ref, calibration: calibration(data, start + 16) };
}
export function surfacePoint(surface: Pick<Surface, 'width' | 'calibration'>, index: number, z: number): [number, number, number] {
  const [x, y, xx, xy, yx, yy] = surface.calibration;
  const column = index % surface.width, row = Math.floor(index / surface.width);
  return [x + xx * column + xy * row, y + yx * column + yy * row, z];
}
/** Bilinear terrain height at a world position, or undefined outside the grid. */
export function surfaceHeightAt(surface: Pick<Surface, 'width' | 'height' | 'calibration' | 'heights'>, x: number, y: number): number | undefined {
  const [x0, y0, xx, xy, yx, yy] = surface.calibration;
  const determinant = xx * yy - xy * yx, dx = x - x0, dy = y - y0;
  const column = (yy * dx - xy * dy) / determinant, row = (xx * dy - yx * dx) / determinant;
  if (!(column >= 0 && row >= 0 && column <= surface.width - 1 && row <= surface.height - 1)) return undefined;
  const c = Math.min(Math.floor(column), surface.width - 2), r = Math.min(Math.floor(row), surface.height - 2);
  const u = column - c, v = row - r, at = (i: number, j: number) => surface.heights[(r + j) * surface.width + c + i];
  const h = (at(0, 0) * (1 - u) + at(1, 0) * u) * (1 - v) + (at(0, 1) * (1 - u) + at(1, 1) * u) * v;
  return Number.isFinite(h) ? h : undefined;
}
