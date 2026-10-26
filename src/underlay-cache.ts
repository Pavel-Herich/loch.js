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
