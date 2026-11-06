import { readBlock, readGeoTiff, type GeoTiff } from './geotiff';
import type { Surface } from './lox-surface';

/**
 * A terrain model (DMR 5.0 from ZBGIS, or any S-JTSK elevation GeoTIFF) as a surface of the
 * model: averaged onto a grid of the chosen step, placed in the model's S-JTSK (JTSK) and kept
 * with its JTSK03 position for Therion. Cells without data (outside an exported polygon) stay
 * empty (NaN).
 */
export type Dmr = {
  name: string; step: number; width: number; height: number;
  /** South-west grid node in the file's system (JTSK03 for DMR 5.0), and the shift into the model's JTSK. */
  origin: [number, number]; shift: [number, number]; epsg: number;
  /** Rows from south to north, west to east. */
  heights: Float32Array;
};

/** EPSG codes read as S-JTSK east–north (negative) coordinates. */
const JTSK03 = 8353, JTSK = 5514;

export async function inspectDmr(file: Blob) {
  const tiff = await readGeoTiff(file);
  let epsg = tiff.epsg;
  if (epsg === undefined || epsg === 32767) {
    // No code given: ÚGKK grids are JTSK03, recognised by S-JTSK east–north values.
    if (tiff.left < -100_000 && tiff.left > -1_000_000 && tiff.top < -900_000 && tiff.top > -1_400_000) epsg = JTSK03;
  }
  if (epsg !== JTSK03 && epsg !== JTSK) throw new Error(`The GeoTIFF is in ${epsg ? `EPSG:${epsg}` : 'an unknown system'}; S-JTSK (EPSG:8353 JTSK03 or EPSG:5514) is needed.`);
  if (Math.abs(tiff.pixelWidth - tiff.pixelHeight) > 1e-6 * tiff.pixelWidth) throw new Error('The GeoTIFF cells are not square.');
  return { tiff, epsg };
}

/** Steps offered for the grid (metres between nodes), each a whole number of the file's cells. */
export function dmrSteps(tiff: GeoTiff) {
  return [1, 2, 5, 10, 20].map(step => Math.max(1, Math.round(step / tiff.pixelWidth)))
    .filter((factor, i, all) => all.indexOf(factor) === i)
    .map(factor => ({ factor, step: factor * tiff.pixelWidth, nodes: Math.floor(tiff.width / factor) * Math.floor(tiff.height / factor) }));
}

/**
 * Averages factor × factor cells into one node (cells without data left out), then trims
 * rows and columns with no data at all. Reads the file block by block.
 */
export async function resampleDmr(file: Blob, tiff: GeoTiff, epsg: number, factor: number, name: string,
  progress?: (done: number, total: number) => void, shift: (east: number, north: number) => [number, number] = () => [0, 0]): Promise<Dmr> {
  const width = Math.floor(tiff.width / factor), height = Math.floor(tiff.height / factor);
  if (!width || !height) throw new Error('The GeoTIFF is too small for this grid step.');
  const sum = new Float64Array(width * height), count = new Uint16Array(width * height);
  const across = Math.ceil(tiff.width / tiff.blockWidth), blocks = tiff.offsets.length;
  for (let index = 0; index < blocks; index++) {
    const values = await readBlock(file, tiff, index);
    const firstColumn = tiff.tiled ? (index % across) * tiff.blockWidth : 0;
    const firstRow = tiff.tiled ? Math.floor(index / across) * tiff.blockHeight : index * tiff.blockHeight;
    const rows = values.length / tiff.blockWidth;
    for (let r = 0; r < rows; r++) {
      const row = firstRow + r, target = Math.floor(row / factor);
      if (row >= tiff.height || target >= height) break;
      for (let c = 0; c < tiff.blockWidth; c++) {
        const column = firstColumn + c, node = Math.floor(column / factor);
        if (column >= tiff.width || node >= width) break;
        const v = values[r * tiff.blockWidth + c];
        if (v === v) { const at = target * width + node; sum[at] += v; count[at]++; }
      }
    }
    progress?.(index + 1, blocks);
  }
  // Rows and columns that hold data (rows counted from the top of the file).
  let top = height, bottom = -1, left = width, right = -1;
  for (let r = 0; r < height; r++) for (let c = 0; c < width; c++) if (count[r * width + c]) {
    if (r < top) top = r; if (r > bottom) bottom = r; if (c < left) left = c; if (c > right) right = c;
  }
  if (bottom < 0) throw new Error('The GeoTIFF holds no heights.');
  const w = right - left + 1, h = bottom - top + 1, heights = new Float32Array(w * h);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    const at = (top + r) * width + left + c;
    heights[(h - 1 - r) * w + c] = count[at] ? sum[at] / count[at] : NaN;
  }
  // Centre of the averaged cells of the south-west node.
  const centre = tiff.pixelIsPoint ? 0 : .5, half = (factor - 1) / 2 + centre;
  const east = tiff.left + (left * factor + half) * tiff.pixelWidth;
  const north = tiff.top - (bottom * factor + half) * tiff.pixelHeight;
  const step = factor * tiff.pixelWidth;
  return { name, step, width: w, height: h, origin: [east, north], shift: epsg === JTSK03 ? shift(east + w * step / 2, north + h * step / 2) : [0, 0], epsg, heights };
}

/** The terrain as a surface of the model (in its JTSK). */
export function dmrSurface(dmr: Dmr): Surface {
  return {
    id: -1, // negative: a terrain model, shaded rather than showing the LOX image
    width: dmr.width, height: dmr.height,
    calibration: [dmr.origin[0] + dmr.shift[0], dmr.origin[1] + dmr.shift[1], dmr.step, 0, 0, dmr.step],
    heights: Float64Array.from(dmr.heights),
  };
}

/** Fills cells without data from their nearest filled neighbours (breadth first), for Therion, which needs a full grid. */
export function filledHeights(dmr: Pick<Dmr, 'width' | 'height' | 'heights'>) {
  const { width, height } = dmr, heights = Float32Array.from(dmr.heights);
  const queue = new Int32Array(width * height);
  let head = 0, tail = 0;
  for (let i = 0; i < heights.length; i++) if (heights[i] === heights[i]) queue[tail++] = i;
  const filled = new Uint8Array(heights.length);
  for (let i = 0; i < tail; i++) filled[queue[i]] = 1;
  while (head < tail) {
    const i = queue[head++], c = i % width, r = (i - c) / width;
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nc = c + dc, nr = r + dr;
      if (nc < 0 || nr < 0 || nc >= width || nr >= height) continue;
      const j = nr * width + nc;
      if (filled[j]) continue;
      // Mean of the filled neighbours of the new cell.
      let total = 0, n = 0;
      for (const [ec, er] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const mc = nc + ec, mr = nr + er;
        if (mc < 0 || mr < 0 || mc >= width || mr >= height) continue;
        const k = mr * width + mc;
        if (filled[k]) { total += heights[k]; n++; }
      }
      heights[j] = total / n; filled[j] = 1; queue[tail++] = j;
    }
  }
  return heights;
}

const plain = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e]/g, '_');

/**
 * The terrain for Therion: one surface block in the file's system (cs ijtsk03 for DMR 5.0,
 * which Therion moves into JTSK with the same GKÚ grid), rows from north to south as Therion
 * reads them, cells without data filled from their neighbours.
 */
export function dmrTherion(dmr: Dmr) {
  const heights = filledHeights(dmr), lines: string[] = [];
  const missing = dmr.heights.reduce((n, h) => h === h ? n : n + 1, 0);
  lines.push(`# Terrain from ${plain(dmr.name)}: ${dmr.width} x ${dmr.height} nodes every ${dmr.step} m (made with loch.js)`);
  lines.push('# Zdroj produktov LLS: UGKK SR (CC BY 4.0)');
  if (missing) lines.push(`# ${missing} nodes without data were filled from their neighbours`);
  lines.push('surface', `  cs ${dmr.epsg === JTSK03 ? 'ijtsk03' : 'ijtsk'}`);
  lines.push(`  grid ${dmr.origin[0].toFixed(2)} ${dmr.origin[1].toFixed(2)} ${dmr.step} ${dmr.step} ${dmr.width} ${dmr.height}`);
  const PER_LINE = 20;
  for (let r = dmr.height - 1; r >= 0; r--) {
    for (let c = 0; c < dmr.width; c += PER_LINE) {
      const values: string[] = [];
      for (let i = c; i < Math.min(dmr.width, c + PER_LINE); i++) values.push(heights[r * dmr.width + i].toFixed(2));
      lines.push(`  ${values.join(' ')}`);
    }
  }
  lines.push('endsurface', '');
  return lines.join('\n');
}

/**
 * The elevation GeoTIFF inside a ZIP from ZBGIS (the largest .tif), read from the central
 * directory; stored entries are sliced, deflated ones decompressed by the browser.
 */
export async function tiffFromZip(file: Blob): Promise<{ name: string; blob: Blob }> {
  const tailSize = Math.min(file.size, 65_557), tail = new Uint8Array(await file.slice(file.size - tailSize).arrayBuffer());
  const tv = new DataView(tail.buffer);
  let end = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (tv.getUint32(i, true) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new Error('This is not a ZIP file.');
  const entries = tv.getUint16(end + 10, true), size = tv.getUint32(end + 12, true), offset = tv.getUint32(end + 16, true);
  if (offset === 0xffffffff || size === 0xffffffff) throw new Error('ZIP files over 4 GB cannot be read; unpack it and open the .tif.');
  const directory = new Uint8Array(await file.slice(offset, offset + size).arrayBuffer()), dv = new DataView(directory.buffer);
  let best: { name: string; method: number; compressed: number; local: number; size: number } | undefined;
  for (let at = 0, i = 0; i < entries && at + 46 <= directory.length; i++) {
    const method = dv.getUint16(at + 10, true), compressed = dv.getUint32(at + 20, true), uncompressed = dv.getUint32(at + 24, true);
    const nameLength = dv.getUint16(at + 28, true), extra = dv.getUint16(at + 30, true), comment = dv.getUint16(at + 32, true);
    const local = dv.getUint32(at + 42, true), name = new TextDecoder().decode(directory.subarray(at + 46, at + 46 + nameLength));
    if (/\.tiff?$/i.test(name) && (!best || uncompressed > best.size)) best = { name, method, compressed, local, size: uncompressed };
    at += 46 + nameLength + extra + comment;
  }
  if (!best) throw new Error('No .tif file inside the ZIP.');
  const header = new DataView(await file.slice(best.local, best.local + 30).arrayBuffer());
  const start = best.local + 30 + header.getUint16(26, true) + header.getUint16(28, true);
  const data = file.slice(start, start + best.compressed);
  const name = best.name.split('/').pop()!;
  if (best.method === 0) return { name, blob: data };
  if (best.method !== 8) throw new Error(`Unsupported ZIP compression (${best.method}).`);
  return { name, blob: await new Response(data.stream().pipeThrough(new DecompressionStream('deflate-raw'))).blob() };
}
