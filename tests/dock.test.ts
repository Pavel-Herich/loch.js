import { describe, expect, it } from 'vitest';
import { ENTRANCE_LABELS, nextLabel, STATION_LABELS } from '../src/dock';
import { stationLabel, STATION_ENTRANCE, type Station } from '../src/lox-stations';
import { stationLabelMode, type StationOptions } from '../src/stations';
import { FULL_SIZE_METRES_PER_PIXEL, symbolScale, symbolSize } from '../src/station-labels';

const station = (flags: number, comment?: string): Station => ({ id: 1, surveyId: 2, name: '7', comment, flags, position: [0, 0, 1286.4], survey: 'krasna_dita', fullSurvey: 'krasna_dita.index' });
const options: StationOptions = { stations: true, entrance: true, fixed: false, continuation: false, label: 'number', entranceLabel: 'name', surface: true, underground: true, splay: true };

describe('dock label cycles', () => {
  it('cycles entrances name → altitude → off and stations number → altitude → survey → off', () => {
    const walk = (cycle: typeof ENTRANCE_LABELS) => { const seen = []; let value = 'none'; for (let i = 0; i < cycle.length; i++) { value = nextLabel(cycle, value).value; seen.push(value); } return seen; };
    expect(walk(ENTRANCE_LABELS)).toEqual(['name', 'altitude', 'none']);
    expect(walk(STATION_LABELS)).toEqual(['number', 'altitude', 'short', 'none']);
    // A label picked in the menu that is not in the cycle restarts it.
    expect(nextLabel(STATION_LABELS, 'comments').value).toBe('number');
  });

  it('labels entrances by their own mode and name them from the comment or survey', () => {
    expect(stationLabelMode(station(STATION_ENTRANCE), options)).toBe('name');
    expect(stationLabelMode(station(0), options)).toBe('number');
    expect(stationLabelMode(station(STATION_ENTRANCE), { ...options, entrance: false })).toBe('number');
    expect(stationLabel(station(STATION_ENTRANCE, 'Krásná Dita'), 'name')).toBe('Krásná Dita');
    expect(stationLabel(station(STATION_ENTRANCE), 'name')).toBe('krasna_dita');
    expect(stationLabel(station(0), 'short')).toBe('7@krasna_dita');
    expect(stationLabel(station(0), 'altitude')).toBe('1286 m');
  });

  it('sizes symbols by zoom: 25 % for the whole model, 100 % from a 100 m scale bar, smooth between', () => {
    const fit = 20;   // metres per pixel when the whole model is in view
    expect(symbolScale(fit, fit)).toBeCloseTo(.25, 9);
    expect(symbolScale(fit * 3, fit)).toBeCloseTo(.25, 9);
    expect(symbolScale(FULL_SIZE_METRES_PER_PIXEL, fit)).toBeCloseTo(1, 9);
    expect(symbolScale(.1, fit)).toBe(1);
    // Halfway in log zoom is halfway in size.
    expect(symbolScale(Math.sqrt(fit * FULL_SIZE_METRES_PER_PIXEL), fit)).toBeCloseTo(.625, 9);
    const sizes = [16, 8, 4, 2, 1].map(m => symbolScale(m, fit));
    expect(sizes.every((size, i) => i === 0 || size > sizes[i - 1])).toBe(true);
    // Models smaller than the full-size zoom always show full-size symbols.
    expect(symbolScale(.5, .4)).toBe(1);
  });

  it('makes nearer symbols larger and farther ones smaller, within 25–100 %', () => {
    expect(symbolSize(.5, 1000, 1000)).toBeCloseTo(.5, 9);
    expect(symbolSize(.5, 500, 1000)).toBeCloseTo(1, 9);
    expect(symbolSize(.5, 1500, 1000)).toBeCloseTo(1 / 3, 9);
    expect(symbolSize(.5, 5000, 1000)).toBe(.25);
    expect(symbolSize(.5, 100, 1000)).toBe(1);
    // Orthographic: no depth, zoom only.
    expect(symbolSize(.5, 3000)).toBe(.5);
  });
});
