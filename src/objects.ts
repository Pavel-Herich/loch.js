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
  /** On the surface (from GPS or picked on the terrain; at start) or in the cave (picked on the walls or centreline). */
  kind?: ObjectKind;
};
export type ObjectKind = 'surface' | 'cave';
export const objectKind = (object: Pick<FieldObject, 'kind'>): ObjectKind => object.kind === 'cave' ? 'cave' : 'surface';
/** The height an object is shown at: on the terrain for a surface object, its own for one in the cave. */
export function objectHeight(object: FieldObject, terrainAt: (east: number, north: number) => number | undefined, fallback = 0) {
  const position = object.position;
  if (!position) return fallback;
  return objectKind(object) === 'cave' ? position.height ?? terrainAt(position.east, position.north) ?? fallback
    : terrainAt(position.east, position.north) ?? position.height ?? fallback;
}

/** Diacritics never leave the app: names and notes are stripped as they are typed. */
export function removeDiacritics(text: string) {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** Same rule as the j_mobil generator: ASCII, lower case, words joined by underscores. */
export function sanitizeName(text: string) {
  return removeDiacritics(text).toLowerCase().trim().replace(/[^\w\s]/gu, '').replace(/\s+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
}

const pad = (value: number) => String(value).padStart(2, '0');

/** `Sinkhole below ridge` saved at 22.10.2026 12:25:48 (device clock) → `sinkhole_below_ridge_26-10-22_12-25-48`. */
export function objectName(title: string, date: Date) {
  const day = `${pad(date.getFullYear() % 100)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
  return `${sanitizeName(title) || 'object'}_${day}_${time}`;
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

/**
 * One survey file per object in the j_mobil layout, fixed in the model's system (cs ijtsk, Bpv
 * height). A surface object is an entrance-flagged station on the surface, fixed to the metre; one
 * in the cave a plain station (bod_mob), fixed to the centimetre.
 */
export function surveyTh(object: FieldObject, team: string) {
  const position = object.position!, date = new Date(object.created), cave = objectKind(object) === 'cave';
  const height = position.height ?? position.gpsAltitude ?? 0;
  const comment = removeDiacritics(object.note || object.title).replace(/\s+/g, ' ').trim();
  const station = cave ? 'bod_mob' : 'gps_mob';
  const fixed = cave ? `${position.east.toFixed(2)} ${position.north.toFixed(2)} ${height.toFixed(2)}` : `${Math.round(position.east)} ${Math.round(position.north)} ${Math.round(height)}`;
  return `encoding  utf-8\r\n\r\nsurvey ${object.name} -title "${object.name}"\r\n\r\n\r\ncentreline\r\n`
    + `station ${station} "${object.name}"${cave ? '' : ' entrance'} #${comment}\r\ncs ijtsk\r\n`
    + `fix ${station} ${fixed}\r\n`
    + `explo-date 0 \r\nexplo-team "Anonymus"\r\ndate ${date.getFullYear()}.${date.getMonth() + 1}.${date.getDate()}\r\n`
    + `team "${removeDiacritics(team).replace(/"/g, '') || 'unknown'}"\r\ndata normal from to compass clino tape\r\n${cave ? '' : 'flags surface\r\nflags not surface\r\n'}endcentreline\r\nendsurvey\r\n\r\n`;
}

/** The export's folders: surface objects in j_mobil (as before), objects in the cave in j_jaskyna. */
export const OBJECT_FOLDERS: Record<ObjectKind, string> = { surface: 'j_mobil', cave: 'j_jaskyna' };

/**
 * j_mobil.zip: j_mobil/<id>/<id>_th.th, thconfig_200.th, _data/ photos; j_mobil.th lists them all.
 * Objects in the cave go the same way into j_jaskyna (j_jaskyna.th, its thconfig.th).
 */
export async function exportTherion(objects: FieldObject[], team: string) {
  const encoder = new TextEncoder(), now = new Date(), entries: ZipEntry[] = [];
  const inputs: Record<ObjectKind, string[]> = { surface: [], cave: [] };
  for (const object of objects) {
    if (!object.position) continue;
    const kind = objectKind(object), date = new Date(object.created), folder = `${OBJECT_FOLDERS[kind]}/${object.name}`;
    entries.push({ name: `${folder}/_data/desktop.ini`, data: encoder.encode(DESKTOP_INI), date });
    for (let i = 0; i < object.photos.length; i++) {
      entries.push({ name: `${folder}/_data/${photoFileName(object, i)}`, data: new Uint8Array(await object.photos[i].blob.arrayBuffer()), date });
    }
    entries.push({ name: `${folder}/${object.name}_th.th`, data: encoder.encode(surveyTh(object, team)), date });
    entries.push({ name: `${folder}/thconfig_200.th`, data: encoder.encode(THCONFIG_TEMPLATE.split('SURVEY_ID').join(object.name)), date });
    inputs[kind].push(`input ${object.name}/${object.name}_th.th`);
  }
  for (const kind of ['surface', 'cave'] as const) {
    // j_mobil always (as before); j_jaskyna only with objects in the cave.
    if (kind === 'cave' && !inputs.cave.length) continue;
    const folder = OBJECT_FOLDERS[kind];
    entries.push({ name: `${folder}/${folder}.th`, data: encoder.encode(inputs[kind].join('\r\n') + '\r\n'), date: now });
    entries.push({ name: `${folder}/thconfig.th`, data: encoder.encode(THCONFIG_MAIN.split('j_mobil').join(folder)), date: now });
  }
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
    // Names are derived from title and save time, so records from older versions follow the current format.
    for (const object of objects) object.name = objectName(object.title, new Date(object.created));
    return objects.sort((a, b) => a.created.localeCompare(b.created));
  }
  async put(object: FieldObject) {
    await this.run('readwrite', store => store.put(object));
    // Ask the browser not to evict field data under storage pressure; refusal is harmless.
    try { await navigator.storage?.persist?.(); } catch { /* Not supported. */ }
  }
  async delete(id: string) { await this.run('readwrite', store => store.delete(id)); }
}
