import { sjtskToWgs84 } from './geo';
import type { ShpPoint } from './shapefile';

/**
 * Point data from common GIS exchange formats, read into the same shape as shapefile
 * vertices so they become ordinary layers: GPX (waypoints, track and route points),
 * KML/KMZ (placemark coordinates), GeoJSON (any geometry's vertices) and CSV (x y z or
 * lat lon columns). `wgs84` says the coordinates are longitude/latitude.
 */
/** `labels` and `attributes` are per record (a waypoint, placemark, feature or CSV row), as `points[].record` counts them. */
export type ParsedPoints = { points: ShpPoint[]; labels: string[]; attributes: Record<string, string>[]; wgs84?: boolean };

const decode = (text: string) => text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&').trim();
const tag = (xml: string, name: string) => { const m = new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`).exec(xml); return m ? decode(m[1]) : ''; };
const attribute = (head: string, name: string) => { const m = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`).exec(head); return m ? m[1] : ''; };

export function parseGpx(text: string): ParsedPoints {
  const result: ParsedPoints = { points: [], labels: [], attributes: [], wgs84: true };
  const kinds: Record<string, string> = { wpt: 'waypoint', trkpt: 'track point', rtept: 'route point' };
  for (const match of text.matchAll(/<(wpt|trkpt|rtept)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/g)) {
    const [, kind, head, body = ''] = match;
    const lat = Number(attribute(head, 'lat')), lon = Number(attribute(head, 'lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const ele = Number(tag(body, 'ele')), name = tag(body, 'name');
    const record = result.points.length;
    result.points.push({ x: lon, y: lat, z: body && tag(body, 'ele') !== '' && Number.isFinite(ele) ? ele : null, record });
    result.labels.push(name);
    result.attributes.push({ type: kinds[kind], ...(name ? { name } : {}), ...(tag(body, 'desc') ? { desc: tag(body, 'desc') } : {}), ...(tag(body, 'time') ? { time: tag(body, 'time') } : {}) });
  }
  return result;
}

export function parseKml(text: string): ParsedPoints {
  const result: ParsedPoints = { points: [], labels: [], attributes: [], wgs84: true };
  let record = 0;
  for (const match of text.matchAll(/<(?:\w+:)?Placemark\b[^>]*>([\s\S]*?)<\/(?:\w+:)?Placemark>/g)) {
    const body = match[1], name = tag(body, 'name'), description = tag(body, 'description');
    const before = result.points.length;
    for (const block of body.matchAll(/<(?:\w+:)?coordinates>([\s\S]*?)<\/(?:\w+:)?coordinates>/g)) {
      for (const tuple of block[1].trim().split(/\s+/)) {
        const [lon, lat, alt] = tuple.split(',').map(Number);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        result.points.push({ x: lon, y: lat, z: Number.isFinite(alt) ? alt : null, record });
      }
    }
    if (result.points.length === before) continue;
    result.labels.push(name); result.attributes.push({ ...(name ? { name } : {}), ...(description ? { description } : {}) });
    record++;
  }
  return result;
}

/** GeoJSON vertices; a crs member naming 5514 (S-JTSK) or 102067 keeps the coordinates as they are. */
export function parseGeoJson(text: string): ParsedPoints {
  const json = JSON.parse(text);
  const crs = JSON.stringify(json.crs ?? '');
  const result: ParsedPoints = { points: [], labels: [], attributes: [], wgs84: !/5514|102067|JTSK/i.test(crs) };
  const features = json.type === 'FeatureCollection' ? json.features : json.type === 'Feature' ? [json] : [{ type: 'Feature', geometry: json, properties: {} }];
  for (const feature of features as { geometry?: { coordinates?: unknown; geometries?: unknown[] }; properties?: Record<string, unknown> }[]) {
    const properties = Object.fromEntries(Object.entries(feature.properties ?? {}).filter(([, v]) => v !== null && typeof v !== 'object').map(([k, v]) => [k, String(v)]));
    const name = properties.name ?? properties.Name ?? properties.NAME ?? properties.nazov ?? properties.NAZOV ?? '';
    const record = result.labels.length, before = result.points.length;
    const visit = (value: unknown): void => {
      if (!Array.isArray(value)) return;
      if (typeof value[0] === 'number') {
        const [x, y, z] = value as number[];
        result.points.push({ x, y, z: Number.isFinite(z) ? z : null, record });
        return;
      }
      for (const item of value) visit(item);
    };
    const geometry = feature.geometry;
    if (geometry?.geometries) for (const part of geometry.geometries as { coordinates?: unknown }[]) visit(part.coordinates);
    else visit(geometry?.coordinates);
    if (result.points.length > before) { result.labels.push(name); result.attributes.push(properties); }
  }
  return result;
}

/**
 * CSV or plain text with a header: x/y/z (or east/north, Y/X as in JTSK) or lat/lon columns,
 * separated by comma, semicolon or tab; a name column labels the points.
 */
export function parseCsv(text: string): ParsedPoints {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter(line => line.trim());
  if (lines.length < 2) throw new Error('The CSV file needs a header line and at least one row.');
  const separator = [';', '\t', ','].find(s => lines[0].includes(s)) ?? ',';
  const header = lines[0].split(separator).map(h => h.trim().replace(/^"|"$/g, ''));
  const find = (...names: string[]) => header.findIndex(h => names.includes(h.toLowerCase()));
  const lat = find('lat', 'latitude', 'sirka', 'šírka'), lon = find('lon', 'lng', 'longitude', 'dlzka', 'dĺžka');
  const x = find('x', 'east', 'easting', 'e'), y = find('y', 'north', 'northing', 'n'), z = find('z', 'h', 'height', 'alt', 'altitude', 'ele', 'vyska', 'výška');
  const name = find('name', 'nazov', 'názov', 'label', 'id', 'cislo', 'číslo', 'bod');
  const wgs84 = lat >= 0 && lon >= 0;
  if (!wgs84 && (x < 0 || y < 0)) throw new Error('The CSV header needs x and y (or lat and lon) columns.');
  const result: ParsedPoints = { points: [], labels: [], attributes: [], wgs84 };
  lines.slice(1).forEach(line => {
    const cells = line.split(separator).map(c => c.trim().replace(/^"|"$/g, ''));
    const number = (index: number) => index < 0 ? NaN : Number(cells[index]?.replace(',', '.'));
    let px = wgs84 ? number(lon) : number(x), py = wgs84 ? number(lat) : number(y);
    if (!Number.isFinite(px) || !Number.isFinite(py)) return;
    // JTSK lists Y (west) before X (south); a header "y;x" in that order is read the same way.
    if (!wgs84 && Math.abs(px) > 900000 && Math.abs(py) < 900000) [px, py] = [py, px];
    const pz = number(z), record = result.points.length;
    result.points.push({ x: px, y: py, z: Number.isFinite(pz) ? pz : null, record });
    result.labels.push(name >= 0 ? cells[name] ?? '' : '');
    result.attributes.push(Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ''])));
  });
  return result;
}

/** The first .kml inside a KMZ (zip): stored or deflated, read with the browser's decompressor. */
export async function kmzText(buffer: ArrayBuffer) {
  const view = new DataView(buffer), bytes = new Uint8Array(buffer);
  for (let at = 0; at + 30 <= bytes.length && view.getUint32(at, true) === 0x04034b50;) {
    const method = view.getUint16(at + 8, true), size = view.getUint32(at + 18, true);
    const nameLength = view.getUint16(at + 26, true), extra = view.getUint16(at + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 30, at + 30 + nameLength));
    const start = at + 30 + nameLength + extra, data = bytes.subarray(start, start + size);
    if (/\.kml$/i.test(name)) {
      if (method === 0) return new TextDecoder().decode(data);
      if (method === 8) return new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
      throw new Error(`Unsupported KMZ compression (${method}).`);
    }
    at = start + size;
  }
  throw new Error('No .kml file inside the KMZ.');
}

/** File extensions read as point layers (besides .shp). */
export const POINT_FORMATS = ['.gpx', '.kml', '.kmz', '.geojson', '.json', '.csv', '.txt'];

export async function parsePointFile(file: File): Promise<ParsedPoints> {
  const name = file.name.toLowerCase();
  if (name.endsWith('.gpx')) return parseGpx(await file.text());
  if (name.endsWith('.kml')) return parseKml(await file.text());
  if (name.endsWith('.kmz')) return parseKml(await kmzText(await file.arrayBuffer()));
  if (name.endsWith('.geojson') || name.endsWith('.json')) return parseGeoJson(await file.text());
  return parseCsv(await file.text());
}

// ---------------------------------------------------------------- export

/** A point to export, in the model's S-JTSK (cs ijtsk) coordinates. */
export type ExportPoint = { name: string; east: number; north: number; z: number; attributes?: Record<string, string> };

export const SJTSK_PRJ = 'PROJCS["S-JTSK_Krovak_East_North",GEOGCS["GCS_S_JTSK",DATUM["D_S_JTSK",SPHEROID["Bessel_1841",6377397.155,299.1528128]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Krovak"],PARAMETER["False_Easting",0.0],PARAMETER["False_Northing",0.0],PARAMETER["Pseudo_Standard_Parallel_1",78.5],PARAMETER["Scale_Factor",0.9999],PARAMETER["Azimuth",30.28813975277778],PARAMETER["Longitude_Of_Center",24.83333333333333],PARAMETER["Latitude_Of_Center",49.5],PARAMETER["X_Scale",-1.0],PARAMETER["Y_Scale",1.0],PARAMETER["XY_Plane_Rotation",90.0],UNIT["Meter",1.0]]';

const xml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** GeoJSON in S-JTSK (EPSG:5514, as in the model) or in WGS 84. */
export function toGeoJson(points: ExportPoint[], wgs84 = false) {
  return JSON.stringify({
    type: 'FeatureCollection',
    ...(wgs84 ? {} : { crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::5514' } } }),
    features: points.map(point => {
      const [lat, lon] = sjtskToWgs84(point.east, point.north, point.z);
      const coordinates = wgs84 ? [Number(lon.toFixed(7)), Number(lat.toFixed(7)), Math.round(point.z * 10) / 10] : [Math.round(point.east * 100) / 100, Math.round(point.north * 100) / 100, Math.round(point.z * 10) / 10];
      return { type: 'Feature', properties: { name: point.name, ...point.attributes }, geometry: { type: 'Point', coordinates } };
    }),
  }, null, 1);
}

export function toKml(points: ExportPoint[], title: string) {
  const marks = points.map(point => {
    const [lat, lon] = sjtskToWgs84(point.east, point.north, point.z);
    return `  <Placemark><name>${xml(point.name)}</name><Point><altitudeMode>absolute</altitudeMode><coordinates>${lon.toFixed(7)},${lat.toFixed(7)},${point.z.toFixed(1)}</coordinates></Point></Placemark>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>${xml(title)}</name>\n${marks.join('\n')}\n</Document></kml>\n`;
}

export function toGpx(points: ExportPoint[]) {
  const rows = points.map(point => {
    const [lat, lon] = sjtskToWgs84(point.east, point.north, point.z);
    return `  <wpt lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}"><ele>${point.z.toFixed(1)}</ele><name>${xml(point.name)}</name></wpt>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="loch.js" xmlns="http://www.topografix.com/GPX/1/1">\n${rows.join('\n')}\n</gpx>\n`;
}

/** CSV with S-JTSK x y z and WGS 84 latitude/longitude. */
export function toCsv(points: ExportPoint[]) {
  const rows = points.map(point => {
    const [lat, lon] = sjtskToWgs84(point.east, point.north, point.z);
    return [point.name.replace(/;/g, ','), point.east.toFixed(2), point.north.toFixed(2), point.z.toFixed(2), lat.toFixed(7), lon.toFixed(7)].join(';');
  });
  return ['name;x;y;z;lat;lon', ...rows].join('\r\n') + '\r\n';
}

/** Shapefile (PointZ) in S-JTSK: .shp, .shx, .dbf (NAME, Z) and .prj, plus .cpg. */
export function toShapefile(points: ExportPoint[]) {
  const recordLength = 4 + 8 * 4; // shape type, x, y, z, m
  const shp = new DataView(new ArrayBuffer(100 + points.length * (8 + recordLength)));
  const shx = new DataView(new ArrayBuffer(100 + points.length * 8));
  const xs = points.map(p => p.east), ys = points.map(p => p.north), zs = points.map(p => p.z);
  const bounds = points.length ? [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys), Math.min(...zs), Math.max(...zs)] : [0, 0, 0, 0, 0, 0];
  for (const [view, length] of [[shp, shp.byteLength], [shx, shx.byteLength]] as const) {
    view.setInt32(0, 9994, false); view.setInt32(24, length / 2, false); view.setInt32(28, 1000, true); view.setInt32(32, 11, true);
    bounds.slice(0, 4).forEach((value, i) => view.setFloat64(36 + i * 8, value, true));
    view.setFloat64(68, bounds[4], true); view.setFloat64(76, bounds[5], true);
  }
  points.forEach((point, i) => {
    const offset = 100 + i * (8 + recordLength);
    shp.setInt32(offset, i + 1, false); shp.setInt32(offset + 4, recordLength / 2, false);
    shp.setInt32(offset + 8, 11, true);
    shp.setFloat64(offset + 12, point.east, true); shp.setFloat64(offset + 20, point.north, true);
    shp.setFloat64(offset + 28, point.z, true); shp.setFloat64(offset + 36, 0, true);
    shx.setInt32(100 + i * 8, offset / 2, false); shx.setInt32(104 + i * 8, recordLength / 2, false);
  });
  // dBASE III: NAME (C 80) and Z (N 12.2), UTF-8 as the .cpg says.
  const fields = [['NAME', 'C', 80, 0], ['Z', 'N', 12, 2]] as const;
  const headerLength = 32 + fields.length * 32 + 1, dbfRecord = 1 + fields.reduce((sum, f) => sum + f[2], 0);
  const dbf = new Uint8Array(headerLength + points.length * dbfRecord + 1), dv = new DataView(dbf.buffer);
  const now = new Date();
  dbf[0] = 3; dbf[1] = now.getFullYear() - 1900; dbf[2] = now.getMonth() + 1; dbf[3] = now.getDate();
  dv.setUint32(4, points.length, true); dv.setUint16(8, headerLength, true); dv.setUint16(10, dbfRecord, true);
  const encoder = new TextEncoder();
  fields.forEach(([name, type, length, decimals], i) => {
    dbf.set(encoder.encode(name), 32 + i * 32); dbf[32 + i * 32 + 11] = type.charCodeAt(0);
    dbf[32 + i * 32 + 16] = length; dbf[32 + i * 32 + 17] = decimals;
  });
  dbf[headerLength - 1] = 0x0d;
  points.forEach((point, i) => {
    const at = headerLength + i * dbfRecord;
    dbf.fill(0x20, at, at + dbfRecord);
    let name = encoder.encode(point.name);
    while (name.length > 80) name = encoder.encode(new TextDecoder().decode(name.subarray(0, name.length - 1)).replace(/�$/, ''));
    dbf.set(name, at + 1);
    dbf.set(encoder.encode(point.z.toFixed(2).padStart(12).slice(-12)), at + 81);
  });
  dbf[dbf.length - 1] = 0x1a;
  return { shp: new Uint8Array(shp.buffer), shx: new Uint8Array(shx.buffer), dbf, prj: encoder.encode(SJTSK_PRJ), cpg: encoder.encode('UTF-8') };
}
