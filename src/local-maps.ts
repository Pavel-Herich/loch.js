import { indexMbtiles, readTile, type MbtilesIndex } from './mbtiles';
import type { TileSource, UnderlayService } from './underlay';

/**
 * Map files added from the device (MBTiles): copied into the app's private storage so they are
 * there at every start, indexed once (the index kept in IndexedDB), and shown as map layers.
 */
export type LocalMap = { id: string; file: string; title: string; attribution: string; minZoom: number; maxZoom: number; format: string; bytes: number; tileSize: number };

const LIST = 'loch.js-local-maps';
export function localMaps(): LocalMap[] {
  try { return JSON.parse(localStorage.getItem(LIST) ?? '[]') as LocalMap[]; } catch { return []; }
}
function saveList(maps: LocalMap[]) { try { localStorage.setItem(LIST, JSON.stringify(maps)); } catch { /* Kept for this session only. */ } }

/** A local map as a layer: tiles from the file, clear where it has none, over the other maps. */
export function localService(map: LocalMap): UnderlayService {
  return {
    id: map.id, kind: 'xyz', title: map.title, url: `mbtiles://${map.id}/{z}/{x}/{y}`, tileSize: map.tileSize,
    minZoom: map.minZoom, maxZoom: map.maxZoom, onDemand: true, local: true, transparent: map.format !== 'jpg' && map.format !== 'jpeg',
    attribution: map.attribution, credits: [{ text: map.attribution || map.title }], bytesPerPixel: 0, opacity: 1,
  };
}

const DB = 'loch.js-local-maps', STORE = 'indexes';
function database() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function run<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>) {
  const db = await database();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(STORE, mode), request = action(transaction.objectStore(STORE));
    transaction.oncomplete = () => { db.close(); resolve(request.result); };
    transaction.onerror = transaction.onabort = () => { db.close(); reject(transaction.error ?? new Error('Map storage failed.')); };
  });
}

/** The app's private folder for map files, when the browser has one. */
async function folder() {
  const root = await navigator.storage?.getDirectory?.();
  return root?.getDirectoryHandle('maps', { create: true });
}
/** Files picked in this session when the browser cannot keep them (used until the app closes). */
const sessionFiles = new Map<string, File>();
async function mapFile(map: LocalMap): Promise<Blob> {
  const kept = sessionFiles.get(map.id);
  if (kept) return kept;
  const directory = await folder();
  if (!directory) throw new Error('The map file is not on this device any more; add it again.');
  return (await directory.getFileHandle(map.file)).getFile();
}

function copyToDevice(file: File, name: string, progress: (done: number, total: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const worker = new Worker(new URL('./mbtiles-copy.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<{ type: string; done?: number; total?: number; message?: string }>) => {
      if (event.data.type === 'progress') progress(event.data.done!, event.data.total!);
      else { worker.terminate(); if (event.data.type === 'done') resolve(); else reject(new Error(event.data.message)); }
    };
    worker.onerror = event => { worker.terminate(); reject(new Error(event.message || 'Copying the map failed.')); };
    worker.postMessage({ file, name });
  });
}

/**
 * Adds a map file: copies it to the device (or keeps it for this session when the browser has
 * no private files), indexes it and remembers it. Raster tiles only (PNG, JPEG, WebP).
 */
export async function addLocalMap(file: File, progress: (stage: 'copy' | 'index', done: number, total: number) => void) {
  const id = `mbtiles-${Date.now().toString(36)}`, name = `${id}.mbtiles`;
  let stored: Blob = file;
  let kept = false;
  try {
    if (await folder()) {
      await copyToDevice(file, name, (done, total) => progress('copy', done, total));
      stored = await (await (await folder())!.getFileHandle(name)).getFile();
      kept = true;
    }
  } catch (error) {
    // Not enough room, or no private files: the picked file serves for this session.
    console.warn('Map file not kept on the device:', error);
    await (await folder().catch(() => undefined))?.removeEntry(name).catch(() => undefined);
  }
  if (!kept) sessionFiles.set(id, file);
  let index: MbtilesIndex;
  try { index = await indexMbtiles(stored, (done, total) => progress('index', done, total)); }
  catch (error) { await removeLocalMap(id).catch(() => undefined); throw error; }
  if (['pbf', 'mvt'].includes(index.format)) {
    await removeLocalMap(id).catch(() => undefined);
    throw new Error('This MBTiles file holds vector tiles; only raster maps (PNG, JPEG, WebP) can be shown.');
  }
  await run('readwrite', store => store.put(index, id));
  indexes.set(id, index);
  const strip = (text: string) => text.replace(/<[^>]*>/g, '').replace(/&copy;/g, '©').replace(/&amp;/g, '&').trim();
  const map: LocalMap = {
    id, file: name, title: strip(index.metadata.name || file.name.replace(/\.mbtiles$/i, '')), attribution: strip(index.metadata.attribution ?? ''),
    minZoom: index.minZoom, maxZoom: index.maxZoom, format: index.format, bytes: file.size,
    tileSize: Number(index.metadata.tilesize) || (/@2x|retina/i.test(index.metadata.scale ?? '') ? 512 : 256),
  };
  saveList([...localMaps().filter(item => item.id !== id), map]);
  return { map, kept };
}

export async function removeLocalMap(id: string) {
  const map = localMaps().find(item => item.id === id);
  saveList(localMaps().filter(item => item.id !== id));
  sessionFiles.delete(id); indexes.delete(id);
  await run('readwrite', store => store.delete(id)).catch(() => undefined);
  await (await folder().catch(() => undefined))?.removeEntry(map?.file ?? `${id}.mbtiles`).catch(() => undefined);
}

const indexes = new Map<string, MbtilesIndex>();
/** Tiles of a local map, read from its file through its index. */
export async function localTiles(map: LocalMap): Promise<TileSource> {
  let index = indexes.get(map.id);
  if (!index) {
    index = await run<MbtilesIndex | undefined>('readonly', store => store.get(map.id));
    if (!index) throw new Error('The map file is not indexed any more; add it again.');
    indexes.set(map.id, index);
  }
  const file = await mapFile(map), type = `image/${map.format === 'jpg' ? 'jpeg' : map.format}`;
  const found = index;
  return async (_url, zoom, x, y) => {
    const bytes = await readTile(file, found, zoom, x, y);
    if (!bytes) throw new Error('No tile here.');
    return createImageBitmap(new Blob([bytes], { type }));
  };
}
