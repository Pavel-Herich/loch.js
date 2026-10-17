import type { Point } from './lox';

export const SHOT_SURFACE = 1;
export const SHOT_DUPLICATE = 2;
export const SHOT_NOT_VISIBLE = 4;
export const SHOT_SPLAY = 16;
export type Shot = { from: Point; to: Point; flags: number };
export type ShotReference = { from: number; to: number; flags: number };

export function resolveShots(references: ShotReference[], stations: Map<number, Point>): Shot[] {
  const shots: Shot[] = [];
  for (const reference of references) {
    const from = stations.get(reference.from), to = stations.get(reference.to);
    if (from && to && !(reference.flags & SHOT_NOT_VISIBLE)) shots.push({ from, to, flags: reference.flags });
  }
  return shots;
}
