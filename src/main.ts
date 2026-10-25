import * as THREE from 'three';
import { initializeAbout } from './about';
import { createCameraControls, resizeCamera, setCameraView, setPerspective, setTiltLocked, type ViewCamera } from './camera';
import { exceptionMessage, showLoadError, type LoadContext } from './errors';
import { parseLox, type Model, type Point } from './lox';
import { initializeMenus } from './menus';
import { createHeadlight, initializeLightControls } from './lighting';
import { loadWallTexture, setTexturedWalls, wallMaterial } from './wall-material';
import type { GeometryBatch, LargeModel, LoadProgress } from './large-lox';
import { largeWallMaterial, LargeScene } from './large-scene';
import { ProgressiveView } from './progressive-view';
import { WallPreparation } from './wall-preparation';
import { setStatusProgress, setStatusText } from './status';
import { surfacePoint, type Surface } from './lox-surface';
import { SurfaceScene, initializeSurfaceControls } from './surface';
import { CentrelineScene, initializeCentrelineControls } from './centreline';
import { initializeIndicators, metresPerPixel } from './indicators';
import { FULL_SIZE_METRES_PER_PIXEL, setSymbolView, symbolScale } from './station-labels';
import { displayProjectTitle } from './lox-title';
import { initializeAutorotateControls } from './autorotate';
import { initializeDock } from './dock';
import { WalkerControls } from './walker';
import { ViewLocks } from './view-locks';
import { FieldObjects } from './objects-ui';
import { ObjectStore } from './objects';
import { looksLikeSJTSK } from './geo';
import { drawLayers, LayerStore, readShapefileLayer, type PointLayer } from './layers';
import { LayerBrowser, type LayerHighlight } from './layers-ui';
import { searchModel, type SearchResult } from './search';
import { browsablePoints } from './layers-ui';
import { STATION_ENTRANCE, temporaryStation } from './lox-stations';
import { animateRotationCentre, pickModelPoint, RotationCentrePicker } from './pivot';
import { DeviceLocation, formatFix, markerScreenPosition, type LocationState, headingScreenAngle } from './location';
import { DeviceHeading } from './heading';
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
/** The bounding box shows for a few seconds after opening a model or switching projection. */
const BOUNDING_BOX_SECONDS = 3;
let boundingBoxTimer = 0;
function flashBoundingBox() {
  clearTimeout(boundingBoxTimer);
  boundingBox.visible = !activeBox.isEmpty() && document.querySelector<HTMLInputElement>('#bounding-box')!.checked;
  if (boundingBox.visible) boundingBoxTimer = window.setTimeout(() => { boundingBox.visible = false; invalidateView(); }, BOUNDING_BOX_SECONDS * 1000);
  invalidateView();
}
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
const walkerIndicator = document.querySelector<HTMLElement>('#walker-indicator')!;
walkerCheckbox.checked = false;
function setWalker(enabled: boolean) {
  pivotPicker.enabled = false;
  walker.enabled = enabled; walkerCheckbox.checked = enabled;
  walkerIndicator.setAttribute('aria-pressed', String(enabled));
  walkerIndicator.title = enabled ? 'Walker on: drag to look, wheel/pinch to walk. Click to return to orbiting' : 'Walker: move through the cave from the camera position';
}
walkerIndicator.title = 'Walker: move through the cave from the camera position';
walkerCheckbox.addEventListener('change', () => setWalker(walkerCheckbox.checked));
walkerIndicator.addEventListener('click', () => setWalker(!walker.enabled));
walkerIndicator.addEventListener('keydown', event => {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setWalker(!walker.enabled); }
});
controls.addEventListener('change', invalidateView);
const pivotHint = document.querySelector<HTMLElement>('#pivot-hint')!;
const pivotMarker = document.querySelector<HTMLElement>('#pivot-marker')!;
let pivotMarkerTimer = 0;
const pivotPicker = new RotationCentrePicker({
  canvas, controls, getCamera: () => camera, getRoots: () => [walls, surfaceGroup, lines],
  onModeChange: active => {
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
document.querySelector<HTMLButtonElement>('#pivot-menu')!.addEventListener('click', () => { pivotPicker.enabled = true; });
// Safari ignores user-scalable=no for pinches; block its page gestures so only the model zooms.
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(type, event => event.preventDefault(), { passive: false });

/** Double click or double tap on the model sets the rotation centre there. */
function centreAt(clientX: number, clientY: number) {
  if (walker.enabled || pivotPicker.enabled || objectPicker.enabled) return;
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2((clientX - rect.left) / rect.width * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  const point = pickModelPoint(camera, [walls, surfaceGroup, lines], ndc, rect.height, controls.target);
  if (!point) return;
  animateRotationCentre(camera, controls, point);
  pivotMarker.hidden = true; void pivotMarker.offsetWidth; pivotMarker.hidden = false;
}
canvas.addEventListener('dblclick', event => { event.preventDefault(); centreAt(event.clientX, event.clientY); });
// Touch has no reliable dblclick: two short taps within 300 ms and 30 px.
let tapStart: { id: number; x: number; y: number; time: number } | undefined;
let lastTap: { x: number; y: number; time: number } | undefined;
canvas.addEventListener('pointerdown', event => {
  if (event.pointerType === 'touch') tapStart = event.isPrimary ? { id: event.pointerId, x: event.clientX, y: event.clientY, time: event.timeStamp } : undefined;
});
canvas.addEventListener('pointerup', event => {
  if (event.pointerType !== 'touch' || !tapStart || tapStart.id !== event.pointerId) return;
  const short = event.timeStamp - tapStart.time < 250 && Math.hypot(event.clientX - tapStart.x, event.clientY - tapStart.y) < 10;
  tapStart = undefined;
  if (!short) { lastTap = undefined; return; }
  if (lastTap && event.timeStamp - lastTap.time < 300 && Math.hypot(event.clientX - lastTap.x, event.clientY - lastTap.y) < 30) {
    lastTap = undefined; centreAt(event.clientX, event.clientY);
  } else lastTap = { x: event.clientX, y: event.clientY, time: event.timeStamp };
});
// Tap or click a symbol (entrance, SHP point, field object) to see what it is.
const infoCard = document.querySelector<HTMLElement>('#info-card')!;
const infoTitle = document.querySelector<HTMLElement>('#info-title')!;
const infoRows = document.querySelector<HTMLElement>('#info-rows')!;
function showInfo(title: string, rows: [string, string][]) {
  infoTitle.textContent = title;
  infoRows.replaceChildren(...rows.filter(([, value]) => value !== '').map(([key, value]) => {
    const row = document.createElement('tr'), th = document.createElement('th'), td = document.createElement('td');
    th.scope = 'row'; th.textContent = key; td.textContent = value; row.append(th, td); return row;
  }));
  infoCard.hidden = false;
}
document.querySelector<HTMLButtonElement>('#info-close')!.addEventListener('click', () => { infoCard.hidden = true; });
document.addEventListener('keydown', event => { if (event.key === 'Escape') infoCard.hidden = true; });
const SYMBOL_HIT_PIXELS = 16;
function symbolAt(clientX: number, clientY: number) {
  const symbols = symbolOptions();
  if (!symbols.visible || !hasModel) return undefined;
  const rect = canvas.getBoundingClientRect(), point = new THREE.Vector3();
  let best: { distance: number; open: () => void } | undefined;
  const consider = (east: number, north: number, z: number, open: () => void) => {
    point.set(east - worldOrigin.x, north - worldOrigin.y, z - worldOrigin.z).project(camera);
    if (point.z < -1 || point.z > 1) return;
    const distance = Math.hypot(rect.left + (point.x + 1) / 2 * rect.width - clientX, rect.top + (1 - point.y) / 2 * rect.height - clientY);
    if (distance <= SYMBOL_HIT_PIXELS && (!best || distance < best.distance)) best = { distance, open };
  };
  if (lines.visible) for (const station of centreline.stationDetails) {
    if (!(station.flags & STATION_ENTRANCE) || temporaryStation(station)) continue;
    const [east, north, z] = station.position;
    consider(east, north, z, () => showInfo(station.comment?.trim() || `${station.name}@${station.survey}`, [
      ['Type', 'Cave entrance'], ['Station', `${station.name}@${station.survey}`], ['Survey', station.fullSurvey],
      ['Altitude', `${z.toFixed(1)} m`], ['x  y', `${Math.round(east)}  ${Math.round(north)}`],
    ]));
  }
  const georeferenced = looksLikeSJTSK(worldOrigin.x, worldOrigin.y);
  if (georeferenced && document.querySelector<HTMLInputElement>('#objects-visible')!.checked) for (const object of fieldObjects.objects) {
    const position = object.position;
    if (!position) continue;
    consider(position.east, position.north, surfaceScene.heightAt(position.east, position.north) ?? position.height ?? worldOrigin.z, () => fieldObjects.open(object));
  }
  if (georeferenced && layersVisible.checked) for (const layer of pointLayers) {
    browsablePoints(layer).forEach((index, position) => {
      const shp = layer.points[index], terrain = surfaceScene.heightAt(shp.east, shp.north);
      consider(shp.east, shp.north, shp.z ?? terrain ?? worldOrigin.z, () => showInfo(shp.label || `${layer.name} #${position + 1}`, [
        ['Layer', layer.name], ['x  y', `${Math.round(shp.east)}  ${Math.round(shp.north)}`],
        ['Z (file)', shp.z === null ? '' : `${shp.z.toFixed(2)} m`], ['Terrain height', terrain === undefined ? '' : `${Math.round(terrain)} m`],
        ...Object.entries(shp.attributes ?? {}),
      ]));
    });
  }
  return best;
}
let clickStart: { x: number; y: number } | undefined;
canvas.addEventListener('pointerdown', event => { clickStart = { x: event.clientX, y: event.clientY }; });
canvas.addEventListener('click', event => {
  // A drag that rotated or panned is not a click.
  if (!clickStart || Math.hypot(event.clientX - clickStart.x, event.clientY - clickStart.y) > 6) return;
  if (walker.enabled || pivotPicker.enabled || objectPicker.enabled) return;
  const hit = symbolAt(event.clientX, event.clientY);
  if (hit) hit.open(); else infoCard.hidden = true;
});
// Picking an object position: same tap-to-pick as the rotation centre, without moving the view.
let resolveObjectPick: ((point: THREE.Vector3 | undefined) => void) | undefined;
const objectPicker = new RotationCentrePicker({
  canvas, controls, getCamera: () => camera, getRoots: () => [walls, surfaceGroup, lines], recenter: false,
  onModeChange: active => {
    pivotHint.textContent = 'Tap the model where the object is · Esc cancels';
    pivotHint.hidden = !active;
    // The picker leaves pick mode just before reporting the point, so a cancel is only certain afterwards.
    if (!active) queueMicrotask(() => { const resolve = resolveObjectPick; resolveObjectPick = undefined; resolve?.(undefined); });
  },
  onMiss: () => { pivotHint.textContent = 'Nothing there. Tap a wall, the surface or a centreline shot · Esc cancels'; },
  onPicked: point => { const resolve = resolveObjectPick; resolveObjectPick = undefined; resolve?.(point.clone()); },
});
function pickObjectPoint() {
  pivotPicker.enabled = false;
  return new Promise<THREE.Vector3 | undefined>(resolve => { resolveObjectPick = resolve; objectPicker.enabled = true; });
}
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
const entranceToggle = document.querySelector<HTMLInputElement>('#station-entrance')!;
const entranceLabel = document.querySelector<HTMLSelectElement>('#entrance-label')!;
/** Entrances, field objects and SHP points share the dock's entrance and entrance-label buttons. */
const symbolOptions = () => ({ visible: entranceToggle.checked, label: entranceLabel.value });
function showSymbols() {
  if (entranceToggle.checked) return;
  entranceToggle.checked = true; entranceToggle.dispatchEvent(new Event('change', { bubbles: true }));
}
const fieldObjects = new FieldObjects({
  getSymbols: symbolOptions, onSaved: showSymbols,
  store: new ObjectStore(),
  heightAt: (east, north) => surfaceScene.heightAt(east, north),
  getOrigin: () => hasModel && looksLikeSJTSK(worldOrigin.x, worldOrigin.y) ? worldOrigin : undefined,
  onChange: () => invalidateView(),
  pickPoint: pickObjectPoint,
});
const deviceLocation = new DeviceLocation({
  scene,
  getModel: () => hasModel ? { origin: worldOrigin, box: activeBox } : undefined,
  heightAt: (east, north) => surfaceScene.heightAt(east, north),
  onState: showLocationState,
  onFirstFix: fix => animateRotationCentre(camera, controls, fix.local),
});
// The phone's heading turns a small arrow at the location dot.
const deviceHeading = new DeviceHeading(() => invalidateView());
const headingArrow = document.querySelector<HTMLElement>('#heading-arrow')!;
function toggleLocation() {
  if (deviceLocation.active) { deviceLocation.stop(); deviceHeading.stop(); }
  else { deviceHeading.start(); deviceLocation.start(); }
}
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
  const angle = screen.onScreen && fix && deviceHeading.heading !== undefined
    ? headingScreenAngle(fix, deviceHeading.heading, camera, width, height) : undefined;
  headingArrow.hidden = angle === undefined;
  if (angle !== undefined) headingArrow.style.transform = `rotate(${angle}deg)`;
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
  camera = setPerspective(camera, controls, perspective.checked, activeBox);
  flashBoundingBox();
});
// Dock buttons mirror menu controls, so wire them after those controls are initialized.
initializeDock();
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
const compassIndicator = document.querySelector<HTMLElement>('#compass-indicator')!;
const tiltIndicator = document.querySelector<HTMLElement>('#tilt-indicator')!;
const viewLocks = new ViewLocks(() => camera, controls, state => {
  compassIndicator.setAttribute('aria-pressed', String(state.north));
  tiltIndicator.setAttribute('aria-pressed', String(state.side));
  lockTilt.checked = state.tiltLocked;
  indicators.refresh(); invalidateView();
});
for (const [element, toggle] of [[compassIndicator, () => viewLocks.toggleNorth()], [tiltIndicator, () => viewLocks.toggleSide()]] as const) {
  element.addEventListener('click', toggle);
  element.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); }
  });
}
const menus = initializeMenus(view => {
  viewLocks.reset();
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
  legend.innerHTML = `<div class="ramp" style="--low:${low};--high:${high}"></div><span class="legend-max">${model.maxZ.toFixed(0)} m</span><span class="legend-min">${model.minZ.toFixed(0)} m</span>`;
  legend.title = `Altitude colours: ${model.minZ.toFixed(1)} m to ${model.maxZ.toFixed(1)} m`;
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
  flashBoundingBox();
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
        flashBoundingBox();
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
// iOS shows Photo Library / Take Photo / Browse when it cannot map every accepted
// extension to a document type (.lox, .shp…). A generic data type opens Files directly.
const iOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
if (iOS) chooser.accept = 'application/octet-stream';
chooser.addEventListener('change', () => { openFiles(Array.from(chooser.files ?? [])); });
/** A model opens as before; files with a .shp are imported as a point layer instead. */
function openFiles(files: File[]) {
  if (files.some(file => file.name.toLowerCase().endsWith('.shp'))) { void importLayer(files); return; }
  const model = files.find(file => modelFileFormat(file.name));
  if (model) void loadFile(model);
}
const layerStore = new LayerStore();
const layerCanvas = document.querySelector<HTMLCanvasElement>('#layer-points')!;
const layersVisible = document.querySelector<HTMLInputElement>('#layers-visible')!;
layersVisible.checked = true;
layersVisible.addEventListener('change', invalidateView);
let pointLayers: PointLayer[] = [];
void layerStore.list().then(layers => { pointLayers = layers; invalidateView(); }).catch(() => { /* Storage unavailable: layers last for this session. */ });
const toast = document.querySelector<HTMLElement>('#toast')!;
let toastTimer = 0;
/** Short message above the dock; the status line belongs to model loading. */
function announce(text: string, error = false) {
  toast.textContent = text; toast.classList.toggle('error', error); toast.hidden = false;
  clearTimeout(toastTimer); toastTimer = window.setTimeout(() => { toast.hidden = true; }, 6000);
}
async function importLayer(files: File[]) {
  try {
    const { layer, summary } = await readShapefileLayer(files, pointLayers.length);
    pointLayers = [...pointLayers, layer];
    showSymbols();
    try { await layerStore.put(layer); } catch { /* Kept for this session only. */ }
    const georeferenced = hasModel && looksLikeSJTSK(worldOrigin.x, worldOrigin.y);
    announce(georeferenced ? summary : `${summary}. Open a model in S-JTSK to see it.`);
    invalidateView();
  } catch (error) {
    announce(`Cannot import SHP layer: ${exceptionMessage(error)}`, true);
  }
}
let layerHighlight: LayerHighlight = null;
/** Centre a scene point and zoom in to full-size symbols if the view is farther out. */
function focusOn(local: THREE.Vector3) {
  const height = canvas.clientHeight || 1, wanted = FULL_SIZE_METRES_PER_PIXEL * .7;
  const current = metresPerPixel(camera, controls.target, height);
  if (current > wanted) {
    if (camera instanceof THREE.PerspectiveCamera) {
      const distance = wanted * height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.getEffectiveFOV()) / 2));
      camera.position.sub(controls.target).setLength(distance).add(controls.target);
    } else { camera.zoom *= current / wanted; camera.updateProjectionMatrix(); }
    controls.update();
  }
  animateRotationCentre(camera, controls, local);
}
const searchDialog = document.querySelector<HTMLDialogElement>('#search-dialog')!;
const searchInput = document.querySelector<HTMLInputElement>('#search-input')!;
const searchBody = document.querySelector<HTMLElement>('#search-results')!;
const searchSummary = document.querySelector<HTMLElement>('#search-summary')!;
const KIND_TEXT: Record<SearchResult['kind'], string> = { cave: 'cave', survey: 'survey', station: 'station' };
let searchTimer = 0;
function runSearch() {
  const query = searchInput.value;
  const { results, total } = searchModel(query, centreline.stationDetails);
  searchSummary.textContent = !query.trim() ? 'Station numbers list every survey that uses them; add @survey to narrow, e.g. 12@krasna.'
    : !centreline.stationDetails.length ? 'This model has no named stations.'
    : total ? `${total} found${total > results.length ? `, first ${results.length} shown` : ''}` : 'Nothing found';
  searchBody.replaceChildren(...results.map(result => {
    const row = document.createElement('tr'); row.tabIndex = 0;
    const name = document.createElement('td'), title = document.createElement('strong'), kind = document.createElement('span');
    title.textContent = result.title; kind.className = 'kind';
    kind.textContent = result.kind === 'survey' ? `survey · ${result.count} stations` : KIND_TEXT[result.kind];
    name.append(title, kind);
    const survey = document.createElement('td'); survey.textContent = result.survey;
    const altitude = document.createElement('td'); altitude.textContent = `${Math.round(result.altitude)} m`;
    row.append(name, survey, altitude);
    const go = () => {
      searchDialog.close();
      focusOn(new THREE.Vector3(result.position[0] - worldOrigin.x, result.position[1] - worldOrigin.y, result.position[2] - worldOrigin.z));
      // Ring at the view centre marks the found place.
      setTimeout(() => { pivotMarker.hidden = true; void pivotMarker.offsetWidth; pivotMarker.hidden = false; }, 280);
    };
    row.addEventListener('click', go);
    row.addEventListener('keydown', event => { if (event.key === 'Enter') go(); });
    return row;
  }));
}
searchInput.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = window.setTimeout(runSearch, 150); });
document.querySelector<HTMLButtonElement>('#search-open')!.addEventListener('click', () => {
  runSearch(); searchDialog.showModal(); searchInput.focus(); searchInput.select();
});
// Dock shortcuts for File → Field objects… and File → SHP files….
document.querySelector<HTMLButtonElement>('#objects-browse')!.addEventListener('click', () => document.querySelector<HTMLButtonElement>('#objects-open')!.click());
document.querySelector<HTMLButtonElement>('#layers-browse')!.addEventListener('click', () => document.querySelector<HTMLButtonElement>('#layers-open')!.click());
document.querySelector<HTMLButtonElement>('#search-close')!.addEventListener('click', () => searchDialog.close());
new LayerBrowser({
  getLayers: () => pointLayers,
  removeLayer: async id => {
    pointLayers = pointLayers.filter(layer => layer.id !== id);
    try { await layerStore.delete(id); } catch { /* Already gone. */ }
    invalidateView();
  },
  heightAt: (east, north) => surfaceScene.heightAt(east, north),
  getOrigin: () => hasModel && looksLikeSJTSK(worldOrigin.x, worldOrigin.y) ? worldOrigin : undefined,
  focus: focusOn,
  setHighlight: highlight => { layerHighlight = highlight; if (highlight) showSymbols(); invalidateView(); },
});
function updateLayers() {
  const georeferenced = hasModel && looksLikeSJTSK(worldOrigin.x, worldOrigin.y);
  const symbols = symbolOptions();
  layerCanvas.hidden = !georeferenced || !layersVisible.checked || !symbols.visible || !pointLayers.length;
  if (!layerCanvas.hidden) drawLayers(layerCanvas, pointLayers, camera, canvas.clientWidth, canvas.clientHeight, worldOrigin, (east, north) => surfaceScene.heightAt(east, north), symbols.label, layerHighlight);
}
document.querySelector<HTMLInputElement>('#walls')!.addEventListener('change', e => { walls.visible = (e.target as HTMLInputElement).checked; invalidateView(); });
document.querySelector<HTMLInputElement>('#lines')!.addEventListener('change', e => { lines.visible = (e.target as HTMLInputElement).checked; invalidateView(); });
document.querySelector<HTMLInputElement>('#bounding-box')!.addEventListener('change', flashBoundingBox);
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('drop', e => { e.preventDefault(); openFiles(Array.from(e.dataTransfer?.files ?? [])); });
const resize = () => { const w = canvas.clientWidth, h = canvas.clientHeight; if (!w || !h) return; renderer.setSize(w, h, false); resizeCamera(camera, w / h); invalidateView(); };
new ResizeObserver(resize).observe(canvas); resize();
function frame(time = performance.now()) {
  requestAnimationFrame(frame);
  autorotate.update(time, Boolean(largeWorker || (preparationPending && walls.visible) || document.hidden));
  if (sceneDirty) {
    // Symbol size: zoom relative to the model (whole model → 25 %, 100 m scale → 100 %),
    // then nearer than the rotation centre larger, farther smaller.
    const height = canvas.clientHeight;
    if (height > 0 && !activeBox.isEmpty()) {
      const targetDepth = camera instanceof THREE.PerspectiveCamera
        ? controls.target.clone().sub(camera.position).dot(camera.getWorldDirection(new THREE.Vector3())) : undefined;
      setSymbolView(symbolScale(metresPerPixel(camera, controls.target, height), activeBox.getSize(new THREE.Vector3()).length() / height), targetDepth);
    }
    indicators.update();
    updateLocationDot();
    fieldObjects.updateMarkers(camera, canvas.clientWidth, canvas.clientHeight);
    updateLayers();
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
    menus.collapse();
  }
  catch (e) { if (loadId === 0) reportLoadError(e, { phase, source }); }
}
void loadSample();
