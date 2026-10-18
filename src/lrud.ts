import type { Point, Scrap } from './lox';
import { SHOT_SURFACE, SHOT_DUPLICATE, SHOT_NOT_VISIBLE, SHOT_NOT_LRUD, SHOT_SPLAY, type ShotReference } from './lox-shots';

export type LRUD = [number, number, number, number];
export type LRUDSection = { from: LRUD; to: LRUD; profile: number; threshold: number; group?: string };
export type LRUDLeg = { from: Point; to: Point; section: LRUDSection };
export const LRUD_BATCH_LEGS = 1024;
export const NO_LRUD_FLAGS = SHOT_SURFACE | SHOT_DUPLICATE | SHOT_NOT_VISIBLE | SHOT_NOT_LRUD | SHOT_SPLAY;
const EPS = 1e-10;
const sub = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Point, b: Point): Point => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function unit(v: Point): Point { const length = Math.hypot(...v); return length > EPS ? v.map(n => n / length) as Point : [0, 0, 0]; }
function usable(values: LRUD) {
  return values.every(Number.isFinite) && Math.max(0, values[0]) + Math.max(0, values[1]) > EPS
    && Math.max(0, values[2]) + Math.max(0, values[3]) > EPS;
}
export function readLoxLRUD(data: DataView, start: number): LRUDSection | undefined {
  const flags = data.getUint32(start + 72, true), profile = data.getUint32(start + 76, true);
  if (flags & NO_LRUD_FLAGS || profile < 1 || profile > 4) return;
  const values = Array.from({ length: 8 }, (_, i) => data.getFloat64(start + 8 + i * 8, true));
  if (!values.every(Number.isFinite)) throw new Error('Invalid LOX LRUD dimension');
  const threshold = data.getFloat64(start + 84, true);
  if (!Number.isFinite(threshold)) throw new Error('Invalid LOX LRUD vertical threshold');
  return { from: values.slice(0, 4) as LRUD, to: values.slice(4) as LRUD, profile, threshold,
    group: String(data.getUint32(start + 80, true)) };
}
export function loxLRUDLegs(references: ShotReference[], stations: Map<number, Point>): LRUDLeg[] {
  return references.flatMap(ref => {
    const from = stations.get(ref.from), to = stations.get(ref.to);
    return ref.section && from && to && !(ref.flags & NO_LRUD_FLAGS) ? [{ from, to, section: ref.section }] : [];
  });
}

/** Loft measured station profiles; retain no more than 1024 legs of output at a time. */
export function* generateLRUDWalls(source: LRUDLeg[]): Generator<Scrap> {
  const legs = source.filter(leg => usable(leg.section.from) && usable(leg.section.to)
    && leg.from.every(Number.isFinite) && leg.to.every(Number.isFinite) && Math.hypot(...sub(leg.to, leg.from)) > EPS);
  const key = (point: Point, leg: LRUDLeg) => JSON.stringify([leg.section.group ?? '', point]);
  const nodes = new Map<string, { leg: LRUDLeg; from: boolean }[]>();
  for (const leg of legs) for (const from of [true, false]) {
    const id = key(from ? leg.from : leg.to, leg), edges = nodes.get(id) ?? [];
    edges.push({ leg, from }); nodes.set(id, edges);
  }
  let mesh: Scrap = { points: [], triangles: [] }, vertices = new Map<string, number>(), count = 0;
  const vertex = (point: Point) => {
    const key = JSON.stringify(point), existing = vertices.get(key);
    if (existing !== undefined) return existing;
    const index = mesh.points.length; mesh.points.push(point); vertices.set(key, index); return index;
  };
  const triangle = (a: number, b: number, c: number) => {
    if (Math.hypot(...cross(sub(mesh.points[b], mesh.points[a]), sub(mesh.points[c], mesh.points[a]))) > EPS) mesh.triangles.push([a, b, c]);
  };
  function ring(leg: LRUDLeg, from: boolean) {
    const centre = from ? leg.from : leg.to, values = from ? leg.section.from : leg.section.to;
    let direction = unit(sub(leg.to, leg.from));
    const edges = nodes.get(key(centre, leg))!;
    if (edges.length === 2) {
      const other = edges.find(edge => edge.leg !== leg)!;
      const outward = unit(sub(other.from ? other.leg.to : other.leg.from, centre));
      const average = unit(direction.map((v, i) => v + outward[i] * (from ? -1 : 1)) as Point);
      if (Math.hypot(...average) > EPS) direction = average;
    }
    let right = unit([direction[1], -direction[0], 0]), up: Point = [0, 0, 1];
    if (Math.hypot(...right) < EPS) { right = [1, 0, 0]; up = [0, direction[2] > 0 ? -1 : 1, 0]; }
    else if (Math.abs(Math.asin(Math.max(-1, Math.min(1, direction[2])))) * 180 / Math.PI >= Math.max(0, Math.min(90, leg.section.threshold))) up = unit(cross(right, direction));
    const diagonal = leg.section.profile === 2 ? 1 : leg.section.profile === 3 ? .5 : Math.SQRT1_2;
    const profile = leg.section.profile === 4
      ? [[0, 1], [.5, .75], [.8, 0], [1, -1], [0, -1], [-1, -1], [-.8, 0], [-.5, .75]]
      : [[0, 1], [diagonal, diagonal], [1, 0], [diagonal, -diagonal], [0, -1], [-diagonal, -diagonal], [-1, 0], [-diagonal, diagonal]];
    const points = profile.map(([x, y]) => centre.map((v, i) => v
      + right[i] * x * Math.max(0, values[x < 0 ? 0 : 1])
      + up[i] * y * Math.max(0, values[y < 0 ? 3 : 2])) as Point);
    return points.map(vertex);
  }
  for (const leg of legs) {
    const from = ring(leg, true), to = ring(leg, false);
    for (let i = 0; i < 8; i++) {
      const next = (i + 1) % 8;
      triangle(from[i], from[next], to[next]); triangle(from[i], to[next], to[i]);
    }
    for (const start of [true, false]) if (nodes.get(key(start ? leg.from : leg.to, leg))!.length === 1) {
      const centre = vertex(start ? leg.from : leg.to);
      const vertices = start ? from : to;
      for (let i = 0; i < 8; i++) {
        const next = (i + 1) % 8;
        if (start) triangle(centre, vertices[next], vertices[i]); else triangle(centre, vertices[i], vertices[next]);
      }
    }
    if (++count === LRUD_BATCH_LEGS) { if (mesh.triangles.length) yield mesh; mesh = { points: [], triangles: [] }; vertices = new Map(); count = 0; }
  }
  if (mesh.triangles.length) yield mesh;
}
