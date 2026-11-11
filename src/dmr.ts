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
  /** How its relief image was drawn. */
  style?: ReliefStyle;
  /** Hillshade of the terrain (JPEG), finer than the grid, over its cells; south-west corner in the file's system. */
  image?: DmrImage;
};
/** The relief image: its outer south-west corner, pixel size east (and north, when it differs) and pixels. */
export type DmrImage = { data: Uint8Array<ArrayBuffer>; width: number; height: number; west: number; south: number; pixel: number; pixelY?: number };

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
/**
 * The part of a grid within S-JTSK corners (west, south, east, north): the nodes inside, so a
 * preview of the whole file shows only what was cropped. The whole grid when nothing lies inside.
 */
export function cropGrid<T extends Pick<Dmr, 'width' | 'height' | 'step' | 'origin' | 'heights'>>(grid: T, [west, south, east, north]: [number, number, number, number]): T {
  const at = (value: number, origin: number) => (value - origin) / grid.step;
  const c0 = Math.max(0, Math.ceil(at(west, grid.origin[0]) - 1e-9)), c1 = Math.min(grid.width - 1, Math.floor(at(east, grid.origin[0]) + 1e-9));
  const r0 = Math.max(0, Math.ceil(at(south, grid.origin[1]) - 1e-9)), r1 = Math.min(grid.height - 1, Math.floor(at(north, grid.origin[1]) + 1e-9));
  if (c1 < c0 || r1 < r0 || (c0 === 0 && r0 === 0 && c1 === grid.width - 1 && r1 === grid.height - 1)) return grid;
  const width = c1 - c0 + 1, height = r1 - r0 + 1, heights = new Float32Array(width * height);
  for (let r = 0; r < height; r++) heights.set(grid.heights.subarray((r0 + r) * grid.width + c0, (r0 + r) * grid.width + c1 + 1), r * width);
  return { ...grid, width, height, heights, origin: [grid.origin[0] + c0 * grid.step, grid.origin[1] + r0 * grid.step] };
}
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
 * How `cells` cells share out among `nodes` nodes of `factor` cells each (any factor ≥ 1): the
 * first node each cell falls in and the part of the cell there, and the part in the next node
 * (0 when it falls in one node only); parts in cells (1 = the whole cell).
 */
export function cellShares(cells: number, nodes: number, factor: number) {
  const first = new Int32Array(cells), part = new Float32Array(cells), second = new Float32Array(cells);
  for (let i = 0; i < cells; i++) {
    const from = i / factor, to = (i + 1) / factor, node = Math.floor(from + 1e-12);
    first[i] = node < nodes ? node : -1;
    part[i] = (Math.min(to, node + 1) - from) * factor;
    second[i] = to > node + 1 + 1e-12 && node + 1 < nodes ? (to - node - 1) * factor : 0;
  }
  return { first, part, second };
}

/**
 * The shaded relief of a part of the file at `factor` cells a pixel (any factor ≥ 1), shaded from
 * the file's own cells and only then reduced, area-weighted, to the pixels (shading heights that
 * were averaged first shows the averaging as a pattern). Read strip by strip of the file, so
 * only the reduced image's sums stay in memory (6 bytes a pixel). Cells without data are left
 * out; pixels with none at all come out white.
 */
export async function reliefFromFile(file: Blob, tiff: GeoTiff, window: CellWindow, factor: number, progress?: (done: number, total: number) => void,
  style: ReliefStyle = 'multidirectional', range: [number, number] = [0, 1], strip = 256) {
  const width = Math.max(1, Math.floor(window.columns / factor + 1e-9)), height = Math.max(1, Math.floor(window.rows / factor + 1e-9));
  const columns = cellShares(window.columns, width, factor), rows = cellShares(window.rows, height, factor);
  const parts = Math.floor(65000 / Math.ceil(factor) ** 2);
  const sums = new Float32Array(width * height), weights = new Uint16Array(width * height);
  // Coloured styles and contours: the mean height of each pixel too (used when the image is drawn).
  const heightSums = reliefUsesHeight(style) ? new Float32Array(width * height) : undefined;
  const across = Math.ceil(tiff.width / tiff.blockWidth);
  const blockRows = tiff.tiled ? Math.ceil(tiff.height / tiff.blockHeight) : tiff.offsets.length;
  const firstBlock = Math.floor(window.row / tiff.blockHeight), lastBlock = Math.min(blockRows - 1, Math.floor((window.row + window.rows - 1) / tiff.blockHeight));
  const firstTile = Math.floor(window.column / tiff.blockWidth), lastTile = Math.floor((window.column + window.columns - 1) / tiff.blockWidth);
  // One band of the file's rows (inside the window) as heights, rows from the top.
  const band = async (blockRow: number) => {
    const top = Math.max(window.row, blockRow * tiff.blockHeight), bottom = Math.min(window.row + window.rows, (blockRow + 1) * tiff.blockHeight);
    const heights = new Float32Array((bottom - top) * window.columns).fill(NaN);
    for (let tile = tiff.tiled ? firstTile : 0; tile <= (tiff.tiled ? lastTile : 0); tile++) {
      const index = tiff.tiled ? blockRow * across + tile : blockRow, values = await readBlock(file, tiff, index);
      const firstColumn = tiff.tiled ? tile * tiff.blockWidth : 0, firstRow = blockRow * tiff.blockHeight;
      for (let row = top; row < bottom; row++) {
        const r = row - firstRow;
        if (r * tiff.blockWidth >= values.length) break;
        for (let c = 0; c < tiff.blockWidth; c++) {
          const column = firstColumn + c - window.column;
          if (column < 0) continue;
          if (column >= window.columns) break;
          heights[(row - top) * window.columns + column] = values[r * tiff.blockWidth + c];
        }
      }
    }
    return { top: top - window.row, rows: bottom - top, heights };
  };
  // Strips of rows, each shaded with the neighbouring rows the style looks at (one for shading,
  // 15 m for the sky-view factor); the file's bands are read once and dropped when passed.
  const reach = reliefReach(style, tiff.pixelWidth), bands = new Map<number, Promise<Awaited<ReturnType<typeof band>>>>();
  const bandOf = (row: number) => Math.floor((window.row + row) / tiff.blockHeight);
  const STRIP = Math.max(strip, Math.min(tiff.blockHeight, 2048));
  for (let start = 0; start < window.rows; start += STRIP) {
    const end = Math.min(window.rows, start + STRIP), from = Math.max(0, start - reach), to = Math.min(window.rows, end + reach), count = to - from;
    // Rows from the south for the shading.
    const grid = new Float32Array(count * window.columns).fill(NaN);
    for (let b = Math.max(firstBlock, bandOf(from)); b <= Math.min(lastBlock, bandOf(to - 1)); b++) {
      if (!bands.has(b)) bands.set(b, band(b));
      const piece = await bands.get(b)!;
      for (let row = Math.max(from, piece.top); row < Math.min(to, piece.top + piece.rows); row++)
        grid.set(piece.heights.subarray((row - piece.top) * window.columns, (row - piece.top + 1) * window.columns), (count - 1 - (row - from)) * window.columns);
    }
    const keep = bandOf(Math.max(0, end - reach));
    for (const b of [...bands.keys()]) if (b < keep) bands.delete(b);
    const tones = reliefTones({ width: window.columns, height: count, heights: grid, step: tiff.pixelWidth }, start - from, end - start, style);
    for (let row = start; row < end; row++) {
      const target = rows.first[row];
      if (target < 0) continue;
      const cells = (count - 1 - (row - from)) * window.columns, shades = (row - start) * window.columns;
      for (const [pixelRow, rowPart] of [[target, rows.part[row]], [target + 1, rows.second[row]]]) {
        if (!rowPart) continue;
        const base = pixelRow * width;
        for (let c = 0; c < window.columns; c++) {
          const pixel = columns.first[c], here = grid[cells + c];
          if (pixel < 0 || here !== here) continue;
          const grey = tones[shades + c];
          const q0 = Math.round(rowPart * columns.part[c] * parts), q1 = Math.round(rowPart * columns.second[c] * parts);
          if (q0) { sums[base + pixel] += grey * q0; weights[base + pixel] += q0; if (heightSums) heightSums[base + pixel] += here * q0; }
          if (q1) { sums[base + pixel + 1] += grey * q1; weights[base + pixel + 1] += q1; if (heightSums) heightSums[base + pixel + 1] += here * q1; }
        }
      }
    }
    progress?.(end, window.rows);
  }
  const pixel = factor * tiff.pixelWidth;
  return {
    width, height,
    /** Pixel rows (north first) as RGBA, a strip at a time. */
    rows(first: number, count: number) {
      const rgba = new Uint8ClampedArray(width * count * 4);
      const coloured = heightSums && (style === 'altitude' || style === 'swiss');
      for (let i = 0; i < width * count; i++) {
        const at = first * width + i, weight = weights[at];
        if (coloured && weight) {
          const [r, g, b] = reliefColour(sums[at] / weight, style, heightSums[at] / weight, range);
          rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b;
        } else rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = weight ? sums[at] / weight : 255;
        rgba[i * 4 + 3] = 255;
      }
      if (style === 'contours' && heightSums) drawContours(rgba, width, height, first, count, pixel, (row, column) => {
        const at = row * width + column;
        return weights[at] ? heightSums[at] / weights[at] : NaN;
      });
      return rgba;
    },
    west: tiff.left + window.column * tiff.pixelWidth, south: tiff.top - (window.row + height * factor) * tiff.pixelHeight, pixel,
  };
}

/**
 * Averages factor × factor cells into one node (cells without data left out), then trims
 * rows and columns with no data at all. Reads the file block by block, only the blocks in the window.
 */
export async function resampleDmr(file: Blob, tiff: GeoTiff, epsg: number, factor: number, name: string,
  progress?: (done: number, total: number) => void, shift: (east: number, north: number) => [number, number] = () => [0, 0],
  window: CellWindow = wholeFile(tiff)): Promise<Dmr> {
  const width = Math.floor(window.columns / factor), height = Math.floor(window.rows / factor);
  if (!width || !height) throw new Error('The area is too small for this grid step.');
  // Single precision and (up to 15 × 15 cells a node) byte counts keep a large pass (for the
  // relief image) at 5 bytes a node; rows are kept from the south, as the result needs them.
  // The factor need not be whole (the relief image, to an exact size): then each cell is shared by
  // the nodes it overlaps, by area, so every node weighs the same ground (counting whole cells
  // would give some nodes one cell and others two or four: a grid pattern in the shading). The
  // shares are counted in as fine parts of a cell as two bytes a node allow (16 250ths for up to
  // 2 × 2 cells a node, 64ths for 32 × 32).
  const whole = Math.abs(factor - Math.round(factor)) < 1e-9;
  const sum = new Float32Array(width * height);
  const count = whole && factor <= 15 ? new Uint8Array(width * height) : new Uint16Array(width * height);
  const shares = (cells: number, nodes: number) => cellShares(cells, nodes, factor);
  const columnShares = whole ? undefined : shares(window.columns, width), rowShares = whole ? undefined : shares(window.rows, height);
  const parts = Math.floor(65000 / Math.ceil(factor) ** 2);
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
      if (row >= window.rows) break;
      if (columnShares && rowShares) {
        const target = rowShares.first[row];
        if (target < 0) break;
        const rowParts = [[target, rowShares.part[row]], [target + 1, rowShares.second[row]]];
        for (let c = 0; c < tiff.blockWidth; c++) {
          const column = firstColumn + c - window.column;
          if (column < 0) continue;
          if (column >= window.columns) break;
          const node = columnShares.first[column], v = values[r * tiff.blockWidth + c];
          if (node < 0 || v !== v) continue;
          for (const [rr, wr] of rowParts) {
            if (!wr) continue;
            const base = (height - 1 - rr) * width;
            const q0 = Math.round(wr * columnShares.part[column] * parts), q1 = Math.round(wr * columnShares.second[column] * parts);
            if (q0) { sum[base + node] += v * q0; count[base + node] += q0; }
            if (q1) { sum[base + node + 1] += v * q1; count[base + node + 1] += q1; }
          }
        }
        continue;
      }
      const target = Math.floor(row / factor);
      if (target >= height) break;
      for (let c = 0; c < tiff.blockWidth; c++) {
        const column = firstColumn + c - window.column;
        if (column < 0) continue;
        const node = Math.floor(column / factor);
        if (column >= window.columns || node >= width) break;
        const v = values[r * tiff.blockWidth + c];
        if (v === v) { const at = (height - 1 - target) * width + node; sum[at] += v; count[at]++; }
      }
    }
    progress?.(n + 1, needed.length);
  }
  // Rows (from the south) and columns that hold data.
  let southRow = height, northRow = -1, left = width, right = -1;
  for (let r = 0; r < height; r++) for (let c = 0; c < width; c++) if (count[r * width + c]) {
    if (r < southRow) southRow = r; if (r > northRow) northRow = r; if (c < left) left = c; if (c > right) right = c;
  }
  if (northRow < 0) throw new Error('No heights in this area of the GeoTIFF.');
  const w = right - left + 1, h = northRow - southRow + 1;
  // Means written over the sums in place (each source lies at or after its target).
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
    const from = (southRow + r) * width + left + c;
    sum[r * w + c] = count[from] ? sum[from] / count[from] : NaN;
  }
  const heights = w * h === sum.length ? sum : sum.slice(0, w * h);
  const bottom = height - 1 - southRow; // the south-west node's row from the top
  // Centre of the averaged cells of the south-west node.
  const centre = tiff.pixelIsPoint ? 0 : .5, half = (factor - 1) / 2 + centre;
  const east = tiff.left + (window.column + left * factor + half) * tiff.pixelWidth;
  const north = tiff.top - (window.row + bottom * factor + half) * tiff.pixelHeight;
  const step = factor * tiff.pixelWidth;
  return { name, step, width: w, height: h, origin: [east, north], shift: epsg === JTSK03 ? shift(east + w * step / 2, north + h * step / 2) : [0, 0], epsg, heights };
}

/**
 * How the relief image is drawn: shaded from four directions (as gdaldem -multidirectional), from
 * the north-west only, coloured by altitude, by slope, by the sky seen (sky-view factor), with
 * contours, in the Swiss manner, or as a composite of sky, slope and shading.
 */
export type ReliefStyle = 'multidirectional' | 'classic' | 'altitude' | 'slope' | 'sky' | 'contours' | 'swiss' | 'composite';
/** Styles whose pixels also need their mean height (colours by altitude, contours). */
export const reliefUsesHeight = (style: ReliefStyle) => style === 'altitude' || style === 'swiss' || style === 'contours';
/** The sky-view factor looks this far (m), along 16 directions, at these distances. */
const SKY_DISTANCES = [1, 2, 3, 4, 5, 6, 8, 10, 12, 15];
/** Rows of neighbours (above and below) a style needs beyond each cell, at a cell size. */
export function reliefReach(style: ReliefStyle, step: number) {
  return style === 'sky' || style === 'composite' ? Math.max(1, Math.ceil(SKY_DISTANCES[SKY_DISTANCES.length - 1] / step)) : 1;
}
/** Per direction: column and row offsets with 1 / distance, each offset once. */
function skyRays(step: number) {
  const rays: number[][] = [];
  for (let k = 0; k < 16; k++) {
    const angle = k * Math.PI / 8, ray: number[] = [], seen = new Set<string>();
    for (const distance of SKY_DISTANCES) {
      const cells = distance / step, dx = Math.round(Math.cos(angle) * cells), dy = Math.round(Math.sin(angle) * cells);
      if ((!dx && !dy) || seen.has(`${dx},${dy}`)) continue;
      seen.add(`${dx},${dy}`); ray.push(dx, dy, 1 / (Math.hypot(dx, dy) * step));
    }
    if (!ray.length) ray.push(Math.round(Math.cos(angle)) || 0, Math.round(Math.sin(angle)) || 0, 1 / (Math.hypot(Math.round(Math.cos(angle)), Math.round(Math.sin(angle))) * step));
    rays.push(ray);
  }
  return rays;
}
/**
 * Colours from low to high ground (a hypsometric tint), at fractions of the height range: deep
 * blue, through cyan, green, yellow and brown, to white.
 */
const TINT: [number, number, number, number][] = [
  [0, 18, 52, 140], [.15, 28, 110, 190], [.3, 70, 170, 200], [.45, 110, 185, 110], [.6, 225, 215, 110], [.75, 205, 140, 70], [.88, 150, 95, 70], [1, 255, 255, 255],
];
/** The tint (0–255 each) at a fraction of the height range. */
export function altitudeTint(fraction: number): [number, number, number] {
  const t = Math.min(1, Math.max(0, fraction));
  let i = 1;
  while (i < TINT.length - 1 && TINT[i][0] < t) i++;
  const [a, ar, ag, ab] = TINT[i - 1], [b, br, bg, bb] = TINT[i], u = (t - a) / (b - a);
  return [ar + (br - ar) * u, ag + (bg - ag) * u, ab + (bb - ab) * u];
}
/**
 * A pixel's colour from its tone (0–255) and, for the coloured styles, its height: altitude tints
 * darkened on slopes away from the light; Swiss ground greyish green low to warm white high, its
 * light side warm and its shadows bluish.
 */
export function reliefColour(tone: number, style: ReliefStyle, height = 0, range: [number, number] = [0, 1]): [number, number, number] {
  if ((style !== 'altitude' && style !== 'swiss') || height !== height) return [tone, tone, tone];
  const fraction = Math.min(1, Math.max(0, (height - range[0]) / Math.max(1e-9, range[1] - range[0])));
  if (style === 'swiss') {
    const t = tone / 255, light = (dark: number, bright: number) => (dark * (1 - t) + bright * t) / 255 * 1.08;
    return [Math.min(255, (150 + 90 * fraction) * light(118, 255)), Math.min(255, (170 + 68 * fraction) * light(132, 250)), Math.min(255, (150 + 75 * fraction) * light(170, 222))];
  }
  const [r, g, b] = altitudeTint(fraction);
  // Flat ground keeps the tint; slopes away from the light darken it.
  const light = .35 + .75 * tone / 255;
  return [Math.min(255, r * light), Math.min(255, g * light), Math.min(255, b * light)];
}
/**
 * Each cell's tone (0–255; NaN without data) in a style, for the rows firstRow … firstRow +
 * rowCount − 1 counted from the north, north first; the grid's rows run from the south. Horn's
 * gradient (a missing neighbour counts as the cell itself). Multidirectional as gdaldem (after
 * Mark 1992): light from 225°, 270°, 315° and 360°, each weighted by sin² of its angle to the
 * slope's aspect. Slope: white flat to dark at 55°. Sky-view factor: the part of the sky seen
 * within 15 m (16 directions), so hollows, shafts and gullies show dark whatever the light.
 * Swiss: the north-west light (40° high) and the multidirectional one together. Composite: sky
 * 45 %, slope 25 % and multidirectional shading 30 %.
 */
export function reliefTones(grid: Pick<Dmr, 'width' | 'height' | 'heights' | 'step'>, firstRow = 0, rowCount = grid.height - firstRow,
  style: ReliefStyle = 'multidirectional', altitude = 45, exaggeration = 1) {
  const { width, height, heights, step } = grid, tones = new Float32Array(width * rowCount).fill(NaN);
  const alt = altitude * Math.PI / 180, sinAlt = Math.sin(alt), cosAlt = Math.cos(alt);
  const sin40 = Math.sin(40 * Math.PI / 180), cos40 = Math.cos(40 * Math.PI / 180);
  const lights = [225, 270, 315, 360].map(az => [Math.sin(az * Math.PI / 180), Math.cos(az * Math.PI / 180)]);
  const [l0x, l0y] = lights[0], [l1x, l1y] = lights[1], [l2x, l2y] = lights[2], [l3x, l3y] = lights[3];
  const scale = exaggeration / (8 * step), degrees = 180 / Math.PI;
  const sky = style === 'sky' || style === 'composite' ? skyRays(step) : undefined;
  for (let r = height - 1 - firstRow; r > height - 1 - firstRow - rowCount && r >= 0; r--) {
    // Neighbouring rows (north up, south down) and columns, kept within the grid.
    const up = (r < height - 1 ? r + 1 : r) * width, row = r * width, down = (r > 0 ? r - 1 : r) * width;
    let out = (height - 1 - r - firstRow) * width;
    for (let c = 0; c < width; c++, out++) {
      const here = heights[row + c];
      if (here !== here) continue;
      const w = c > 0 ? c - 1 : c, e = c < width - 1 ? c + 1 : c;
      let a = heights[up + w], b = heights[up + c], d = heights[up + e];
      let f = heights[row + w], g = heights[row + e];
      let h = heights[down + w], i = heights[down + c], j = heights[down + e];
      if (a !== a) a = here; if (b !== b) b = here; if (d !== d) d = here; if (f !== f) f = here;
      if (g !== g) g = here; if (h !== h) h = here; if (i !== i) i = here; if (j !== j) j = here;
      // East and north gradients (Horn).
      const dzdx = ((d + 2 * g + j) - (a + 2 * f + h)) * scale;
      const dzdy = ((a + 2 * b + d) - (h + 2 * i + j)) * scale;
      const slope2 = dzdx * dzdx + dzdy * dzdy, norm = Math.sqrt(1 + slope2);
      let shade = sinAlt;
      if (style === 'classic') {
        // One light from the north-west.
        if (slope2) shade = Math.max(0, (-dzdx * l2x * cosAlt - dzdy * l2y * cosAlt + sinAlt) / norm);
        tones[out] = 255 * Math.min(1, .18 + .95 * shade);
        continue;
      }
      if (slope2 && style !== 'slope' && style !== 'sky') {
        // Downhill direction, and the light from each azimuth on the surface normal (-dzdx, -dzdy, 1),
        // weighted by how much it falls across the slope.
        const length = Math.sqrt(slope2), ax = -dzdx / length, ay = -dzdy / length;
        const nx = -dzdx * cosAlt, ny = -dzdy * cosAlt;
        let total = 0, along: number, lit: number;
        lit = (nx * l0x + ny * l0y + sinAlt) / norm; along = ax * l0x + ay * l0y; if (lit > 0) total += (1 - along * along) * lit;
        lit = (nx * l1x + ny * l1y + sinAlt) / norm; along = ax * l1x + ay * l1y; if (lit > 0) total += (1 - along * along) * lit;
        lit = (nx * l2x + ny * l2y + sinAlt) / norm; along = ax * l2x + ay * l2y; if (lit > 0) total += (1 - along * along) * lit;
        lit = (nx * l3x + ny * l3y + sinAlt) / norm; along = ax * l3x + ay * l3y; if (lit > 0) total += (1 - along * along) * lit;
        shade = total / 2;
      }
      const flatness = 1 - Math.min(1, Math.atan(Math.sqrt(slope2)) * degrees / 55);
      let open = 1;
      if (sky) {
        // Mean over the directions of 1 − sin(horizon angle), the horizon no lower than level.
        let sum = 0;
        for (const ray of sky) {
          let rise = 0;
          for (let k = 0; k < ray.length; k += 3) {
            const x = c + ray[k], y = r + ray[k + 1];
            if (x < 0 || x >= width || y < 0 || y >= height) continue;
            const there = heights[y * width + x];
            if (there === there) { const s = (there - here) * ray[k + 2]; if (s > rise) rise = s; }
          }
          sum += 1 - rise / Math.sqrt(1 + rise * rise);
        }
        open = Math.min(1, Math.max(0, (sum / sky.length - .5) / .45));
      }
      let tone: number;
      if (style === 'slope') tone = 255 * (1 - .9 * (1 - flatness));
      else if (style === 'sky') tone = 255 * open;
      else if (style === 'composite') tone = 255 * Math.min(1, .45 * open + .25 * flatness + .3 * Math.min(1, shade));
      else if (style === 'swiss') {
        const sun = slope2 ? Math.max(0, (-dzdx * l2x * cos40 - dzdy * l2y * cos40 + sin40) / norm) : sin40;
        tone = 255 * Math.min(1, Math.max(0, .5 * sun / sin40 + .5 * shade / .65 - .35) / 1.15);
      } else tone = 255 * Math.min(1, .18 + .95 * shade);
      tones[out] = tone;
    }
  }
  return tones;
}
/** Contours every 10 m, each 50 m bolder, drawn from heights smoothed over about 5 m. */
const CONTOURS = { interval: 10, index: 5, smooth: 5, thin: [160, 100, 50], bold: [105, 55, 20] };
/** Box blur (radius in pixels) along rows, then columns, of a rows × width array, in place. */
function boxBlur(values: Float32Array, width: number, rows: number, radius: number) {
  const line = new Float32Array(Math.max(width, rows));
  for (let r = 0; r < rows; r++) {
    let sum = 0;
    for (let c = -radius; c <= radius; c++) if (c >= 0 && c < width) sum += values[r * width + c];
    for (let c = 0; c < width; c++) {
      line[c] = sum;
      const add = c + radius + 1, drop = c - radius;
      if (add < width) sum += values[r * width + add];
      if (drop >= 0) sum -= values[r * width + drop];
    }
    values.set(line.subarray(0, width), r * width);
  }
  for (let c = 0; c < width; c++) {
    let sum = 0;
    for (let r = -radius; r <= radius; r++) if (r >= 0 && r < rows) sum += values[r * width + c];
    for (let r = 0; r < rows; r++) {
      line[r] = sum;
      const add = r + radius + 1, drop = r - radius;
      if (add < rows) sum += values[add * width + c];
      if (drop >= 0) sum -= values[drop * width + c];
    }
    for (let r = 0; r < rows; r++) values[r * width + c] = line[r];
  }
}
/**
 * Draws contours over RGBA rows first … first + count − 1 of an image `height` rows high (north
 * first), from the heights of its pixels (heightAt(row from the north, column); NaN without data),
 * smoothed (twice a box of about 5 m, cells without data left out) so they run calmly, and
 * antialiased: each pixel by its distance to the nearest contour (height off the contour over the gradient).
 */
export function drawContours(rgba: Uint8ClampedArray, width: number, height: number, first: number, count: number, pixel: number,
  heightAt: (row: number, column: number) => number) {
  const radius = Math.max(1, Math.round(CONTOURS.smooth / pixel)), margin = 2 * radius + 2;
  const top = Math.max(0, first - margin), bottom = Math.min(height, first + count + margin), rows = bottom - top;
  const sums = new Float32Array(rows * width), weights = new Float32Array(rows * width);
  for (let r = 0; r < rows; r++) for (let c = 0; c < width; c++) {
    const h = heightAt(top + r, c);
    if (h === h) { sums[r * width + c] = h; weights[r * width + c] = 1; }
  }
  for (let pass = 0; pass < 2; pass++) { boxBlur(sums, width, rows, radius); boxBlur(weights, width, rows, radius); }
  const smooth = (r: number, c: number) => {
    const at = Math.min(rows - 1, Math.max(0, r)) * width + Math.min(width - 1, Math.max(0, c));
    return weights[at] > 1e-6 ? sums[at] / weights[at] : NaN;
  };
  for (let row = first; row < first + count; row++) {
    const r = row - top;
    for (let c = 0; c < width; c++) {
      if (heightAt(row, c) !== heightAt(row, c)) continue;
      const h = smooth(r, c);
      if (h !== h) continue;
      let east = smooth(r, c + 1), west = smooth(r, c - 1), north = smooth(r - 1, c), south = smooth(r + 1, c);
      if (east !== east) east = h; if (west !== west) west = h; if (north !== north) north = h; if (south !== south) south = h;
      const gradient = Math.hypot((east - west) / 2, (north - south) / 2);
      if (gradient < 1e-6) continue;
      const k = Math.round(h / CONTOURS.interval), bold = k % CONTOURS.index === 0;
      const distance = Math.abs(h - k * CONTOURS.interval) / gradient;
      const cover = Math.min(1, Math.max(0, (bold ? .95 : .55) + .5 - distance)) * (bold ? .95 : .8);
      if (cover <= 0) continue;
      const colour = bold ? CONTOURS.bold : CONTOURS.thin, at = ((row - first) * width + c) * 4;
      for (let k2 = 0; k2 < 3; k2++) rgba[at + k2] = rgba[at + k2] * (1 - cover) + colour[k2] * cover;
    }
  }
}
/**
 * The relief of a grid as RGBA rows (north first) in a style, a strip of rows at a time (firstRow,
 * rowCount: memory stays low for a large image); cells without data white. Coloured styles need
 * the height range; contours are drawn from the whole grid's heights.
 */
export function hillshade(grid: Pick<Dmr, 'width' | 'height' | 'heights' | 'step'>, altitude = 45, exaggeration = 1, firstRow = 0, rowCount = grid.height - firstRow,
  style: ReliefStyle = 'multidirectional', range?: [number, number]) {
  const { width, height, heights } = grid, rgba = new Uint8ClampedArray(width * rowCount * 4);
  const tones = reliefTones(grid, firstRow, rowCount, style, altitude, exaggeration);
  const coloured = range && (style === 'altitude' || style === 'swiss');
  for (let i = 0; i < width * rowCount; i++) {
    const tone = tones[i];
    if (tone !== tone) { rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = 255; }
    else if (coloured) {
      const row = firstRow + Math.floor(i / width), [r, g, b] = reliefColour(tone, style, heights[(height - 1 - row) * width + i % width], range);
      rgba[i * 4] = r; rgba[i * 4 + 1] = g; rgba[i * 4 + 2] = b;
    } else rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = tone;
    rgba[i * 4 + 3] = 255;
  }
  if (style === 'contours') drawContours(rgba, width, height, firstRow, rowCount, grid.step, (row, column) => heights[(height - 1 - row) * width + column]);
  return rgba;
}

/**
 * The relief image: JPEG at quality 0.98 (about 0.39 bytes a pixel for this shading), its longer
 * side 1 000–15 000 px and its size about 3–70 MB (7.7–179 million pixels), within what the
 * device can draw. Within those limits it has the file's own cells; a larger area averages
 * `factor` × `factor` cells (any factor) into a pixel, a smaller one is drawn `upscale` times larger, smoothly.
 */
export const RELIEF_IMAGE = { quality: .98, bytesPerPixel: .39, maxBytes: 70e6, minBytes: 3e6, maxSide: 15000, minSide: 1000 };
export function imagePlan(area: { width: number; height: number }, device: { maxPixels: number; maxSide: number }) {
  const { bytesPerPixel, maxBytes, minBytes, maxSide, minSide } = RELIEF_IMAGE;
  const cells = area.width * area.height, longer = Math.max(area.width, area.height);
  const mostPixels = Math.min(maxBytes / bytesPerPixel, device.maxPixels), mostSide = Math.min(maxSide, device.maxSide);
  const most = Math.min(Math.sqrt(mostPixels / cells), mostSide / longer);
  const least = Math.max(Math.sqrt(Math.min(minBytes / bytesPerPixel, mostPixels) / cells), minSide / longer);
  const scale = Math.min(most, Math.max(1, least));
  // A larger area: `factor` cells (not necessarily whole) averaged into each pixel, straight to the
  // size; a smaller one: drawn `upscale` times larger.
  return scale < 1 ? { factor: 1 / scale, upscale: 1, mostPixels, mostSide } : { factor: 1, upscale: scale, mostPixels, mostSide };
}
/** The image's size in pixels for a grid drawn `upscale` times larger. */
export function imageSize(grid: { width: number; height: number }, upscale: number) {
  const width = Math.max(1, Math.round(grid.width * upscale));
  return { width, height: Math.max(1, Math.round(grid.height * width / grid.width)) };
}

export function imagePlace(grid: Pick<Dmr, 'origin' | 'step' | 'width' | 'height'>, size: { width: number; height: number } = grid) {
  // Pixels fill the grid's cells exactly, also where rounding left them a little taller than wide.
  const pixel = grid.step * grid.width / size.width, pixelY = grid.step * grid.height / size.height;
  return { west: grid.origin[0] - grid.step / 2, south: grid.origin[1] - grid.step / 2, pixel, ...(Math.abs(pixelY - pixel) > 1e-9 ? { pixelY } : {}), width: size.width, height: size.height };
}

/** The terrain as a surface of the model (in its JTSK). */
export function dmrSurface(dmr: Dmr): Surface {
  const image = dmr.image;
  return {
    ...(image ? { bitmap: { mime: 'image/jpeg' as const, data: image.data, calibration: [image.west + dmr.shift[0], image.south + dmr.shift[1], image.pixel, 0, 0, image.pixelY ?? image.pixel] as Surface['calibration'] } } : {}),
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
  if (image && imageName) lines.push(`  bitmap ${therionName(imageName)} [0 0 ${(image.west + dx).toFixed(2)} ${(image.south + dy).toFixed(2)} ${image.width} ${image.height} ${(image.west + dx + image.width * image.pixel).toFixed(2)} ${(image.south + dy + image.height * (image.pixelY ?? image.pixel)).toFixed(2)}]`);
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
  return ['encoding utf-8', `source ${therionName(`${base}.th`)}`, '', 'cs ijtsk', '', `export model -output ${therionName(`${base}.lox`)}`, ''].join('\n');
}
/** A file name as Therion reads it: in quotes when it has spaces. */
const therionName = (name: string) => /\s/.test(name) ? `"${name}"` : name;

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
