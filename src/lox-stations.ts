import type { Point } from './lox';

export const STATION_SURFACE = 1;
export type Survey = { id: number; parent: number; name: string };
export type Station = { id: number; surveyId: number; name: string; comment?: string; flags: number; position: Point; survey: string; fullSurvey: string };
export type StationLabel = 'none' | 'number' | 'short' | 'full' | 'altitude' | 'comments';

export function stationNameReference(data: DataView, start: number, dataSize: number) {
  return stationTextReference(data, start + 8, dataSize, 'name');
}
export function stationCommentReference(data: DataView, start: number, dataSize: number) {
  return stationTextReference(data, start + 16, dataSize, 'comment');
}
function stationTextReference(data: DataView, start: number, dataSize: number, kind: string) {
  const offset = data.getUint32(start, true), size = data.getUint32(start + 4, true);
  if (offset > dataSize || size > dataSize - offset) throw new Error(`Invalid station ${kind} pointer`);
  return { offset, size };
}

export function resolveStationSurveys(stations: Station[], surveys: Map<number, Survey>) {
  const paths = new Map<number, string>();
  for (const station of stations) {
    station.survey = surveys.get(station.surveyId)?.name ?? '';
    if (!paths.has(station.surveyId)) {
      const names: string[] = [], seen = new Set<number>();
      let survey = surveys.get(station.surveyId);
      while (survey && !seen.has(survey.id)) {
        seen.add(survey.id);
        if (survey.name) names.push(survey.name);
        survey = surveys.get(survey.parent);
      }
      paths.set(station.surveyId, names.join('.'));
    }
    station.fullSurvey = paths.get(station.surveyId)!;
  }
  return stations;
}

export function temporaryStation(station: Station) { return station.name === '.' || station.name === '-'; }
export function stationLabel(station: Station, mode: StationLabel) {
  if (mode === 'none' || temporaryStation(station)) return '';
  if (mode === 'comments') return station.comment?.trim() ?? '';
  if (mode === 'altitude') return `${station.position[2].toFixed(0)} m`;
  const name = station.name || String(station.id);
  const survey = mode === 'short' ? station.survey : mode === 'full' ? station.fullSurvey : '';
  return survey ? `${name}@${survey}` : name;
}
