import { createZip, type ZipEntry } from './zip';

/** A field record: position from the device, a name, a note and photos. */
export type FieldPhoto = { name: string; type: string; blob: Blob };
export type FieldPosition = {
  latitude: number; longitude: number; gpsAltitude: number | null; accuracy: number;
  /** EPSG:5514 / Therion ijtsk, metres. */
  east: number; north: number;
  height: number | null; heightSource: 'surface' | 'gps' | null;
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

const pad = (value: number, size = 2) => String(value).padStart(size, '0');

/** `Závrt pod hrebeňom` saved at 2026-10-22 11:44:05 → `Závrt_pod_hrebeňom_2026-10-22_11-44-05`. */
export function objectName(title: string, date: Date) {
  const base = title.trim().replace(/\s+/g, '_') || 'Objekt';
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
  return `${base}_${stamp}`;
}

function extension(type: string, fallback: string) {
  const known: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/heic': 'heic', 'image/heif': 'heif', 'image/webp': 'webp' };
  return known[type] ?? (fallback.match(/\.([A-Za-z0-9]{1,5})$/)?.[1]?.toLowerCase() ?? 'jpg');
}

/** File names used inside the export, unique per object and photo. */
export function photoFileName(object: FieldObject, index: number) {
  const photo = object.photos[index];
  return `${object.name}${object.photos.length > 1 ? `_${index + 1}` : ''}.${extension(photo.type, photo.name)}`;
}

function csvCell(value: string | number | null | undefined) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[;"\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Semicolon CSV with S-JTSK Y/X as surveyors write them (positive), opened directly by Excel. */
export function objectsCsv(objects: FieldObject[]) {
  const header = ['name', 'title', 'created', 'Y_jtsk', 'X_jtsk', 'height_m', 'height_source', 'accuracy_m', 'latitude', 'longitude', 'gps_altitude_m', 'note', 'photos'];
  const rows = objects.map(object => {
    const p = object.position;
    return [object.name, object.title, object.created,
      p ? (-p.east).toFixed(2) : null, p ? (-p.north).toFixed(2) : null, p?.height?.toFixed(2), p?.heightSource,
      p?.accuracy.toFixed(1), p?.latitude.toFixed(8), p?.longitude.toFixed(8), p?.gpsAltitude?.toFixed(1),
      object.note, object.photos.map((_, i) => `photos/${photoFileName(object, i)}`).join(', ')].map(csvCell).join(';');
  });
  return '﻿' + [header.join(';'), ...rows].join('\r\n') + '\r\n';
}

/** GeoJSON in WGS 84 for GIS; S-JTSK coordinates are kept as properties. */
export function objectsGeoJson(objects: FieldObject[]) {
  return JSON.stringify({
    type: 'FeatureCollection',
    features: objects.map(object => ({
      type: 'Feature',
      geometry: object.position ? { type: 'Point', coordinates: [object.position.longitude, object.position.latitude, ...(object.position.gpsAltitude === null ? [] : [object.position.gpsAltitude])] } : null,
      properties: {
        name: object.name, title: object.title, created: object.created, note: object.note,
        Y_jtsk: object.position ? -object.position.east : null, X_jtsk: object.position ? -object.position.north : null,
        height: object.position?.height ?? null, height_source: object.position?.heightSource ?? null,
        accuracy: object.position?.accuracy ?? null,
        photos: object.photos.map((_, i) => `photos/${photoFileName(object, i)}`),
      },
    })),
  }, null, 2);
}

export async function exportObjects(objects: FieldObject[]) {
  const encoder = new TextEncoder(), now = new Date();
  const entries: ZipEntry[] = [
    { name: 'objects.csv', data: encoder.encode(objectsCsv(objects)), date: now },
    { name: 'objects.geojson', data: encoder.encode(objectsGeoJson(objects)), date: now },
  ];
  for (const object of objects) for (let i = 0; i < object.photos.length; i++) {
    entries.push({ name: `photos/${photoFileName(object, i)}`, data: new Uint8Array(await object.photos[i].blob.arrayBuffer()), date: new Date(object.created) });
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
    return objects.sort((a, b) => a.created.localeCompare(b.created));
  }
  async put(object: FieldObject) {
    await this.run('readwrite', store => store.put(object));
    // Ask the browser not to evict field data under storage pressure; refusal is harmless.
    try { await navigator.storage?.persist?.(); } catch { /* Not supported. */ }
  }
  async delete(id: string) { await this.run('readwrite', store => store.delete(id)); }
}
