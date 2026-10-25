import { describe, expect, it } from 'vitest';
import { searchModel } from '../src/search';
import { STATION_ENTRANCE, type Station } from '../src/lox-stations';

let id = 0;
const station = (name: string, survey: string, path: string, z: number, flags = 0, comment?: string): Station =>
  ({ id: id++, surveyId: 0, name, comment, flags, position: [0, 0, z], survey, fullSurvey: path });
const stations = [
  station('1', 'krasna_dita', 'krasna_dita.ohniste', 1331, STATION_ENTRANCE, 'Krásná Dita'),
  station('12', 'krasna_dita', 'krasna_dita.ohniste', 1320),
  station('12', 'jelenia_priepast', 'jelenia_priepast.ohniste', 1480),
  station('13', 'jelenia_priepast', 'jelenia_priepast.ohniste', 1470),
  station('-', 'jelenia_priepast', 'jelenia_priepast.ohniste', 1470),
  station('1', 'jaskyna_v_hradovici', 'j_v_hradovici.ohniste', 1279, STATION_ENTRANCE, 'Jaskyňa v Hradovici 1 V1'),
];

describe('search', () => {
  it('lists every survey that uses a station number', () => {
    const { results } = searchModel('12', stations);
    expect(results.map(r => [r.kind, r.title, r.survey])).toEqual([
      ['station', '12', 'jelenia_priepast.ohniste'], ['station', '12', 'krasna_dita.ohniste']]);
  });

  it('puts stations first for a number and matches caves only by the whole number', () => {
    const more = [...stations, station('5', 'x', 'x', 900, STATION_ENTRANCE, 'Demanovska hora 12'), station('6', 'y', 'y', 900, STATION_ENTRANCE, 'brloh_2025_10_120')];
    expect(searchModel('12', more).results.map(r => [r.kind, r.title])).toEqual([
      ['station', '12'], ['station', '12'], ['cave', 'Demanovska hora 12']]);
  });

  it('narrows a number with @survey', () => {
    expect(searchModel('12@krasna', stations).results.map(r => r.survey)).toEqual(['krasna_dita.ohniste']);
  });

  it('finds caves by entrance name without diacritics and surveys by name', () => {
    const { results } = searchModel('hradov', stations);
    expect(results.map(r => [r.kind, r.title])).toEqual([['cave', 'Jaskyňa v Hradovici 1 V1'], ['survey', 'jaskyna_v_hradovici']]);
    const surveys = searchModel('jelenia', stations).results;
    expect(surveys).toEqual([{ kind: 'survey', title: 'jelenia_priepast', survey: 'jelenia_priepast.ohniste', altitude: 1475, position: [0, 0, 1475], count: 2 }]);
    expect(searchModel('krasna dita', stations).results[0]).toMatchObject({ kind: 'cave', title: 'Krásná Dita' });
  });
});
