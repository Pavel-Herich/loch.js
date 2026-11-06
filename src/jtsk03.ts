import { SHIFT_DATA, SHIFT_GRID } from './jtsk03-shift-data';

let grid: Int16Array | undefined;
const OUTSIDE = -32768;

/**
 * How far a JTSK03 position (EPSG:8353) moves into JTSK (EPSG:5514), east and north in metres:
 * up to about 1.6 m in Slovakia. Nothing outside the GKÚ grid.
 */
export function jtsk03Shift(east: number, north: number): [number, number] {
  if (!grid) {
    const text = atob(SHIFT_DATA), bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
    grid = new Int16Array(bytes.buffer);
  }
  const { east0, north0, step, columns, rows } = SHIFT_GRID;
  const c = (east - east0) / step, r = (north - north0) / step;
  const c0 = Math.floor(c), r0 = Math.floor(r), u = c - c0, v = r - r0;
  const result: [number, number] = [0, 0];
  for (const component of [0, 1]) {
    let total = 0, weights = 0;
    for (const [dc, dr, w] of [[0, 0, (1 - u) * (1 - v)], [1, 0, u * (1 - v)], [0, 1, (1 - u) * v], [1, 1, u * v]]) {
      const cc = c0 + dc, rr = r0 + dr;
      if (cc < 0 || rr < 0 || cc >= columns || rr >= rows) continue;
      const value = grid[component * columns * rows + rr * columns + cc];
      if (value === OUTSIDE) continue;
      total += value * w; weights += w;
    }
    result[component] = weights > 1e-9 ? total / weights / 1000 : 0;
  }
  return result;
}
