import type { Model, Point } from './lox';
import { SHOT_DUPLICATE, SHOT_SPLAY, SHOT_SURFACE, undergroundShotRange, type Shot } from './lox-shots';
import type { Station } from './lox-stations';
import { generateLRUDWalls, NO_LRUD_FLAGS, type LRUD, type LRUDLeg } from './lrud';

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
  private passages: LRUDLeg[] = [];
  passage(from: Point, to: Point, fromLRUD: LRUD, toLRUD: LRUD, group: string) {
    this.passages.push({ from, to, section: { from: fromLRUD, to: toLRUD, profile: 1, threshold: 60, group } });
  }
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
    const parents = new Map<string, string>(), pairs = new Map<string, boolean>(), graph = new Map<string, Point[]>();
    const pair = (from: Point, to: Point) => JSON.stringify([from.join(','), to.join(',')].sort());
    const find = (key: string): string => {
      let root = key;
      while (parents.has(root) && parents.get(root) !== root) root = parents.get(root)!;
      while (parents.has(key) && parents.get(key) !== root) { const next = parents.get(key)!; parents.set(key, root); key = next; }
      return root;
    };
    for (const shot of this.shots) {
      const key = pair(shot.from, shot.to), allowed = !(shot.flags & NO_LRUD_FLAGS);
      pairs.set(key, Boolean(pairs.get(key) || allowed));
      if (allowed) {
        parents.set(find(shot.from.join(',')), find(shot.to.join(',')));
        for (const [from, to] of [[shot.from, shot.to], [shot.to, shot.from]]) {
          const key = from.join(','), neighbours = graph.get(key) ?? []; neighbours.push(to); graph.set(key, neighbours);
        }
      }
    }
    const passages = this.passages.flatMap(leg => {
      const key = pair(leg.from, leg.to);
      if (pairs.has(key)) return pairs.get(key) ? [leg] : [];
      if (find(leg.from.join(',')) !== find(leg.to.join(','))) return [];
      // Sparse Survex sections follow intervening survey legs rather than cutting across bends.
      const queue = [leg.from], previous = new Map<string, Point>([[leg.from.join(','), leg.from]]);
      for (let i = 0; i < queue.length && !previous.has(leg.to.join(',')); i++) {
        for (const point of graph.get(queue[i].join(',')) ?? []) if (!previous.has(point.join(','))) {
          previous.set(point.join(','), queue[i]); queue.push(point);
        }
      }
      if (!previous.has(leg.to.join(','))) return [];
      const path = [leg.to];
      while (path.at(-1)!.join(',') !== leg.from.join(',')) path.push(previous.get(path.at(-1)!.join(','))!);
      path.reverse();
      const distances = [0];
      for (let i = 1; i < path.length; i++) distances.push(distances[i - 1] + Math.hypot(...path[i].map((v, axis) => v - path[i - 1][axis])));
      const dimensions = distances.map(distance => leg.section.from.map((value, i) => value < 0 || leg.section.to[i] < 0
        ? -1 : value + (leg.section.to[i] - value) * distance / distances.at(-1)!) as LRUD);
      return path.slice(1).map((to, i) => ({ from: path[i], to, section: { ...leg.section, from: dimensions[i], to: dimensions[i + 1] } }));
    });
    const scraps = Array.from(generateLRUDWalls(passages));
    for (const scrap of scraps) for (const point of scrap.points) { minZ = Math.min(minZ, point[2]); maxZ = Math.max(maxZ, point[2]); }
    if (!Number.isFinite(minZ)) { minZ = 0; maxZ = 0; }
    return { title: title?.trim() || undefined, stations: this.stations, stationDetails, shots: this.shots, minZ, maxZ, scraps, surfaces: [] };
  }
}
