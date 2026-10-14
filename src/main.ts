import * as THREE from 'three';
import { createCameraControls } from './camera';
import { parseLox, type Model, type Point } from './lox';
import './style.css';

const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
const status = document.querySelector<HTMLElement>('#status')!;
const legend = document.querySelector<HTMLElement>('#legend')!;
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x09131c);
const camera = new THREE.PerspectiveCamera(45, 1, .01, 1e9);
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true }); renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
const controls = createCameraControls(camera, canvas);
scene.add(new THREE.HemisphereLight(0xcfe9ff, 0x213847, 2.1));
const light = new THREE.DirectionalLight(0xffffff, 2); light.position.set(1, 2, 3); scene.add(light);
const walls = new THREE.Group(), lines = new THREE.Group(); scene.add(walls, lines);
let activeBox = new THREE.Box3();
const c = new THREE.Color();
function altitudeColor(z: number, model: Model): THREE.Color {
  const t = model.maxZ === model.minZ ? .5 : (z - model.minZ) / (model.maxZ - model.minZ);
  return c.setHSL((1 - t) * .68, .82, .54).clone();
}
function offset(p: Point, origin: THREE.Vector3): [number, number, number] { return [p[0] - origin.x, p[1] - origin.y, p[2] - origin.z]; }
function clear(g: THREE.Group) {
  for (const object of [...g.children]) { g.remove(object); const mesh = object as THREE.Mesh; (mesh.geometry as THREE.BufferGeometry)?.dispose(); (mesh.material as THREE.Material)?.dispose(); }
}
function fit(box: THREE.Box3) {
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
  const radius = Math.max(size.length() / 2, 1);
  controls.target.copy(center);
  camera.position.copy(center).add(new THREE.Vector3(radius * 1.25, -radius * 1.8, radius * 1.1));
  camera.near = Math.max(radius / 10000, .001); camera.far = radius * 100; camera.updateProjectionMatrix(); controls.update();
}
function draw(model: Model, label: string) {
  clear(walls); clear(lines);
  const bounds = new THREE.Box3();
  for (const p of model.stations.values()) bounds.expandByPoint(new THREE.Vector3(...p));
  for (const scrap of model.scraps) for (const p of scrap.points) bounds.expandByPoint(new THREE.Vector3(...p));
  const origin = bounds.getCenter(new THREE.Vector3());
  const centered = new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(), bounds.getSize(new THREE.Vector3()));
  activeBox = centered;
  for (const scrap of model.scraps) {
    const positions: number[] = [], colors: number[] = [], indices: number[] = [];
    for (const p of scrap.points) {
      positions.push(...offset(p, origin)); const col = altitudeColor(p[2], model); colors.push(col.r, col.g, col.b);
    }
    for (const triangle of scrap.triangles) indices.push(...triangle);
    if (!indices.length) continue;
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3)); g.setIndex(indices); g.computeVertexNormals();
    walls.add(new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: .85, metalness: 0 })));
  }
  const vertices: number[] = [], colors: number[] = [];
  for (const [a, b] of model.shots) for (const p of [a, b]) {
    vertices.push(...offset(p, origin)); const col = altitudeColor(p[2], model); colors.push(col.r, col.g, col.b);
  }
  if (vertices.length) {
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    lines.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true })));
  }
  const low = altitudeColor(model.minZ, model).getStyle(), high = altitudeColor(model.maxZ, model).getStyle();
  legend.innerHTML = `<span>${model.maxZ.toFixed(1)} m</span><div class="ramp" style="--low:${low};--high:${high}"></div><span>${model.minZ.toFixed(1)} m</span>`;
  status.textContent = `${label} · ${model.scraps.length} scraps · ${model.shots.length} centerline segments`;
  fit(activeBox);
}
async function loadFile(file: File) {
  status.textContent = `Opening ${file.name}…`;
  try { draw(parseLox(await file.arrayBuffer()), file.name); }
  catch (e) { status.textContent = `Cannot read ${file.name}: ${e instanceof Error ? e.message : String(e)}`; }
}
const chooser = document.querySelector<HTMLInputElement>('#file')!;
chooser.addEventListener('change', () => { if (chooser.files?.[0]) void loadFile(chooser.files[0]); });
document.querySelector<HTMLInputElement>('#walls')!.addEventListener('change', e => { walls.visible = (e.target as HTMLInputElement).checked; });
document.querySelector<HTMLInputElement>('#lines')!.addEventListener('change', e => { lines.visible = (e.target as HTMLInputElement).checked; });
document.querySelector('#fit')!.addEventListener('click', () => fit(activeBox));
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => { e.preventDefault(); const file = e.dataTransfer?.files[0]; if (file?.name.toLowerCase().endsWith('.lox')) void loadFile(file); });
const resize = () => { const w = canvas.clientWidth, h = canvas.clientHeight; if (!w || !h) return; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); };
new ResizeObserver(resize).observe(canvas); resize();
function frame() { requestAnimationFrame(frame); controls.update(); renderer.render(scene, camera); } frame();
fetch(`${import.meta.env.BASE_URL}sample/demo.lox`).then(r => { if (!r.ok) throw Error('Sample missing'); return r.arrayBuffer(); }).then(b => draw(parseLox(b), 'Sample cave')).catch(e => status.textContent = String(e));
