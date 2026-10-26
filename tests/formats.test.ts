import { describe, expect, it } from 'vitest';
import { kmzText, parseCsv, parseGeoJson, parseGpx, parseKml, toCsv, toGeoJson, toGpx, toKml, toShapefile } from '../src/formats';
import { parseDbf, parseShp } from '../src/shapefile';
import { wgs84ToSJTSK } from '../src/geo';

describe('import', () => {
  it('reads GPX waypoints and track points', () => {
    const gpx = `<gpx><wpt lat="48.98" lon="19.63"><ele>1556</ele><name>Javorova</name></wpt>
      <trk><trkseg><trkpt lat="48.981" lon="19.631"><ele>1560.5</ele></trkpt><trkpt lat="48.982" lon="19.632"/></trkseg></trk></gpx>`;
    const parsed = parseGpx(gpx);
    expect(parsed.wgs84).toBe(true);
    expect(parsed.points.map(p => [p.x, p.y, p.z])).toEqual([[19.63, 48.98, 1556], [19.631, 48.981, 1560.5], [19.632, 48.982, null]]);
    expect(parsed.labels[0]).toBe('Javorova');
    expect(parsed.attributes[1].type).toBe('track point');
  });
  it('reads KML placemarks, one label per placemark', () => {
    const kml = `<kml><Document><Placemark><name>Ponor &amp; jama</name><Point><coordinates>19.6,48.9,1200</coordinates></Point></Placemark>
      <Placemark><name>Line</name><LineString><coordinates>19.6,48.9 19.61,48.91</coordinates></LineString></Placemark></Document></kml>`;
    const parsed = parseKml(kml);
    expect(parsed.points.map(p => p.record)).toEqual([0, 1, 1]);
    expect(parsed.labels).toEqual(['Ponor & jama', 'Line']);
  });
  it('reads GeoJSON in WGS 84 or S-JTSK', () => {
    const wgs = parseGeoJson(JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name: 'A', depth: 12 }, geometry: { type: 'Point', coordinates: [19.6, 48.9, 1000] } }] }));
    expect(wgs.wgs84).toBe(true); expect(wgs.attributes[0]).toEqual({ name: 'A', depth: '12' });
    const jtsk = parseGeoJson(JSON.stringify({ type: 'FeatureCollection', crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::5514' } },
      features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[-380000, -1204000], [-379990, -1204000], [-379990, -1203990]]] } }] }));
    expect(jtsk.wgs84).toBe(false); expect(jtsk.points).toHaveLength(3);
  });
  it('reads CSV with x;y;z or lat,lon, decimal commas and JTSK Y/X order', () => {
    const jtsk = parseCsv('name;x;y;z\nA;-380000,5;-1204000;1500\n');
    expect(jtsk.points[0]).toMatchObject({ x: -380000.5, y: -1204000, z: 1500 });
    expect(jtsk.labels[0]).toBe('A');
    const swapped = parseCsv('id;y;x\n1;-1204000;-380000');
    expect(swapped.points[0]).toMatchObject({ x: -380000, y: -1204000 });
    const wgs = parseCsv('lat,lon,name\n48.9,19.6,B');
    expect(wgs.wgs84).toBe(true); expect(wgs.points[0]).toMatchObject({ x: 19.6, y: 48.9 });
  });
  it('reads the KML inside a KMZ (deflated)', async () => {
    const kml = new TextEncoder().encode('<kml><Placemark><name>Z</name><Point><coordinates>19,49,0</coordinates></Point></Placemark></kml>');
    const deflated = new Uint8Array(await new Response(new Blob([kml]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
    const name = new TextEncoder().encode('doc.kml'), header = new Uint8Array(30 + name.length), view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true); view.setUint16(8, 8, true); view.setUint32(18, deflated.length, true); view.setUint32(22, kml.length, true); view.setUint16(26, name.length, true);
    header.set(name, 30);
    const zip = new Uint8Array([...header, ...deflated]);
    expect(parseKml(await kmzText(zip.buffer)).labels).toEqual(['Z']);
  });
});

describe('export', () => {
  const points = [{ name: 'Javorová priepasť', east: -380238, north: -1204398, z: 1556.6, attributes: { survey: 'javorova_p' } }];
  it('writes a shapefile that reads back with its names and heights', () => {
    const files = toShapefile(points);
    const { type, points: read } = parseShp(files.shp.buffer as ArrayBuffer);
    expect(type).toBe('PointZ');
    expect(read[0]).toMatchObject({ x: -380238, y: -1204398, z: 1556.6 });
    expect(parseDbf(files.dbf.buffer as ArrayBuffer)[0]).toEqual({ NAME: 'Javorová priepasť', Z: '1556.60' });
    expect(new TextDecoder().decode(files.prj)).toContain('Krovak');
  });
  it('writes GeoJSON, KML, GPX and CSV that agree on the position', () => {
    const geo = JSON.parse(toGeoJson(points));
    expect(geo.crs.properties.name).toContain('5514');
    expect(geo.features[0].geometry.coordinates).toEqual([-380238, -1204398, 1556.6]);
    const [lon, lat] = JSON.parse(toGeoJson(points, true)).features[0].geometry.coordinates;
    const [east, north] = wgs84ToSJTSK(lat, lon, 1556.6);
    expect(east).toBeCloseTo(-380238, 0); expect(north).toBeCloseTo(-1204398, 0);
    expect(toKml(points, 'Entrances')).toContain(`<coordinates>${lon.toFixed(7)},${lat.toFixed(7)},1556.6</coordinates>`);
    expect(toGpx(points)).toContain(`lat="${lat.toFixed(7)}"`);
    expect(toCsv(points).split('\r\n')[1]).toBe(`Javorová priepasť;-380238.00;-1204398.00;1556.60;${lat.toFixed(7)};${lon.toFixed(7)}`);
  });
});
