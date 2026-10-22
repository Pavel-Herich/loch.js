/** Minimal ZIP writer (stored, no compression): photos are already compressed. */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array) {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export type ZipEntry = { name: string; data: Uint8Array; date?: Date };

function dosTime(date: Date) {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    day: ((Math.max(date.getFullYear(), 1980) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

export function createZip(entries: ZipEntry[]): Blob {
  const encoder = new TextEncoder();
  const parts: BlobPart[] = [], central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name), crc = crc32(entry.data), { time, day } = dosTime(entry.date ?? new Date());
    const local = new DataView(new ArrayBuffer(30));
    // Flag bit 11: file names are UTF-8 (Slovak diacritics).
    [[0, 0x04034b50, 4], [4, 20, 2], [6, 0x0800, 2], [8, 0, 2], [10, time, 2], [12, day, 2], [14, crc, 4],
      [18, entry.data.length, 4], [22, entry.data.length, 4], [26, name.length, 2], [28, 0, 2]]
      .forEach(([at, value, size]) => size === 4 ? local.setUint32(at, value, true) : local.setUint16(at, value, true));
    parts.push(local.buffer, name, entry.data as Uint8Array<ArrayBuffer>);
    const record = new DataView(new ArrayBuffer(46));
    [[0, 0x02014b50, 4], [4, 20, 2], [6, 20, 2], [8, 0x0800, 2], [10, 0, 2], [12, time, 2], [14, day, 2], [16, crc, 4],
      [20, entry.data.length, 4], [24, entry.data.length, 4], [28, name.length, 2], [30, 0, 2], [32, 0, 2], [34, 0, 2],
      [36, 0, 2], [38, 0, 4], [42, offset, 4]]
      .forEach(([at, value, size]) => size === 4 ? record.setUint32(at, value, true) : record.setUint16(at, value, true));
    const header = new Uint8Array(46 + name.length); header.set(new Uint8Array(record.buffer)); header.set(name, 46);
    central.push(header);
    offset += 30 + name.length + entry.data.length;
  }
  const size = central.reduce((sum, header) => sum + header.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, size, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central.map(header => header as Uint8Array<ArrayBuffer>), end.buffer], { type: 'application/zip' });
}
