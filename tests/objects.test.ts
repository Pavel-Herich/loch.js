import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { exportObjects, objectName, objectsCsv, objectsGeoJson, photoFileName, type FieldObject } from '../src/objects';
import { crc32 } from '../src/zip';

const object = (photos = 1): FieldObject => ({
  id: 'a', title: 'Závrt pod hrebeňom', name: 'Závrt_pod_hrebeňom_2026-10-22_11-44-05', created: '2026-10-22T09:44:05.000Z',
  position: { latitude: 48.985971893, longitude: 19.741300668, gpsAltitude: 1320.4, accuracy: 4.2, east: -372234.807, north: -1203810.66, height: 1286.2, heightSource: 'surface' },
  note: 'Prievan; "silný" ťah', photos: Array.from({ length: photos }, (_, i) => ({ name: `IMG_${i}.JPG`, type: 'image/jpeg', blob: new Blob([new Uint8Array([0xff, 0xd8, i, 0xff, 0xd9])]) })),
});

describe('field objects', () => {
  it('appends the save date and time to the name as one word', () => {
    expect(objectName('  Závrt pod  hrebeňom ', new Date(2026, 9, 22, 11, 44, 5))).toBe('Závrt_pod_hrebeňom_2026-10-22_11-44-05');
    expect(objectName('', new Date(2026, 0, 2, 3, 4, 5))).toBe('Objekt_2026-01-02_03-04-05');
  });

  it('writes CSV with positive S-JTSK Y/X, quoted notes and photo paths', () => {
    const csv = objectsCsv([object(2)]);
    expect(csv.startsWith('﻿name;title;created;Y_jtsk;X_jtsk')).toBe(true);
    const row = csv.split('\r\n')[1];
    expect(row).toContain(';372234.81;1203810.66;1286.20;surface;4.2;48.98597189;19.74130067;1320.4;');
    expect(row).toContain('"Prievan; ""silný"" ťah"');
    expect(row).toContain('photos/Závrt_pod_hrebeňom_2026-10-22_11-44-05_1.jpg, photos/Závrt_pod_hrebeňom_2026-10-22_11-44-05_2.jpg');
    expect(photoFileName(object(1), 0)).toBe('Závrt_pod_hrebeňom_2026-10-22_11-44-05.jpg');
  });

  it('writes GeoJSON in WGS 84 and keeps objects without a position', () => {
    const data = JSON.parse(objectsGeoJson([object(), { ...object(0), id: 'b', position: null }]));
    expect(data.features[0].geometry.coordinates).toEqual([19.741300668, 48.985971893, 1320.4]);
    expect(data.features[0].properties.Y_jtsk).toBeCloseTo(372234.807, 6);
    expect(data.features[1].geometry).toBeNull();
  });

  it('exports a valid ZIP with the tables and photos', async () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    const blob = await exportObjects([object(2)]);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(new DataView(bytes.buffer).getUint32(0, true)).toBe(0x04034b50);
    expect(new DataView(bytes.buffer).getUint16(bytes.length - 22 + 10, true)).toBe(4);
    if (process.env.ZIP_OUT) writeFileSync(process.env.ZIP_OUT, bytes);
  });
});
