import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { exportTherion, objectName, photoFileName, removeDiacritics, sanitizeName, surveyTh, type FieldObject } from '../src/objects';
import { THCONFIG_MAIN, THCONFIG_TEMPLATE } from '../src/therion-templates';
import { crc32 } from '../src/zip';

const object = (photos = 1, position = true): FieldObject => ({
  id: 'a', title: 'Zavrt pod hrebenom', name: 'zavrt_pod_hrebenom_2026_10_22_11_44_5', created: new Date(2026, 9, 22, 11, 44, 5).toISOString(),
  position: position ? { latitude: 48.985971893, longitude: 19.741300668, gpsAltitude: 1320.4, accuracy: 4.2, east: -372234.807, north: -1203810.66, height: 1286.4, heightSource: 'surface', source: 'gps' } : null,
  note: 'Prievan citit,  fotka na V', photos: Array.from({ length: photos }, (_, i) => ({ name: `IMG_${i}.JPG`, type: 'image/jpeg', blob: new Blob([new Uint8Array([0xff, 0xd8, i, 0xff, 0xd9])]) })),
});

describe('field objects for Therion', () => {
  it('strips diacritics and builds the j_mobil survey id with the save time', () => {
    expect(removeDiacritics('Závrt pod hrebeňom, ľadová ťava')).toBe('Zavrt pod hrebenom, ladova tava');
    expect(sanitizeName('  Závrt pod  hrebeňom (V1) ')).toBe('zavrt_pod_hrebenom_v1');
    expect(objectName('Závrt pod hrebeňom', new Date(2026, 9, 22, 11, 44, 5))).toBe('zavrt_pod_hrebenom_2026_10_22_11_44_5');
    expect(objectName('', new Date(2026, 0, 2, 3, 4, 5))).toBe('objekt_2026_1_2_3_4_5');
  });

  it('writes the survey exactly like the j_mobil generator', () => {
    expect(surveyTh(object(), 'P. Herich')).toBe(
      'encoding  utf-8\r\n\r\nsurvey zavrt_pod_hrebenom_2026_10_22_11_44_5 -title "zavrt_pod_hrebenom_2026_10_22_11_44_5"\r\n\r\n\r\ncentreline\r\n'
      + 'station gps_mob "zavrt_pod_hrebenom_2026_10_22_11_44_5" entrance #Prievan citit, fotka na V\r\ncs lat-long\r\n'
      + 'fix gps_mob 48.9859719 19.7413007 1286\r\nexplo-date 0 \r\nexplo-team "Anonymus"\r\ndate 2026.10.22\r\nteam "P. Herich"\r\n'
      + 'data normal from to compass clino tape\r\nflags surface\r\nflags not surface\r\nendcentreline\r\nendsurvey\r\n\r\n');
    expect(photoFileName(object(2), 1)).toBe('zavrt_pod_hrebenom_2026_10_22_11_44_5_2.jpg');
  });

  it('exports j_mobil.zip with one folder per positioned object', async () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    const blob = await exportTherion([object(2), { ...object(1, false), id: 'b', name: 'bez_polohy_2026_10_22_12_0_0' }], 'P. Herich');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(new DataView(bytes.buffer).getUint32(0, true)).toBe(0x04034b50);
    if (process.env.ZIP_OUT) writeFileSync(process.env.ZIP_OUT, bytes);
    const text = new TextDecoder('latin1').decode(bytes);
    expect(text).toContain('j_mobil/zavrt_pod_hrebenom_2026_10_22_11_44_5/_data/desktop.ini');
    expect(text).not.toContain('bez_polohy');
    expect(THCONFIG_TEMPLATE).toContain('source SURVEY_ID_th.th');
    expect(THCONFIG_MAIN).toContain('source j_mobil.th');
  });
});
