import { describe, expect, it } from 'vitest';
import { ENTRANCE_LABELS, nextLabel, STATION_LABELS } from '../src/dock';
import { stationLabel, STATION_ENTRANCE, type Station } from '../src/lox-stations';
import { stationLabelMode, type StationOptions } from '../src/stations';
import { entranceSize } from '../src/station-labels';

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

  it('shrinks entrance symbols with distance from full size down to 20 %', () => {
    expect(entranceSize(50)).toBe(1);
    expect(entranceSize(200)).toBe(1);
    expect(entranceSize(400)).toBeCloseTo(.5, 9);
    expect(entranceSize(1000)).toBeCloseTo(.2, 9);
    expect(entranceSize(20000)).toBe(.2);
  });
});
