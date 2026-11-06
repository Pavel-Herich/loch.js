/**
 * A small GeoTIFF reader for elevation grids (DMR 5.0 from ZBGIS and the like): classic TIFF
 * and BigTIFF, strips or tiles, uncompressed, LZW or Deflate, with the horizontal or floating
 * point predictor, one band of integers or floats. The file is read piece by piece, so a large
 * grid never has to fit in memory at once.
 */
export type GeoTiff = {
  width: number; height: number;
  /** Size of one strip or tile (strips are as wide as the image). */
  blockWidth: number; blockHeight: number; tiled: boolean;
  offsets: number[]; counts: number[];
  compression: number; predictor: number; sampleFormat: number; bitsPerSample: number; littleEndian: boolean;
  /** World position of the outer corner of the top-left pixel, and the pixel size (east, south). */
  left: number; top: number; pixelWidth: number; pixelHeight: number;
  /** Pixel values stand for the pixel centres (area) or for the corners (point). */
  pixelIsPoint: boolean;
  epsg?: number; nodata?: number;
};

const TYPE_SIZES: Record<number, number> = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8, 17: 8, 18: 8 };

async function bytesAt(file: Blob, start: number, length: number) {
  return new Uint8Array(await file.slice(start, start + length).arrayBuffer());
}

/** Reads the first image's tags and georeference. */
export async function readGeoTiff(file: Blob): Promise<GeoTiff> {
  const head = await bytesAt(file, 0, 16), view = new DataView(head.buffer);
  const order = String.fromCharCode(head[0], head[1]);
  if (order !== 'II' && order !== 'MM') throw new Error('This is not a TIFF file.');
  const little = order === 'II', magic = view.getUint16(2, little), big = magic === 43;
  if (magic !== 42 && !big) throw new Error('This is not a TIFF file.');
  const first = big ? Number(view.getBigUint64(8, little)) : view.getUint32(4, little);
  const countSize = big ? 8 : 2, entrySize = big ? 20 : 12, inline = big ? 8 : 4;
  const countBytes = new DataView((await bytesAt(file, first, countSize)).buffer);
  const entries = big ? Number(countBytes.getBigUint64(0, little)) : countBytes.getUint16(0, little);
  const table = await bytesAt(file, first + countSize, entries * entrySize), tv = new DataView(table.buffer);
  const tags = new Map<number, number[] | string>();
  for (let i = 0; i < entries; i++) {
    const at = i * entrySize, tag = tv.getUint16(at, little), type = tv.getUint16(at + 2, little);
    const count = big ? Number(tv.getBigUint64(at + 4, little)) : tv.getUint32(at + 4, little);
    const size = (TYPE_SIZES[type] ?? 1) * count, valueAt = at + (big ? 12 : 8);
    let data: DataView;
    if (size <= inline) data = new DataView(table.buffer, valueAt, inline);
    else {
      const offset = big ? Number(tv.getBigUint64(valueAt, little)) : tv.getUint32(valueAt, little);
      data = new DataView((await bytesAt(file, offset, size)).buffer);
    }
    if (type === 2) { tags.set(tag, new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, Math.max(0, count - 1)))); continue; }
    const values: number[] = [];
    for (let j = 0; j < count; j++) {
      const o = j * (TYPE_SIZES[type] ?? 1);
      values.push(type === 3 ? data.getUint16(o, little) : type === 4 || type === 13 ? data.getUint32(o, little)
        : type === 8 ? data.getInt16(o, little) : type === 9 ? data.getInt32(o, little)
        : type === 11 ? data.getFloat32(o, little) : type === 12 ? data.getFloat64(o, little)
        : type === 16 ? Number(data.getBigUint64(o, little)) : type === 17 ? Number(data.getBigInt64(o, little))
        : type === 5 ? data.getUint32(o, little) / data.getUint32(o + 4, little) : type === 10 ? data.getInt32(o, little) / data.getInt32(o + 4, little)
        : type === 6 ? data.getInt8(o) : data.getUint8(o));
    }
    tags.set(tag, values);
  }
  const num = (tag: number, fallback?: number) => {
    const value = tags.get(tag);
    if (Array.isArray(value) && value.length) return value[0];
    if (fallback === undefined) throw new Error(`The TIFF file has no tag ${tag}.`);
    return fallback;
  };
  const list = (tag: number) => { const value = tags.get(tag); return Array.isArray(value) ? value : undefined; };
  if (num(277, 1) !== 1) throw new Error('Only single-band elevation grids can be read (this TIFF has several bands).');
  const width = num(256), height = num(257), tiled = tags.has(322);
  const blockWidth = tiled ? num(322) : width, blockHeight = tiled ? num(323) : Math.min(num(278, height), height);
  const offsets = list(tiled ? 324 : 273), counts = list(tiled ? 325 : 279);
  if (!offsets || !counts) throw new Error('The TIFF file has no image data.');
  const compression = num(259, 1), predictor = num(317, 1);
  if (![1, 5, 8, 32946].includes(compression)) throw new Error(`Unsupported TIFF compression (${compression}); save it uncompressed, LZW or Deflate.`);
  const scale = list(33550), tie = list(33922), transform = list(34264);
  let left: number, top: number, pixelWidth: number, pixelHeight: number;
  if (scale && tie && tie.length >= 6) {
    pixelWidth = scale[0]; pixelHeight = scale[1];
    left = tie[3] - tie[0] * pixelWidth; top = tie[4] + tie[1] * pixelHeight;
    // Exported grids carry float noise (-359128.9999 for -359129): kept to the millimetre.
    pixelWidth = Math.round(pixelWidth * 1e9) / 1e9; pixelHeight = Math.round(pixelHeight * 1e9) / 1e9;
    left = Math.round(left * 1e3) / 1e3; top = Math.round(top * 1e3) / 1e3;
  } else if (transform && transform.length >= 16 && transform[1] === 0 && transform[4] === 0) {
    pixelWidth = transform[0]; pixelHeight = -transform[5]; left = transform[3]; top = transform[7];
  } else throw new Error('The TIFF file has no georeference (it is not a GeoTIFF).');
  const keys = geoKeys(list(34735));
  const nodataText = tags.get(42113);
  const nodata = typeof nodataText === 'string' && nodataText.trim() ? Number(nodataText) : undefined;
  return {
    width, height, blockWidth, blockHeight, tiled, offsets, counts, compression, predictor,
    sampleFormat: num(339, 1), bitsPerSample: num(258, 8), littleEndian: little,
    left, top, pixelWidth, pixelHeight, pixelIsPoint: keys.get(1025) === 2,
    epsg: keys.get(3072), nodata: Number.isFinite(nodata) ? nodata : undefined,
  };
}

function geoKeys(directory?: number[]) {
  const keys = new Map<number, number>();
  if (!directory) return keys;
  for (let i = 4; i + 3 < directory.length && i < 4 + directory[3] * 4; i += 4) {
    if (directory[i + 1] === 0) keys.set(directory[i], directory[i + 3]);
  }
  return keys;
}

/** TIFF LZW (most significant bit first, code width grows one code early). */
export function lzwDecode(input: Uint8Array, size: number) {
  const out = new Uint8Array(size), start = new Int32Array(4096), length = new Int32Array(4096);
  let o = 0, bit = 0, width = 9, next = 258, previous = -1, previousStart = 0, previousLength = 0;
  const total = input.length * 8;
  while (bit + width <= total) {
    const byte = bit >>> 3;
    const word = (input[byte] << 16) | ((input[byte + 1] ?? 0) << 8) | (input[byte + 2] ?? 0);
    const code = (word >>> (24 - (bit & 7) - width)) & ((1 << width) - 1);
    bit += width;
    if (code === 257) break;
    if (code === 256) { width = 9; next = 258; previous = -1; continue; }
    const here = o;
    let count: number;
    if (code < 256) { if (o < size) out[o] = code; count = 1; }
    else if (code < next) { out.copyWithin(o, start[code], start[code] + length[code]); count = length[code]; }
    else if (code === next && previous >= 0) {
      out.copyWithin(o, previousStart, previousStart + previousLength);
      if (o + previousLength < size) out[o + previousLength] = out[previousStart];
      count = previousLength + 1;
    } else throw new Error('Damaged LZW data in the TIFF file.');
    o += count;
    if (previous >= 0 && next < 4096) { start[next] = previousStart; length[next] = previousLength + 1; next++; }
    previous = code; previousStart = here; previousLength = count;
    if (next >= (1 << width) - 1 && width < 12) width++;
    if (o >= size) break;
  }
  return out;
}

async function inflate(data: Uint8Array) {
  // TIFF Deflate is zlib-wrapped, which the browser's "deflate" format reads.
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** One strip or tile as numbers (row by row, blockWidth wide); NaN where there is no data. */
export async function readBlock(file: Blob, tiff: GeoTiff, index: number): Promise<Float64Array> {
  const bytesPer = tiff.bitsPerSample / 8, rows = tiff.tiled ? tiff.blockHeight : Math.min(tiff.blockHeight, tiff.height - index * tiff.blockHeight);
  const size = tiff.blockWidth * rows * bytesPer;
  const raw = await bytesAt(file, tiff.offsets[index], tiff.counts[index]);
  let bytes = tiff.compression === 5 ? lzwDecode(raw, size) : tiff.compression === 1 ? raw : await inflate(raw);
  if (bytes.length < size) { const padded = new Uint8Array(size); padded.set(bytes); bytes = padded; }
  let little = tiff.littleEndian;
  if (tiff.predictor === 3) {
    // Floating point predictor: bytes of each row were split by significance (most significant first) and differenced.
    const row = tiff.blockWidth * bytesPer, shuffled = new Uint8Array(size);
    for (let r = 0; r < rows; r++) {
      const base = r * row;
      for (let i = 1; i < row; i++) bytes[base + i] = (bytes[base + i] + bytes[base + i - 1]) & 255;
      for (let x = 0; x < tiff.blockWidth; x++) for (let b = 0; b < bytesPer; b++) shuffled[base + x * bytesPer + b] = bytes[base + b * tiff.blockWidth + x];
    }
    bytes = shuffled; little = false;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, size), count = tiff.blockWidth * rows;
  const values = new Float64Array(count), format = tiff.sampleFormat, bits = tiff.bitsPerSample;
  for (let i = 0; i < count; i++) {
    const o = i * bytesPer;
    values[i] = format === 3 ? (bits === 32 ? view.getFloat32(o, little) : view.getFloat64(o, little))
      : format === 2 ? (bits === 16 ? view.getInt16(o, little) : bits === 32 ? view.getInt32(o, little) : view.getInt8(o))
      : (bits === 16 ? view.getUint16(o, little) : bits === 32 ? view.getUint32(o, little) : view.getUint8(o));
  }
  if (tiff.predictor === 2 && format !== 3) {
    // Differences wrap around within the sample's bits.
    const range = 2 ** bits, low = format === 2 ? -range / 2 : 0;
    const wrap = (v: number) => ((((v - low) % range) + range) % range) + low;
    for (let r = 0; r < rows; r++) for (let x = 1; x < tiff.blockWidth; x++) {
      const at = r * tiff.blockWidth + x;
      values[at] = wrap(values[at] + values[at - 1]);
    }
  }
  for (let i = 0; i < count; i++) {
    const v = values[i];
    if (!Number.isFinite(v) || v === tiff.nodata || (tiff.nodata !== undefined && Math.abs(v - tiff.nodata) <= Math.abs(tiff.nodata) * 1e-6) || Math.abs(v) > 1e30) values[i] = NaN;
  }
  return values;
}
