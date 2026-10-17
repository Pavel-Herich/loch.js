import * as THREE from 'three';
import { initializeAbout } from './about';
import { createCameraControls, resizeCamera, setCameraView, setPerspective, setTiltLocked, type ViewCamera } from './camera';
import { exceptionMessage, showLoadError, type LoadContext } from './errors';
import { parseLox, type Model, type Point } from './lox';
import { initializeMenus } from './menus';
import { createHeadlight, initializeLightControls } from './lighting';
import { WalkerControls } from './walker';
import { loadWallTexture, setTexturedWalls, wallMaterial } from './wall-material';
import type { GeometryBatch, LargeModel, LoadProgress } from './large-lox';
import { largeWallMaterial, LargeScene } from './large-scene';
import { ProgressiveView } from './progressive-view';
import { setStatusProgress, setStatusText } from './status';
import './style.css';

initializeAbout();

const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
const status = document.querySelector<HTMLElement>('#status')!;
const legend = document.querySelector<HTMLElement>('#legend')!;
const detail = document.querySelector<HTMLSelectElement>('#detail')!;
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x09131c);
let camera: ViewCamera = new THREE.PerspectiveCamera(45, 1, .01, 1e9);
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true }); renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
const controls = createCameraControls(camera, canvas);
const fillLight = new THREE.HemisphereLight(0xcfe9ff, 0x213847, 2.1); scene.add(fillLight);
const light = new THREE.DirectionalLight(0xffffff, 2); scene.add(light, light.target);
const headlight = createHeadlight(); scene.add(headlight, headlight.target);
const walls = new THREE.Group(), lines = new THREE.Group(); scene.add(walls, lines);
const boundingBox = new THREE.Box3Helper(new THREE.Box3(), 0xff0000);
boundingBox.visible = false;
scene.add(boundingBox);
let activeBox = new THREE.Box3();
let loadId = 0;
let largeWorker: Worker | undefined;
let loadingLargeWalls = false;
let largeScene: LargeScene | undefined;
let largeModel: { name: string; model: LargeModel; file: File } | undefined;
let sceneDirty = true;
let viewRefined = false;
let loadingError = false;
let lastViewChange = performance.now();
let progressiveView: ProgressiveView | undefined;
function invalidateView() {
  sceneDirty = true; viewRefined = false; lastViewChange = performance.now();
  progressiveView?.dispose(); progressiveView = undefined;
  if (!largeWorker) { setStatusProgress(status); updateLargeStatus(); }
}
function reportLoadError(error: unknown, context: LoadContext) {
  loadingError = true;
  showLoadError(status, error, context);
}
const lighting = initializeLightControls({ directional: light, fill: fillLight, headlight }, () => camera, () => controls.target, invalidateView);
const walker = new WalkerControls(controls, canvas);
const walkerCheckbox = document.querySelector<HTMLInputElement>('#walker')!;
const walkerButton = document.querySelector<HTMLButtonElement>('#walker-toggle')!;
walkerCheckbox.checked = false;
function setWalker(enabled: boolean) {
  walker.enabled = enabled; walkerCheckbox.checked = enabled;
  walkerButton.setAttribute('aria-pressed', String(enabled));
  walkerButton.title = enabled ? 'Disable Walker mode' : 'Enable Walker mode';
}
walkerCheckbox.addEventListener('change', () => setWalker(walkerCheckbox.checked));
walkerButton.addEventListener('click', () => setWalker(!walker.enabled));
controls.addEventListener('change', invalidateView);
canvas.addEventListener('webglcontextrestored', invalidateView);
const lockTilt = document.querySelector<HTMLInputElement>('#lock-tilt')!;
// Start unlocked even when the browser restores previous checkbox values.
lockTilt.checked = false;
lockTilt.addEventListener('change', () => setTiltLocked(controls, lockTilt.checked));
const perspective = document.querySelector<HTMLInputElement>('#perspective')!;
perspective.checked = true;
perspective.addEventListener('change', () => {
  camera = setPerspective(camera, controls, perspective.checked);
  invalidateView();
});
const wallsCulling = document.querySelector<HTMLInputElement>('#walls-culling')!;
wallsCulling.checked = false;
function applyWallCulling() {
  const side = wallsCulling.checked ? THREE.FrontSide : THREE.DoubleSide;
  const materials = new Set<THREE.Material>();
  for (const child of walls.children) if (child instanceof THREE.Mesh) {
    for (const material of Array.isArray(child.material) ? child.material : [child.material]) materials.add(material);
  }
  for (const material of materials) if (material.side !== side) { material.side = side; material.needsUpdate = true; }
  largeScene?.setCulling(wallsCulling.checked);
}
wallsCulling.addEventListener('change', () => { applyWallCulling(); invalidateView(); });
const texturedWalls = document.querySelector<HTMLInputElement>('#textured-walls')!;
texturedWalls.checked = false;
texturedWalls.addEventListener('change', () => {
  setTexturedWalls(texturedWalls.checked);
  if (texturedWalls.checked) void loadWallTexture().then(invalidateView).catch(error => {
    reportLoadError(error, { phase: 'Loading wall texture', source: 'limestone wall texture' });
  });
  invalidateView();
});
const menus = initializeMenus(view => {
  setCameraView(camera, controls, activeBox, view);
  lockTilt.checked = controls.minPolarAngle === controls.maxPolarAngle;
}, error => {
  loadingError = true; setStatusProgress(status);
  setStatusText(status, `Cannot change full screen: ${exceptionMessage(error)}`);
});
const c = new THREE.Color();
function altitudeColor(z: number, model: Pick<Model, 'minZ' | 'maxZ'>): THREE.Color {
  const t = model.maxZ === model.minZ ? .5 : (z - model.minZ) / (model.maxZ - model.minZ);
  return c.setHSL((1 - t) * .68, .82, .54).clone();
}
function offset(p: Point, origin: THREE.Vector3): [number, number, number] { return [p[0] - origin.x, p[1] - origin.y, p[2] - origin.z]; }
function clear(g: THREE.Group) {
  const materials = new Set<THREE.Material>();
  for (const object of [...g.children]) { g.remove(object); const mesh = object as THREE.Mesh; mesh.geometry?.dispose(); if (mesh.material) materials.add(mesh.material as THREE.Material); }
  for (const material of materials) material.dispose();
}
function updateLegend(model: Pick<Model, 'minZ' | 'maxZ'>) {
  const low = altitudeColor(model.minZ, model).getStyle(), high = altitudeColor(model.maxZ, model).getStyle();
  legend.innerHTML = `<span>${model.maxZ.toFixed(1)} m</span><div class="ramp" style="--low:${low};--high:${high}"></div><span>${model.minZ.toFixed(1)} m</span>`;
}
function draw(model: Model, label: string) {
  largeScene = undefined; largeModel = undefined;
  invalidateView();
  clear(walls); clear(lines);
  const bounds = new THREE.Box3();
  for (const p of model.stations.values()) bounds.expandByPoint(new THREE.Vector3(...p));
  for (const scrap of model.scraps) for (const p of scrap.points) bounds.expandByPoint(new THREE.Vector3(...p));
  const origin = bounds.getCenter(new THREE.Vector3());
  const centered = new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(), bounds.getSize(new THREE.Vector3()));
  activeBox = bounds.isEmpty() ? new THREE.Box3() : centered;
  boundingBox.box.copy(centered);
  boundingBox.visible = !bounds.isEmpty() && document.querySelector<HTMLInputElement>('#bounding-box')!.checked;
  for (const scrap of model.scraps) {
    const positions: number[] = [], colors: number[] = [], indices: number[] = [];
    for (const p of scrap.points) {
      positions.push(...offset(p, origin)); const col = altitudeColor(p[2], model); colors.push(col.r, col.g, col.b);
    }
    for (const triangle of scrap.triangles) indices.push(...triangle);
    if (!indices.length) continue;
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3)); g.setIndex(indices); g.computeVertexNormals();
    walls.add(new THREE.Mesh(g, wallMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: .85, metalness: 0 }))));
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
  updateLegend(model);
  applyWallCulling();
  setStatusText(status, `${label} · ${model.scraps.length} scraps · ${model.shots.length} centerline segments`);
  setCameraView(camera, controls, activeBox, 'fit');
}
async function loadFile(file: File) {
  const id = ++loadId;
  largeWorker?.terminate(); largeWorker = undefined;
  loadingLargeWalls = false; loadingError = false;
  invalidateView();
  setStatusText(status, `Opening ${file.name}…`); setStatusProgress(status, 0);
  let phase = 'Reading file';
  try {
    if (file.size > 32 * 1024 * 1024) { loadLargeFile(file, id); return; }
    const buffer = await file.arrayBuffer();
    if (id !== loadId) return;
    phase = 'Parsing LOX';
    const model = parseLox(buffer);
    phase = 'Rendering model';
    draw(model, file.name);
    menus.collapse();
  }
  catch (e) { if (id === loadId) reportLoadError(e, { phase, file }); }
}

function loadLargeFile(file: File, id: number) {
  const worker = new Worker(new URL('./large-lox.worker.ts', import.meta.url), { type: 'module' });
  largeWorker = worker;
  loadingLargeWalls = true;
  let phase = 'Reading LOX directory';
  let material: THREE.MeshStandardMaterial | undefined;
  function stop(error?: unknown) {
    worker.terminate();
    if (largeWorker === worker) largeWorker = undefined;
    loadingLargeWalls = false;
    invalidateView();
    if (material && !walls.children.length) material.dispose();
    if (error !== undefined && id === loadId) reportLoadError(error, { phase, file });
  }
  worker.onerror = event => {
    event.preventDefault();
    if (id === loadId) stop(new Error(event.message || 'Large-file worker failed'));
  };
  worker.onmessage = (event: MessageEvent<{
    type: string; model: LargeModel; batch: GeometryBatch;
    error: { name: string; message: string; stack?: string; code?: number };
  } & LoadProgress>) => {
    if (id !== loadId) return;
    const message = event.data;
    try {
      if (message.type === 'progress') {
        phase = message.phase;
        const percent = message.total ? Math.round(message.completed / message.total * 100) : 100;
        setStatusText(status, `${file.name} · ${phase} · ${percent}%`);
        setStatusProgress(status, percent / 100);
      } else if (message.type === 'ready') {
        phase = 'Preparing full-detail scene';
        const model = message.model;
        largeScene = undefined; largeModel = undefined;
        clear(walls); clear(lines);
        loadingLargeWalls = true;
        invalidateView();
        const origin = new THREE.Vector3(...model.origin);
        activeBox = new THREE.Box3(new THREE.Vector3(...model.min).sub(origin), new THREE.Vector3(...model.max).sub(origin));
        boundingBox.box.copy(activeBox);
        boundingBox.visible = document.querySelector<HTMLInputElement>('#bounding-box')!.checked;
        material = largeWallMaterial(model);
        largeScene = new LargeScene(walls, material, model);
        applyWallCulling();
        const vertices = new Float32Array(model.shots.length * 6), colors = new Float32Array(vertices.length);
        let p = 0;
        for (const shot of model.shots) for (const point of shot) {
          vertices.set(offset(point, origin), p);
          colors.set(altitudeColor(point[2], model).toArray(), p); p += 3;
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
        geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        lines.add(new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ vertexColors: true })));
        updateLegend(model); setCameraView(camera, controls, activeBox, 'fit'); menus.collapse();
        worker.postMessage({ acknowledge: true });
      } else if (message.type === 'batch') {
        phase = 'Rendering full-detail walls';
        largeScene!.add(message.batch);
        worker.postMessage({ acknowledge: true });
      } else if (message.type === 'done') {
        largeModel = { name: file.name, model: message.model, file };
        updateLargeStatus();
        stop();
      } else if (message.type === 'error') {
        stop(Object.assign(new Error(message.error.message), message.error));
      }
    } catch (error) { stop(error); }
  };
  worker.postMessage({ file });
}
function updateLargeStatus() {
  if (!largeModel || largeWorker || loadingError) return;
  const { name, model } = largeModel;
  setStatusText(status, `${name} · ${model.scraps} scraps · ${model.triangles.toLocaleString()} triangles · ${detail.value === 'full' ? 'full detail' : viewRefined ? 'automatic detail · stationary view complete' : 'automatic detail (moving preview)'}`);
}
detail.addEventListener('change', () => { loadingError = false; invalidateView(); });
const chooser = document.querySelector<HTMLInputElement>('#file')!;
chooser.addEventListener('change', () => { if (chooser.files?.[0]) void loadFile(chooser.files[0]); });
document.querySelector<HTMLInputElement>('#walls')!.addEventListener('change', e => { walls.visible = (e.target as HTMLInputElement).checked; invalidateView(); });
document.querySelector<HTMLInputElement>('#lines')!.addEventListener('change', e => { lines.visible = (e.target as HTMLInputElement).checked; invalidateView(); });
document.querySelector<HTMLInputElement>('#bounding-box')!.addEventListener('change', e => {
  boundingBox.visible = !activeBox.isEmpty() && (e.target as HTMLInputElement).checked;
  invalidateView();
});
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => { e.preventDefault(); const file = e.dataTransfer?.files[0]; if (file?.name.toLowerCase().endsWith('.lox')) void loadFile(file); });
const resize = () => { const w = canvas.clientWidth, h = canvas.clientHeight; if (!w || !h) return; renderer.setSize(w, h, false); resizeCamera(camera, w / h); invalidateView(); };
new ResizeObserver(resize).observe(canvas); resize();
function frame() {
  requestAnimationFrame(frame); controls.update();
  if (sceneDirty) {
    lighting.updateCamera();
    const visible = walls.visible;
    if (!loadingLargeWalls) largeScene?.update(camera, detail.value === 'full');
    if (loadingLargeWalls) walls.visible = false;
    renderer.render(scene, camera);
    walls.visible = visible; sceneDirty = false;
    return;
  }
  if (largeWorker || !largeScene || !largeModel || !walls.visible || detail.value === 'full' || loadingError
    || viewRefined || performance.now() - lastViewChange < 500) return;
  try {
    progressiveView ??= new ProgressiveView(renderer, scene, camera, largeScene);
    if (!progressiveView.complete) progressiveView.step();
    const percent = Math.round(progressiveView.progress * 100);
    setStatusText(status, `${largeModel.name} · Refining stationary view · ${percent}%`);
    setStatusProgress(status, percent / 100);
    if (progressiveView.complete) { viewRefined = true; setStatusProgress(status); updateLargeStatus(); }
  } catch (error) {
    progressiveView?.dispose(); progressiveView = undefined;
    reportLoadError(error, { phase: 'Refining stationary view', file: largeModel.file });
  }
}
frame();
async function loadSample() {
  const source = `${import.meta.env.BASE_URL}sample/demo.lox`;
  let phase = 'Fetching sample';
  try {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`Sample request failed: HTTP ${response.status} ${response.statusText}`);
    phase = 'Reading sample';
    const buffer = await response.arrayBuffer();
    if (loadId !== 0) return;
    phase = 'Parsing LOX';
    const model = parseLox(buffer);
    phase = 'Rendering model';
    draw(model, 'Sample cave');
  }
  catch (e) { if (loadId === 0) reportLoadError(e, { phase, source }); }
}
void loadSample();
