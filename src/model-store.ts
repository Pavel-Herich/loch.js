/** The last opened model file, kept on the device so the app reopens it without a signal. */
const DB = 'loch.js-model', STORE = 'model', KEY = 'last';

function open(factory: IDBFactory | undefined = globalThis.indexedDB) {
  return new Promise<IDBDatabase>((resolve, reject) => {
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
    transaction.onerror = transaction.onabort = () => { db.close(); reject(transaction.error ?? new Error('Model storage failed.')); };
  }));
}

export async function saveLastModel(file: File) {
  // The same file again (name, size, date) is not copied a second time.
  const kept = await run<{ name: string; size?: number; modified?: number } | undefined>('readonly', store => store.get(KEY)).catch(() => undefined);
  if (kept && kept.name === file.name && kept.size === file.size && kept.modified === file.lastModified) return;
  // A File is stored as its bytes with name and type; ask the browser to keep them.
  await globalThis.navigator?.storage?.persist?.().catch(() => false);
  await run('readwrite', store => store.put({ name: file.name, type: file.type, size: file.size, modified: file.lastModified, blob: file, saved: new Date().toISOString() }, KEY));
}

export async function loadLastModel(): Promise<File | undefined> {
  const record = await run<{ name: string; type: string; blob: Blob } | undefined>('readonly', store => store.get(KEY));
  return record ? new File([record.blob], record.name, { type: record.type }) : undefined;
}

export function forgetLastModel() { return run('readwrite', store => store.delete(KEY)); }
