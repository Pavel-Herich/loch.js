import { BufferGeometry, Float32BufferAttribute, Vector3 } from 'three';
import type { Point, Scrap } from './lox';

/** LOX has no normals. Rebuild connected surfaces before averaging face normals. */
export function createWallGeometry(scrap: Scrap, origin: Vector3): BufferGeometry {
  const points: Point[] = [], unique = new Map<string, number>();
  const remap = scrap.points.map(point => {
    const key = point.join(',');
    let index = unique.get(key);
    if (index === undefined) { index = points.length; unique.set(key, index); points.push(point); }
    return index;
  });
  // Original Loch reads triangles in this order before computing VTK normals.
  const triangles = scrap.triangles
    .map(([a, b, c]) => [remap[a], remap[c], remap[b]])
    .filter(triangle => {
      const [a, b, c] = triangle.map(index => new Vector3(...points[index]));
      return b.sub(a).cross(c.sub(a)).lengthSq() > 0;
    });
  const edges = new Map<number, number[]>();
  for (let face = 0; face < triangles.length; face++) {
    const triangle = triangles[face];
    for (let corner = 0; corner < 3; corner++) {
      const a = triangle[corner], b = triangle[(corner + 1) % 3];
      if (a === b) continue;
      const key = Math.min(a, b) * points.length + Math.max(a, b);
      const uses = edges.get(key);
      const use = face * 2 + (a < b ? 0 : 1);
      if (uses) uses.push(use); else edges.set(key, [use]);
    }
  }
  const neighbors: [number, boolean][][] = Array.from({ length: triangles.length }, () => []);
  for (const uses of edges.values()) {
    // An edge with more than two faces has no unambiguous surface orientation.
    if (uses.length !== 2) continue;
    const a = Math.floor(uses[0] / 2), b = Math.floor(uses[1] / 2);
    const opposite = uses[0] % 2 === uses[1] % 2;
    neighbors[a].push([b, opposite]); neighbors[b].push([a, opposite]);
  }
  const flipped = new Int8Array(triangles.length).fill(-1);
  for (let seed = 0; seed < triangles.length; seed++) {
    if (flipped[seed] !== -1) continue;
    flipped[seed] = 0;
    const queue = [seed];
    for (let next = 0; next < queue.length; next++) {
      const face = queue[next];
      for (const [neighbor, opposite] of neighbors[face]) {
        if (flipped[neighbor] !== -1) continue;
        flipped[neighbor] = flipped[face] ^ Number(opposite);
        queue.push(neighbor);
      }
    }
  }
  const faceNormals = triangles.map((triangle, face) => {
    if (flipped[face]) [triangle[1], triangle[2]] = [triangle[2], triangle[1]];
    const [a, b, c] = triangle.map(index => new Vector3(...points[index]));
    return b.sub(a).cross(c.sub(a)).normalize();
  });
  // Average only within connected smooth fans, splitting edges sharper than 120°.
  const parent = Int32Array.from({ length: triangles.length * 3 }, (_, i) => i);
  const find = (index: number): number => {
    while (parent[index] !== index) { parent[index] = parent[parent[index]]; index = parent[index]; }
    return index;
  };
  for (const uses of edges.values()) {
    if (uses.length !== 2) continue;
    const a = Math.floor(uses[0] / 2), b = Math.floor(uses[1] / 2);
    if (faceNormals[a].lengthSq() === 0 || faceNormals[b].lengthSq() === 0) continue;
    if (faceNormals[a].dot(faceNormals[b]) < -0.5) continue;
    for (let corner = 0; corner < 3; corner++) {
      const other = triangles[b].indexOf(triangles[a][corner]);
      if (other !== -1) parent[find(b * 3 + other)] = find(a * 3 + corner);
    }
  }
  const positions: number[] = [], normals: number[] = [], indices: number[] = [];
  const groups = new Map<number, number>();
  for (let face = 0; face < triangles.length; face++) {
    for (let corner = 0; corner < 3; corner++) {
      const group = find(face * 3 + corner);
      let index = groups.get(group);
      if (index === undefined) {
        index = groups.size; groups.set(group, index);
        const point = points[triangles[face][corner]];
        positions.push(point[0] - origin.x, point[1] - origin.y, point[2] - origin.z);
        normals.push(0, 0, 0);
      }
      indices.push(index);
      const normal = faceNormals[face];
      normals[index * 3] += normal.x; normals[index * 3 + 1] += normal.y; normals[index * 3 + 2] += normal.z;
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new Float32BufferAttribute(normals, 3));
  geometry.normalizeNormals();
  geometry.setIndex(indices);
  return geometry;
}
