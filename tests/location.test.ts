import { describe, expect, it } from 'vitest';
import { Box3, Group, Vector3 } from 'three';
import { DeviceLocation, errorMessage, formatFix, type LocationState } from '../src/location';
import { surfaceHeightAt } from '../src/lox-surface';

type Success = (position: { coords: { latitude: number; longitude: number; altitude: number | null; accuracy: number } }) => void;
type Failure = (error: { code: number; message: string }) => void;

function fakeGeolocation() {
  const geo = {
    success: undefined as Success | undefined, failure: undefined as Failure | undefined, cleared: 0,
    watchPosition(success: Success, failure: Failure) { geo.success = success; geo.failure = failure; return 7; },
    clearWatch(id: number) { if (id === 7) geo.cleared++; },
  };
  return geo;
}

// "gps" fixed station of j_v_hradovici in demanovske_vrchy.lox (S-JTSK) and its WGS 84 position from PROJ.
const STATION = { east: -372234.807, north: -1203810.66, latitude: 48.985971893, longitude: 19.741300668 };

function setup(origin = new Vector3(-378000, -1201000, 1100), heightAt = (_e: number, _n: number): number | undefined => 1279.14) {
  const geo = fakeGeolocation(), states: LocationState[] = [], firstFixes: Vector3[] = [];
  const box = new Box3(new Vector3(-9000, -4000, -400), new Vector3(9000, 4000, 600));
  const location = new DeviceLocation({
    scene: new Group(), getModel: () => ({ origin, box }), heightAt, geolocation: geo as unknown as Geolocation, secure: true,
    onState: state => states.push(state), onFirstFix: fix => firstFixes.push(fix.local.clone()),
  });
  return { geo, states, firstFixes, location };
}

describe('device location', () => {
  it('places a GPS fix on the terrain at its S-JTSK position', () => {
    const { geo, states, firstFixes, location } = setup();
    location.start();
    expect(states.at(-1)).toEqual({ kind: 'waiting' });
    geo.success!({ coords: { latitude: STATION.latitude, longitude: STATION.longitude, altitude: 1320, accuracy: 4.2 } });
    const state = states.at(-1)!;
    expect(state.kind).toBe('fix');
    if (state.kind !== 'fix') return;
    expect(state.fix.east).toBeCloseTo(STATION.east, 1);
    expect(state.fix.north).toBeCloseTo(STATION.north, 1);
    expect(state.fix.heightSource).toBe('surface');
    expect(state.fix.local.x).toBeCloseTo(STATION.east + 378000, 1);
    expect(state.fix.local.z).toBeCloseTo(179.14, 6);
    expect(state.fix.outside).toBe(0);
    expect(location.group.visible).toBe(true);
    // Only the first fix recentres the view.
    geo.success!({ coords: { latitude: STATION.latitude, longitude: STATION.longitude, altitude: null, accuracy: 3 } });
    expect(firstFixes).toHaveLength(1);
    expect(formatFix(state.fix)).toMatchObject({ accuracy: '±4.2 m', coordinates: 'x -372235  y -1203811', height: '1279 m (terrain)' });
    location.stop();
    expect(geo.cleared).toBe(1); expect(location.group.visible).toBe(false); expect(states.at(-1)).toEqual({ kind: 'off' });
  });

  it('falls back to GPS height off the terrain and reports the distance outside the model', () => {
    const { geo, states, firstFixes, location } = setup(new Vector3(-390000, -1201000, 1100), () => undefined);
    location.start();
    geo.success!({ coords: { latitude: STATION.latitude, longitude: STATION.longitude, altitude: 1320, accuracy: 12 } });
    const state = states.at(-1)!;
    if (state.kind !== 'fix') throw new Error('expected a fix');
    expect(state.fix.heightSource).toBe('gps'); expect(state.fix.height).toBe(1320);
    expect(state.fix.outside).toBeCloseTo(STATION.east + 390000 - 9000, 0);
    expect(formatFix(state.fix).outside).toBe('8.8 km outside the model');
    expect(firstFixes).toHaveLength(0);
  });

  it('refuses models without S-JTSK coordinates and insecure pages', () => {
    const local = setup(new Vector3(0, 0, 0));
    local.location.start();
    expect(local.states.at(-1)?.kind).toBe('error'); expect(local.location.active).toBe(false);
    const geo = fakeGeolocation(), states: LocationState[] = [];
    new DeviceLocation({ scene: new Group(), getModel: () => undefined, heightAt: () => undefined, geolocation: geo as unknown as Geolocation, secure: false, onState: s => states.push(s) }).start();
    expect(states[0]).toMatchObject({ kind: 'error', message: expect.stringContaining('HTTPS') });
  });

  it('stops on permission errors and keeps waiting on timeouts', () => {
    const { geo, states, location } = setup();
    location.start();
    geo.failure!({ code: 3, message: 'timeout' });
    expect(location.active).toBe(true); expect(states.at(-1)).toEqual({ kind: 'waiting' });
    geo.failure!({ code: 1, message: 'denied' });
    expect(location.active).toBe(false);
    expect(states.at(-1)).toMatchObject({ kind: 'error', message: expect.stringContaining('permission') });
  });

  it('interpolates terrain height bilinearly inside the grid only', () => {
    const grid = { width: 2, height: 2, calibration: [100, 200, 10, 0, 0, 10] as [number, number, number, number, number, number], heights: Float64Array.from([0, 10, 20, 30]) };
    expect(surfaceHeightAt(grid, 105, 205)).toBeCloseTo(15, 9);
    expect(surfaceHeightAt(grid, 110, 210)).toBeCloseTo(30, 9);
    expect(surfaceHeightAt(grid, 99, 205)).toBeUndefined();
  });

  it('explains that embedded views block location', () => {
    expect(errorMessage({ code: 1, message: '' }, true)).toContain('embedded');
    expect(errorMessage({ code: 1, message: '' }, false)).toContain('browser settings');
  });
});
