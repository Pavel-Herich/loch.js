import { Plane, Vector3 } from 'three';

/**
 * Vertical section: a vertical plane through two picked points (scene coordinates) and a slab
 * of the given width around it, from a little before the first point to a little past the
 * second. Everything outside is clipped away, and the view looks across the plane, so the
 * cave shows as a profile along the section line.
 */
export type Section = {
  a: Vector3; b: Vector3; width: number;
  /** Horizontal unit normal of the section plane. */
  normal: Vector3;
  /** Clipping planes that keep only the slab between the ends. */
  planes: Plane[];
  /** Horizontal unit vector from a to b, and how far the cut runs past each end. */
  along: Vector3; overrun: number;
  /** Viewing bearing (clockwise from +Y) that looks straight across the plane. */
  bearing: number;
  /** Bearing of the section line from a to b, for the card. */
  lineBearing: number;
  length: number;
};

export function makeSection(a: Vector3, b: Vector3, width: number): Section | undefined {
  const along = new Vector3(b.x - a.x, b.y - a.y, 0);
  const length = along.length();
  if (length < .5) return undefined;
  along.divideScalar(length);
  // Left of the line a → b, so the view looks across it with a on the left and b on the right.
  const normal = new Vector3(-along.y, along.x, 0);
  const half = width / 2, offset = normal.dot(a), start = along.dot(a), overrun = Math.max(10, length * .1);
  const planes = [new Plane(normal.clone(), -offset + half), new Plane(normal.clone().negate(), offset + half),
    new Plane(along.clone(), -start + overrun), new Plane(along.clone().negate(), start + length + overrun)];
  const deg = (x: number, y: number) => ((Math.atan2(x, y) * 180 / Math.PI) % 360 + 360) % 360;
  return { a: a.clone(), b: b.clone(), width, normal, planes, along, overrun, bearing: deg(normal.x, normal.y), lineBearing: deg(along.x, along.y), length };
}

/** Same section with another slab width. */
export function withWidth(section: Section, width: number) { return makeSection(section.a, section.b, width)!; }

/** Is a scene point inside the slab (and between its ends)? */
export function inSection(section: Section, point: { x: number; y: number }) {
  const dx = point.x - section.a.x, dy = point.y - section.a.y, s = section.along.x * dx + section.along.y * dy;
  return Math.abs(section.normal.x * dx + section.normal.y * dy) <= section.width / 2 && s >= -section.overrun && s <= section.length + section.overrun;
}

/** Slab widths offered by the slider (metres), from a thin cut to a broad band. */
export const SECTION_WIDTHS = [1, 2, 5, 10, 20, 50, 100, 200, 500];
