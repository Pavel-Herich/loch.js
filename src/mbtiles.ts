/**
 * MBTiles maps (an SQLite file of Web Mercator tiles) read straight from the file, without an
 * SQLite engine and without loading the file into memory: one pass over the file indexes every
 * tile (where its bytes lie, also across overflow pages), and a tile is then read with a few
 * slices. Both layouts are read: a `tiles` table, and `map` + `images` (deduplicated tiles).
 * Rows are in TMS order (row 0 at the south); the index uses XYZ (row 0 at the north).
 */

/** Where a value lies in the file: the payload starts at `start` with `local` bytes on its page, the rest on overflow pages. */
type Payload = { start: number; local: number; overflow: number };
/** A tile's bytes: `offset`/`length` within its row's payload. */
export type TileRef = Payload & { offset: number; length: number };
export type MbtilesIndex = {
  pageSize: number; usable: number;
  /** First four bytes of every page: the next page of an overflow chain. */
  next: Uint32Array;
  tiles: Map<string, TileRef>;
  metadata: Record<string, string>;
  minZoom: number; maxZoom: number; format: string;
};

type Value = null | number | { offset: number; length: number; text: boolean; inline?: string };
/** A table row: where its payload lies, and its column values as read from its own page. */
type Cell = { rowid: number; payload: Payload; size: number; values: Value[] };

function varint(bytes: Uint8Array, at: number): [value: number, size: number] {
  let value = 0;
  for (let i = 0; i < 8; i++) {
    const byte = bytes[at + i];
    value = value * 128 + (byte & 0x7f);
    if (!(byte & 0x80)) return [value, i + 1];
  }
  return [value * 256 + bytes[at + 8], 9];
}

/**
 * Reads the parts of the file it needs. `read(offset, length)` gives bytes of the file.
 */
class Reader {
  constructor(private file: Blob) {}
  async read(offset: number, length: number) { return new Uint8Array(await this.file.slice(offset, offset + length).arrayBuffer()); }
}

/** Bytes of a payload range, following its overflow chain. */
async function payloadBytes(reader: Reader, index: Pick<MbtilesIndex, 'pageSize' | 'usable' | 'next'>, payload: Payload, offset: number, length: number) {
  const out = new Uint8Array(length);
  let filled = 0;
  // On the cell's own page.
  if (offset < payload.local) {
    const take = Math.min(length, payload.local - offset);
    out.set(await reader.read(payload.start + offset, take), 0);
    filled = take;
  }
  const per = index.usable - 4;
  let page = payload.overflow, position = payload.local;
  // Contiguous overflow pages are read in one slice.
  const runs: [fileOffset: number, length: number, into: number][] = [];
  while (filled < length && page) {
    const pageEnd = position + per;
    const from = offset + filled;
    if (from < pageEnd) {
      const within = from - position, take = Math.min(length - filled, per - within);
      const fileOffset = (page - 1) * index.pageSize + 4 + within, last = runs.at(-1);
      if (last && last[0] + last[1] === fileOffset) last[1] += take; else runs.push([fileOffset, take, filled]);
      filled += take;
    }
    position = pageEnd; page = index.next[page - 1];
  }
  for (const [fileOffset, size, into] of runs) out.set(await reader.read(fileOffset, size), into);
  if (filled < length) throw new Error('The MBTiles file is damaged (a tile runs past its pages).');
  return out;
}

/** Column values of a record whose header lies on the cell's own page. */
function record(page: Uint8Array, at: number, local: number): Value[] {
  const [headerSize, headerBytes] = varint(page, at);
  let h = at + headerBytes, body = headerSize;
  const values: Value[] = [];
  while (h < at + headerSize) {
    const [type, size] = varint(page, h); h += size;
    if (type === 0) values.push(null);
    else if (type <= 6) {
      const width = [0, 1, 2, 3, 4, 6, 8][type];
      let value = 0;
      // Integers in the header part are read where they lie (they are short and on the page in practice).
      if (body + width <= local) {
        for (let i = 0; i < width; i++) value = value * 256 + page[at + body + i];
        if (page[at + body] & 0x80) value -= 2 ** (8 * width);
      } else value = NaN;
      values.push(value); body += width;
    } else if (type === 7) { values.push(NaN); body += 8; }
    else if (type === 8 || type === 9) values.push(type - 8);
    else if (type >= 12) {
      const length = type % 2 ? (type - 13) / 2 : (type - 12) / 2;
      const value: Value = { offset: body, length, text: type % 2 === 1 };
      // Short text on the page is read at once (names, tile ids, metadata).
      if (value.text && body + length <= local && length <= 4096) value.inline = new TextDecoder().decode(page.subarray(at + body, at + body + length));
      values.push(value); body += length;
    } else values.push(null);
  }
  return values;
}

/** Column names of a CREATE TABLE statement (and which one is the rowid alias). */
export function tableColumns(sql: string) {
  const inner = sql.slice(sql.indexOf('(') + 1, sql.lastIndexOf(')'));
  const parts: string[] = [];
  let depth = 0, current = '';
  for (const char of inner) {
    if (char === '(') depth++;
    if (char === ')') depth--;
    if (char === ',' && !depth) { parts.push(current); current = ''; } else current += char;
  }
  parts.push(current);
  const columns = parts.map(part => part.trim()).filter(part => part && !/^(primary|unique|constraint|check|foreign)\b/i.test(part));
  return {
    names: columns.map(part => part.split(/\s+/)[0].replace(/^["'`[]|["'`\]]$/g, '').toLowerCase()),
    rowidAlias: columns.findIndex(part => /\binteger\s+primary\s+key\b/i.test(part)),
  };
}

/**
 * Indexes an MBTiles file: one pass reads every page (in large chunks), keeping the next-page
 * pointers and the cells of table pages; the tables are then walked from their roots.
 */
export async function indexMbtiles(file: Blob, progress?: (done: number, total: number) => void): Promise<MbtilesIndex> {
  const reader = new Reader(file);
  const header = await reader.read(0, 100);
  if (new TextDecoder().decode(header.subarray(0, 15)) !== 'SQLite format 3') throw new Error('Not an MBTiles (SQLite) file.');
  const view = new DataView(header.buffer);
  const pageSize = view.getUint16(16) === 1 ? 65536 : view.getUint16(16);
  const usable = pageSize - header[20];
  const pageCount = Math.ceil(file.size / pageSize);
  const next = new Uint32Array(pageCount);
  // Table pages: interior pages (children) and the cells of leaf pages.
  const interior = new Map<number, number[]>();
  const leaves = new Map<number, Cell[]>();
  const maxLocal = usable - 35, minLocal = Math.floor((usable - 12) * 32 / 255) - 23;
  const CHUNK = Math.max(pageSize, Math.floor((16 << 20) / pageSize) * pageSize);
  for (let start = 0; start < file.size; start += CHUNK) {
    const chunk = await reader.read(start, CHUNK);
    for (let p = 0; p + 4 <= chunk.length; p += pageSize) {
      const number = (start + p) / pageSize + 1, at = number === 1 ? 100 : 0;
      next[number - 1] = ((chunk[p] << 24) >>> 0) + (chunk[p + 1] << 16) + (chunk[p + 2] << 8) + chunk[p + 3];
      const type = chunk[p + at];
      if (p + pageSize > chunk.length && start + p + pageSize <= file.size) continue;
      if (type !== 5 && type !== 13) continue;
      const cells = (chunk[p + at + 3] << 8) | chunk[p + at + 4];
      if (type === 5) {
        // Plausibility: cell pointers inside the page; otherwise it is an overflow or free page.
        const children: number[] = [];
        let ok = cells < pageSize / 4;
        for (let i = 0; ok && i < cells; i++) {
          const pointer = (chunk[p + at + 12 + i * 2] << 8) | chunk[p + at + 13 + i * 2];
          if (pointer < at + 12 || pointer >= pageSize) { ok = false; break; }
          children.push(((chunk[p + pointer] << 24) >>> 0) + (chunk[p + pointer + 1] << 16) + (chunk[p + pointer + 2] << 8) + chunk[p + pointer + 3]);
        }
        if (!ok) continue;
        children.push(((chunk[p + at + 8] << 24) >>> 0) + (chunk[p + at + 9] << 16) + (chunk[p + at + 10] << 8) + chunk[p + at + 11]);
        interior.set(number, children);
      } else {
        const list: Cell[] = [];
        let ok = cells < pageSize / 2;
        for (let i = 0; ok && i < cells; i++) {
          const pointer = (chunk[p + at + 8 + i * 2] << 8) | chunk[p + at + 9 + i * 2];
          if (pointer < at + 8 || pointer >= pageSize) { ok = false; break; }
          let q = p + pointer;
          const [size, a] = varint(chunk, q); q += a;
          const [rowid, b] = varint(chunk, q); q += b;
          let local = size;
          if (size > maxLocal) { const k = minLocal + (size - minLocal) % (usable - 4); local = k <= maxLocal ? k : minLocal; }
          const overflow = local < size ? ((chunk[q + local] << 24) >>> 0) + (chunk[q + local + 1] << 16) + (chunk[q + local + 2] << 8) + chunk[q + local + 3] : 0;
          if (q + local > p + pageSize) { ok = false; break; }
          let row: Value[];
          try { row = record(chunk, q, local); } catch { ok = false; break; }
          list.push({ rowid, size, payload: { start: start + q, local, overflow }, values: row });
        }
        if (!ok) continue;
        leaves.set(number, list);
      }
    }
    progress?.(Math.min(file.size, start + CHUNK), file.size);
  }
  const rowsOf = (root: number) => {
    const out: Cell[] = [], stack = [root], seen = new Set<number>();
    while (stack.length) {
      const page = stack.pop()!;
      if (seen.has(page)) continue;
      seen.add(page);
      const children = interior.get(page);
      if (children) stack.push(...children.reverse());
      else out.push(...(leaves.get(page) ?? []));
    }
    return out;
  };
  const text = async (cell: Cell, value: Value) => {
    if (!value || typeof value === 'number') return value === null ? '' : String(value);
    if (value.inline !== undefined) return value.inline;
    return new TextDecoder().decode(await payloadBytes(reader, { pageSize, usable, next }, cell.payload, value.offset, value.length));
  };
  // The schema (sqlite_master, rooted at page 1).
  const schema = new Map<string, { type: string; root: number; sql: string }>();
  for (const cell of rowsOf(1)) {
    const [type, name, , root, sql] = cell.values;
    schema.set((await text(cell, name)).toLowerCase(), { type: await text(cell, type), root: Number(root), sql: await text(cell, sql) });
  }
  const tableRows = (name: string) => {
    const table = schema.get(name);
    if (!table || table.type !== 'table') return undefined;
    const { names, rowidAlias } = tableColumns(table.sql);
    return rowsOf(table.root).map(cell => {
      const row = [...cell.values];
      if (rowidAlias >= 0 && row[rowidAlias] === null) row[rowidAlias] = cell.rowid;
      return { cell, get: (column: string) => row[names.indexOf(column)] };
    });
  };
  const metadata: Record<string, string> = {};
  for (const row of tableRows('metadata') ?? []) metadata[(await text(row.cell, row.get('name') ?? null)).toLowerCase()] = await text(row.cell, row.get('value') ?? null);
  const tiles = new Map<string, TileRef>();
  const add = (z: number, x: number, tmsRow: number, cell: Cell, data: Value) => {
    if (!data || typeof data === 'number' || !Number.isInteger(z)) return;
    tiles.set(`${z}/${x}/${2 ** z - 1 - tmsRow}`, { ...cell.payload, offset: data.offset, length: data.length });
  };
  const direct = tableRows('tiles');
  if (direct) for (const row of direct) add(Number(row.get('zoom_level')), Number(row.get('tile_column')), Number(row.get('tile_row')), row.cell, row.get('tile_data') ?? null);
  else {
    const images = tableRows('images'), map = tableRows('map');
    if (!images || !map) throw new Error('No tiles in the MBTiles file (neither a tiles table nor map and images).');
    const byId = new Map<string, { cell: Cell; data: Value }>();
    for (const row of images) byId.set(await text(row.cell, row.get('tile_id') ?? null), { cell: row.cell, data: row.get('tile_data') ?? null });
    for (const row of map) {
      const image = byId.get(await text(row.cell, row.get('tile_id') ?? null));
      if (image) add(Number(row.get('zoom_level')), Number(row.get('tile_column')), Number(row.get('tile_row')), image.cell, image.data);
    }
  }
  if (!tiles.size) throw new Error('The MBTiles file has no tiles.');
  const zooms = [...tiles.keys()].map(key => Number(key.split('/')[0]));
  return {
    pageSize, usable, next, tiles, metadata,
    minZoom: Number(metadata.minzoom ?? Math.min(...zooms)), maxZoom: Number(metadata.maxzoom ?? Math.max(...zooms)),
    format: (metadata.format ?? 'png').toLowerCase(),
  };
}

/** One tile's image bytes (XYZ numbering), or undefined where the map has none. */
export async function readTile(file: Blob, index: Pick<MbtilesIndex, 'pageSize' | 'usable' | 'next' | 'tiles'>, zoom: number, x: number, y: number) {
  const ref = index.tiles.get(`${zoom}/${x}/${y}`);
  if (!ref) return undefined;
  return payloadBytes(new Reader(file), index, ref, ref.offset, ref.length);
}
