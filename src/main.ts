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
import { WallPreparation } from './wall-preparation';
import { setStatusProgress, setStatusText } from './status';
import { surfacePoint, type Surface } from './lox-surface';
import { SurfaceScene, initializeSurfaceControls } from './surface';
import { CentrelineScene, initializeCentrelineControls } from './centreline';
import { initializeIndicators } from './indicators';
import { displayProjectTitle } from './lox-title';
import { initializeAutorotateControls } from './autorotate';
import { animateRotationCentre, RotationCentrePicker } from './pivot';
import { DeviceLocation, formatFix, markerScreenPosition, type LocationState } from './location';
import { modelFileFormat, parseModelFile } from './model-file';
import './style.css';

initializeAbout();

const canvas = document.querySelector<HTMLCanvasElement>('#view')!;
const status = document.querySelector<HTMLElement>('#status')!;
const legend = document.querySelector<HTMLElement>('#legend')!;
const projectTitle = document.querySelector<HTMLElement>('#project-title')!;
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
const surfaceGroup = new THREE.Group(); scene.add(surfaceGroup);
const boundingBox = new THREE.Box3Helper(new THREE.Box3(), 0xff0000);
boundingBox.visible = false;
scene.add(boundingBox);
let activeBox = new THREE.Box3();
/** File coordinates of the scene origin; the scene is drawn relative to it. */
const worldOrigin = new THREE.Vector3();
let hasModel = false;
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
let preparationPending = false;
let preparation: WallPreparation | undefined;
let collapseAfterRender = false;
function reportPreparation() {
  if (!largeModel) return;
  const phase = preparation?.phase ?? 'Preparing geometry';
  const progress = preparation ? preparation.progress : 0;
  setStatusText(status, `${largeModel.name} · ${phase}${progress === null ? '…' : ` · ${Math.round(progress * 100)}%`}`);
  setStatusProgress(status, progress);
}
function invalidateView() {
  sceneDirty = true; viewRefined = false; lastViewChange = performance.now();
  progressiveView?.dispose(); progressiveView = undefined;
  preparation?.dispose(); preparation = undefined;
  if (!largeWorker && !loadingError) {
    if (preparationPending && largeModel && walls.visible) reportPreparation();
    else { setStatusProgress(status); updateLargeStatus(); }
  }
}
function reportLoadError(error: unknown, context: LoadContext) {
  loadingError = true; preparationPending = false;
  collapseAfterRender = false;
  preparation?.dispose(); preparation = undefined;
  showLoadError(status, error, context);
}
const lighting = initializeLightControls({ directional: light, fill: fillLight, headlight }, () => camera, () => controls.target, invalidateView);
const surfaceScene = new SurfaceScene(surfaceGroup, invalidateView, error => reportLoadError(error, {
  phase: 'Loading surface image', ...(largeModel ? { file: largeModel.file } : { source: 'LOX surface image' }),
}));
initializeSurfaceControls(surfaceScene);
const centreline = new CentrelineScene(lines, invalidateView, document.querySelector<HTMLCanvasElement>('#station-labels')!);
initializeCentrelineControls(centreline);
const indicators = initializeIndicators(canvas, () => camera, () => controls.target);
const autorotate = initializeAutorotateControls(controls);
const walker = new WalkerControls(controls, canvas);
const walkerCheckbox = document.querySelector<HTMLInputElement>('#walker')!;
const walkerButton = document.querySelector<HTMLButtonElement>('#walker-toggle')!;
walkerCheckbox.checked = false;
function setWalker(enabled: boolean) {
  pivotPicker.enabled = false;
  walker.enabled = enabled; walkerCheckbox.checked = enabled;
  walkerButton.setAttribute('aria-pressed', String(enabled));
  walkerButton.title = enabled ? 'Disable Walker mode' : 'Enable Walker mode';
}
walkerCheckbox.addEventListener('change', () => setWalker(walkerCheckbox.checked));
walkerButton.addEventListener('click', () => setWalker(!walker.enabled));
controls.addEventListener('change', invalidateView);
const pivotButton = document.querySelector<HTMLButtonElement>('#pivot-toggle')!;
const pivotHint = document.querySelector<HTMLElement>('#pivot-hint')!;
const pivotMarker = document.querySelector<HTMLElement>('#pivot-marker')!;
let pivotMarkerTimer = 0;
const pivotPicker = new RotationCentrePicker({
  canvas, controls, getCamera: () => camera, getRoots: () => [walls, surfaceGroup, lines],
  onModeChange: active => {
    pivotButton.setAttribute('aria-pressed', String(active));
    pivotButton.title = active ? 'Cancel setting the rotation centre' : 'Set rotation centre: click the model';
    pivotHint.textContent = 'Click the model to set the rotation centre · Esc cancels';
    pivotHint.hidden = !active;
  },
  onMiss: () => { pivotHint.textContent = 'Nothing there. Click a wall, the surface or a centreline shot · Esc cancels'; },
  onPicked: () => {
    // Restart the fade so repeated picks each show the marker.
    pivotMarker.hidden = true; void pivotMarker.offsetWidth; pivotMarker.hidden = false;
    clearTimeout(pivotMarkerTimer);
    pivotMarkerTimer = window.setTimeout(() => { pivotMarker.hidden = true; }, 1500);
  },
});
pivotButton.addEventListener('click', () => { pivotPicker.enabled = !pivotPicker.enabled; });
document.querySelector<HTMLButtonElement>('#pivot-menu')!.addEventListener('click', () => { pivotPicker.enabled = true; });
const locateButton = document.querySelector<HTMLButtonElement>('#locate-toggle')!;
const locationDot = document.querySelector<HTMLElement>('#location-dot')!;
const locationInfo = document.querySelector<HTMLElement>('#location-info')!;
let locationInfoTimer = 0;
function showLocationState(state: LocationState) {
  const active = state.kind === 'waiting' || state.kind === 'fix';
  locateButton.setAttribute('aria-pressed', String(active));
  locateButton.title = active ? 'Stop showing my location' : 'Show my location (GPS)';
  locateButton.setAttribute('aria-label', locateButton.title);
  clearTimeout(locationInfoTimer);
  locationInfo.classList.toggle('error', state.kind === 'error');
  if (state.kind === 'off') locationInfo.hidden = true;
  else if (state.kind === 'waiting') { locationInfo.textContent = 'Waiting for GPS fix…'; locationInfo.hidden = false; }
  else if (state.kind === 'error') {
    locationInfo.textContent = state.message; locationInfo.hidden = false;
    locationInfoTimer = window.setTimeout(() => { locationInfo.hidden = true; }, 8000);
  } else {
    const text = formatFix(state.fix);
    locationInfo.replaceChildren();
    const first = document.createElement('div');
    const accuracy = document.createElement('strong'); accuracy.textContent = text.accuracy;
    first.append(accuracy, ` · ${text.height}`);
    const second = document.createElement('div'); second.textContent = text.outside || text.coordinates;
    locationInfo.append(first, second); locationInfo.hidden = false;
  }
  invalidateView();
}
const deviceLocation = new DeviceLocation({
  scene,
  getModel: () => hasModel ? { origin: worldOrigin, box: activeBox } : undefined,
  heightAt: (east, north) => surfaceScene.heightAt(east, north),
  onState: showLocationState,
  onFirstFix: fix => animateRotationCentre(camera, controls, fix.local),
});
function toggleLocation() { if (deviceLocation.active) deviceLocation.stop(); else deviceLocation.start(); }
locateButton.addEventListener('click', toggleLocation);
document.querySelector<HTMLButtonElement>('#locate-menu')!.addEventListener('click', toggleLocation);
function updateLocationDot() {
  const fix = deviceLocation.state.kind === 'fix' ? deviceLocation.state.fix : undefined;
  const width = canvas.clientWidth, height = canvas.clientHeight;
  const screen = fix && deviceLocation.active ? markerScreenPosition(fix.local, camera, width, height) : undefined;
  if (!screen) { locationDot.hidden = true; return; }
  // Keep an off-screen position visible at the edge, pointing the way to it.
  const x = Math.min(Math.max(screen.x, 10), width - 10), y = Math.min(Math.max(screen.y, 10), height - 10);
  locationDot.classList.toggle('edge', !screen.onScreen);
  locationDot.style.transform = `translate(${x}px, ${y}px)`;
  locationDot.hidden = false;
}
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
function updateProjectTitle(title: string | undefined, filename: string) {
  projectTitle.textContent = displayProjectTitle(title, filename); projectTitle.hidden = false;
}
function draw(model: Model, label: string) {
  largeScene = undefined; largeModel = undefined; preparationPending = false;
  invalidateView();
  clear(walls); centreline.clear(); surfaceScene.clear();
  const bounds = new THREE.Box3();
  for (const p of model.stations.values()) bounds.expandByPoint(new THREE.Vector3(...p));
  for (const scrap of model.scraps) for (const p of scrap.points) bounds.expandByPoint(new THREE.Vector3(...p));
  for (const surface of model.surfaces) for (let i = 0; i < surface.heights.length; i++) {
    bounds.expandByPoint(new THREE.Vector3(...surfacePoint(surface, i, surface.heights[i])));
  }
  const origin = bounds.getCenter(new THREE.Vector3());
  const centered = new THREE.Box3().setFromCenterAndSize(new THREE.Vector3(), bounds.getSize(new THREE.Vector3()));
  activeBox = bounds.isEmpty() ? new THREE.Box3() : centered;
  worldOrigin.copy(origin); hasModel = !bounds.isEmpty();
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
  updateProjectTitle(model.title, label);
  centreline.setModel(model, origin);
  for (const surface of model.surfaces) surfaceScene.add(surface, origin);
  updateLegend(model);
  applyWallCulling();
  setStatusText(status, `${label} · ${model.scraps.length} scraps · ${model.shots.length} centerline segments`);
  setCameraView(camera, controls, activeBox, 'fit');
  deviceLocation.update();
}
async function loadFile(file: File) {
  const id = ++loadId;
  collapseAfterRender = false;
  menus.expand();
  largeWorker?.terminate(); largeWorker = undefined;
  loadingLargeWalls = false; loadingError = false; preparationPending = false;
  surfaceScene.clear();
  invalidateView();
  setStatusText(status, `Opening ${file.name}…`); setStatusProgress(status, 0);
  let phase = 'Reading file';
  try {
    if (modelFileFormat(file.name) === 'lox' && file.size > 32 * 1024 * 1024) { loadLargeFile(file, id); return; }
    const buffer = await file.arrayBuffer();
    if (id !== loadId) return;
    phase = `Parsing ${modelFileFormat(file.name)?.toUpperCase() ?? 'survey file'}`;
    const model = parseModelFile(buffer, file.name);
    phase = 'Rendering model';
    draw(model, file.name);
    collapseAfterRender = true;
  }
  catch (e) { if (id === loadId) reportLoadError(e, { phase, file }); }
}

function loadLargeFile(file: File, id: number) {
  const worker = new Worker(new URL('./large-lox.worker.ts', import.meta.url), { type: 'module' });
  largeWorker = worker;
  loadingLargeWalls = true;
  let phase = 'Reading LOX directory';
  let material: THREE.MeshStandardMaterial | undefined;
  let modelOrigin = new THREE.Vector3();
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
    type: string; model: LargeModel; batch: GeometryBatch; surface: Surface;
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
        clear(walls); centreline.clear(); surfaceScene.clear();
        loadingLargeWalls = true;
        invalidateView();
        const origin = new THREE.Vector3(...model.origin); modelOrigin = origin;
        worldOrigin.copy(origin); hasModel = true;
        activeBox = new THREE.Box3(new THREE.Vector3(...model.min).sub(origin), new THREE.Vector3(...model.max).sub(origin));
        boundingBox.box.copy(activeBox);
        boundingBox.visible = document.querySelector<HTMLInputElement>('#bounding-box')!.checked;
        material = largeWallMaterial(model);
        largeScene = new LargeScene(walls, material, model);
        applyWallCulling();
        updateProjectTitle(model.title, file.name);
        centreline.setModel(model, origin);
        updateLegend(model); setCameraView(camera, controls, activeBox, 'fit');
        deviceLocation.update();
        worker.postMessage({ acknowledge: true });
      } else if (message.type === 'surface') {
        phase = 'Preparing surface';
        surfaceScene.add(message.surface, modelOrigin);
        deviceLocation.update();
        worker.postMessage({ acknowledge: true });
      } else if (message.type === 'batch') {
        phase = 'Rendering full-detail walls';
        largeScene!.add(message.batch);
        worker.postMessage({ acknowledge: true });
      } else if (message.type === 'done') {
        largeModel = { name: file.name, model: message.model, file };
        preparationPending = true;
        collapseAfterRender = true;
        stop();
      } else if (message.type === 'error') {
        stop(Object.assign(new Error(message.error.message), message.error));
      }
    } catch (error) { stop(error); }
  };
  worker.postMessage({ file });
}
function updateLargeStatus() {
  if (!largeModel || largeWorker || loadingError || (preparationPending && walls.visible)) return;
  const { name, model } = largeModel;
  setStatusText(status, `${name} · ${model.scraps} scraps · ${model.triangles.toLocaleString()} triangles · ${detail.value === 'full' ? 'full detail' : viewRefined ? 'automatic detail · stationary view complete' : 'automatic detail (moving preview)'}`);
}
function finishFileLoading() {
  if (!collapseAfterRender || loadingError || largeWorker || surfaceScene.loading || (preparationPending && walls.visible)) return;
  collapseAfterRender = false;
  setStatusProgress(status);
  menus.collapse();
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
window.addEventListener('drop', e => { e.preventDefault(); const file = e.dataTransfer?.files[0]; if (file && modelFileFormat(file.name)) void loadFile(file); });
const resize = () => { const w = canvas.clientWidth, h = canvas.clientHeight; if (!w || !h) return; renderer.setSize(w, h, false); resizeCamera(camera, w / h); invalidateView(); };
new ResizeObserver(resize).observe(canvas); resize();
function frame(time = performance.now()) {
  requestAnimationFrame(frame);
  autorotate.update(time, Boolean(largeWorker || (preparationPending && walls.visible) || document.hidden));
  if (sceneDirty) {
    indicators.update();
    updateLocationDot();
    centreline.updateLabels(camera, canvas.clientWidth, canvas.clientHeight);
  }
  if (preparationPending && !largeWorker && largeScene && largeModel && walls.visible && !loadingError) {
    try {
      if (!preparation) {
        lighting.updateCamera();
        preparation = new WallPreparation(renderer, scene, camera, largeScene, detail.value === 'full');
        // Paint the stage label before starting the expensive work next frame.
        renderer.render(scene, camera);
      } else {
        preparation.step();
        reportPreparation();
        if (preparation.complete) {
          preparation.dispose(); preparation = undefined; preparationPending = false;
          setStatusProgress(status); updateLargeStatus();
          finishFileLoading();
        }
      }
      sceneDirty = false;
    } catch (error) {
      reportLoadError(error, { phase: preparation?.phase ?? 'Preparing geometry', file: largeModel.file });
    }
    return;
  }
  if (sceneDirty) {
    lighting.updateCamera();
    const visible = walls.visible;
    if (!loadingLargeWalls) largeScene?.update(camera, detail.value === 'full');
    if (loadingLargeWalls) walls.visible = false;
    renderer.render(scene, camera);
    walls.visible = visible; sceneDirty = false;
    finishFileLoading();
    return;
  }
  if (largeWorker || !largeScene || !largeModel || !walls.visible || detail.value === 'full' || loadingError
    || viewRefined || performance.now() - lastViewChange < 500) return;
  try {
    progressiveView ??= new ProgressiveView(renderer, scene, camera, largeScene, surfaceGroup);
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
