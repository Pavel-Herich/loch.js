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
import { FULL_SIZE_METRES_PER_PIXEL, setSymbolFilter, setSymbolView } from './station-labels';
import { displayProjectTitle } from './lox-title';
import { initializeAutorotateControls } from './autorotate';
import { initializeDock } from './dock';
import { WalkerControls } from './walker';
import { orbitTo, ViewLocks } from './view-locks';
import { FieldObjects } from './objects-ui';
import { ObjectStore } from './objects';
import { looksLikeSJTSK } from './geo';
import { drawLayers, LayerStore, readShapefileLayer, type PointLayer, readPointFileLayer } from './layers';
import { POINT_FORMATS, toCsv, toGeoJson, toGpx, toKml, toShapefile, type ExportPoint } from './formats';
import { LayerBrowser } from './layers-ui';
import { searchModel, type SearchResult } from './search';
import { browsablePoints } from './layers-ui';
import { STATION_ENTRANCE, temporaryStation, type Station } from './lox-stations';
import { animateRotationCentre, pickModelPoint, RotationCentrePicker } from './pivot';
import { DeviceLocation, formatFix, markerScreenPosition, type LocationFix, type LocationState, headingScreenAngle } from './location';
import { DeviceHeading } from './heading';
import { fetchUnderlay, UNDERLAY_SERVICES } from './underlay';
import { forgetStoredUnderlays, loadStoredUnderlay, storeUnderlay, underlayKey } from './underlay-cache';
import { createZip } from './zip';
import { inSection, makeSection, SECTION_WIDTHS, withWidth, type Section } from './section';
import { sectionCsv, sectionSvg, type ProfileStation } from './section-export';
import { formatDistance, navigate } from './navigation';
import { drawTracks, TrackStore, trackGpx, trackLength, trackTherion, type Track } from './track';
import { forgetLastModel, loadLastModel, saveLastModel } from './model-store';
import { viewOrientation } from './indicators';
import { resetSymbolSpace, symbolHidden } from './declutter';
import { initializeLayout } from './layout';
import { degrees, metres, segment, signedMetres, type MeasurePoint, type Segment } from './measure';
import { drawMeasure } from './measure-draw';
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
// The projection switch cycles Persp → Ortho → Walk (the Walker, in perspective) → Persp.
const projectionIndicator = document.querySelector<HTMLElement>('#projection-indicator')!;
walkerCheckbox.checked = false;
function syncProjection() {
  const mode = walker.enabled ? 'walk' : document.querySelector<HTMLInputElement>('#perspective')!.checked ? 'persp' : 'ortho';
  document.querySelector('#projection-perspective')!.toggleAttribute('hidden', mode !== 'persp');
  document.querySelector('#projection-orthographic')!.toggleAttribute('hidden', mode !== 'ortho');
  document.querySelector('#projection-walker')!.toggleAttribute('hidden', mode !== 'walk');
  document.querySelector('#projection-value')!.textContent = { persp: 'Persp', ortho: 'Ortho', walk: 'Walk' }[mode];
  projectionIndicator.setAttribute('aria-pressed', String(mode !== 'persp'));
  projectionIndicator.title = { persp: 'Perspective. Click for orthographic', ortho: 'Orthographic. Click for the Walker', walk: 'Walker: drag to look, wheel/pinch to walk. Click for perspective' }[mode];
  projectionIndicator.setAttribute('aria-label', projectionIndicator.title);
}
function setWalker(enabled: boolean) {
  pivotPicker.enabled = false;
  walker.enabled = enabled; walkerCheckbox.checked = enabled;
  syncProjection();
  // Like the projection switch, a view mode change flashes the model's red box.
  flashBoundingBox();
}
function cycleProjection() {
  const perspectiveBox = document.querySelector<HTMLInputElement>('#perspective')!;
  if (walker.enabled) setWalker(false);
  else if (perspectiveBox.checked) { perspectiveBox.checked = false; perspectiveBox.dispatchEvent(new Event('change')); }
  else { perspectiveBox.checked = true; perspectiveBox.dispatchEvent(new Event('change')); setWalker(true); }
  syncProjection();
}
walkerCheckbox.addEventListener('change', () => setWalker(walkerCheckbox.checked));
projectionIndicator.addEventListener('click', cycleProjection);
projectionIndicator.addEventListener('keydown', event => {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); cycleProjection(); }
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
  // A double tap while measuring centres the view and adds no point.
  cancelPendingMeasure(); lastCentreAt = performance.now();
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
const infoActions = document.querySelector<HTMLElement>('#info-actions')!;
type InfoAction = { label: string; run: () => void; primary?: boolean };
function showInfo(title: string, rows: [string, string][], actions: InfoAction[] = []) {
  infoTitle.textContent = title;
  infoActions.replaceChildren(...actions.map(action => {
    const button = document.createElement('button');
    button.type = 'button'; button.textContent = action.label; if (action.primary) button.className = 'primary';
    button.addEventListener('click', action.run); return button;
  }));
  infoActions.hidden = !actions.length;
  infoRows.replaceChildren(...rows.filter(([, value]) => value !== '').map(([key, value]) => {
    const row = document.createElement('tr'), th = document.createElement('th'), td = document.createElement('td');
    th.scope = 'row'; th.textContent = key; td.textContent = value; row.append(th, td); return row;
  }));
  infoCard.hidden = false;
}
document.querySelector<HTMLButtonElement>('#info-close')!.addEventListener('click', () => { infoCard.hidden = true; });
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  infoCard.hidden = true; select(null);
  if (sectionPicks) { sectionPicks = undefined; pivotHint.hidden = true; sectionToggle.setAttribute('aria-pressed', String(Boolean(section))); }
  if (measuring) setMeasuring(false);
});
const SYMBOL_HIT_PIXELS = 16;
type SymbolHit = { distance: number; open: () => void; name: string; position: MeasurePoint; gps?: boolean; key?: string };
/** Nearest visible symbol under the pointer; `measuring` also snaps to shown stations and the GPS position. */
function symbolAt(clientX: number, clientY: number, measuring = false): SymbolHit | undefined {
  const symbols = symbolOptions();
  if (!hasModel || (!symbols.visible && !measuring)) return undefined;
  const rect = canvas.getBoundingClientRect(), point = new THREE.Vector3();
  let best: SymbolHit | undefined;
  const consider = (east: number, north: number, z: number, name: string, open: () => void, gps = false, key?: string, ref?: object) => {
    // A symbol hidden behind another cannot be tapped.
    if (ref && symbolHidden(ref)) return;
    point.set(east - worldOrigin.x, north - worldOrigin.y, z - worldOrigin.z).project(camera);
    if (point.z < -1 || point.z > 1) return;
    const distance = Math.hypot(rect.left + (point.x + 1) / 2 * rect.width - clientX, rect.top + (1 - point.y) / 2 * rect.height - clientY);
    if (distance <= SYMBOL_HIT_PIXELS && (!best || distance < best.distance)) best = { distance, open, name, position: { name, east, north, z }, gps, key };
  };
  if (measuring && deviceLocation.active && deviceLocation.state.kind === 'fix') {
    const fix = deviceLocation.state.fix;
    consider(fix.east, fix.north, fix.height, 'My location', () => undefined, true);
  }
  if (measuring && lines.visible && document.querySelector<HTMLInputElement>('#station-all')!.checked) for (const station of centreline.stationDetails) {
    if (temporaryStation(station)) continue;
    const [east, north, z] = station.position;
    consider(east, north, z, `${station.name}@${station.survey}`, () => undefined);
  }
  if (!symbols.visible) return best;
  if (lines.visible) for (const station of centreline.stationDetails) {
    if (!(station.flags & STATION_ENTRANCE) || temporaryStation(station)) continue;
    const [east, north, z] = station.position;
    const name = station.comment?.trim() || `${station.name}@${station.survey}`;
    consider(east, north, z, name, () => showInfo(name, [
      ['Type', 'Cave entrance'], ['Station', `${station.name}@${station.survey}`], ['Survey', station.fullSurvey],
      ['Altitude', `${z.toFixed(1)} m`], ['x  y', `${Math.round(east)}  ${Math.round(north)}`],
    ], navigateActions({ name, east, north, z })), false, undefined, station);
  }
  const georeferenced = looksLikeSJTSK(worldOrigin.x, worldOrigin.y);
  if (georeferenced && document.querySelector<HTMLInputElement>('#objects-visible')!.checked) for (const object of fieldObjects.objects) {
    const position = object.position;
    if (!position) continue;
    consider(position.east, position.north, surfaceScene.heightAt(position.east, position.north) ?? position.height ?? worldOrigin.z, object.title || object.name, () => showInfo(object.title || object.name, [
      ['Type', 'Field object'], ['Saved as', object.name],
      ['x  y  z', `${Math.round(position.east)}  ${Math.round(position.north)}  ${position.height === null ? '–' : Math.round(position.height)}`],
      ['Note', object.note], ['Photos', object.photos.length ? String(object.photos.length) : ''],
    ], [{ label: 'Open', primary: true, run: () => { infoCard.hidden = true; fieldObjects.open(object); } },
      ...navigateActions({ name: object.title || object.name, east: position.east, north: position.north, z: surfaceScene.heightAt(position.east, position.north) ?? position.height ?? worldOrigin.z })]), false, undefined, object);
  }
  if (georeferenced && layersVisible.checked) for (const layer of pointLayers) {
    browsablePoints(layer).forEach((index, position) => {
      const shp = layer.points[index], terrain = surfaceScene.heightAt(shp.east, shp.north);
      const name = shp.label || `${layer.name} #${position + 1}`, z = shp.z ?? terrain ?? worldOrigin.z;
      consider(shp.east, shp.north, z, name, () => showInfo(name, [
        ['Layer', layer.name], ['x  y', `${Math.round(shp.east)}  ${Math.round(shp.north)}`],
        ['Z (file)', shp.z === null ? '' : `${shp.z.toFixed(2)} m`], ['Terrain height', terrain === undefined ? '' : `${Math.round(terrain)} m`],
        ...Object.entries(shp.attributes ?? {}),
      ], navigateActions({ name, east: shp.east, north: shp.north, z })), false, `shp:${layer.id}:${index}`, shp);
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
  if (sectionPicks) { addSectionPick(event.clientX, event.clientY); return; }
  if (measuring) { queueMeasurePoint(event.clientX, event.clientY); return; }
  const hit = symbolAt(event.clientX, event.clientY);
  // The tapped point is ringed; the ring moves with the next tapped point and goes with a tap beside them.
  if (hit) { select(hit.position); hit.open(); } else { infoCard.hidden = true; select(null); }
});
// Measuring: tap points (snapping to entrances, objects, SHP points, shown stations and the GPS
// position, else the model under the finger); the card gives the last leg and the total.
const measureButton = document.querySelector<HTMLButtonElement>('#measure-toggle')!;
const measureCanvas = document.querySelector<HTMLCanvasElement>('#measure-overlay')!;
let measuring = false;
let measured: (MeasurePoint & { gps?: boolean })[] = [];
let surfaceLink: { from: MeasurePoint; to: MeasurePoint; above?: number; sideways?: MeasurePoint } | undefined;
const MEASURE_HINT = 'Tap points to measure: entrances, objects, SHP points, your location or the model · Esc ends';
function setMeasuring(on: boolean) {
  measuring = on; measured = []; surfaceLink = undefined; cancelPendingMeasure();
  if (on) { pivotPicker.enabled = false; if (walker.enabled) setWalker(false); }
  measureButton.setAttribute('aria-pressed', String(on));
  measureButton.title = on ? 'Stop measuring' : 'Measure distances: tap points, entrances, objects or your location';
  pivotHint.textContent = MEASURE_HINT; pivotHint.hidden = !on;
  infoCard.hidden = true;
  invalidateView();
}
measureButton.addEventListener('click', () => setMeasuring(!measuring));
/** A tap adds its point only once it is clearly not the first half of a double tap. */
const DOUBLE_TAP_MS = 300;
let pendingMeasure: { timer: number; x: number; y: number } | undefined;
/** On touch the double tap is recognised before the second tap's click arrives. */
let lastCentreAt = 0;
function cancelPendingMeasure() { if (pendingMeasure) { clearTimeout(pendingMeasure.timer); pendingMeasure = undefined; } }
function queueMeasurePoint(clientX: number, clientY: number) {
  if (performance.now() - lastCentreAt < 400) return;
  if (pendingMeasure && Math.hypot(clientX - pendingMeasure.x, clientY - pendingMeasure.y) < 30) { cancelPendingMeasure(); return; }
  cancelPendingMeasure();
  const timer = window.setTimeout(() => { pendingMeasure = undefined; addMeasurePoint(clientX, clientY); }, DOUBLE_TAP_MS);
  pendingMeasure = { timer, x: clientX, y: clientY };
}
function addMeasurePoint(clientX: number, clientY: number) {
  const hit = symbolAt(clientX, clientY, true);
  let point: (MeasurePoint & { gps?: boolean }) | undefined = hit ? { ...hit.position, gps: hit.gps } : undefined;
  if (!point) {
    const rect = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2((clientX - rect.left) / rect.width * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const local = pickModelPoint(camera, [walls, surfaceGroup, lines], ndc, rect.height, controls.target);
    if (local) point = { name: `Point ${measured.length + 1}`, east: local.x + worldOrigin.x, north: local.y + worldOrigin.y, z: local.z + worldOrigin.z };
  }
  if (!point) { pivotHint.textContent = 'Nothing there. Tap a symbol, a wall, the surface or a centreline shot · Esc ends'; pivotHint.hidden = false; return; }
  const last = measured.at(-1);
  // A second tap on the same spot (e.g. a double tap) adds nothing.
  if (last && Math.hypot(last.east - point.east, last.north - point.north, last.z - point.z) < .5) return;
  measured.push(point); surfaceLink = undefined;
  pivotHint.hidden = true;
  showMeasure(); invalidateView();
}
function nearestToSurface() {
  const from = measured.at(-1);
  if (!from) return;
  const found = surfaceScene.nearestPoint(from.east, from.north, from.z);
  if (!found) { announce('No surface in this model to measure to.', true); return; }
  const sideways = surfaceScene.nearestHorizontalPoint(from.east, from.north, from.z);
  surfaceLink = {
    from, to: { name: 'Surface', east: found.east, north: found.north, z: found.z }, above: surfaceScene.heightAt(from.east, from.north),
    ...(sideways ? { sideways: { name: 'Surface (horizontal)', east: sideways.east, north: sideways.north, z: sideways.z } } : {}),
  };
  showMeasure(); invalidateView();
}
function showMeasure() {
  const georeferenced = looksLikeSJTSK(worldOrigin.x, worldOrigin.y);
  const position = (p: MeasurePoint) => `${Math.round(p.east)}  ${Math.round(p.north)}  ${Math.round(p.z)}`;
  // Compact rows so the card leaves the measured line in view on phones.
  const legRows = (leg: Segment): [string, string][] => [
    ['Distance', `${metres(leg.slope)} · horizontal ${metres(leg.horizontal)}`],
    ['Height', `${signedMetres(leg.dz)} · inclination ${Math.round(leg.inclination)}°`],
    ['Bearing', `${degrees(leg.bearing)} grid${leg.trueBearing === undefined ? '' : ` · ${degrees(leg.trueBearing)} true`}`],
  ];
  const actions: InfoAction[] = [
    { label: 'Nearest to surface', run: nearestToSurface, primary: true },
    ...(measured.length > 1 ? [{ label: 'Undo', run: () => { measured.pop(); surfaceLink = undefined; showMeasure(); invalidateView(); } }] : []),
    { label: 'Clear', run: () => { measured = []; surfaceLink = undefined; infoCard.hidden = true; pivotHint.textContent = MEASURE_HINT; pivotHint.hidden = false; invalidateView(); } },
  ];
  if (surfaceLink) {
    const leg = segment(surfaceLink.from, surfaceLink.to), above = surfaceLink.above;
    const onSurface = leg.slope < .5;
    showInfo(`${surfaceLink.from.name} → nearest surface`, [
      ['Nearest', onSurface ? '0 m · the point is on the surface' : `${metres(leg.slope)} · inclination ${Math.round(leg.inclination)}°${leg.horizontal >= .5 ? ` · bearing ${degrees(leg.bearing)}` : ''}`],
      ['Horizontal', surfaceLink.sideways ? (() => { const out = segment(surfaceLink.from, surfaceLink.sideways); return out.horizontal < .5 ? '0 m' : `${metres(out.horizontal)} · bearing ${degrees(out.bearing)}`; })() : 'the terrain never reaches this height'],
      ['Vertical', above === undefined ? 'outside the surface' : `${signedMetres(above - surfaceLink.from.z)} to the terrain above`],
      ['Surface x y z', position(surfaceLink.to)],
    ], actions);
    return;
  }
  const last = measured.at(-1);
  if (!last) { infoCard.hidden = true; return; }
  if (measured.length === 1) {
    showInfo(last.name, [['x  y  z', position(last)], ['Next', 'tap a second point']], actions);
    return;
  }
  const previous = measured[measured.length - 2], leg = segment(previous, last);
  let total = 0, totalHorizontal = 0;
  for (let i = 1; i < measured.length; i++) { const part = segment(measured[i - 1], measured[i]); total += part.slope; totalHorizontal += part.horizontal; }
  showInfo(`${previous.name} → ${last.name}`, [
    ...legRows(leg),
    ...(measured.length > 2 ? [['Total', `${metres(total)} · horizontal ${metres(totalHorizontal)} · ${measured.length - 1} legs`]] as [string, string][] : []),
    ...(georeferenced ? [] : [['Coordinates', 'local model units']] as [string, string][]),
  ], actions);
}
/** Measured GPS positions follow new fixes. */
function updateMeasuredLocation(fix: LocationFix) {
  if (!measuring || !measured.some(point => point.gps)) return;
  for (const point of measured) if (point.gps) Object.assign(point, { east: fix.east, north: fix.north, z: fix.height });
  if (surfaceLink && measured.at(-1)?.gps) surfaceLink = undefined;
  if (!infoCard.hidden) showMeasure();
  invalidateView();
}
// Navigation to an object: distance, height difference and an arrow turned from where the phone points.
let navTarget: MeasurePoint | undefined;
const navPanel = document.querySelector<HTMLElement>('#nav-panel')!;
const navArrow = document.querySelector<SVGElement>('#nav-arrow')!;
const navText = document.querySelector<HTMLElement>('#nav-text')!;
function navigateActions(target: MeasurePoint): InfoAction[] {
  if (!looksLikeSJTSK(worldOrigin.x, worldOrigin.y)) return [];
  return [{ label: 'Navigate', run: () => {
    navTarget = target; infoCard.hidden = true; select(target);
    // Navigation needs the position and, for the arrow, the compass (asked for during this tap on iPhone).
    if (!deviceLocation.active) toggleLocation(); else deviceHeading.start();
    invalidateView();
  } }];
}
document.querySelector<HTMLButtonElement>('#nav-stop')!.addEventListener('click', () => { navTarget = undefined; invalidateView(); });
function updateNavigation() {
  navPanel.hidden = !navTarget;
  if (!navTarget) return;
  const fix = deviceLocation.state.kind === 'fix' ? deviceLocation.state.fix : undefined;
  const title = document.createElement('strong'); title.textContent = navTarget.name;
  if (!fix) {
    navText.replaceChildren(title, deviceLocation.active ? 'Waiting for GPS fix…' : 'Location is off');
    navArrow.style.opacity = '.3'; return;
  }
  const way = navigate(fix, navTarget, deviceHeading.heading);
  // Without a compass the arrow points the way on the map as it is shown on screen.
  const angle = way.turn ?? way.gridBearing - viewOrientation(camera).bearing;
  navArrow.style.transform = `rotate(${angle}deg)`; navArrow.style.opacity = '1';
  const height = Math.round(way.dz);
  navText.replaceChildren(title, `${formatDistance(way.horizontal)} · ${height === 0 ? 'same height' : `${height > 0 ? '↑' : '↓'} ${Math.abs(height)} m`} · ${Math.round(way.trueBearing) % 360}°${way.turn === undefined ? ' (no compass: arrow on the map)' : ''}`);
}

// Recording: GPS tracks kept on the device; started and stopped in the Recording window
// (REC in the top bar, or View → Recording…), each shown, renamed, exported or deleted there.
const tracks = new TrackStore();
const trackCanvas = document.querySelector<HTMLCanvasElement>('#track-overlay')!;
const trackToggle = document.querySelector<HTMLButtonElement>('#track-toggle')!;
const tracksDialog = document.querySelector<HTMLDialogElement>('#tracks-dialog')!;
const tracksList = document.querySelector<HTMLElement>('#tracks-list')!;
const tracksRecord = document.querySelector<HTMLButtonElement>('#tracks-record')!;
const tracksStatus = document.querySelector<HTMLElement>('#tracks-status')!;
void tracks.load().then(() => { renderTracks(); invalidateView(); });
function trackSummary(track: Track) {
  const date = new Date(track.created);
  return `${track.points.length} ${track.points.length === 1 ? 'point' : 'points'} · ${formatDistance(trackLength(track))} · ${date.getDate()}.${date.getMonth() + 1}.${date.getFullYear()} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
function syncRecording() {
  const recording = tracks.recording;
  trackToggle.setAttribute('aria-pressed', String(Boolean(recording)));
  trackToggle.title = recording ? `Recording: ${trackSummary(recording)}` : 'Recording: GPS tracks';
  tracksRecord.textContent = recording ? 'Stop recording' : 'Start recording';
  tracksRecord.classList.toggle('recording', Boolean(recording));
  tracksStatus.textContent = recording ? `● ${recording.points.length} ${recording.points.length === 1 ? 'point' : 'points'} · ${formatDistance(trackLength(recording))}` : '';
}
function renderTracks() {
  syncRecording();
  tracksList.replaceChildren(...[...tracks.tracks].reverse().map(track => {
    const row = document.createElement('li'); row.style.setProperty('--track', track.color);
    const shown = document.createElement('input'); shown.type = 'checkbox'; shown.checked = track.visible; shown.setAttribute('aria-label', `Show ${track.name}`);
    shown.addEventListener('change', () => { tracks.setVisible(track.id, shown.checked); invalidateView(); });
    const name = document.createElement('button'); name.type = 'button'; name.className = 'track-name'; name.textContent = track.name; name.style.color = track.color;
    name.addEventListener('click', () => {
      // Rename in place (no browser prompt, which installed apps may block).
      const input = document.createElement('input'); input.className = 'track-name-input'; input.value = track.name; input.setAttribute('aria-label', 'Track name');
      let finished = false;
      const done = () => { if (finished) return; finished = true; tracks.rename(track.id, input.value); renderTracks(); };
      input.addEventListener('keydown', event => { if (event.key === 'Enter') done(); if (event.key === 'Escape') { event.stopPropagation(); finished = true; renderTracks(); } });
      input.addEventListener('blur', done);
      name.replaceWith(input); input.focus(); input.select();
    });
    const meta = document.createElement('div'); meta.className = 'track-meta'; meta.classList.toggle('recording', tracks.recording?.id === track.id);
    meta.textContent = `${tracks.recording?.id === track.id ? '● recording · ' : ''}${trackSummary(track)}`;
    const actions = document.createElement('div'); actions.className = 'track-actions';
    const button = (label: string, run: () => void) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.addEventListener('click', run); actions.append(b); return b; };
    const file = track.name.replace(/[^\w.-]+/g, '_');
    button('Show', () => {
      if (!track.points.length || !looksLikeSJTSK(worldOrigin.x, worldOrigin.y)) return;
      const east = track.points.reduce((sum, p) => sum + p.east, 0) / track.points.length, north = track.points.reduce((sum, p) => sum + p.north, 0) / track.points.length;
      if (!track.visible) { tracks.setVisible(track.id, true); }
      tracksDialog.close(); focusOn(new THREE.Vector3(east - worldOrigin.x, north - worldOrigin.y, (surfaceScene.heightAt(east, north) ?? worldOrigin.z) - worldOrigin.z));
    }).disabled = !track.points.length;
    button('GPX', () => download(`${file}.gpx`, trackGpx(track.points, track.name), 'application/gpx+xml')).disabled = !track.points.length;
    button('Therion', () => download(`${file}.th`, trackTherion(track.points, track.name), 'text/plain')).disabled = !track.points.length;
    const remove = button('Delete', () => {
      if (remove.dataset.armed !== 'true') { remove.dataset.armed = 'true'; remove.textContent = 'Delete?'; return; }
      tracks.remove(track.id); renderTracks(); invalidateView();
    });
    row.append(shown, name, meta, actions);
    return row;
  }));
}
function openTracks() {
  document.querySelectorAll<HTMLDetailsElement>('#menus details').forEach(group => { group.open = false; });
  renderTracks(); tracksDialog.showModal(); document.querySelector<HTMLButtonElement>('#tracks-close')!.focus();
}
trackToggle.addEventListener('click', openTracks);
document.querySelector<HTMLButtonElement>('#tracks-open')!.addEventListener('click', openTracks);
document.querySelector<HTMLButtonElement>('#tracks-close')!.addEventListener('click', () => tracksDialog.close());
tracksRecord.addEventListener('click', () => {
  if (tracks.recording) tracks.stop();
  else { tracks.start(); if (!deviceLocation.active) toggleLocation(); }
  renderTracks(); showLocationState(deviceLocation.state); invalidateView();
});
function recordFix(fix: LocationFix) {
  if (tracks.add({ time: new Date().toISOString(), latitude: fix.latitude, longitude: fix.longitude, east: fix.east, north: fix.north,
    height: fix.heightSource === 'model' ? null : Math.round(fix.height * 10) / 10, accuracy: fix.accuracy })) {
    syncRecording(); if (tracksDialog.open) renderTracks(); invalidateView();
  }
}
function download(name: string, text: string, type: string) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([text], { type })); link.download = name;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
}
document.querySelector<HTMLButtonElement>('#maps-forget')!.addEventListener('click', () => {
  void forgetStoredUnderlays().then(() => announce('Saved map underlays are forgotten; they download again when chosen.')).catch(() => undefined);
});
document.querySelector<HTMLButtonElement>('#model-forget')!.addEventListener('click', () => {
  void forgetLastModel().then(() => announce('The saved model is forgotten; the sample cave opens next time.')).catch(() => undefined);
});

// Vertical section: tap two points; only a slab around the vertical plane through them stays,
// seen straight across, so passages show as a profile along the line.
const sectionPanel = document.querySelector<HTMLElement>('#section-panel')!;
const sectionText = document.querySelector<HTMLElement>('#section-text')!;
const sectionWidth = document.querySelector<HTMLInputElement>('#section-width')!;
const sectionWidthValue = document.querySelector<HTMLOutputElement>('#section-width-value')!;
let section: Section | undefined, sectionFlipped = false;
let sectionPicks: THREE.Vector3[] | undefined;
const SECTION_HINT = 'Tap two points on the model for the section line · Esc cancels';
const sectionToggle = document.querySelector<HTMLButtonElement>('#section-toggle')!;
function startSectionPick() {
  if (measuring) setMeasuring(false);
  // Out of the way, so the model can be tapped.
  menus.close();
  sectionPicks = []; pivotHint.textContent = SECTION_HINT; pivotHint.hidden = false; infoCard.hidden = true;
  sectionToggle.setAttribute('aria-pressed', 'true');
}
sectionToggle.addEventListener('click', () => {
  if (sectionPicks) { sectionPicks = undefined; pivotHint.hidden = true; sectionToggle.setAttribute('aria-pressed', String(Boolean(section))); }
  else if (section) applySection(undefined);
  else startSectionPick();
});
function addSectionPick(clientX: number, clientY: number) {
  const rect = canvas.getBoundingClientRect();
  const ndc = new THREE.Vector2((clientX - rect.left) / rect.width * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
  const point = pickModelPoint(camera, [walls, surfaceGroup, lines], ndc, rect.height, controls.target);
  if (!point || !sectionPicks) { pivotHint.textContent = 'Nothing there. Tap a wall, the surface or a centreline shot · Esc cancels'; return; }
  sectionPicks.push(point);
  pivotMarker.style.left = `${clientX - rect.left}px`; pivotMarker.style.top = `${clientY - rect.top}px`;
  pivotMarker.hidden = true; void pivotMarker.offsetWidth; pivotMarker.hidden = false;
  if (sectionPicks.length < 2) { pivotHint.textContent = 'Now tap the second point · Esc cancels'; return; }
  const [a, b] = sectionPicks; sectionPicks = undefined; pivotHint.hidden = true;
  setTimeout(() => { pivotMarker.style.left = ''; pivotMarker.style.top = ''; }, 1500);
  const made = makeSection(a, b, SECTION_WIDTHS[Number(sectionWidth.value)]);
  if (!made) { announce('The two points are too close together for a section.', true); return; }
  sectionFlipped = false; applySection(made, true);
}
function applySection(next: Section | undefined, turnView = false) {
  section = next;
  sectionToggle.setAttribute('aria-pressed', String(Boolean(next)));
  renderer.clippingPlanes = next ? next.planes : [];
  sectionPanel.hidden = !next;
  if (next) {
    // Symbols, labels and objects outside the slab are hidden too (file coordinates).
    setSymbolFilter((east, north) => inSection(next, { x: east - worldOrigin.x, y: north - worldOrigin.y }));
    sectionWidthValue.value = `${next.width} m`;
    sectionText.textContent = `Section ${Math.round(next.length)} m long, bearing ${Math.round(next.lineBearing)}°${sectionFlipped ? ' (seen from the other side)' : ''}`;
    if (turnView) {
      orbitTo(camera, controls, (next.bearing + (sectionFlipped ? 180 : 0)) % 360, 0);
      animateRotationCentre(camera, controls, next.a.clone().add(next.b).multiplyScalar(.5));
    }
  } else setSymbolFilter(undefined);
  invalidateView();
}
document.querySelector<HTMLButtonElement>('#section-menu')!.addEventListener('click', startSectionPick);
// Export of the section: a 1:1000 profile drawing, an image of the view, or the stations in it.
const sectionExportMenu = document.querySelector<HTMLElement>('#section-export-menu')!;
document.querySelector<HTMLButtonElement>('#section-export')!.addEventListener('click', () => { sectionExportMenu.hidden = !sectionExportMenu.hidden; });
document.addEventListener('pointerdown', event => {
  if (!sectionExportMenu.hidden && !sectionExportMenu.parentElement!.contains(event.target as Node)) sectionExportMenu.hidden = true;
});
function sectionStations(): ProfileStation[] {
  return centreline.stationDetails.filter(station => !temporaryStation(station)).map(station => ({
    name: station.flags & STATION_ENTRANCE && station.comment?.trim() ? station.comment.trim() : `${station.name}@${station.survey}`,
    x: station.position[0] - worldOrigin.x, y: station.position[1] - worldOrigin.y, z: station.position[2] - worldOrigin.z,
    entrance: Boolean(station.flags & STATION_ENTRANCE),
  }));
}
function sectionShots() {
  const shots: [THREE.Vector3, THREE.Vector3][] = [];
  lines.updateMatrixWorld(true);
  lines.traverse(object => {
    if (!(object instanceof THREE.LineSegments) || !object.visible) return;
    const position = object.geometry.getAttribute('position');
    for (let i = 0; i + 1 < position.count; i += 2) shots.push([
      new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(object.matrixWorld),
      new THREE.Vector3().fromBufferAttribute(position, i + 1).applyMatrix4(object.matrixWorld)]);
  });
  return shots;
}
sectionExportMenu.addEventListener('click', event => {
  const kind = (event.target as HTMLElement).closest<HTMLElement>('[data-export]')?.dataset.export;
  if (!kind || !section) return;
  sectionExportMenu.hidden = true;
  const name = `section_${Math.round(section.lineBearing)}deg_${Math.round(section.length)}m`;
  const title = `${document.querySelector('#project-title')?.textContent?.trim() || 'loch.js'}: section ${Math.round(section.length)} m`;
  if (kind === 'svg') {
    const current = section, dx = current.b.x - current.a.x, dy = current.b.y - current.a.y, length = Math.hypot(dx, dy);
    const terrainAt = (s: number) => surfaceScene.heightAt(current.a.x + dx / length * s + worldOrigin.x, current.a.y + dy / length * s + worldOrigin.y);
    download(`${name}.svg`, sectionSvg(current, sectionShots(), sectionStations(), terrainAt, worldOrigin.z, title), 'image/svg+xml');
  } else if (kind === 'csv') download(`${name}.csv`, sectionCsv(section, sectionStations(), worldOrigin.z), 'text/csv');
  else {
    // The 3D view and its symbol overlays, drawn the moment after a fresh render.
    renderer.render(scene, camera);
    const image = document.createElement('canvas'); image.width = canvas.width; image.height = canvas.height;
    const context = image.getContext('2d')!;
    context.fillStyle = '#09131c'; context.fillRect(0, 0, image.width, image.height);
    context.drawImage(canvas, 0, 0);
    for (const overlay of Array.from(document.querySelectorAll<HTMLCanvasElement>('#station-labels, #layer-points, #track-overlay, #measure-overlay'))) {
      if (!overlay.hidden && overlay.width) context.drawImage(overlay, 0, 0, image.width, image.height);
    }
    image.toBlob(blob => {
      if (!blob) return;
      const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `${name}.png`;
      document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
    }, 'image/png');
  }
});

document.querySelector<HTMLButtonElement>('#section-end')!.addEventListener('click', () => applySection(undefined));
document.querySelector<HTMLButtonElement>('#section-flip')!.addEventListener('click', () => { if (section) { sectionFlipped = !sectionFlipped; applySection(section, true); } });
sectionWidth.addEventListener('input', () => {
  sectionWidthValue.value = `${SECTION_WIDTHS[Number(sectionWidth.value)]} m`;
  if (section) applySection(withWidth(section, SECTION_WIDTHS[Number(sectionWidth.value)]));
});

// File → Export points…: entrances, all stations, field objects or an imported layer, in GIS formats.
const exportDialog = document.querySelector<HTMLDialogElement>('#export-dialog')!;
const exportWhat = document.querySelector<HTMLSelectElement>('#export-what')!;
const exportFormat = document.querySelector<HTMLSelectElement>('#export-format')!;
const exportCount = document.querySelector<HTMLElement>('#export-count')!;
function exportSources(): { id: string; title: string; points: () => ExportPoint[] }[] {
  const stations = centreline.stationDetails.filter(station => !temporaryStation(station));
  const station = (s: Station): ExportPoint => ({ name: s.comment?.trim() || `${s.name}@${s.survey}`, east: s.position[0], north: s.position[1], z: s.position[2],
    attributes: { station: `${s.name}@${s.survey}`, survey: s.fullSurvey } });
  return [
    { id: 'entrances', title: 'Cave entrances', points: () => stations.filter(s => s.flags & STATION_ENTRANCE).map(station) },
    { id: 'stations', title: 'All survey stations', points: () => stations.map(s => ({ ...station(s), name: `${s.name}@${s.survey}` })) },
    { id: 'objects', title: 'Field objects', points: () => fieldObjects.objects.filter(o => o.position).map(o => ({
      name: o.title || o.name, east: o.position!.east, north: o.position!.north,
      z: surfaceScene.heightAt(o.position!.east, o.position!.north) ?? o.position!.height ?? 0, attributes: { id: o.name, note: o.note } })) },
    ...pointLayers.map(layer => ({ id: `layer:${layer.id}`, title: `Layer ${layer.name}`, points: () => browsablePoints(layer).map(index => {
      const p = layer.points[index];
      return { name: p.label, east: p.east, north: p.north, z: p.z ?? surfaceScene.heightAt(p.east, p.north) ?? 0, attributes: p.attributes };
    }) })),
  ];
}
function updateExportCount() {
  const source = exportSources().find(item => item.id === exportWhat.value);
  const count = source?.points().length ?? 0;
  exportCount.textContent = `${count} point${count === 1 ? '' : 's'}${!looksLikeSJTSK(worldOrigin.x, worldOrigin.y) ? ' · this model is not in S-JTSK: coordinates are local and WGS 84 formats are meaningless' : ''}`;
}
document.querySelector<HTMLButtonElement>('#export-open')!.addEventListener('click', () => {
  document.querySelectorAll<HTMLDetailsElement>('#menus details').forEach(group => { group.open = false; });
  exportWhat.replaceChildren(...exportSources().map(item => new Option(item.title, item.id)));
  updateExportCount(); exportDialog.showModal(); document.querySelector<HTMLButtonElement>('#export-close')!.focus();
});
exportWhat.addEventListener('change', updateExportCount);
document.querySelector<HTMLButtonElement>('#export-close')!.addEventListener('click', () => exportDialog.close());
document.querySelector<HTMLButtonElement>('#export-go')!.addEventListener('click', () => {
  const source = exportSources().find(item => item.id === exportWhat.value);
  const points = source?.points() ?? [];
  if (!source || !points.length) { announce('Nothing to export there.', true); return; }
  const base = source.title.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const format = exportFormat.value;
  if (format === 'shp') {
    const files = toShapefile(points);
    const blob = createZip(Object.entries(files).map(([extension, data]) => ({ name: `${base}.${extension}`, data })));
    const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `${base}_shp.zip`;
    document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
  } else if (format === 'kml') download(`${base}.kml`, toKml(points, source.title), 'application/vnd.google-earth.kml+xml');
  else if (format === 'gpx') download(`${base}.gpx`, toGpx(points), 'application/gpx+xml');
  else if (format === 'csv') download(`${base}.csv`, toCsv(points), 'text/csv');
  else download(`${base}${format === 'geojson-wgs' ? '_wgs84' : ''}.geojson`, toGeoJson(points, format === 'geojson-wgs'), 'application/geo+json');
  announce(`${points.length} points exported.`);
});

// Scene → Surface → Underlay: ZBGIS orthophoto, ZBGIS base map or the geological map draped on the surface.
const underlaySelect = document.querySelector<HTMLSelectElement>('#surface-underlay')!;
underlaySelect.value = 'lox';
const underlayToggle = document.querySelector<HTMLButtonElement>('#underlay-toggle')!;
const underlayMenu = document.querySelector<HTMLElement>('#underlay-menu')!;
function syncUnderlayMenu() {
  for (const item of Array.from(underlayMenu.querySelectorAll<HTMLButtonElement>('[data-underlay]'))) item.setAttribute('aria-checked', String(item.dataset.underlay === underlaySelect.value));
  underlayToggle.classList.toggle('on', underlaySelect.value !== 'lox');
}
underlayToggle.addEventListener('click', () => {
  syncUnderlayMenu(); underlayMenu.hidden = !underlayMenu.hidden;
  underlayToggle.setAttribute('aria-expanded', String(!underlayMenu.hidden));
});
underlayMenu.addEventListener('click', event => {
  const item = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-underlay]');
  if (!item) return;
  underlayMenu.hidden = true; underlayToggle.setAttribute('aria-expanded', 'false');
  if (underlaySelect.value !== item.dataset.underlay) { underlaySelect.value = item.dataset.underlay!; underlaySelect.dispatchEvent(new Event('change')); }
});
document.addEventListener('pointerdown', event => {
  if (!underlayMenu.hidden && !underlayMenu.contains(event.target as Node) && !underlayToggle.contains(event.target as Node)) { underlayMenu.hidden = true; underlayToggle.setAttribute('aria-expanded', 'false'); }
});
underlaySelect.addEventListener('change', syncUnderlayMenu);
let underlayRequest: AbortController | undefined;
underlaySelect.addEventListener('change', () => {
  underlayRequest?.abort(); underlayRequest = undefined;
  const service = UNDERLAY_SERVICES.find(item => item.id === underlaySelect.value);
  if (!service) { surfaceScene.setUnderlay(undefined); return; }
  const extent = surfaceScene.extent();
  if (!extent || !looksLikeSJTSK(worldOrigin.x, worldOrigin.y)) {
    announce('Map underlays need a model with a surface in S-JTSK.', true); underlaySelect.value = 'lox'; syncUnderlayMenu(); return;
  }
  const overlay = document.querySelector<HTMLInputElement>('#surface-image-overlay')!;
  if (!overlay.checked) { overlay.checked = true; overlay.dispatchEvent(new Event('change')); }
  const request = underlayRequest = new AbortController();
  // Phones run out of graphics memory with two large surface images: 2048 px there, 4096 on a computer.
  const size = Math.min(renderer.capabilities.maxTextureSize, matchMedia('(pointer: coarse)').matches ? 2048 : 4096);
  const key = underlayKey(service.id, extent, size);
  const show = (image: TexImageSource, width: number, height: number, note: string) => {
    if (request !== underlayRequest) return;
    const texture = image instanceof HTMLCanvasElement ? new THREE.CanvasTexture(image) : new THREE.Texture(image);
    texture.needsUpdate = true;
    texture.flipY = false; texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 4;
    surfaceScene.setUnderlay({ texture, extent, width, height });
    announce(`${service.title} ${service.attribution}${note}`);
  };
  // A copy kept on the device first (works offline), then the service.
  void loadStoredUnderlay(key).catch(() => undefined).then(async stored => {
    if (stored) { show(await createImageBitmap(stored.blob, { imageOrientation: 'none' }), stored.width, stored.height, ` · saved copy from ${stored.saved.slice(0, 10)}`); return; }
    announce(`Loading ${service.title}…`);
    const { canvas: image, width, height } = await fetchUnderlay(service, extent, size, (done, total) => announce(`Loading ${service.title}… ${done}/${total}`), request.signal);
    show(image, width, height, ' · saved for offline use');
    image.toBlob(blob => { if (blob) void storeUnderlay(key, { blob, width, height, saved: new Date().toISOString() }).catch(() => undefined); },
      service.format === 'image/jpeg' ? 'image/jpeg' : 'image/png', .9);
  }).catch(error => {
    if (request !== underlayRequest || (error as Error).name === 'AbortError') return;
    announce(`${service.title}: ${exceptionMessage(error)}`, true);
    underlaySelect.value = 'lox'; syncUnderlayMenu(); surfaceScene.setUnderlay(undefined);
  });
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
  if (state.kind === 'fix') { updateMeasuredLocation(state.fix); recordFix(state.fix); }
  const active = state.kind === 'waiting' || state.kind === 'fix';
  locateButton.setAttribute('aria-pressed', String(active));
  locateButton.title = active ? 'Stop showing my location' : 'Show my location (GPS)';
  locateButton.setAttribute('aria-label', locateButton.title);
  clearTimeout(locationInfoTimer);
  locationInfo.classList.toggle('error', state.kind === 'error');
  if (state.kind === 'off') locationInfo.hidden = true;
  else if (state.kind === 'waiting') { locationInfo.textContent = state.message ?? 'Waiting for GPS fix…'; locationInfo.hidden = false; }
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
    if (tracks.recording) second.textContent += ` · REC ${tracks.recording.points.length} pts, ${formatDistance(trackLength(tracks.recording))}`;
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
  showInModel: (local, object) => {
    focusOn(local);
    const position = object.position!;
    select({ name: object.title, east: position.east, north: position.north, z: local.z + worldOrigin.z });
  },
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
  flashBoundingBox(); syncProjection();
});
// Dock buttons mirror menu controls, so wire them after those controls are initialized.
initializeDock();
syncProjection();
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
for (const [element, toggle] of [[compassIndicator, () => { viewLocks.toggleNorth(); flashBoundingBox(); }], [tiltIndicator, () => { viewLocks.toggleSide(); flashBoundingBox(); }]] as const) {
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
// On a computer the menu stays open and the dock's icons stack under it on the left.
initializeLayout(computer => { menus.pin(computer); invalidateView(); });
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
  // A section and a map underlay belong to the model they were made for.
  applySection(undefined);
  underlayRequest?.abort(); underlayRequest = undefined; underlaySelect.value = 'lox'; syncUnderlayMenu();
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
/** A model opened from a file, copied to the device once it has loaded. */
let pendingModelSave: { file: File; id: number } | undefined;
function finishFileLoading() {
  if (!collapseAfterRender || loadingError || largeWorker || surfaceScene.loading || (preparationPending && walls.visible)) return;
  collapseAfterRender = false;
  setStatusProgress(status);
  menus.collapse();
  const save = pendingModelSave; pendingModelSave = undefined;
  if (save && save.id === loadId) setTimeout(() => void saveLastModel(save.file).catch(() => { /* No room or no storage: the sample opens next time. */ }), 1000);
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
  // Shapefiles and GPX, KML/KMZ, GeoJSON or CSV become point layers.
  if (files.some(file => file.name.toLowerCase().endsWith('.shp') || POINT_FORMATS.some(extension => file.name.toLowerCase().endsWith(extension)))) { void importLayer(files); return; }
  const model = files.find(file => modelFileFormat(file.name));
  if (!model) return;
  void loadFile(model);
  // Reopened on the next start, also without a signal. Copied to the device only once the
  // model has finished loading, so the copy does not compete with reading the file.
  pendingModelSave = { file: model, id: loadId };
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
  const pointFile = files.find(file => POINT_FORMATS.some(extension => file.name.toLowerCase().endsWith(extension)));
  try {
    const { layer, summary } = files.some(file => file.name.toLowerCase().endsWith('.shp')) || !pointFile
      ? await readShapefileLayer(files, pointLayers.length) : await readPointFileLayer(pointFile, pointLayers.length);
    pointLayers = [...pointLayers, layer];
    showSymbols();
    try { await layerStore.put(layer); } catch { /* Kept for this session only. */ }
    const georeferenced = hasModel && looksLikeSJTSK(worldOrigin.x, worldOrigin.y);
    announce(georeferenced ? summary : `${summary}. Open a model in S-JTSK to see it.`);
    invalidateView();
  } catch (error) {
    announce(`Cannot import layer: ${exceptionMessage(error)}`, true);
  }
}
/** Ringed point (file coordinates): the one shown from File → SHP files or tapped last. */
let selection: MeasurePoint | null = null;
const selectionRing = document.querySelector<HTMLElement>('#selection-ring')!;
function select(point: MeasurePoint | null) { selection = point; invalidateView(); }
function updateSelectionRing() {
  const screen = selection && hasModel ? markerScreenPosition(new THREE.Vector3(selection.east - worldOrigin.x, selection.north - worldOrigin.y, selection.z - worldOrigin.z), camera, canvas.clientWidth, canvas.clientHeight) : undefined;
  selectionRing.hidden = !screen?.onScreen;
  if (screen?.onScreen) selectionRing.style.transform = `translate(${screen.x}px, ${screen.y}px)`;
}
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
  setHighlight: highlight => {
    const layer = highlight && pointLayers.find(item => item.id === highlight.layerId), point = layer?.points[highlight!.index];
    if (!point) { select(null); return; }
    showSymbols();
    select({ name: point.label, east: point.east, north: point.north, z: point.z ?? surfaceScene.heightAt(point.east, point.north) ?? worldOrigin.z });
  },
});
function updateLayers() {
  const georeferenced = hasModel && looksLikeSJTSK(worldOrigin.x, worldOrigin.y);
  const symbols = symbolOptions();
  layerCanvas.hidden = !georeferenced || !layersVisible.checked || !symbols.visible || !pointLayers.length;
  if (!layerCanvas.hidden) drawLayers(layerCanvas, pointLayers, camera, canvas.clientWidth, canvas.clientHeight, worldOrigin, (east, north) => surfaceScene.heightAt(east, north), symbols.label);
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
      const perDepth = camera instanceof THREE.PerspectiveCamera ? 2 * Math.tan(THREE.MathUtils.degToRad(camera.getEffectiveFOV()) / 2) / height : undefined;
      setSymbolView(activeBox.getSize(new THREE.Vector3()).length() / height, metresPerPixel(camera, controls.target, height), perDepth);
    }
    surfaceScene.updateCamera(camera.position);
    indicators.update();
    updateLocationDot();
    updateSelectionRing();
    updateNavigation();
    trackCanvas.hidden = !hasModel || !tracks.tracks.some(t => t.visible && t.points.length) || !looksLikeSJTSK(worldOrigin.x, worldOrigin.y);
    if (!trackCanvas.hidden) drawTracks(trackCanvas, tracks.tracks, camera, canvas.clientWidth, canvas.clientHeight, worldOrigin, (east, north) => surfaceScene.heightAt(east, north));
    // Overlapping small symbols hide behind earlier ones: entrances first, then field objects, then SHP points.
    resetSymbolSpace();
    centreline.updateLabels(camera, canvas.clientWidth, canvas.clientHeight);
    fieldObjects.updateMarkers(camera, canvas.clientWidth, canvas.clientHeight);
    updateLayers();
    measureCanvas.hidden = !measuring || (!measured.length && !surfaceLink);
    if (!measureCanvas.hidden) drawMeasure(measureCanvas, measured, surfaceLink, camera, canvas.clientWidth, canvas.clientHeight, worldOrigin);
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
// The last opened model, if one is kept on the device; otherwise the sample cave.
void loadLastModel().then(file => { if (file && loadId === 0) void loadFile(file); else void loadSample(); }).catch(() => void loadSample());
