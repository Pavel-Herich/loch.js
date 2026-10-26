/**
 * Mild clustering of object symbols on screen: only where several symbols crowd one small
 * cell (about the size of two symbols) are they drawn as one bubble with their count.
 * Tapping a bubble zooms in, where the symbols separate again.
 */
export const CLUSTER_CELL = 26;
export const CLUSTER_MIN = 4;
export const CLUSTER_RADIUS = 11;

export type ScreenPoint = { x: number; y: number };
/** A drawn bubble: screen position, count, and the mean position of its members in file coordinates. */
export type Cluster = { x: number; y: number; count: number; east: number; north: number; z: number };

/** Indices of points that share a crowded cell, grouped; everything else stays single. */
export function clusterPoints(points: ScreenPoint[], cell = CLUSTER_CELL, minimum = CLUSTER_MIN) {
  const cells = new Map<string, number[]>();
  points.forEach((point, index) => {
    const key = `${Math.floor(point.x / cell)},${Math.floor(point.y / cell)}`;
    const members = cells.get(key);
    if (members) members.push(index); else cells.set(key, [index]);
  });
  const groups: number[][] = [];
  const clustered = new Uint8Array(points.length);
  for (const members of cells.values()) {
    if (members.length < minimum) continue;
    groups.push(members);
    for (const index of members) clustered[index] = 1;
  }
  return { groups, clustered };
}

/** Mean screen and file position of a group. */
export function summarise(group: number[], screen: ScreenPoint[], world: (index: number) => [number, number, number]): Cluster {
  let x = 0, y = 0, east = 0, north = 0, z = 0;
  for (const index of group) {
    x += screen[index].x; y += screen[index].y;
    const [e, n, h] = world(index); east += e; north += n; z += h;
  }
  const count = group.length;
  return { x: x / count, y: y / count, count, east: east / count, north: north / count, z: z / count };
}

/** Bubbles that would overlap are merged into one (weighted by their counts). */
export function mergeClusters(clusters: Cluster[], distance = 2 * CLUSTER_RADIUS + 2) {
  const merged: Cluster[] = [];
  for (const cluster of [...clusters].sort((a, b) => b.count - a.count)) {
    const near = merged.find(other => Math.hypot(other.x - cluster.x, other.y - cluster.y) < distance);
    if (!near) { merged.push({ ...cluster }); continue; }
    const total = near.count + cluster.count, mix = (a: number, b: number) => (a * near.count + b * cluster.count) / total;
    Object.assign(near, { x: mix(near.x, cluster.x), y: mix(near.y, cluster.y), east: mix(near.east, cluster.east),
      north: mix(near.north, cluster.north), z: mix(near.z, cluster.z), count: total });
  }
  return merged;
}

export const clusterText = (count: number) => String(count);
/** Wider bubbles for three-digit counts. */
export const clusterRadius = (count: number) => count >= 100 ? CLUSTER_RADIUS + 3 : CLUSTER_RADIUS;

/** Round bubble with the count, edged in the symbol's colour. */
export function drawCluster(context: CanvasRenderingContext2D, cluster: Cluster, color: string) {
  context.save();
  context.beginPath(); context.arc(cluster.x, cluster.y, clusterRadius(cluster.count), 0, Math.PI * 2);
  context.fillStyle = '#162531e6'; context.fill();
  context.lineWidth = 3.2; context.strokeStyle = '#09131c'; context.stroke();
  context.lineWidth = 2; context.strokeStyle = color; context.stroke();
  context.fillStyle = '#ffffff'; context.font = `bold ${cluster.count >= 100 ? 10 : 11}px system-ui, sans-serif`;
  context.textAlign = 'center'; context.textBaseline = 'middle';
  context.fillText(clusterText(cluster.count), cluster.x, cluster.y + .5);
  context.restore();
}

/** Bubbles drawn in the last frame, per kind, for tapping. */
const drawn = new Map<string, Cluster[]>();
export function setDrawnClusters(kind: string, clusters: Cluster[]) { drawn.set(kind, clusters); }
export function clusterAt(x: number, y: number) {
  let best: Cluster | undefined, distance = Infinity;
  for (const clusters of drawn.values()) for (const cluster of clusters) {
    const d = Math.hypot(cluster.x - x, cluster.y - y);
    if (d <= clusterRadius(cluster.count) + 4 && d < distance) { best = cluster; distance = d; }
  }
  return best;
}
