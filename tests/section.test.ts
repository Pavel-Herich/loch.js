import { Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import { inSection, makeSection, withWidth } from '../src/section';

describe('vertical section', () => {
  const section = makeSection(new Vector3(0, 0, 10), new Vector3(100, 0, -40), 20)!;
  it('keeps a vertical slab around the line, whatever the height', () => {
    expect(inSection(section, { x: 50, y: 9 })).toBe(true);
    expect(inSection(section, { x: 500, y: -9 })).toBe(true);
    expect(inSection(section, { x: 50, y: 11 })).toBe(false);
    for (const [y, inside] of [[9, true], [11, false], [-11, false]] as const) {
      const point = new Vector3(30, y, -300);
      expect(section.planes.every(plane => plane.distanceToPoint(point) >= 0)).toBe(inside);
    }
  });
  it('looks straight across the line, a on the left', () => {
    expect(section.lineBearing).toBeCloseTo(90);
    expect(section.bearing).toBeCloseTo(0);
    expect(section.length).toBeCloseTo(100);
  });
  it('changes width and refuses a line without length', () => {
    expect(inSection(withWidth(section, 50), { x: 0, y: 24 })).toBe(true);
    expect(makeSection(new Vector3(1, 1, 0), new Vector3(1.1, 1, 50), 10)).toBeUndefined();
  });
});
