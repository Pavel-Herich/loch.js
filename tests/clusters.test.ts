import { describe, expect, it } from 'vitest';
import { clusterAt, clusterPoints, mergeClusters, setDrawnClusters, summarise } from '../src/clusters';

describe('clusterPoints', () => {
  it('groups only crowded cells (4 or more symbols)', () => {
    const crowd = [{ x: 1, y: 1 }, { x: 5, y: 3 }, { x: 10, y: 8 }, { x: 20, y: 20 }];
    const loose = [{ x: 100, y: 100 }, { x: 110, y: 104 }, { x: 115, y: 110 }, { x: 300, y: 300 }];
    const { groups, clustered } = clusterPoints([...crowd, ...loose]);
    expect(groups).toEqual([[0, 1, 2, 3]]);
    expect(Array.from(clustered)).toEqual([1, 1, 1, 1, 0, 0, 0, 0]);
  });
  it('summarises a group at its mean and finds it under a tap', () => {
    const screen = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }, { x: 10, y: 10 }];
    const bubble = summarise([0, 1, 2, 3], screen, index => [index * 10, 0, 100]);
    expect(bubble).toMatchObject({ x: 5, y: 5, count: 4, east: 15, north: 0, z: 100 });
    setDrawnClusters('test', [bubble]);
    expect(clusterAt(8, 6)).toBe(bubble);
    expect(clusterAt(40, 40)).toBeUndefined();
    setDrawnClusters('test', []);
  });
  it('merges bubbles that would overlap', () => {
    const a = { x: 0, y: 0, count: 6, east: 0, north: 0, z: 0 }, b = { x: 20, y: 0, count: 2, east: 80, north: 0, z: 0 };
    const merged = mergeClusters([a, b, { x: 200, y: 0, count: 4, east: 1, north: 1, z: 1 }]);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({ count: 8, x: 5, east: 20 });
  });
});
