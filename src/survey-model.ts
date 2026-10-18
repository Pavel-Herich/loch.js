import type { Model, Point } from './lox';
import { SHOT_DUPLICATE, SHOT_SPLAY, SHOT_SURFACE, undergroundShotRange, type Shot } from './lox-shots';
import type { Station } from './lox-stations';

export function survexShotFlags(flags: number) {
  return (flags & 1 ? SHOT_SURFACE : 0) | (flags & 2 ? SHOT_DUPLICATE : 0) | (flags & 4 ? SHOT_SPLAY : 0);
}
export function surveyText(bytes: Uint8Array) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return new TextDecoder('windows-1252').decode(bytes); }
}

/** Common centreline model for processed survey formats without triangle meshes. */
export class SurveyModel {
  private stations = new Map<number, Point>();
  private positions = new Map<string, { id: number; point: Point }>();
  private labels = new Map<string, { station: Station; flags?: number }>();
  private shots: Shot[] = [];
  private stationTypes = new Map<string, number>();
  private splayEnds = new Set<string>();
  private surveyStations = new Set<string>();
  point(point: Point) {
    if (!point.every(Number.isFinite)) throw new Error('Invalid survey coordinate');
    const key = point.join(','), existing = this.positions.get(key);
    if (existing) return existing.point;
    const id = this.stations.size;
    this.positions.set(key, { id, point }); this.stations.set(id, point);
    return point;
  }
  shot(from: Point, to: Point, flags: number) {
    from = this.point(from); to = this.point(to);
    this.shots.push({ from, to, flags });
    for (const point of [from, to]) {
      const key = point.join(',');
      this.stationTypes.set(key, (this.stationTypes.get(key) ?? 0) | (flags & SHOT_SURFACE ? 1 : 2));
    }
    this.surveyStations.add(from.join(','));
    if (flags & SHOT_SPLAY) this.splayEnds.add(to.join(',')); else this.surveyStations.add(to.join(','));
  }
  station(name: string, point: Point, surveyPath: string[] = [], flags?: number) {
    point = this.point(point);
    const key = JSON.stringify([surveyPath, name, point]);
    if (this.labels.has(key)) return;
    this.labels.set(key, { flags, station: {
      id: this.positions.get(point.join(','))!.id, surveyId: 0, name, position: point, flags: flags ?? 0,
      survey: surveyPath.at(-1) ?? '', fullSurvey: [...surveyPath].reverse().filter(Boolean).join('.'),
    } });
  }
  finish(title?: string): Model {
    if (!this.stations.size) throw new Error('No survey geometry in file');
    const stationDetails = Array.from(this.labels.values(), ({ station, flags }) => {
      const key = station.position.join(',');
      if (flags === undefined) station.flags = this.stationTypes.get(key) === 1 ? 1 : 0;
      if (this.splayEnds.has(key) && !this.surveyStations.has(key)) station.name = '-';
      return station;
    });
    let { minZ, maxZ } = undergroundShotRange(this.shots);
    if (!Number.isFinite(minZ)) { minZ = 0; maxZ = 0; }
    return { title: title?.trim() || undefined, stations: this.stations, stationDetails, shots: this.shots, minZ, maxZ, scraps: [], surfaces: [] };
  }
}
