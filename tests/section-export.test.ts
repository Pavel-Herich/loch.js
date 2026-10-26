import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { makeSection } from '../src/section';
import { sectionCsv, sectionSvg, toProfile } from '../src/section-export';

describe('section export', () => {
  const section = makeSection(new Vector3(0, 0, 0), new Vector3(100, 0, 0), 20)!;
  const stations = [
    { name: 'Entrance', x: 10, y: 2, z: 50, entrance: true },
    { name: '2@cave', x: 40, y: -5, z: 20, entrance: false },
    { name: 'far', x: 40, y: 30, z: 20, entrance: false },
  ];
  it('measures chainage along the line and file heights', () => {
    expect(toProfile(section, { x: 40, y: -5, z: 20 }, 1000)).toEqual({ s: 40, z: 1020 });
  });
  it('draws terrain, shots and entrances inside the slab at 1:1000', () => {
    const shots: [Vector3, Vector3][] = [[new Vector3(10, 2, 50), new Vector3(40, -5, 20)], [new Vector3(0, 50, 0), new Vector3(10, 50, 0)]];
    const svg = sectionSvg(section, shots, stations, s => 1060 - s * .2, 1000, 'Test cave: section 100 m');
    expect(svg).toMatch(/width="[\d.]+mm"/);
    expect(svg).toContain('<polyline class="terrain"');
    expect((svg.match(/M[\d.]+ [\d.]+L/g) ?? []).length).toBe(1);
    expect(svg).toContain('>Entrance</text>');
    expect(svg).not.toContain('far');
  });
  it('lists the stations in the slab by chainage', () => {
    expect(sectionCsv(section, stations, 1000).split('\r\n').slice(0, 3)).toEqual(['name;chainage;z;type', 'Entrance;10.00;1050.00;entrance', '2@cave;40.00;1020.00;']);
  });
});
