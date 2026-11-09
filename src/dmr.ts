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
  /** Hillshade of the terrain (JPEG), finer than the grid, over its cells; south-west corner in the file's system. */
  image?: DmrImage;
};
export type DmrImage = { data: Uint8Array<ArrayBuffer>; width: number; height: number; west: number; south: number; pixel: number };

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

/**
 * A part of the file: columns and rows of its cells (end exclusive, rows from the top). The
 * whole file when not cropped.
 */
export type CellWindow = { column: number; row: number; columns: number; rows: number };
export const wholeFile = (tiff: Pick<GeoTiff, 'width' | 'height'>): CellWindow => ({ column: 0, row: 0, columns: tiff.width, rows: tiff.height });

/** The cells inside a rectangle given by its south-west and north-east corners (in the file's system). */
export function cropWindow(tiff: GeoTiff, west: number, south: number, east: number, north: number): CellWindow {
  const c0 = Math.max(0, Math.round((Math.min(west, east) - tiff.left) / tiff.pixelWidth));
  const c1 = Math.min(tiff.width, Math.round((Math.max(west, east) - tiff.left) / tiff.pixelWidth));
  const r0 = Math.max(0, Math.round((tiff.top - Math.max(south, north)) / tiff.pixelHeight));
  const r1 = Math.min(tiff.height, Math.round((tiff.top - Math.min(south, north)) / tiff.pixelHeight));
  return { column: c0, row: r0, columns: Math.max(0, c1 - c0), rows: Math.max(0, r1 - r0) };
}
/** Corners of a window: west, south, east, north (outer cell edges). */
export function windowCorners(tiff: GeoTiff, window: CellWindow): [number, number, number, number] {
  return [tiff.left + window.column * tiff.pixelWidth, tiff.top - (window.row + window.rows) * tiff.pixelHeight,
    tiff.left + (window.column + window.columns) * tiff.pixelWidth, tiff.top - window.row * tiff.pixelHeight];
}

/** Steps offered for the grid (metres between nodes), each a whole number of the file's cells. */
export function dmrSteps(tiff: GeoTiff, window: CellWindow = wholeFile(tiff)) {
  return [1, 2, 5, 10, 20].map(step => Math.max(1, Math.round(step / tiff.pixelWidth)))
    .filter((factor, i, all) => all.indexOf(factor) === i)
    .map(factor => {
      const columns = Math.floor(window.columns / factor), rows = Math.floor(window.rows / factor);
      return { factor, step: factor * tiff.pixelWidth, columns, rows, nodes: columns * rows };
    });
}

/**
 * Averages factor × factor cells into one node (cells without data left out), then trims
 * rows and columns with no data at all. Reads the file block by block, only the blocks in the window.
 */
export async function resampleDmr(file: Blob, tiff: GeoTiff, epsg: number, factor: number, name: string,
  progress?: (done: number, total: number) => void, shift: (east: number, north: number) => [number, number] = () => [0, 0],
  window: CellWindow = wholeFile(tiff), circle?: [number, number, number]): Promise<Dmr> {
  const width = Math.floor(window.columns / factor), height = Math.floor(window.rows / factor);
  if (!width || !height) throw new Error('The area is too small for this grid step.');
  // Single precision keeps a full-resolution pass (for the relief image) at 6 bytes a cell.
  const sum = new Float32Array(width * height), count = new Uint16Array(width * height);
  const across = Math.ceil(tiff.width / tiff.blockWidth), blocks = tiff.offsets.length;
  const needed: number[] = [];
  for (let index = 0; index < blocks; index++) {
    const firstColumn = tiff.tiled ? (index % across) * tiff.blockWidth : 0;
    const firstRow = tiff.tiled ? Math.floor(index / across) * tiff.blockHeight : index * tiff.blockHeight;
    if (firstColumn < window.column + window.columns && firstColumn + tiff.blockWidth > window.column
      && firstRow < window.row + window.rows && firstRow + tiff.blockHeight > window.row) needed.push(index);
  }
  for (let n = 0; n < needed.length; n++) {
    const index = needed[n], values = await readBlock(file, tiff, index);
    const firstColumn = tiff.tiled ? (index % across) * tiff.blockWidth : 0;
    const firstRow = tiff.tiled ? Math.floor(index / across) * tiff.blockHeight : index * tiff.blockHeight;
    const rows = values.length / tiff.blockWidth;
    for (let r = 0; r < rows; r++) {
      const row = firstRow + r - window.row;
      if (row < 0) continue;
      const target = Math.floor(row / factor);
      if (row >= window.rows || target >= height) break;
      for (let c = 0; c < tiff.blockWidth; c++) {
        const column = firstColumn + c - window.column;
        if (column < 0) continue;
        const node = Math.floor(column / factor);
        if (column >= window.columns || node >= width) break;
        const v = values[r * tiff.blockWidth + c];
        if (v === v) { const at = target * width + node; sum[at] += v; count[at]++; }
      }
    }
    progress?.(n + 1, needed.length);
  }
  // Cropped to a circle (east, north, radius): nodes whose centre lies outside it stay empty.
  const half0 = (factor - 1) / 2 + (tiff.pixelIsPoint ? 0 : .5);
  if (circle) for (let r = 0; r < height; r++) for (let c = 0; c < width; c++) {
    const east = tiff.left + (window.column + c * factor + half0) * tiff.pixelWidth;
    const north = tiff.top - (window.row + r * factor + half0) * tiff.pixelHeight;
    if (Math.hypot(east - circle[0], north - circle[1]) > circle[2]) count[r * width + c] = 0;
  }
  // Rows and columns that hold data (rows counted from the top of the file).
  let top = height, bottom = -1, left = width, right = -1;
  for (let r = 0; r < height; r++) for (let c = 0; c < width; c++) if (count[r * width + c]) {
    if (r < top) top = r; if (r > bottom) bottom = r; if (c < left) left = c; if (c > right) right = c;
  }
  if (bottom < 0) throw new Error('No heights in this area of the GeoTIFF.');
  const w = right - left + 1, h = bottom - top + 1, heights = new Float32Array(w * h);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    const at = (top + r) * width + left + c;
    heights[(h - 1 - r) * w + c] = count[at] ? sum[at] / count[at] : NaN;
  }
  // Centre of the averaged cells of the south-west node.
  const centre = tiff.pixelIsPoint ? 0 : .5, half = (factor - 1) / 2 + centre;
  const east = tiff.left + (window.column + left * factor + half) * tiff.pixelWidth;
  const north = tiff.top - (window.row + bottom * factor + half) * tiff.pixelHeight;
  const step = factor * tiff.pixelWidth;
  return { name, step, width: w, height: h, origin: [east, north], shift: epsg === JTSK03 ? shift(east + w * step / 2, north + h * step / 2) : [0, 0], epsg, heights };
}

/**
 * Multidirectional hillshade (as gdaldem -multidirectional, after Mark 1992): light from 225°,
 * 270°, 315° and 360° at the given altitude, each weighted by sin² of its angle to the slope's
 * aspect, so every slope is lit across rather than along. RGBA rows from north to south; cells
 * without data white. Horn's gradient; a missing neighbour counts as the cell itself.
 */
export function hillshade(grid: Pick<Dmr, 'width' | 'height' | 'heights' | 'step'>, altitude = 45, exaggeration = 1) {
  const { width, height, heights, step } = grid, rgba = new Uint8ClampedArray(width * height * 4);
  const alt = altitude * Math.PI / 180, sinAlt = Math.sin(alt), cosAlt = Math.cos(alt);
  const lights = [225, 270, 315, 360].map(az => [Math.sin(az * Math.PI / 180), Math.cos(az * Math.PI / 180)]);
  for (let r = 0; r < height; r++) for (let c = 0; c < width; c++) {
    const at = r * width + c, here = heights[at], out = ((height - 1 - r) * width + c) * 4;
    let value = 255;
    if (here === here) {
      const z = (dc: number, dr: number) => {
        const cc = Math.min(width - 1, Math.max(0, c + dc)), rr = Math.min(height - 1, Math.max(0, r + dr));
        const v = heights[rr * width + cc];
        return v === v ? v : here;
      };
      // East and north gradients (rows go north).
      const dzdx = ((z(1, 1) + 2 * z(1, 0) + z(1, -1)) - (z(-1, 1) + 2 * z(-1, 0) + z(-1, -1))) / (8 * step) * exaggeration;
      const dzdy = ((z(-1, 1) + 2 * z(0, 1) + z(1, 1)) - (z(-1, -1) + 2 * z(0, -1) + z(1, -1))) / (8 * step) * exaggeration;
      const slope2 = dzdx * dzdx + dzdy * dzdy, norm = Math.sqrt(1 + slope2);
      let shade: number;
      if (slope2 === 0) shade = sinAlt;
      else {
        // Downhill direction, and the light from each azimuth on the surface normal (-dzdx, -dzdy, 1).
        const ax = -dzdx / Math.sqrt(slope2), ay = -dzdy / Math.sqrt(slope2);
        let total = 0;
        for (const [lx, ly] of lights) {
          const lit = Math.max(0, (-dzdx * lx * cosAlt - dzdy * ly * cosAlt + sinAlt) / norm);
          const along = ax * lx + ay * ly;
          total += (1 - along * along) * lit;
        }
        shade = total / 2;
      }
      // Bright paper-like tone: flat ground light grey, shadows kept readable.
      value = 255 * Math.min(1, .18 + .95 * shade);
    }
    rgba[out] = rgba[out + 1] = rgba[out + 2] = value; rgba[out + 3] = 255;
  }
  return rgba;
}

/** The image's pixel size: the file's cells, coarser only to stay within the pixel and side limits. */
export function imageFactor(area: { width: number; height: number }, maxPixels: number, maxSide: number) {
  return Math.max(1, Math.ceil(Math.sqrt(area.width * area.height / maxPixels)), Math.ceil(Math.max(area.width, area.height) / maxSide));
}

/** The image over the cells of a hillshaded grid (corners, not centres). */
export function imagePlace(grid: Pick<Dmr, 'origin' | 'step' | 'width' | 'height'>) {
  return { west: grid.origin[0] - grid.step / 2, south: grid.origin[1] - grid.step / 2, pixel: grid.step, width: grid.width, height: grid.height };
}

/** The terrain as a surface of the model (in its JTSK). */
export function dmrSurface(dmr: Dmr): Surface {
  const image = dmr.image;
  return {
    ...(image ? { bitmap: { mime: 'image/jpeg' as const, data: image.data, calibration: [image.west + dmr.shift[0], image.south + dmr.shift[1], image.pixel, 0, 0, image.pixel] as Surface['calibration'] } } : {}),
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
 * The terrain for Therion: one surface block in the model's system (`cs ijtsk`; JTSK03 files are
 * moved into JTSK here with the GKÚ grid, so Therion needs no grid of its own), rows from north
 * to south as Therion reads them, cells without data filled from their neighbours, and the relief
 * image as its bitmap.
 */
export function dmrTherion(dmr: Dmr, imageName?: string) {
  const heights = filledHeights(dmr), lines: string[] = [];
  const missing = dmr.heights.reduce((n, h) => h === h ? n : n + 1, 0);
  const [dx, dy] = dmr.shift;
  lines.push('encoding utf-8');
  lines.push(`# Terrain from ${plain(dmr.name)}: ${dmr.width} x ${dmr.height} nodes every ${dmr.step} m (made with loch.js)`);
  lines.push('# Zdroj produktov LLS: UGKK SR (CC BY 4.0)');
  if (dmr.epsg === JTSK03) lines.push(`# Moved from S-JTSK [JTSK03] into JTSK by ${dx.toFixed(2)} m east, ${dy.toFixed(2)} m north (GKU grid sk_gku_JTSK03_to_JTSK)`);
  if (missing) lines.push(`# ${missing} nodes without data were filled from their neighbours`);
  lines.push('surface', '  cs ijtsk');
  lines.push(`  grid ${(dmr.origin[0] + dx).toFixed(2)} ${(dmr.origin[1] + dy).toFixed(2)} ${dmr.step} ${dmr.step} ${dmr.width} ${dmr.height}`);
  // Image pixels count from the bottom-left corner, as in Therion.
  const image = dmr.image;
  if (image && imageName) lines.push(`  bitmap ${imageName} [0 0 ${(image.west + dx).toFixed(2)} ${(image.south + dy).toFixed(2)} ${image.width} ${image.height} ${(image.west + dx + image.width * image.pixel).toFixed(2)} ${(image.south + dy + image.height * image.pixel).toFixed(2)}]`);
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

/** A thconfig that makes a LOX of the exported surface. */
export function dmrThconfig(base: string) {
  return ['encoding utf-8', `source ${base}.th`, '', 'cs ijtsk', '', `export model -output ${base}.lox`, ''].join('\n');
}

/**
 * The terrain as a LOX file, as Therion writes it from the exported surface: an empty root
 * survey (carrying the title), the grid (cells without data filled, as Therion needs) and the
 * relief image, in JTSK.
 */
export function dmrLox(dmr: Dmr, title: string): Blob {
  const surface = dmrSurface(dmr), filled = filledHeights(dmr), text = new TextEncoder();
  const chunk = (kind: number, count: number, records: Uint8Array, data: Uint8Array | Blob) => {
    const header = new DataView(new ArrayBuffer(16));
    header.setUint32(0, kind, true); header.setUint32(4, records.length, true); header.setUint32(8, count, true);
    header.setUint32(12, data instanceof Blob ? data.size : data.length, true);
    return [header.buffer, records, data] as BlobPart[];
  };
  // Survey 0: name and title as zero-ended text.
  const name = text.encode(`${plain(title)}\0`), titleBytes = name;
  const survey = new DataView(new ArrayBuffer(24));
  survey.setUint32(0, 0, true); survey.setUint32(4, 0, true); survey.setUint32(8, name.length, true);
  survey.setUint32(12, 0, true); survey.setUint32(16, name.length, true); survey.setUint32(20, titleBytes.length, true);
  const surveyData = new Uint8Array(name.length + titleBytes.length); surveyData.set(name); surveyData.set(titleBytes, name.length);
  // Surface 0: width, height, heights pointer, calibration.
  const record = new DataView(new ArrayBuffer(68));
  record.setUint32(0, 0, true); record.setUint32(4, dmr.width, true); record.setUint32(8, dmr.height, true);
  record.setUint32(12, 0, true); record.setUint32(16, dmr.width * dmr.height * 8, true);
  surface.calibration.forEach((value, i) => record.setFloat64(20 + i * 8, value, true));
  const heights = new Float64Array(filled.length);
  for (let i = 0; i < filled.length; i++) heights[i] = filled[i];
  const parts: BlobPart[] = [
    ...chunk(1, 1, new Uint8Array(survey.buffer), surveyData),
    ...chunk(5, 1, new Uint8Array(record.buffer), new Uint8Array(heights.buffer)),
  ];
  if (surface.bitmap) {
    const bitmap = new DataView(new ArrayBuffer(64));
    bitmap.setUint32(0, 0, true); bitmap.setUint32(4, 0, true); bitmap.setUint32(8, 0, true); bitmap.setUint32(12, surface.bitmap.data.length, true);
    surface.bitmap.calibration.forEach((value, i) => bitmap.setFloat64(16 + i * 8, value, true));
    parts.push(...chunk(6, 1, new Uint8Array(bitmap.buffer), surface.bitmap.data));
  }
  return new Blob(parts, { type: 'application/octet-stream' });
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
