import type { Vector3 } from 'three';
import { inSection, type Section } from './section';

/** A station for the profile, in scene coordinates. */
export type ProfileStation = { name: string; x: number; y: number; z: number; entrance: boolean };

/** Chainage along the section line from its first point (metres) and height (file z). */
export function toProfile(section: Section, point: { x: number; y: number; z: number }, originZ: number) {
  const dx = section.b.x - section.a.x, dy = section.b.y - section.a.y, length = Math.hypot(dx, dy);
  return { s: ((point.x - section.a.x) * dx + (point.y - section.a.y) * dy) / length, z: point.z + originZ };
}

const niceStep = (span: number) => [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000].find(step => span / step <= 12) ?? 2000;
const xml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The section as a vector profile at 1:1000 (1 m = 1 mm): terrain along the section line,
 * centreline shots and stations inside the slab, entrances named, with a chainage/height grid.
 */
export function sectionSvg(section: Section, shots: [Vector3, Vector3][], stations: ProfileStation[],
  terrainAt: (s: number) => number | undefined, originZ: number, title: string) {
  const inside = shots.filter(([a, b]) => inSection(section, a) && inSection(section, b))
    .map(([a, b]) => [toProfile(section, a, originZ), toProfile(section, b, originZ)] as const);
  const points = stations.filter(station => inSection(section, station)).map(station => ({ ...station, ...toProfile(section, station, originZ) }));
  const all = [...inside.flat(), ...points];
  // The cut runs from a little before the first point to a little past the second.
  const s0 = -section.overrun, s1 = section.length + section.overrun;
  const terrain: { s: number; z: number }[] = [];
  const step = Math.max(.5, (s1 - s0) / 600);
  for (let s = s0; s <= s1; s += step) { const z = terrainAt(s); if (z !== undefined) terrain.push({ s, z }); }
  const heights = [...all.map(p => p.z), ...terrain.map(p => p.z)];
  let z0 = Math.min(...heights), z1 = Math.max(...heights);
  if (!Number.isFinite(z0)) { z0 = originZ - 50; z1 = originZ + 50; }
  const zMargin = Math.max(10, (z1 - z0) * .08); z0 -= zMargin; z1 += zMargin;
  const left = 22, top = 16, width = s1 - s0, height = z1 - z0;
  const X = (s: number) => (left + s - s0).toFixed(2), Y = (z: number) => (top + z1 - z).toFixed(2);
  const lines: string[] = [];
  const gx = niceStep(width), gz = niceStep(height);
  for (let s = Math.ceil(s0 / gx) * gx; s <= s1; s += gx) lines.push(`<line class="grid" x1="${X(s)}" y1="${Y(z1)}" x2="${X(s)}" y2="${Y(z0)}"/><text class="axis" x="${X(s)}" y="${(top + height + 5).toFixed(2)}" text-anchor="middle">${Math.round(s)} m</text>`);
  for (let z = Math.ceil(z0 / gz) * gz; z <= z1; z += gz) lines.push(`<line class="grid" x1="${X(s0)}" y1="${Y(z)}" x2="${X(s1)}" y2="${Y(z)}"/><text class="axis" x="${left - 2}" y="${Y(z)}" text-anchor="end" dominant-baseline="middle">${Math.round(z)}</text>`);
  const terrainPath = terrain.length ? `<polyline class="terrain" points="${terrain.map(p => `${X(p.s)},${Y(p.z)}`).join(' ')}"/>` : '';
  const shotPaths = inside.length ? `<path class="shots" d="${inside.map(([a, b]) => `M${X(a.s)} ${Y(a.z)}L${X(b.s)} ${Y(b.z)}`).join('')}"/>` : '';
  const marks = points.filter(p => p.entrance).map(p => `<circle class="entrance" cx="${X(p.s)}" cy="${Y(p.z)}" r="1.2"/><text class="name" x="${(Number(X(p.s)) + 2).toFixed(2)}" y="${(Number(Y(p.z)) - 2).toFixed(2)}">${xml(p.name)}</text>`);
  const w = left + width + 8, h = top + height + 12;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w.toFixed(1)}mm" height="${h.toFixed(1)}mm" viewBox="0 0 ${w.toFixed(2)} ${h.toFixed(2)}">
<style>
.grid{stroke:#c8d2da;stroke-width:.15}.axis{font:2.4px sans-serif;fill:#456}.terrain{fill:none;stroke:#8a5a2b;stroke-width:.45}
.shots{fill:none;stroke:#0b3d91;stroke-width:.35;stroke-linecap:round}.entrance{fill:#fff;stroke:#000;stroke-width:.3}.name{font:2.6px sans-serif;fill:#000}
.title{font:bold 3.4px sans-serif;fill:#000}.note{font:2.4px sans-serif;fill:#456}
</style>
<rect width="100%" height="100%" fill="#fff"/>
<text class="title" x="${left}" y="6">${xml(title)}</text>
<text class="note" x="${left}" y="10.5">Vertical section ${Math.round(section.length)} m, bearing ${Math.round(section.lineBearing)}° (S-JTSK grid), slab ${section.width} m · 1:1000 (1 m = 1 mm) · heights Bpv</text>
${lines.join('\n')}
${terrainPath}
${shotPaths}
${marks.join('\n')}
</svg>
`;
}

/** Stations inside the slab with their chainage and height. */
export function sectionCsv(section: Section, stations: ProfileStation[], originZ: number) {
  const rows = stations.filter(station => inSection(section, station)).map(station => ({ ...station, ...toProfile(section, station, originZ) }))
    .sort((a, b) => a.s - b.s).map(p => `${p.name.replace(/;/g, ',')};${p.s.toFixed(2)};${p.z.toFixed(2)};${p.entrance ? 'entrance' : ''}`);
  return ['name;chainage;z;type', ...rows].join('\r\n') + '\r\n';
}
