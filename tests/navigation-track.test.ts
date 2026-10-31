import { describe, expect, it } from 'vitest';
import { formatDistance, navigate } from '../src/navigation';
import { parseGpxTracks, TrackStore, trackGpx, trackLength, trackTherion, type Track, type TrackPoint } from '../src/track';

describe('navigate', () => {
  const here = { east: 0, north: 0, height: 1000, trueNorth: 4 };
  it('gives distance, height difference and bearings', () => {
    const way = navigate(here, { east: 300, north: 400, z: 1030 });
    expect(way.horizontal).toBeCloseTo(500); expect(way.dz).toBe(30);
    expect(way.gridBearing).toBeCloseTo(36.87, 1);
    // True north lies 4° clockwise of grid north, so the true bearing is 4° less.
    expect(way.trueBearing).toBeCloseTo(32.87, 1);
    expect(way.turn).toBeUndefined();
  });
  it('turns from where the phone points', () => {
    expect(navigate(here, { east: 0, north: 100, z: 1000 }, 350).turn).toBeCloseTo(6);
    expect(navigate(here, { east: 0, north: -100, z: 1000 }, 10).turn).toBeCloseTo(166);
  });
  it('formats distances', () => { expect(formatDistance(245.4)).toBe('245 m'); expect(formatDistance(1340)).toBe('1.3 km'); });
});

describe('TrackStore', () => {
  const point = (east: number, accuracy = 5): TrackPoint => ({ time: '2026-10-26T10:00:00Z', latitude: 49, longitude: 19.6, east, north: -1200000, height: 1500, accuracy });
  const memory = () => {
    const data = new Map<string, Track>();
    return { data, list: async () => [...data.values()], put: async (t: Track) => void data.set(t.id, t), delete: async (id: string) => void data.delete(id) };
  };
  it('records precise fixes that moved into the started track, and keeps several tracks', async () => {
    const saved = memory(), store = new TrackStore(saved);
    expect(store.add(point(0))).toBe(false);
    const first = store.start();
    expect(store.add(point(0))).toBe(true);
    expect(store.add(point(1))).toBe(false);
    expect(store.add(point(10, 80))).toBe(false);
    expect(store.add(point(10))).toBe(true);
    store.stop();
    expect(trackLength(first)).toBe(10);
    store.start(); store.add(point(50)); store.stop();
    const reloaded = new TrackStore(saved); await reloaded.load();
    expect(reloaded.tracks.map(t => t.points.length)).toEqual([2, 1]);
    expect(reloaded.tracks[0].color).not.toBe(reloaded.tracks[1].color);
  });
  it('starts a new segment after the page was hidden or a long pause, never joining across it', () => {
    const store = new TrackStore(memory());
    const at = (east: number, time: string): TrackPoint => ({ ...point(east), time });
    const track = store.start();
    store.add(at(0, '2026-10-31T10:00:00Z')); store.add(at(10, '2026-10-31T10:00:20Z'));
    store.interrupt();                                      // screen off
    store.add(at(400, '2026-10-31T10:00:30Z'));             // back: a new segment
    store.add(at(410, '2026-10-31T10:00:40Z'));
    store.add(at(900, '2026-10-31T10:05:00Z'));             // 4 minutes without a fix
    expect(track.points.map(p => Boolean(p.gap))).toEqual([false, false, true, false, true]);
    expect(trackLength(track)).toBe(20);
    const gpx = trackGpx(track.points);
    expect(gpx.match(/<trkseg>/g)).toHaveLength(3);
    const th = trackTherion(track.points, 'walk');
    expect(th).toContain('    1 2'); expect(th).not.toContain('    2 3'); expect(th).toContain('    3 4'); expect(th).not.toContain('    4 5');
  });
  it('imports GPX tracks with their segments, or routes', () => {
    const gpx = `<?xml version="1.0"?><gpx version="1.1" creator="OsmAnd" xmlns="http://www.topografix.com/GPX/1/1">
      <metadata><name>file name</name></metadata>
      <trk><name>Jaskyňa pod Ohniskom</name>
        <trkseg><trkpt lat="49.0" lon="19.6"><ele>1210.43</ele><time>2026-10-31T09:00:00Z</time><name>p1</name></trkpt>
          <trkpt lat="49.0001" lon="19.6"><ele>1211</ele><time>2026-10-31T09:00:10Z</time></trkpt></trkseg>
        <trkseg><trkpt lat="49.001" lon="19.601"/></trkseg>
      </trk></gpx>`;
    const [track] = parseGpxTracks(gpx, 'walk');
    expect(track.name).toBe('Jaskyňa pod Ohniskom');
    expect(track.points.map(p => Boolean(p.gap))).toEqual([false, false, true]);
    expect(track.points[0]).toMatchObject({ height: 1210.4, time: '2026-10-31T09:00:00.000Z' });
    expect(track.points[0].east).toBeLessThan(-300000); expect(track.points[2].height).toBeNull();
    const store = new TrackStore(memory()), imported = store.importTrack(track.name, track.points);
    expect(imported.name).toBe('Jaskyna pod Ohniskom');
    expect(imported.created).toBe('2026-10-31T09:00:00.000Z');
    const route = parseGpxTracks('<gpx><rte><rtept lat="49" lon="19.6"/><rtept lat="49.01" lon="19.6"/></rte></gpx>', 'plan');
    expect(route).toHaveLength(1); expect(route[0].name).toBe('plan'); expect(route[0].points).toHaveLength(2);
    expect(parseGpxTracks('<gpx><wpt lat="49" lon="19.6"/></gpx>', 'x')).toEqual([]);
  });
  it('hides, renames and deletes tracks', async () => {
    const saved = memory(), store = new TrackStore(saved);
    const empty = store.start(); store.stop();
    expect(store.find(empty.id)).toBeUndefined(); // no fix: not kept
    const track = store.start(); store.add(point(0)); store.stop();
    store.setVisible(track.id, false); store.rename(track.id, 'Ponor walk');
    expect(saved.data.get(track.id)).toMatchObject({ visible: false, name: 'Ponor walk' });
    store.remove(track.id);
    await Promise.resolve();
    expect(store.tracks).toHaveLength(0); expect(saved.data.size).toBe(0);
  });
  it('exports GPX and a Therion survey fixed in cs ijtsk', () => {
    const points = [point(-380000), point(-379990)];
    expect(trackGpx(points)).toContain('<trkpt lat="49.0000000" lon="19.6000000"><ele>1500.0</ele>');
    const th = trackTherion(points, 'Track 26-10-26');
    expect(th).toContain('cs ijtsk');
    expect(th).toContain('fix 2 -379990 -1200000 1500');
    expect(th).toContain('data nosurvey from to');
    expect(th.split('\r\n')[0]).toBe('survey track_26_10_26 -title "track_26_10_26"');
  });
});
