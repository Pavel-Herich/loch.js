/**
 * Map underlays kept on the device: once a service's image for a surface extent has been
 * downloaded, it is stored and used again without a network (in the field).
 */
const DB = 'loch.js-underlays', STORE = 'images';
export type StoredUnderlay = { blob: Blob; width: number; height: number; saved: string };

function open() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const factory = globalThis.indexedDB;
    if (!factory) { reject(new Error('IndexedDB unavailable.')); return; }
    const request = factory.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function run<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>) {
  return open().then(db => new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(STORE, mode), request = action(transaction.objectStore(STORE));
    transaction.oncomplete = () => { db.close(); resolve(request.result); };
    transaction.onerror = transaction.onabort = () => { db.close(); reject(transaction.error ?? new Error('Map storage failed.')); };
  }));
}

/** One key per service, extent (whole metres) and size. */
export const underlayKey = (service: string, extent: [number, number, number, number], size: number) => `${service}|${extent.map(Math.round).join(',')}|${size}`;

export const loadStoredUnderlay = (key: string) => run<StoredUnderlay | undefined>('readonly', store => store.get(key));
export async function storeUnderlay(key: string, value: StoredUnderlay) {
  await globalThis.navigator?.storage?.persist?.().catch(() => false);
  await run('readwrite', store => store.put(value, key));
}
export const forgetStoredUnderlays = () => run('readwrite', store => store.clear());
/** Keys of the saved copies that start with a prefix. */
export const storedKeys = (prefix: string) => run<IDBValidKey[]>('readonly', store => store.getAllKeys(IDBKeyRange.bound(prefix, `${prefix}\uffff`))).then(keys => new Set(keys.map(String)));
/** One saved tile (its image as the service sent it). */
export const loadStoredTile = (key: string) => run<{ blob: Blob } | undefined>('readonly', store => store.get(key));
let persistAsked = false;
export async function storeTile(key: string, blob: Blob) {
  // Ask once that the browser keeps the saved maps (not cleared when space runs low).
  if (!persistAsked) { persistAsked = true; await globalThis.navigator?.storage?.persist?.().catch(() => false); }
  await run('readwrite', store => store.put({ blob, saved: new Date().toISOString() }, key));
}
/** Removes single saved copies. */
export const forgetStored = (keys: string[]) => keys.length ? run('readwrite', store => { let last!: IDBRequest; for (const key of keys) last = store.delete(key); return last; }) : Promise.resolve();
/** Removes the copies of one service (keys start with its name). */
export const forgetStoredUnderlaysOf = (service: string) => run('readwrite', store => store.delete(IDBKeyRange.bound(`${service}|`, `${service}|\uffff`)));
