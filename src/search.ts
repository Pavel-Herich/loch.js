import { STATION_ENTRANCE, temporaryStation, type Station } from './lox-stations';
import type { Point } from './lox';

export type SearchResult = {
  kind: 'cave' | 'survey' | 'station';
  /** Main text: cave name, survey name, or station number. */
  title: string;
  /** Where it belongs: the full survey path. */
  survey: string;
  altitude: number;
  /** Model file coordinates to centre on. */
  position: Point;
  /** Stations in a survey result. */
  count?: number;
};

const fold = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/**
 * Find stations by number (all surveys that use it, each with its survey path),
 * caves by entrance name, and surveys by name. `12@krasna` narrows a number to
 * matching surveys. A bare number lists stations first; text lists caves, surveys, then stations.
 */
export function searchModel(query: string, stations: Station[], limit = 200): { results: SearchResult[]; total: number } {
  const text = fold(query);
  if (!text) return { results: [], total: 0 };
  const [namePart, surveyPart] = text.includes('@') ? text.split('@', 2) : [text, ''];
  // A bare number is a station number: caves only match it as a whole word, surveys not at all.
  const numeric = /^\d+$/.test(text);
  const wholeNumber = new RegExp(`(^|\\D)${text}(\\D|$)`);
  const caveMatches = (name: string) => numeric ? wholeNumber.test(name) : name.includes(text);
  const caves: SearchResult[] = [], numbers: SearchResult[] = [];
  const surveys = new Map<string, { stations: Station[]; path: string }>();
  for (const station of stations) {
    if (temporaryStation(station)) continue;
    const survey = fold(station.survey), path = fold(station.fullSurvey);
    if (!surveyPart && station.flags & STATION_ENTRANCE && station.comment && caveMatches(fold(station.comment))) {
      caves.push({ kind: 'cave', title: station.comment.trim(), survey: station.fullSurvey || station.survey, altitude: station.position[2], position: station.position });
    }
    if (fold(station.name) === namePart && (!surveyPart || survey.includes(surveyPart) || path.includes(surveyPart))) {
      numbers.push({ kind: 'station', title: station.name, survey: station.fullSurvey || station.survey, altitude: station.position[2], position: station.position });
    }
    if (!surveyPart && !numeric && text.length >= 2 && survey.includes(text)) {
      const entry = surveys.get(station.fullSurvey) ?? { stations: [], path: station.fullSurvey };
      entry.stations.push(station); surveys.set(station.fullSurvey, entry);
    }
  }
  const surveyResults: SearchResult[] = [...surveys.values()].map(({ stations: members, path }) => {
    // Centre of the survey's stations.
    const sum = members.reduce((acc, station) => acc.map((value, i) => value + station.position[i]), [0, 0, 0]);
    const position = sum.map(value => value / members.length) as Point;
    return { kind: 'survey', title: members[0].survey, survey: path, altitude: position[2], position, count: members.length };
  });
  const byName = (a: SearchResult, b: SearchResult) => a.title.localeCompare(b.title, 'sk') || a.survey.localeCompare(b.survey, 'sk');
  const stationResults = numbers.sort((a, b) => a.survey.localeCompare(b.survey, 'sk'));
  // Station numbers come first when the query is one.
  const all = numeric || surveyPart ? [...stationResults, ...caves.sort(byName)]
    : [...caves.sort(byName), ...surveyResults.sort(byName), ...stationResults];
  return { results: all.slice(0, limit), total: all.length };
}
