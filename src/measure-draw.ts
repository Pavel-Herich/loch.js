import { Matrix4, type Camera, type Vector3 } from 'three';
import { metres, segment, type MeasurePoint } from './measure';

const LINE = '#ffd84d', LINK = '#7fe3ff', OUTLINE = '#09131c';

/** Measured points joined by a line with each length, plus the dashed link to the nearest surface point. */
export function drawMeasure(canvas: HTMLCanvasElement, points: MeasurePoint[], link: { from: MeasurePoint; to: MeasurePoint } | undefined,
  camera: Camera, width: number, height: number, origin: Vector3) {
  const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
  if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
    canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
  }
  const context = canvas.getContext('2d');
  if (!context) return;
  context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, width, height);
  camera.updateMatrixWorld();
  const m = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).elements;
  const screen = (p: MeasurePoint) => {
    const x = p.east - origin.x, y = p.north - origin.y, z = p.z - origin.z;
    const w = m[3] * x + m[7] * y + m[11] * z + m[15];
    if (w <= 0) return undefined;
    return { x: ((m[0] * x + m[4] * y + m[8] * z + m[12]) / w + 1) / 2 * width, y: (1 - (m[1] * x + m[5] * y + m[9] * z + m[13]) / w) / 2 * height };
  };
  context.lineJoin = 'round'; context.lineCap = 'round';
  context.font = '600 12px system-ui, sans-serif'; context.textAlign = 'center'; context.textBaseline = 'middle';
  const line = (a: MeasurePoint, b: MeasurePoint, color: string, dashed: boolean, text: string) => {
    const p = screen(a), q = screen(b);
    if (!p || !q) return;
    context.setLineDash(dashed ? [6, 5] : []);
    context.beginPath(); context.moveTo(p.x, p.y); context.lineTo(q.x, q.y);
    context.lineWidth = 5; context.strokeStyle = OUTLINE; context.stroke();
    context.lineWidth = 2.2; context.strokeStyle = color; context.stroke();
    context.setLineDash([]);
    const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
    context.lineWidth = 3.5; context.strokeStyle = OUTLINE; context.strokeText(text, mx, my - 10);
    context.fillStyle = color; context.fillText(text, mx, my - 10);
  };
  const dot = (point: MeasurePoint, color: string) => {
    const p = screen(point);
    if (!p) return;
    context.beginPath(); context.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
    context.fillStyle = color; context.fill(); context.lineWidth = 2; context.strokeStyle = OUTLINE; context.stroke();
  };
  for (let i = 1; i < points.length; i++) line(points[i - 1], points[i], LINE, false, metres(segment(points[i - 1], points[i]).slope));
  if (link) { line(link.from, link.to, LINK, true, metres(segment(link.from, link.to).slope)); dot(link.to, LINK); }
  for (const point of points) dot(point, LINE);
}
