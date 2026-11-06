import type { Dmr } from './dmr';

/** Terrain models made from GeoTIFFs, kept on the device per survey model (file name and size). */
const DB = 'loch.js-terrain', STORE = 'dmr';
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
    transaction.onerror = transaction.onabort = () => { db.close(); reject(transaction.error ?? new Error('Terrain storage failed.')); };
  });
}
export const saveDmr = (model: string, dmr: Dmr) => run('readwrite', store => store.put(dmr, model)).then(() => undefined);
export const loadDmr = (model: string) => run<Dmr | undefined>('readonly', store => store.get(model));
export const forgetDmr = (model: string) => run('readwrite', store => store.delete(model)).then(() => undefined);
