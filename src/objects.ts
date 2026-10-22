import { createZip, type ZipEntry } from './zip';
import { DESKTOP_INI, THCONFIG_MAIN, THCONFIG_TEMPLATE } from './therion-templates';

/** A field record: position from the device, a name, a note and photos. */
export type FieldPhoto = { name: string; type: string; blob: Blob };
export type FieldPosition = {
  latitude: number; longitude: number; gpsAltitude: number | null; accuracy: number;
  /** EPSG:5514 / Therion ijtsk, metres. */
  east: number; north: number;
  height: number | null; heightSource: 'surface' | 'gps' | 'model' | null;
  /** Where the position came from: the device GPS or a point picked in the model. */
  source?: 'gps' | 'model';
};
export type FieldObject = {
  id: string;
  /** Name as typed, and the saved name with date and time appended as one word. */
  title: string; name: string;
  created: string;
  position: FieldPosition | null;
  note: string;
  photos: FieldPhoto[];
};

/** Diacritics never leave the app: names and notes are stripped as they are typed. */
export function removeDiacritics(text: string) {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** Same rule as the j_mobil generator: ASCII, lower case, words joined by underscores. */
export function sanitizeName(text: string) {
  return removeDiacritics(text).toLowerCase().trim().replace(/[^\w\s]/gu, '').replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
}

/** `Zavrt pod hrebenom` saved at 22.10.2026 11:44:05 → `zavrt_pod_hrebenom_2026_10_22_11_44_5` (j_mobil survey id). */
export function objectName(title: string, date: Date) {
  const stamp = [date.getFullYear(), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds()].join('_');
  return `${sanitizeName(title) || 'objekt'}_${stamp}`;
}

function extension(type: string, fallback: string) {
  const known: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/heic': 'heic', 'image/heif': 'heif', 'image/webp': 'webp' };
  return known[type] ?? (fallback.match(/\.([A-Za-z0-9]{1,5})$/)?.[1]?.toLowerCase() ?? 'jpg');
}

/** Photo file names inside a survey's _data folder, unique per object and photo. */
export function photoFileName(object: FieldObject, index: number) {
  const photo = object.photos[index];
  return `${object.name}${object.photos.length > 1 ? `_${index + 1}` : ''}.${extension(photo.type, photo.name)}`;
}

/** One survey file per object, as written by the j_mobil generator. */
export function surveyTh(object: FieldObject, team: string) {
  const position = object.position!, date = new Date(object.created);
  const elevation = Math.round(position.height ?? position.gpsAltitude ?? 0);
  const comment = removeDiacritics(object.note || object.title).replace(/\s+/g, ' ').trim();
  return `encoding  utf-8\r\n\r\nsurvey ${object.name} -title "${object.name}"\r\n\r\n\r\ncentreline\r\n`
    + `station gps_mob "${object.name}" entrance #${comment}\r\ncs lat-long\r\n`
    + `fix gps_mob ${position.latitude.toFixed(7)} ${position.longitude.toFixed(7)} ${elevation}\r\n`
    + `explo-date 0 \r\nexplo-team "Anonymus"\r\ndate ${date.getFullYear()}.${date.getMonth() + 1}.${date.getDate()}\r\n`
    + `team "${removeDiacritics(team).replace(/"/g, '') || 'Kto zameral'}"\r\ndata normal from to compass clino tape\r\nflags surface\r\nflags not surface\r\nendcentreline\r\nendsurvey\r\n\r\n`;
}

/** j_mobil.zip: j_mobil/<id>/<id>_th.th, thconfig_200.th, _data/ photos; j_mobil.th lists them all. */
export async function exportTherion(objects: FieldObject[], team: string) {
  const encoder = new TextEncoder(), now = new Date(), entries: ZipEntry[] = [], inputs: string[] = [];
  for (const object of objects) {
    if (!object.position) continue;
    const date = new Date(object.created), folder = `j_mobil/${object.name}`;
    entries.push({ name: `${folder}/_data/desktop.ini`, data: encoder.encode(DESKTOP_INI), date });
    for (let i = 0; i < object.photos.length; i++) {
      entries.push({ name: `${folder}/_data/${photoFileName(object, i)}`, data: new Uint8Array(await object.photos[i].blob.arrayBuffer()), date });
    }
    entries.push({ name: `${folder}/${object.name}_th.th`, data: encoder.encode(surveyTh(object, team)), date });
    entries.push({ name: `${folder}/thconfig_200.th`, data: encoder.encode(THCONFIG_TEMPLATE.split('SURVEY_ID').join(object.name)), date });
    inputs.push(`input ${object.name}/${object.name}_th.th`);
  }
  entries.push({ name: 'j_mobil/j_mobil.th', data: encoder.encode(inputs.join('\r\n') + '\r\n'), date: now });
  entries.push({ name: 'j_mobil/thconfig.th', data: encoder.encode(THCONFIG_MAIN), date: now });
  return createZip(entries);
}

/** Records stay on this device (IndexedDB), photos included, until exported or deleted. */
export class ObjectStore {
  private db?: Promise<IDBDatabase>;
  constructor(private name = 'loch.js-objects', private factory: IDBFactory | undefined = globalThis.indexedDB) {}

  private open() {
    this.db ??= new Promise((resolve, reject) => {
      if (!this.factory) { reject(new Error('This browser cannot store objects (IndexedDB unavailable).')); return; }
      const request = this.factory.open(this.name, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('objects', { keyPath: 'id' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('Could not open object storage.'));
    });
    return this.db;
  }

  private async run<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>) {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      const transaction = db.transaction('objects', mode), request = action(transaction.objectStore('objects'));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error ?? request.error ?? new Error('Object storage failed.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Object storage was aborted (storage full?).'));
    });
  }

  async list() {
    const objects = await this.run<FieldObject[]>('readonly', store => store.getAll() as IDBRequest<FieldObject[]>);
    return objects.sort((a, b) => a.created.localeCompare(b.created));
  }
  async put(object: FieldObject) {
    await this.run('readwrite', store => store.put(object));
    // Ask the browser not to evict field data under storage pressure; refusal is harmless.
    try { await navigator.storage?.persist?.(); } catch { /* Not supported. */ }
  }
  async delete(id: string) { await this.run('readwrite', store => store.delete(id)); }
}
