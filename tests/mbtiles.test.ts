import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { indexMbtiles, readTile, tableColumns } from '../src/mbtiles';

const blob = (z: number, x: number, y: number, n: number) => Uint8Array.from({ length: n }, (_, i) => (i * 7 + z * 31 + x * 13 + y * 5) % 256);
const file = (name: string) => new Blob([readFileSync(new URL(`./fixtures/${name}`, import.meta.url))]);

describe('MBTiles', () => {
  it('reads a tiles table, with tiles spread over overflow pages, in XYZ numbering', async () => {
    const mbtiles = file('plain.mbtiles'), index = await indexMbtiles(mbtiles);
    expect(index.metadata).toMatchObject({ name: 'Zonacia test', attribution: '© ŠOP SR' });
    expect([index.minZoom, index.maxZoom, index.format]).toEqual([0, 2, 'png']);
    expect(index.tiles.size).toBe(5);
    // TMS row 1 at zoom 2 is XYZ row 2; row 3 is row 0.
    expect(await readTile(mbtiles, index, 2, 2, 2)).toEqual(blob(2, 2, 1, 2500));
    expect(await readTile(mbtiles, index, 2, 3, 0)).toEqual(blob(2, 3, 3, 12));
    expect(await readTile(mbtiles, index, 0, 0, 0)).toEqual(blob(0, 0, 0, 3000));
    expect(await readTile(mbtiles, index, 1, 1, 0)).toEqual(blob(1, 1, 1, 900));
    expect(await readTile(mbtiles, index, 5, 0, 0)).toBeUndefined();
  });

  it('reads deduplicated maps (map + images), long overflow chains on small pages', async () => {
    const mbtiles = file('dedup.mbtiles'), index = await indexMbtiles(mbtiles);
    expect(index.tiles.size).toBe(40);
    expect(index.format).toBe('jpg');
    for (const i of [0, 7, 13, 39]) {
      const k = i % 10;
      expect(await readTile(mbtiles, index, 3, i % 8, 7 - Math.floor(i / 8))).toEqual(blob(3, k, 0, 5000 + k * 7));
    }
  });

  it('tells columns and the rowid alias of a table', () => {
    expect(tableColumns('CREATE TABLE images (tile_id INTEGER PRIMARY KEY, tile_data BLOB)')).toEqual({ names: ['tile_id', 'tile_data'], rowidAlias: 0 });
    expect(tableColumns('CREATE TABLE "map" ("zoom_level" integer, tile_column integer, tile_row integer, tile_id text, PRIMARY KEY (zoom_level, tile_column, tile_row))').names)
      .toEqual(['zoom_level', 'tile_column', 'tile_row', 'tile_id']);
  });

  it('refuses a file that is not SQLite', async () => {
    await expect(indexMbtiles(new Blob([new Uint8Array(200)]))).rejects.toThrow(/Not an MBTiles/);
  });
});
