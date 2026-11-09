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
import { cropWindow, dmrLox, dmrSteps, dmrSurface, dmrTherion, dmrThconfig, hillshade, imagePlace, imagePlan, imageSize, RELIEF_IMAGE, inspectDmr, resampleDmr, tiffFromZip, wholeFile, type CellWindow, type Dmr } from './dmr';
import type { GeoTiff } from './geotiff';
import { forgetDmr, loadDmr, saveDmr } from './dmr-store';
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
import { looksLikeSJTSK, sjtskToWgs84 } from './geo';
import { drawLayers, LayerStore, readShapefileLayer, type PointLayer, readPointFileLayer } from './layers';
import { POINT_FORMATS, toCsv, toGeoJson, toGpx, toKml, toShapefile, type ExportPoint } from './formats';
import { LayerBrowser } from './layers-ui';
import { searchModel, type SearchResult } from './search';
import { browsablePoints } from './layers-ui';
import { STATION_ENTRANCE, temporaryStation, type Station } from './lox-stations';
import { animateRotationCentre, pickModelPoint, RotationCentrePicker } from './pivot';
import { DeviceLocation, formatFix, markerScreenPosition, type LocationFix, type LocationState, headingScreenAngle } from './location';
import { DeviceHeading } from './heading';
import { addLocalMap, localMaps, localService, localTiles, removeLocalMap } from './local-maps';
import { downloadEstimate, fetchMap, loadBlob, prepareWms, nearestPointGap, offlineTiles, OFFLINE_BASE, planPieces, tileGround, tileTemplate, tileUrl, UNDERLAY_SERVICES, zoomFor, type TileSource, type UnderlayService, type XyzService } from './underlay';
import { forgetStored, forgetStoredUnderlays, loadStoredTile, loadStoredUnderlay, storedKeys, storeTile, storeUnderlay, underlayKey } from './underlay-cache';
import { createZip } from './zip';
import { inSection, makeSection, SECTION_WIDTHS, withWidth, type Section } from './section';
import { sectionCsv, sectionSvg, type ProfileStation } from './section-export';
import { formatDistance, navigate } from './navigation';
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
// Full detail at every start (browsers may restore a choice from an earlier visit).
detail.value = 'full';
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
  try { localStorage.removeItem(START_EMPTY); } catch { /* Nothing kept. */ }
  void forgetLastModel().then(() => announce('The saved model is forgotten; the sample cave opens next time.')).catch(() => undefined);
});
/** After File → New the app starts empty (not with the sample) until a model is opened. */
const START_EMPTY = 'loch.js-start-empty';
document.querySelector<HTMLButtonElement>('#new')!.addEventListener('click', () => {
  menus.close(); // the File dropdown closes too
  newScene();
  try { localStorage.setItem(START_EMPTY, '1'); localStorage.removeItem(LAST_TERRAIN); } catch { /* The sample may open next time. */ }
  void forgetLastModel().catch(() => undefined);
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
    for (const overlay of Array.from(document.querySelectorAll<HTMLCanvasElement>('#station-labels, #layer-points, #measure-overlay'))) {
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

// Map layers over the LOX image: orthophotos, outdoor maps and the geological map, each
// switched on and given an opacity on its own; imagery and maps are draped in pieces sharper
// near the cave. Downloaded maps are kept on the device; on mobile data the app asks first,
// with the expected size.
const underlayToggle = document.querySelector<HTMLButtonElement>('#underlay-toggle')!;
const underlayMenu = document.querySelector<HTMLElement>('#underlay-menu')!;
const layerList = document.querySelector<HTMLElement>('#map-layers')!;
type MapLayerState = {
  on: boolean; opacity: number; request?: AbortController;
  /** On-demand layers: API key, failures in a row, and whether the attribution was announced. */
  apiKey?: string; failures?: number; announced?: boolean;
  /** Offline layers: zooms kept on the device (lowest, and the highest for each piece). */
  low?: number; highest?: Map<string, number>;
  /** On-demand layers: the zoom each piece shows or is loading, and its request. */
  shown?: Map<string, { zoom: number; pixels: number; loading?: AbortController }>;
  /** Map files: where their tiles come from. */
  source?: TileSource;
};
// Map files added earlier (MBTiles) join the layers, under the geological map.
for (const map of localMaps()) UNDERLAY_SERVICES.splice(UNDERLAY_SERVICES.findIndex(service => service.id === 'geology'), 0, localService(map));
const mapLayers = new Map<string, MapLayerState>(UNDERLAY_SERVICES.map(service => [service.id, { on: false, opacity: service.opacity }]));
// One row per layer: a switch and, while it is on, its opacity.
for (const service of UNDERLAY_SERVICES) addLayerRow(service);
function addLayerRow(service: UnderlayService) {
  const row = document.createElement('div'); row.className = 'map-layer'; row.dataset.layer = service.id;
  const toggle = document.createElement('button'); toggle.type = 'button'; toggle.setAttribute('role', 'menuitemcheckbox'); toggle.textContent = service.title;
  const range = document.createElement('label'); range.className = 'menu-range';
  const input = document.createElement('input'); input.type = 'range'; input.min = '5'; input.max = '100'; input.step = '5'; input.setAttribute('aria-label', `${service.title} opacity`);
  const output = document.createElement('output');
  range.append('Opacity', input, output);
  const status = document.createElement('small'); status.className = 'layer-status';
  row.append(toggle, range, status);
  // Before the geological map, which stays on top.
  const geology = layerList.querySelector('.map-layer[data-layer="geology"]');
  if (geology && service.id !== 'geology') layerList.insertBefore(row, geology); else layerList.append(row);
  if (service.kind === 'xyz' && service.local) {
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'layer-remove'; remove.textContent = 'Remove map file';
    remove.addEventListener('click', () => {
      if (remove.dataset.armed !== 'true') { remove.dataset.armed = 'true'; remove.textContent = 'Remove? Tap again'; return; }
      setMapLayer(service.id, false);
      void removeLocalMap(service.id).then(() => {
        UNDERLAY_SERVICES.splice(UNDERLAY_SERVICES.indexOf(service), 1); mapLayers.delete(service.id); row.remove();
        announce(`${service.title} removed from this device.`); void showStorageUse();
      });
    });
    range.after(remove);
  }
  toggle.addEventListener('click', () => setMapLayer(service.id, !mapLayers.get(service.id)!.on));
  input.addEventListener('input', () => {
    mapLayers.get(service.id)!.opacity = Number(input.value) / 100;
    output.value = `${input.value}%`;
    surfaceScene.setLayerOpacity(service.id, Number(input.value) / 100);
    rememberModelLayers();
  });
}
/** The main map layers, or the other ones (Scene → Surface → Other map layers…); an other layer that is on shows in both. */
let menuMode: 'main' | 'other' = 'main';
function syncUnderlayMenu() {
  const other = menuMode === 'other';
  document.querySelector('#map-caption')!.textContent = other ? 'Other map layers' : 'Over the LOX image';
  document.querySelector<HTMLElement>('#map-add')!.hidden = other;
  if (other) document.querySelector<HTMLElement>('#map-storage')!.hidden = true;
  for (const row of Array.from(layerList.querySelectorAll<HTMLElement>('.map-layer'))) {
    const state = mapLayers.get(row.dataset.layer!)!;
    const listed = UNDERLAY_SERVICES.find(service => service.id === row.dataset.layer)?.other === true;
    row.hidden = other ? !listed : listed && !state.on;
    row.querySelector('button')!.setAttribute('aria-checked', String(state.on));
    const range = row.querySelector<HTMLElement>('.menu-range')!; range.hidden = !state.on;
    const status = row.querySelector<HTMLElement>('.layer-status')!; status.hidden = !state.on || !status.textContent;
    const percent = String(Math.round(state.opacity * 100));
    row.querySelector('input')!.value = percent; row.querySelector('output')!.value = `${percent}%`;
  }
  underlayToggle.classList.toggle('on', [...mapLayers.values()].some(state => state.on));
}
underlayToggle.addEventListener('click', () => {
  menuMode = 'main'; syncUnderlayMenu(); underlayMenu.hidden = !underlayMenu.hidden;
  if (!underlayMenu.hidden) void showStorageUse();
  underlayToggle.setAttribute('aria-expanded', String(!underlayMenu.hidden));
});
const closeUnderlayMenu = () => { underlayMenu.hidden = true; underlayToggle.setAttribute('aria-expanded', 'false'); };
document.addEventListener('pointerdown', event => {
  if (!underlayMenu.hidden && !underlayMenu.contains(event.target as Node) && !underlayToggle.contains(event.target as Node)
    && !(event.target as Element).closest?.('dialog')) closeUnderlayMenu();
});
// Map files (MBTiles) from the device: copied into the app, indexed, then a layer like the others.
const mapFileInput = document.querySelector<HTMLInputElement>('#map-file')!;
if (/iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) mapFileInput.removeAttribute('accept');
document.querySelector<HTMLButtonElement>('#map-add')!.addEventListener('click', () => mapFileInput.click());
mapFileInput.addEventListener('change', async () => {
  const file = mapFileInput.files?.[0]; mapFileInput.value = '';
  if (!file) return;
  closeUnderlayMenu();
  const megabytes = (bytes: number) => Math.round(bytes / 1e6).toLocaleString();
  try {
    const { map, kept } = await addLocalMap(file, (stage, done, total) => {
      importing = { text: stage === 'copy' ? `Copying ${file.name} to this device: ${megabytes(done)} / ${megabytes(total)} MB` : `Indexing ${file.name}: ${Math.floor(done / total * 100)} %`, fraction: total ? done / total : 0 };
      showMapProgress();
    });
    const service = localService(map);
    UNDERLAY_SERVICES.splice(UNDERLAY_SERVICES.findIndex(item => item.id === 'geology'), 0, service);
    mapLayers.set(service.id, { on: false, opacity: service.opacity });
    addLayerRow(service);
    announce(`${map.title} added (zoom ${map.minZoom}–${map.maxZoom}, ${map.format.toUpperCase()})${kept ? '' : ' for this session only: the browser could not keep a copy'}.`);
    if (mapsUsable(true)) setMapLayer(service.id, true);
  } catch (error) { announce(`${file.name}: ${exceptionMessage(error)}`, true); }
  finally { importing = undefined; showMapProgress(); }
});

for (const [button, mode] of [['#surface-maps', 'main'], ['#surface-other-maps', 'other']] as const) document.querySelector<HTMLButtonElement>(button)!.addEventListener('click', () => {
  document.querySelectorAll<HTMLDetailsElement>('#menus details').forEach(group => { group.open = false; });
  menuMode = mode; syncUnderlayMenu(); underlayMenu.hidden = false; underlayToggle.setAttribute('aria-expanded', 'true');
  if (mode === 'main') void showStorageUse();
});

// Terrain from a GeoTIFF (DMR 5.0 from ZBGIS): replaces the LOX surface of this model, kept on the device for it.
/** The model's own surfaces (from the LOX), shown when it has no terrain of its own. */
let loxSurfaces: Surface[] = [];
let terrain: Dmr | undefined;
/** The model's own box, before a terrain widened it. */
let boxWithoutTerrain: THREE.Box3 | undefined;
const dmrDialog = document.querySelector<HTMLDialogElement>('#dmr-dialog')!;
const dmrInput = document.querySelector<HTMLInputElement>('#dmr-file')!;
function syncTerrainMenu() {
  document.querySelector<HTMLButtonElement>('#surface-dmr-export')!.hidden = !terrain;
  document.querySelector<HTMLButtonElement>('#file-dmr-export')!.hidden = !terrain;
  document.querySelector<HTMLButtonElement>('#file-dmr-lox')!.hidden = !terrain;
  document.querySelector<HTMLButtonElement>('#surface-dmr-lox')!.hidden = !terrain;
  document.querySelector<HTMLButtonElement>('#surface-dmr-remove')!.hidden = !terrain;
}
/** Shows the terrain or the LOX surfaces, with the map layers that were on laid over again. */
function showSurfaces() {
  const on = [...mapLayers].filter(([, state]) => state.on).map(([id]) => id);
  for (const id of on) setMapLayer(id, false, true);
  surfaceScene.clear();
  for (const surface of terrain ? [dmrSurface(terrain)] : loxSurfaces) surfaceScene.add(surface, worldOrigin);
  // The model's box takes in the terrain (as it does a LOX surface), so the view reaches all of it.
  boxWithoutTerrain ??= activeBox.clone();
  activeBox = boxWithoutTerrain.clone();
  if (terrain) {
    const surface = dmrSurface(terrain), [x0, y0, step] = surface.calibration;
    let low = Infinity, high = -Infinity;
    for (const h of terrain.heights) if (h === h) { if (h < low) low = h; if (h > high) high = h; }
    activeBox.expandByPoint(new THREE.Vector3(x0, y0, low).sub(worldOrigin));
    activeBox.expandByPoint(new THREE.Vector3(x0 + (terrain.width - 1) * step, y0 + (terrain.height - 1) * step, high).sub(worldOrigin));
  }
  boundingBox.box.copy(activeBox);
  const radius = activeBox.getBoundingSphere(new THREE.Sphere()).radius;
  if (camera.far < radius * 100) { camera.far = radius * 100; camera.updateProjectionMatrix(); }
  for (const id of on) setMapLayer(id, true, true);
  syncTerrainMenu(); deviceLocation.update(); invalidateView();
}
async function restoreTerrain() {
  const key = modelKey;
  const kept = await loadDmr(key).catch(() => undefined);
  if (!kept || key !== modelKey) return;
  terrain = kept; showSurfaces();
  if (kept.image) return;
  // Kept by an older version without its relief image: shaded from the kept grid now (from the
  // GeoTIFF again for the full detail).
  try {
    kept.image = await reliefImage(kept, imagePlan(kept, imageDevice()));
    if (terrain !== kept) return;
    showSurfaces(); void saveDmr(key, kept).catch(() => undefined);
    announce('Relief image added from the terrain grid; open the GeoTIFF again for the full detail.');
  } catch (error) { console.warn('Relief image not made:', error); }
}
/** The model's centre as S-JTSK east, north. */
function modelCentre(): [number, number] {
  const centre = activeBox.isEmpty() ? new THREE.Vector3() : activeBox.getCenter(new THREE.Vector3());
  return [worldOrigin.x + centre.x, worldOrigin.y + centre.y];
}
document.querySelector<HTMLButtonElement>('#surface-dmr-get')!.addEventListener('click', () => {
  const [east, north] = modelCentre();
  const [latitude, longitude] = hasModel && looksLikeSJTSK(east, north) ? sjtskToWgs84(east, north) : [48.7, 19.5];
  // MAPKA, theme Terrain, export: draw the area (up to 400 km²) and download it as GeoTIFF.
  window.open(`https://zbgis.skgeodesy.sk/mapka/sk/teren/export?c=${longitude.toFixed(5)},${latitude.toFixed(5)}&z=14`, '_blank', 'noopener');
  announce('In MAPKA, choose the area round the cave and export DMR 5.0 as GeoTIFF; then open the downloaded ZIP or .tif with “Open terrain (GeoTIFF)…”.');
});
/**
 * A terrain goes under an open S-JTSK model; with no model, or one in other coordinates (the
 * sample), it becomes the whole scene on its own, e.g. just to make a Therion surface.
 */
const underModel = () => hasModel && !terrainOnly && looksLikeSJTSK(...modelCentre());
for (const button of ['#surface-dmr-open', '#import-tif']) document.querySelector<HTMLButtonElement>(button)!.addEventListener('click', () => dmrInput.click());
/** A GeoTIFF or ZIP dropped on the app or picked with Open…. */
function openTerrain(file: File) { void importTerrain(file); }
/** The terrain alone: an empty scene centred on it, kept on the device and reopened at the next start. */
let terrainOnly = false;
const LAST_TERRAIN = 'loch.js-last-terrain';
function showTerrainOnly(dmr: Dmr, key: string) {
  newScene();
  modelKey = key; terrainOnly = true; hasModel = true;
  const step = dmr.step, x0 = dmr.origin[0] + dmr.shift[0], y0 = dmr.origin[1] + dmr.shift[1];
  let low = Infinity, high = -Infinity;
  for (const h of dmr.heights) if (h === h) { if (h < low) low = h; if (h > high) high = h; }
  worldOrigin.set(x0 + (dmr.width - 1) * step / 2, y0 + (dmr.height - 1) * step / 2, (low + high) / 2);
  activeBox = new THREE.Box3(); boxWithoutTerrain = undefined;
  terrain = dmr; showSurfaces();
  updateLegend({ minZ: low, maxZ: high });
  projectTitle.textContent = dmr.name; projectTitle.hidden = false;
  setStatusText(status, `${dmr.name} · terrain ${dmr.width} columns × ${dmr.height} rows every ${dmr.step} m`);
  setCameraView(camera, controls, activeBox, 'fit');
  try { localStorage.setItem(LAST_TERRAIN, key); } catch { /* Not reopened next time. */ }
  restoreModelLayers();
}
async function restoreTerrainOnly(key: string) {
  const id = loadId, dmr = await loadDmr(key).catch(() => undefined);
  if (!dmr || id !== loadId) return false;
  showTerrainOnly(dmr, key);
  return true;
}
dmrInput.addEventListener('change', () => { const file = dmrInput.files?.[0]; dmrInput.value = ''; if (file) void importTerrain(file); });
/**
 * Crop (optional): a rectangle of the file, dragged on a shaded preview (inside it to move it,
 * at a corner to resize it) or typed as its corners; Whole area keeps the whole file.
 */
const cropDialog = document.querySelector<HTMLDialogElement>('#crop-dialog')!;
function askCrop(tiff: GeoTiff, preview: Dmr) {
  const canvas = document.querySelector<HTMLCanvasElement>('#crop-canvas')!, context = canvas.getContext('2d')!;
  const inputs = (['west', 'south', 'east', 'north'] as const).map(side => document.querySelector<HTMLInputElement>(`#crop-${side}`)!);
  const square = document.querySelector<HTMLInputElement>('#crop-square')!, size = document.querySelector('#crop-size')!;
  // Each crop starts as a free rectangle (the browser would keep Square from the last time).
  square.checked = false;
  // The preview: north up, one pixel per preview node, cells without data dark.
  const rgba = hillshade(preview);
  for (let r = 0; r < preview.height; r++) for (let c = 0; c < preview.width; c++) {
    if (preview.heights[r * preview.width + c] === preview.heights[r * preview.width + c]) continue;
    const at = ((preview.height - 1 - r) * preview.width + c) * 4;
    rgba[at] = 19; rgba[at + 1] = 32; rgba[at + 2] = 43;
  }
  const image = new ImageData(rgba, preview.width, preview.height);
  canvas.width = preview.width; canvas.height = preview.height;
  // Shown at the preview's own proportions (so the pointer lands where it points), as large as the dialog allows.
  const view = canvas.parentElement!;
  const fit = () => {
    const room = view.clientWidth, most = Math.min(innerHeight * .52, 460);
    const scale = Math.min(room / preview.width, most / preview.height);
    canvas.style.width = `${Math.floor(preview.width * scale)}px`; canvas.style.height = `${Math.floor(preview.height * scale)}px`;
  };
  const west0 = preview.origin[0] - preview.step / 2, north0 = preview.origin[1] - preview.step / 2 + preview.height * preview.step;
  const toWorld = (x: number, y: number): [number, number] => [west0 + x * preview.step, north0 - y * preview.step];
  const toCanvas = (east: number, north: number): [number, number] => [(east - west0) / preview.step, (north0 - north) / preview.step];
  const full: [number, number, number, number] = [west0, north0 - preview.height * preview.step, west0 + preview.width * preview.step, north0];
  let rect: [number, number, number, number] = [...full], typing = false;
  const snap = (v: number) => Math.round(v);
  const draw = () => {
    context.putImageData(image, 0, 0);
    const [x0, y0] = toCanvas(rect[0], rect[3]), [x1, y1] = toCanvas(rect[2], rect[1]);
    context.fillStyle = 'rgba(9, 19, 24, .55)';
    context.beginPath(); context.rect(0, 0, canvas.width, canvas.height); context.rect(x0, y0, x1 - x0, y1 - y0); context.fill('evenodd');
    const scale = canvas.width / Math.max(1, canvas.getBoundingClientRect().width);
    context.strokeStyle = '#8ed9ff'; context.lineWidth = 2 * scale; context.strokeRect(x0, y0, x1 - x0, y1 - y0);
    context.fillStyle = '#8ed9ff';
    for (const [x, y] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]]) context.fillRect(x - 4 * scale, y - 4 * scale, 8 * scale, 8 * scale);
    // Grips in the middle of the sides: each side drags on its own.
    const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    for (const [x, y, w, h] of [[mx, y0, 18, 6], [mx, y1, 18, 6], [x0, my, 6, 18], [x1, my, 6, 18]]) context.fillRect(x - w / 2 * scale, y - h / 2 * scale, w * scale, h * scale);
    if (!typing) rect.forEach((value, i) => { inputs[i].value = String(snap(value)); });
    const w = rect[2] - rect[0], h = rect[3] - rect[1];
    size.textContent = `${(w / 1000).toFixed(2)} × ${(h / 1000).toFixed(2)} km · ${(w * h / 1e6).toFixed(2)} km²`;
  };
  const normalise = () => {
    rect = [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])];
    rect = [Math.max(full[0], rect[0]), Math.max(full[1], rect[1]), Math.min(full[2], rect[2]), Math.min(full[3], rect[3])];
  };
  // Pointer: new rectangle, move, or a corner.
  // What a pointer takes: a corner (0 south-west, 1 south-east, 2 north-west, 3 north-east), a side
  // (west, south, east, north, as the rectangle's 0–3), the inside to move, or a new rectangle.
  type Grip = { corner: number } | { side: number } | 'move' | 'new';
  let mode: Grip | undefined, start: [number, number] = [0, 0], startRect = rect;
  const point = (event: PointerEvent): [number, number] => {
    const box = canvas.getBoundingClientRect();
    return toWorld((event.clientX - box.left) / box.width * canvas.width, (event.clientY - box.top) / box.height * canvas.height);
  };
  const grip = (event: PointerEvent): Grip => {
    const p = point(event), box = canvas.getBoundingClientRect();
    const near = (event.pointerType === 'touch' ? 22 : 12) * preview.step * canvas.width / box.width;
    // While the rectangle is the whole area, dragging inside draws a new one (its sides still move).
    const whole = rect.every((value, i) => Math.abs(value - full[i]) < preview.step);
    const corners: [number, number][] = [[rect[0], rect[1]], [rect[2], rect[1]], [rect[0], rect[3]], [rect[2], rect[3]]];
    const corner = corners.findIndex(([e, n]) => Math.abs(e - p[0]) < near && Math.abs(n - p[1]) < near);
    if (corner >= 0) return { corner };
    const alongX = p[0] > rect[0] - near && p[0] < rect[2] + near, alongY = p[1] > rect[1] - near && p[1] < rect[3] + near;
    if (alongY && Math.abs(p[0] - rect[0]) < near) return { side: 0 };
    if (alongY && Math.abs(p[0] - rect[2]) < near) return { side: 2 };
    if (alongX && Math.abs(p[1] - rect[1]) < near) return { side: 1 };
    if (alongX && Math.abs(p[1] - rect[3]) < near) return { side: 3 };
    return !whole && p[0] > rect[0] && p[0] < rect[2] && p[1] > rect[1] && p[1] < rect[3] ? 'move' : 'new';
  };
  const cursorOf = (g: Grip) => g === 'move' ? 'move' : g === 'new' ? 'crosshair'
    : 'corner' in g ? (g.corner === 0 || g.corner === 3 ? 'nesw-resize' : 'nwse-resize') : g.side % 2 ? 'ns-resize' : 'ew-resize';
  const down = (event: PointerEvent) => {
    event.preventDefault(); canvas.setPointerCapture(event.pointerId);
    const p = point(event);
    mode = grip(event); start = p; startRect = [...rect];
    if (mode === 'new') rect = [p[0], p[1], p[0], p[1]];
  };
  const move = (event: PointerEvent) => {
    if (mode === undefined) { canvas.style.cursor = cursorOf(grip(event)); return; }
    const p = point(event);
    if (mode === 'move') {
      const w = startRect[2] - startRect[0], h = startRect[3] - startRect[1];
      const e = Math.min(full[2] - w, Math.max(full[0], startRect[0] + p[0] - start[0])), n = Math.min(full[3] - h, Math.max(full[1], startRect[1] + p[1] - start[1]));
      rect = [e, n, e + w, n + h];
    } else if (mode !== 'new' && 'side' in mode) {
      // One side follows the pointer; with Square the neighbouring side keeps it square.
      const side = mode.side, next: [number, number, number, number] = [...startRect];
      next[side] = Math.min(full[2 + (side % 2)] , Math.max(full[side % 2], side % 2 ? p[1] : p[0]));
      if (square.checked) {
        // The other side grows from its west or south edge, as far as the file allows; the dragged side stops there too.
        const opposite = next[(side + 2) % 4], room = side % 2 ? full[2] - next[0] : full[3] - next[1];
        const length = Math.min(Math.abs(next[side] - opposite), room);
        next[side] = opposite + Math.sign(next[side] - opposite || 1) * length;
        if (side % 2) next[2] = next[0] + length; else next[3] = next[1] + length;
      }
      rect = next; normalise();
    } else {
      // The opposite corner stays; with Square the shorter side follows the longer.
      const fixed: [number, number] = mode === 'new' ? start : [mode.corner % 2 ? startRect[0] : startRect[2], mode.corner < 2 ? startRect[3] : startRect[1]];
      let dx = p[0] - fixed[0], dy = p[1] - fixed[1];
      if (square.checked) { const side = Math.max(Math.abs(dx), Math.abs(dy)); dx = Math.sign(dx || 1) * side; dy = Math.sign(dy || 1) * side; }
      rect = [fixed[0], fixed[1], fixed[0] + dx, fixed[1] + dy];
      normalise();
    }
    draw();
  };
  const up = () => {
    if (mode === undefined) return;
    normalise();
    if (rect[2] - rect[0] < preview.step || rect[3] - rect[1] < preview.step) rect = [...startRect];
    mode = undefined; draw();
  };
  const typed = () => {
    const values = inputs.map(input => Number(input.value));
    if (!values.every(Number.isFinite)) return;
    rect = values as [number, number, number, number];
    if (square.checked) { const side = Math.max(rect[2] - rect[0], rect[3] - rect[1]); rect[2] = rect[0] + side; rect[3] = rect[1] + side; }
    normalise(); typing = true; draw(); typing = false;
    // Show what was kept (clipped to the file, squared) once the typing is done.
    inputs.forEach((input, i) => { if (input !== document.activeElement) input.value = String(snap(rect[i])); });
  };
  const squared = () => { if (square.checked) typed(); else draw(); };
  canvas.addEventListener('pointerdown', down); canvas.addEventListener('pointermove', move);
  canvas.addEventListener('pointerup', up); canvas.addEventListener('pointercancel', up);
  for (const input of inputs) input.addEventListener('change', typed);
  // Enter in a corner applies it (a form in a dialog would otherwise close with its first button, Cancel).
  const enter = (event: KeyboardEvent) => {
    if (event.key !== 'Enter' || !(event.target instanceof HTMLInputElement)) return;
    event.preventDefault();
    if (inputs.includes(event.target)) typed();
  };
  cropDialog.addEventListener('keydown', enter);
  square.addEventListener('change', squared);
  addEventListener('resize', fit);
  cropDialog.returnValue = ''; cropDialog.showModal(); fit(); draw();
  cropDialog.querySelector<HTMLButtonElement>('button[value="crop"]')!.focus();
  return new Promise<{ area: CellWindow } | undefined>(resolve => cropDialog.addEventListener('close', () => {
    canvas.removeEventListener('pointerdown', down); canvas.removeEventListener('pointermove', move);
    canvas.removeEventListener('pointerup', up); canvas.removeEventListener('pointercancel', up);
    for (const input of inputs) input.removeEventListener('change', typed);
    cropDialog.removeEventListener('keydown', enter);
    square.removeEventListener('change', squared);
    removeEventListener('resize', fit);
    const value = cropDialog.returnValue;
    if (value === 'whole') resolve({ area: wholeFile(tiff) });
    else if (value === 'crop') {
      const area = cropWindow(tiff, snap(rect[0]), snap(rect[1]), snap(rect[2]), snap(rect[3]));
      resolve(area.columns && area.rows ? { area } : { area: wholeFile(tiff) });
    } else resolve(undefined);
  }, { once: true }));
}
/** Grid step: the finest within what this device draws smoothly, coarser ones offered too. */
function askTerrainStep(name: string, steps: ReturnType<typeof dmrSteps>, cell: number) {
  const smooth = isCoarse() ? 1.5e6 : 5e6, most = isCoarse() ? 5e6 : 2e7;
  const suggested = steps.find(step => step.nodes <= smooth) ?? steps[steps.length - 1];
  const options = document.querySelector('#dmr-options')!;
  options.replaceChildren(...steps.map(step => {
    const button = document.createElement('button');
    button.value = String(step.factor); button.className = 'quality-option';
    button.classList.toggle('suggested', step === suggested);
    button.disabled = step.nodes > most;
    const title = document.createElement('strong'); title.textContent = `${step.step} m`;
    const text = document.createElement('small');
    text.textContent = `${step.columns.toLocaleString()} columns × ${step.rows.toLocaleString()} rows${step.nodes > most ? ': too many for this device' : step.nodes > smooth ? ': may be slow here' : ''}.`;
    button.append(title, text);
    return button;
  }));
  document.querySelector('#dmr-text')!.textContent = `${name}: cells of ${cell} m. Heights are averaged onto a grid of the chosen step; a shaded relief image from the full cells lies over it. Both go to Therion.`;
  dmrDialog.returnValue = ''; dmrDialog.showModal();
  return new Promise<number | undefined>(resolve => dmrDialog.addEventListener('close', () => {
    const factor = Number(dmrDialog.returnValue); resolve(factor > 0 ? factor : undefined);
  }, { once: true }));
}
async function importTerrain(picked: File) {
  const id = loadId, alone = !underModel(), key = alone ? `${picked.name}|${picked.size}|terrain` : modelKey;
  try {
    setStatusText(status, `${picked.name} · Reading terrain…`); setStatusProgress(status, 0);
    const { name, blob } = /\.zip$/i.test(picked.name) ? await tiffFromZip(picked) : { name: picked.name, blob: picked as Blob };
    const { tiff, epsg } = await inspectDmr(blob);
    // First (optional) step: a rectangle of the file, on a quick shaded preview.
    const preview = await resampleDmr(blob, tiff, epsg, Math.max(1, Math.ceil(Math.max(tiff.width, tiff.height) / 900)), name, (done, total) => {
      setStatusText(status, `${name} · Preview · ${Math.round(done / total * 100)}%`); setStatusProgress(status, done / total);
    });
    setStatusProgress(status); setStatusText(status, '');
    if (id !== loadId) return;
    const crop = await askCrop(tiff, preview);
    if (!crop || id !== loadId) return;
    const { area } = crop;
    const factor = await askTerrainStep(name, dmrSteps(tiff, area), tiff.pixelWidth);
    if (!factor || id !== loadId) { setStatusText(status, ''); return; }
    const { jtsk03Shift } = await import('./jtsk03');
    const dmr = await resampleDmr(blob, tiff, epsg, factor, name, (done, total) => {
      setStatusText(status, `${name} · Making terrain · ${Math.round(done / total * 100)}%`); setStatusProgress(status, done / total);
    }, jtsk03Shift, area);
    if (id !== loadId) return;
    // The shaded relief image, from the file's own cells (coarser only on big areas or small devices).
    const plan = imagePlan({ width: area.columns, height: area.rows }, imageDevice());
    const fine = await resampleDmr(blob, tiff, epsg, plan.factor, name, (done, total) => {
      setStatusText(status, `${name} · Shading relief · ${Math.round(done / total * 100)}%`); setStatusProgress(status, done / total);
    }, undefined, area);
    if (id !== loadId) return;
    setStatusText(status, `${name} · Encoding relief image…`);
    try { dmr.image = await reliefImage(fine, plan); }
    catch (error) { announce(`The relief image could not be made here (${error instanceof Error ? error.message : String(error)}); the terrain is shaded instead.`, true); }
    setStatusProgress(status); setStatusText(status, '');
    void saveDmr(key, dmr).catch(() => announce('The terrain is shown, but there was no room to keep it on this device.', true));
    const moved = epsg === 8353 ? `, moved ${Math.hypot(...dmr.shift).toFixed(2)} m from JTSK03 into JTSK` : '';
    if (alone) {
      showTerrainOnly(dmr, key);
      void forgetLastModel().catch(() => undefined);
      announce(`Terrain opened on its own: ${dmr.width} columns × ${dmr.height} rows every ${dmr.step} m${moved}. Export it with File → Export terrain to Therion.`);
      return;
    }
    terrain = dmr; showSurfaces();
    // How far it lies from the cave, if apart.
    const [east, north] = modelCentre(), x0 = dmr.origin[0] + dmr.shift[0], y0 = dmr.origin[1] + dmr.shift[1];
    const gap = Math.hypot(Math.max(0, x0 - east, east - (x0 + dmr.width * dmr.step)), Math.max(0, y0 - north, north - (y0 + dmr.height * dmr.step)));
    announce(gap > 100 ? `Terrain loaded, but it lies ${(gap / 1000).toFixed(1)} km from the cave.` : `Terrain loaded: ${dmr.width} columns × ${dmr.height} rows every ${dmr.step} m${moved}.`, gap > 100);
  } catch (error) {
    setStatusProgress(status); setStatusText(status, '');
    announce(error instanceof Error ? error.message : String(error), true);
  }
}
function saveBlob(blob: Blob, name: string) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob); link.download = name;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
}
/**
 * A name for what is saved from the terrain (the Therion export or the LOX): no diacritics or
 * characters files cannot have; the suggestion comes from the model or the GeoTIFF.
 */
const nameDialog = document.querySelector<HTMLDialogElement>('#lox-dialog')!, nameInput = document.querySelector<HTMLInputElement>('#lox-name')!;
/** A name as it is saved: no diacritics, every space and character files cannot have an underscore. */
function plainFileName(name: string) {
  return name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[\s\\/:*?"<>|]/g, '_').replace(/[^\x20-\x7e]/g, '_');
}
// Enter saves (a form in a dialog would otherwise close with its first button, Cancel).
nameInput.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); nameDialog.close('save'); } });
function askTerrainName(heading: string, text: string) {
  nameDialog.querySelector('h2')!.textContent = heading;
  nameDialog.querySelector('p')!.textContent = text;
  nameInput.value = plainFileName((modelKey.split('|')[0] || terrain?.name || 'terrain').replace(/\.[^.]+$/, '') + (terrainOnly ? '' : '-terrain'));
  nameDialog.returnValue = ''; nameDialog.showModal(); nameInput.select();
  return new Promise<string | undefined>(resolve => nameDialog.addEventListener('close', () => {
    if (nameDialog.returnValue !== 'save') { resolve(undefined); return; }
    const name = nameInput.value.trim().replace(/\.(lox|th|zip)$/i, '') || 'terrain';
    // Without diacritics, and every space (or character files cannot have) an underscore.
    resolve(plainFileName(name));
  }, { once: true }));
}
// For Therion: a folder <name> with <name>.th, <name>.jpg and a thconfig that makes <name>.lox, zipped.
for (const button of ['#surface-dmr-export', '#file-dmr-export']) document.querySelector<HTMLButtonElement>(button)!.addEventListener('click', async () => {
  if (!terrain) return;
  const name = await askTerrainName('Export terrain to Therion', 'A ZIP with a folder of this name: the surface (.th), its relief image (.jpg) and a thconfig; run therion in the folder to make the LOX.');
  if (!name || !terrain) return;
  const encode = (text: string) => new TextEncoder().encode(text);
  const files = [
    { name: `${name}/${name}.th`, data: encode(dmrTherion(terrain, terrain.image ? `${name}.jpg` : undefined)) },
    ...(terrain.image ? [{ name: `${name}/${name}.jpg`, data: terrain.image.data }] : []),
    { name: `${name}/thconfig`, data: encode(dmrThconfig(name)) },
  ];
  saveBlob(createZip(files), `${name}.zip`);
});
// The terrain as a LOX file under a chosen name (to open later here or in Loch).
for (const button of ['#surface-dmr-lox', '#file-dmr-lox']) document.querySelector<HTMLButtonElement>(button)!.addEventListener('click', async () => {
  if (!terrain) return;
  const name = await askTerrainName('Save terrain as LOX', 'A LOX file of the terrain and its relief image (as Therion makes it from the exported surface), to open later here or in Loch. The name is also its title.');
  if (name && terrain) saveBlob(dmrLox(terrain, name), `${name}.lox`);
});
/** What this device can draw: phones (Safari above all) keep canvases to about 16 million pixels. */
const imageDevice = () => isCoarse() ? { maxPixels: 16e6, maxSide: 8192 } : { maxPixels: Infinity, maxSide: Infinity };
/**
 * The shaded relief of a grid as JPEG: drawn in strips (no full copy of the pixels besides the
 * canvas), enlarged smoothly when `upscale` > 1, and encoded again at lower quality if it would
 * pass 50 MB.
 */
async function reliefImage(grid: Pick<Dmr, 'origin' | 'step' | 'width' | 'height' | 'heights'>, plan: ReturnType<typeof imagePlan>) {
  const native = new OffscreenCanvas(grid.width, grid.height), context = native.getContext('2d')!;
  const STRIP = 256;
  for (let row = 0; row < grid.height; row += STRIP) {
    const rows = Math.min(STRIP, grid.height - row);
    context.putImageData(new ImageData(hillshade(grid, 45, 1, row, rows) as Uint8ClampedArray<ArrayBuffer>, grid.width, rows), 0, row);
  }
  const encode = async (upscale: number) => {
    const size = imageSize(grid, upscale);
    let canvas = native;
    if (size.width !== grid.width) {
      canvas = new OffscreenCanvas(size.width, size.height);
      const large = canvas.getContext('2d')!;
      large.imageSmoothingEnabled = true; large.imageSmoothingQuality = 'high';
      large.drawImage(native, 0, 0, size.width, size.height);
    }
    let blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: RELIEF_IMAGE.quality });
    for (const quality of [.94, .9, .85]) {
      if (blob.size <= RELIEF_IMAGE.maxBytes) break;
      blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
    }
    return { size, blob };
  };
  let { size, blob } = await encode(plan.upscale);
  // Smooth ground (or an enlarged image) packs tighter than estimated: below 3 MB, drawn once more
  // as much larger as the shortfall asks, within the pixel and side limits.
  const longer = Math.max(grid.width, grid.height);
  const most = Math.min(Math.sqrt(plan.mostPixels / (grid.width * grid.height)), plan.mostSide / longer);
  let upscale = plan.upscale;
  for (let attempt = 0; attempt < 3 && blob.size < RELIEF_IMAGE.minBytes && upscale < most * .99; attempt++) {
    upscale = Math.min(most, upscale * Math.sqrt(RELIEF_IMAGE.minBytes * 1.1 / blob.size));
    ({ size, blob } = await encode(upscale));
  }
  return { ...imagePlace(grid, size), data: new Uint8Array(await blob.arrayBuffer()) };
}
document.querySelector<HTMLButtonElement>('#surface-dmr-remove')!.addEventListener('click', () => {
  if (!terrain) return;
  void forgetDmr(modelKey).catch(() => undefined);
  if (terrainOnly) { try { localStorage.removeItem(LAST_TERRAIN); } catch { /* Nothing kept. */ } newScene(); announce('Terrain removed.'); return; }
  terrain = undefined;
  showSurfaces(); announce('Terrain removed; the surface from the model file is shown again.');
});

const downloadDialog = document.querySelector<HTMLDialogElement>('#download-dialog')!;
/** On mobile data (or when the phone does not tell), ask before a download; true goes ahead. */
/** Downloads above this ask first on any device (with the size); smaller ones only on mobile data. */
const ASK_ABOVE = 25e6;
function confirmDownload(title: string, bytes: number, tiles?: number) {
  const connection = (navigator as Navigator & { connection?: { type?: string; saveData?: boolean } }).connection;
  const known = connection?.type && connection.type !== 'unknown';
  const mobile = connection?.type === 'cellular' || connection?.saveData === true || (!known && matchMedia('(pointer: coarse)').matches);
  if (!mobile && bytes <= ASK_ABOVE) return Promise.resolve(true);
  const megabytes = bytes / 1e6;
  document.querySelector<HTMLElement>('#download-text')!.textContent =
    `${title} needs about ${megabytes >= 1000 ? `${(megabytes / 1000).toFixed(1)} GB` : `${megabytes < 10 ? megabytes.toFixed(1) : Math.round(megabytes)} MB`} of map images${tiles ? ` (${tiles.toLocaleString()} tiles)` : ''}${connection?.type === 'cellular' ? ' over mobile data' : ''}. They are kept on this device for use without a signal.`;
  downloadDialog.returnValue = '';
  downloadDialog.showModal();
  return new Promise<boolean>(resolve => downloadDialog.addEventListener('close', () => resolve(downloadDialog.returnValue === 'download'), { once: true }));
}

/** How much of a map with a choice (ZBGIS orthophoto) is saved: remembered per map in this browser. */
type MapQuality = 'optimal' | 'max' | 'online';
const MAP_QUALITY = 'loch.js-map-quality';
function mapQuality(id: string): MapQuality {
  try { return (JSON.parse(localStorage.getItem(MAP_QUALITY) ?? '{}') as Record<string, MapQuality>)[id] ?? 'optimal'; } catch { return 'optimal'; }
}
function setMapQuality(id: string, quality: MapQuality) {
  try { localStorage.setItem(MAP_QUALITY, JSON.stringify({ ...JSON.parse(localStorage.getItem(MAP_QUALITY) ?? '{}') as object, [id]: quality })); } catch { /* This session only. */ }
}
const qualityDialog = document.querySelector<HTMLDialogElement>('#quality-dialog')!;
const formatBytes = (bytes: number) => bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${bytes < 1e7 ? (bytes / 1e6).toFixed(1) : Math.round(bytes / 1e6)} MB`;
/** Optimal or Max, each with what it still has to download; the last choice is marked. */
type OfflinePlan = ReturnType<typeof offlineTiles>;
async function askQuality(service: XyzService, optimal: OfflinePlan, max: OfflinePlan) {
  const kept = await storedKeys(`${service.id}|t|`).catch(() => new Set<string>());
  const describe = (tiles: [number, number, number][], what: string) => {
    const missing = tiles.filter(t => !kept.has(`${service.id}|t|${t.join('/')}`)).length;
    return `${what} ${missing ? `About ${formatBytes(missing * (service.tileBytes ?? 30_000))} to download (${missing.toLocaleString()} of ${tiles.length.toLocaleString()} tiles).` : `All ${tiles.length.toLocaleString()} tiles already saved.`}`;
  };
  const [latitude] = (() => { const e = surfaceScene.extent()!; return sjtskToWgs84((e[0] + e[2]) / 2, (e[1] + e[3]) / 2); })();
  let near = 0;
  for (const zoom of optimal.highest.values()) near = Math.max(near, zoom);
  const ground = (zoom: number) => tileGround(latitude, tileTemplate(service).size, zoom).toFixed(1);
  document.querySelector('#quality-optimal')!.textContent = describe(optimal.tiles, `About ${OFFLINE_BASE} m/px over the whole surface, sharper near the survey stations (${ground(near)} m/px within 100 m).`);
  document.querySelector('#quality-max')!.textContent = describe(max.tiles, `About ${ground(service.maxZoom)} m/px over the whole surface.`);
  const connection = (navigator as Navigator & { connection?: { type?: string } }).connection;
  document.querySelector('#quality-text')!.textContent = `How much of ${service.title} to keep on this device for use without a signal${connection?.type === 'cellular' ? ' (you are on mobile data)' : ''}? The map is shown either way.`;
  const last = mapQuality(service.id);
  qualityDialog.querySelectorAll<HTMLButtonElement>('.quality-option').forEach(button => button.classList.toggle('last', button.value === last));
  qualityDialog.returnValue = '';
  qualityDialog.showModal();
  return new Promise<MapQuality | 'cancel'>(resolve => qualityDialog.addEventListener('close', () => {
    const value = qualityDialog.returnValue;
    resolve(value === 'optimal' || value === 'max' || value === 'online' ? value : 'cancel');
  }, { once: true }));
}

const isCoarse = () => matchMedia('(pointer: coarse)').matches;
// Mapy.com tiles need the user's own (free) API key; it stays in this browser.
const MAPY_KEY = 'loch.js-mapy-key';
let keyAskedAgain = false;
const mapyKey = () => { try { return localStorage.getItem(MAPY_KEY) ?? ''; } catch { return ''; } };
const keyDialog = document.querySelector<HTMLDialogElement>('#mapy-key-dialog')!;
const keyInput = document.querySelector<HTMLInputElement>('#mapy-key')!;
function askMapyKey() {
  keyInput.value = mapyKey(); keyDialog.returnValue = '';
  keyDialog.showModal(); keyInput.focus();
  return new Promise<string>(resolve => keyDialog.addEventListener('close', () => {
    const key = keyInput.value.trim();
    if (keyDialog.returnValue !== 'save') { resolve(''); return; }
    try { if (key) localStorage.setItem(MAPY_KEY, key); else localStorage.removeItem(MAPY_KEY); } catch { /* Kept for this session only. */ }
    resolve(key);
  }, { once: true }));
}
document.querySelector<HTMLButtonElement>('#underlay-mapy-key')!.addEventListener('click', () => {
  document.querySelectorAll<HTMLDetailsElement>('#menus details').forEach(group => { group.open = false; });
  void askMapyKey();
});

function mapTexture(image: ImageBitmap | HTMLCanvasElement) {
  const texture = image instanceof HTMLCanvasElement ? new THREE.CanvasTexture(image) : new THREE.Texture(image);
  texture.flipY = false; texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 4; texture.needsUpdate = true;
  return texture;
}
const toBlob = (canvas: HTMLCanvasElement, type: string) => new Promise<Blob | null>(resolve => canvas.toBlob(resolve, type, .88));
const mapsUsable = (quiet = false) => {
  if (surfaceScene.extent() && looksLikeSJTSK(worldOrigin.x, worldOrigin.y)) return true;
  if (!quiet) announce('Map layers need a model with a surface in S-JTSK.', true);
  return false;
};
// Map layers are remembered for each model (by file name and size) and come back when it opens again.
const MODEL_LAYERS = 'loch.js-model-layers';
let modelKey = '';
function rememberModelLayers() {
  if (!modelKey) return;
  try {
    const all = JSON.parse(localStorage.getItem(MODEL_LAYERS) ?? '{}') as Record<string, Record<string, number>>;
    const on = Object.fromEntries([...mapLayers].filter(([, state]) => state.on).map(([id, state]) => [id, state.opacity]));
    if (Object.keys(on).length) all[modelKey] = on; else delete all[modelKey];
    localStorage.setItem(MODEL_LAYERS, JSON.stringify(all));
  } catch { /* Not remembered (private mode). */ }
}
function restoreModelLayers() {
  let layers: Record<string, number> | undefined;
  try { layers = (JSON.parse(localStorage.getItem(MODEL_LAYERS) ?? '{}') as Record<string, Record<string, number>>)[modelKey]; } catch { return; }
  if (!layers || !mapsUsable(true)) return;
  for (const service of UNDERLAY_SERVICES) {
    const opacity = layers[service.id];
    if (opacity === undefined || mapLayers.get(service.id)!.on) continue;
    mapLayers.get(service.id)!.opacity = opacity;
    setMapLayer(service.id, true, true);
  }
}
// Pieces saved by earlier versions (before the tiles themselves were kept) are not used any more.
for (const service of ['mapy-aerial', 'mapy-outdoor']) void storedKeys(`${service}|`).then(keys => {
  void forgetStored([...keys].filter(key => !key.startsWith(`${service}|t|`))).catch(() => undefined);
}).catch(() => undefined);

/**
 * Progress of map work, at the map while it lasts: tiles being saved for use without a
 * signal (per layer, with a bar) and pieces of the view still loading.
 */
const mapProgress = document.querySelector<HTMLElement>('#map-progress')!;
const savingProgress = new Map<string, { title: string; done: number; total: number; failed: number }>();
let viewLoading = 0, progressFrame = 0;
let importing: { text: string; fraction: number } | undefined;
function showMapProgress() {
  if (progressFrame) return;
  progressFrame = requestAnimationFrame(() => {
    progressFrame = 0;
    const rows: HTMLElement[] = [];
    for (const [id, saving] of savingProgress) {
      const row = document.createElement('div'); row.className = 'map-progress-row';
      const percent = saving.total ? Math.floor(saving.done / saving.total * 100) : 0;
      const label = document.createElement('span');
      label.textContent = `Saving ${saving.title}: ${saving.done.toLocaleString()} / ${saving.total.toLocaleString()} tiles (${percent} %)${saving.failed ? ` · ${saving.failed} missing` : ''}`;
      const bar = document.createElement('progress'); bar.max = saving.total || 1; bar.value = saving.done;
      row.append(label, bar); rows.push(row);
      const status = layerList.querySelector<HTMLElement>(`.map-layer[data-layer="${id}"] .layer-status`);
      if (status) { status.textContent = `Saving ${percent} % (${saving.done.toLocaleString()} / ${saving.total.toLocaleString()} tiles)`; status.hidden = false; }
    }
    if (importing) {
      const row = document.createElement('div'); row.className = 'map-progress-row';
      const label = document.createElement('span'); label.textContent = importing.text;
      const bar = document.createElement('progress'); bar.max = 1; bar.value = importing.fraction;
      row.append(label, bar); rows.push(row);
    }
    if (viewLoading > 0) {
      const row = document.createElement('div'); row.className = 'map-progress-row';
      row.textContent = `Loading map for the view… ${viewLoading} ${viewLoading === 1 ? 'piece' : 'pieces'}`;
      rows.push(row);
    }
    mapProgress.replaceChildren(...rows); mapProgress.hidden = !rows.length;
  });
}
function layerStatus(id: string, text: string) {
  const status = layerList.querySelector<HTMLElement>(`.map-layer[data-layer="${id}"] .layer-status`);
  if (status) { status.textContent = text; status.hidden = !text; }
}
/** What the saved maps take on this device, shown in the map menu. */
async function showStorageUse() {
  const line = document.querySelector<HTMLElement>('#map-storage')!;
  const estimate = await globalThis.navigator?.storage?.estimate?.().catch(() => undefined);
  if (!estimate?.usage) { line.hidden = true; return; }
  const counts = await Promise.all(['mapy-aerial', 'mapy-outdoor'].map(id => storedKeys(`${id}|t|`).then(keys => keys.size).catch(() => 0)));
  const files = localMaps();
  line.textContent = `Saved on this device: ${Math.round(estimate.usage / 1e6).toLocaleString()} MB${estimate.quota ? ` of ${Math.round(estimate.quota / 1e6).toLocaleString()} MB available` : ''} · Mapy.com tiles: ${counts[0].toLocaleString()} aerial, ${counts[1].toLocaleString()} outdoor${files.length ? ` · map files: ${files.length} (${Math.round(files.reduce((sum, map) => sum + map.bytes, 0) / 1e6).toLocaleString()} MB)` : ''}`;
  line.hidden = false;
}

/** Tiles of offline layers: the copy on the device first, else the service (and the copy is kept). */
const tilesInFlight = new Map<string, Promise<Blob>>();
function savedTiles(id: string): TileSource {
  return async (url, zoom, x, y, signal) => {
    const key = `${id}|t|${zoom}/${x}/${y}`;
    const saved = await loadStoredTile(key).catch(() => undefined);
    if (saved) return createImageBitmap(saved.blob);
    let blob = tilesInFlight.get(key);
    if (!blob) {
      blob = loadBlob(url, signal).finally(() => tilesInFlight.delete(key));
      tilesInFlight.set(key, blob);
      void blob.then(data => storeTile(key, data)).catch(() => undefined);
    }
    try { return await createImageBitmap(await blob); }
    catch (error) {
      if ((error as Error).name === 'AbortError') throw error;
      // Without a signal: the part of a coarser saved tile that covers this one, enlarged.
      for (let up = 1; up <= 6 && zoom - up >= 0; up++) {
        const parent = await loadStoredTile(`${id}|t|${zoom - up}/${x >> up}/${y >> up}`).catch(() => undefined);
        if (!parent) continue;
        const image = await createImageBitmap(parent.blob), part = image.width / 2 ** up;
        const size = image.width;
        const crop = await createImageBitmap(image, (x % 2 ** up) * part, (y % 2 ** up) * part, part, part, { resizeWidth: size, resizeHeight: size, resizeQuality: 'high' });
        image.close();
        return crop;
      }
      throw error;
    }
  };
}
/**
 * Saves an offline layer's tiles for the whole surface (sharpest near the survey stations),
 * lowest zooms first, so the map works without a signal; tiles already kept are skipped.
 */
async function saveOfflineTiles(id: string, service: XyzService, tiles: [number, number, number][], request: AbortController, apiKey: string, asked = false) {
  layerStatus(id, 'Checking saved tiles…');
  const kept = await storedKeys(`${id}|t|`).catch(() => new Set<string>());
  const missing = tiles.filter(t => !kept.has(`${id}|t|${t.join('/')}`));
  if (request.signal.aborted) return;
  if (!missing.length) { layerStatus(id, `All ${tiles.length.toLocaleString()} tiles saved on this device`); return; }
  if (!asked && !await confirmDownload(service.title, missing.length * (service.tileBytes ?? 30_000), missing.length)) {
    layerStatus(id, `Online only · ${(tiles.length - missing.length).toLocaleString()} of ${tiles.length.toLocaleString()} tiles saved`);
    announce(`${service.title}: shown online only (not saved for use without a signal).`); return;
  }
  const progress = { title: service.title, done: 0, total: missing.length, failed: 0 };
  savingProgress.set(id, progress); showMapProgress();
  request.signal.addEventListener('abort', () => { savingProgress.delete(id); showMapProgress(); });
  let done = 0, failed = 0;
  const report = (final = false) => {
    if (request.signal.aborted) return;
    progress.done = done; progress.failed = failed;
    if (!final) { showMapProgress(); return; }
    savingProgress.delete(id); showMapProgress();
    layerStatus(id, `All ${(tiles.length - failed).toLocaleString()} tiles saved on this device${failed ? ` · ${failed} missing` : ''}`);
    announce(`${service.title}: ${done - failed} tiles saved for use without a signal${failed ? `, ${failed} missing` : ''}.`);
  };
  // A few at a time, lowest zooms first (tens of thousands of tiles for a whole surface at the sharpest zoom).
  let next = 0, full = false;
  const worker = async () => {
    while (next < missing.length && !request.signal.aborted && !full) {
      const [zoom, x, y] = missing[next++];
      const key = `${id}|t|${zoom}/${x}/${y}`;
      try {
        // The view may have fetched (and kept) it meanwhile.
        if (await loadStoredTile(key).catch(() => undefined)) continue;
        let blob = tilesInFlight.get(key);
        if (!blob) { blob = loadBlob(tileUrl(service, zoom, x, y, apiKey), request.signal, true).finally(() => tilesInFlight.delete(key)); tilesInFlight.set(key, blob); }
        await storeTile(key, await blob);
      } catch (error) {
        if ((error as Error).name === 'AbortError') return;
        if ((error as Error).name === 'QuotaExceededError') full = true;
        failed++;
      }
      finally { done++; report(); }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  if (full && !request.signal.aborted) {
    savingProgress.delete(id); showMapProgress();
    layerStatus(id, `Device storage full · ${(done - failed).toLocaleString()} of ${missing.length.toLocaleString()} new tiles saved`);
    announce(`${service.title}: the device storage is full; ${(done - failed).toLocaleString()} tiles saved, the rest shown online only.`, true);
    return;
  }
  if (!request.signal.aborted) report(true);
}
/** Distance from a piece to the nearest survey station (file coordinates): maps are sharpest over the caves. */
function stationPoints() {
  const stations = centreline.stationDetails.filter(station => !temporaryStation(station));
  const points = new Float64Array(stations.length * 2);
  stations.forEach((station, i) => { points[i * 2] = station.position[0]; points[i * 2 + 1] = station.position[1]; });
  return points;
}
function caveGap() {
  const points = stationPoints();
  return points.length ? nearestPointGap(points) : undefined;
}

/** Switch a map layer on (loading it: saved copies first, then the service) or off. */
/** Attribution of the layers shown, at the map (with links, as the map services ask). */
const attribution = document.querySelector<HTMLElement>('#map-attribution')!;
function syncAttribution() {
  const shown = UNDERLAY_SERVICES.filter(service => mapLayers.get(service.id)?.on);
  attribution.replaceChildren(...shown.flatMap(service => service.credits).flatMap((credit, i) => {
    const item = credit.href ? Object.assign(document.createElement('a'), { href: credit.href, target: '_blank', rel: 'noopener', textContent: credit.text }) : document.createTextNode(credit.text);
    return i ? [document.createTextNode(' · '), item] : [item];
  }));
  attribution.hidden = !shown.length;
  fitCredits();
}
/** On phones the credits lie under the dock, which moves up by their height (one or two lines). */
function fitCredits() {
  document.body.style.setProperty('--credits', attribution.hidden ? '0px' : `${attribution.offsetHeight + 2}px`);
}
addEventListener('resize', fitCredits);

/**
 * On-demand layers (Freemap): each piece the view shows gets the zoom that matches how large it
 * appears on screen, nearest pieces first, once the view rests; nothing is loaded for pieces out
 * of view and nothing is stored beyond the browser's HTTP cache, as the service asks.
 */
function refreshOnDemand(id: string) {
  const state = mapLayers.get(id)!, service = UNDERLAY_SERVICES.find(item => item.id === id)!;
  const shown = state.shown, request = state.request;
  if (!state.on || !shown || !request || service.kind !== 'xyz') return;
  const height = canvas.clientHeight, extent = surfaceScene.extent();
  if (!height || !extent) return;
  camera.updateMatrixWorld();
  const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  const [latitude] = sjtskToWgs84((extent[0] + extent[2]) / 2, (extent[1] + extent[3]) / 2);
  const tile = tileTemplate(service).size, minZoom = service.minZoom ?? 1;
  const maxSide = Math.min(renderer.capabilities.maxTextureSize, isCoarse() ? 2048 : 4096), budget = isCoarse() ? 12e6 : 40e6;
  // Texture pixels per screen pixel: device pixels, but not more than two per CSS pixel.
  const density = Math.min(globalThis.devicePixelRatio || 1, 2);
  const perspective = camera instanceof THREE.PerspectiveCamera;
  const size = (piece: { extent: [number, number, number, number] }, zoom: number) => {
    const ground = tileGround(latitude, tile, zoom);
    return { width: Math.max(16, Math.round((piece.extent[2] - piece.extent[0]) / ground)), height: Math.max(16, Math.round((piece.extent[3] - piece.extent[1]) / ground)) };
  };
  const wanted = surfaceScene.pieceBoxes().filter(piece => frustum.intersectsBox(piece.box)).map(piece => {
    const distance = Math.max(1, piece.box.distanceToPoint(camera.position));
    const screen = perspective ? distance * 2 * Math.tan(THREE.MathUtils.degToRad((camera as THREE.PerspectiveCamera).getEffectiveFOV()) / 2) / height
      : ((camera as THREE.OrthographicCamera).top - (camera as THREE.OrthographicCamera).bottom) / (camera as THREE.OrthographicCamera).zoom / height;
    let zoom = Math.max(minZoom, Math.min(service.maxZoom, Math.ceil(Math.log2(tileGround(latitude, tile, 0) / (screen / density)) - .05)));
    // Offline layers stay within the zooms kept on the device.
    if (state.highest) zoom = Math.max(state.low ?? minZoom, Math.min(zoom, state.highest.get(piece.key) ?? zoom));
    while (zoom > minZoom && Math.max(size(piece, zoom).width, size(piece, zoom).height) > maxSide) zoom--;
    return { ...piece, distance, zoom };
  }).sort((a, b) => a.distance - b.distance);
  // Within the memory budget: the farthest pieces get coarser first.
  const total = () => wanted.reduce((sum, piece) => { const s = size(piece, piece.zoom); return sum + s.width * s.height; }, 0);
  for (let guard = 0; total() > budget && guard < 400; guard++) {
    const farthest = [...wanted].reverse().find(piece => piece.zoom > minZoom);
    if (!farthest) break;
    farthest.zoom--;
  }
  const visible = new Set(wanted.map(piece => piece.key));
  // Pieces out of view keep their map until memory runs short; the farthest go first.
  let held = [...shown.values()].reduce((sum, piece) => sum + piece.pixels, 0);
  for (const [key, piece] of [...shown.entries()].reverse()) {
    if (held <= budget * 1.5) break;
    if (visible.has(key)) continue;
    piece.loading?.abort(); shown.delete(key); surfaceScene.removeLayerPiece(id, key); held -= piece.pixels;
  }
  let started = 0;
  for (const piece of wanted) {
    const current = shown.get(piece.key);
    if (current && current.zoom === piece.zoom) continue;
    current?.loading?.abort();
    const loading = new AbortController(), { width, height: rows } = size(piece, piece.zoom);
    request.signal.addEventListener('abort', () => loading.abort());
    const entry: { zoom: number; pixels: number; loading?: AbortController } = { zoom: piece.zoom, pixels: current?.pixels ?? 0, loading };
    shown.set(piece.key, entry); started++;
    viewLoading++; showMapProgress();
    void fetchMap(service, piece.extent, width, rows, loading.signal, state.apiKey ?? '', piece.zoom, service.offline ? savedTiles(id) : state.source).then(canvas => {
      if (entry.loading !== loading || !state.on) return;
      entry.loading = undefined; entry.pixels = width * rows; state.failures = 0;
      surfaceScene.setLayerPiece(id, piece.key, mapTexture(canvas), piece.extent);
    }).catch(error => {
      if ((error as Error).name === 'AbortError' || entry.loading !== loading) return;
      shown.delete(piece.key);
      // A service that refuses everything (no CORS, no answer) is switched off with the reason.
      if ((state.failures = (state.failures ?? 0) + 1) >= 3 && state.on) {
        // A refused Mapy.com key: ask for it once more and start again.
        if (service.apiKey && /API key/.test(exceptionMessage(error)) && !keyAskedAgain) {
          keyAskedAgain = true; setMapLayer(id, false);
          void askMapyKey().then(key => { if (key) setMapLayer(id, true); });
          return;
        }
        announce(`${service.title}: ${exceptionMessage(error)}`, true); setMapLayer(id, false);
      }
    }).finally(() => { viewLoading--; showMapProgress(); });
  }
  if (started && !state.announced) { state.announced = true; announce(`${service.title} ${service.attribution} · loaded for the view as it rests`); }
}
let onDemandTimer: number | undefined;
// After the view rests a moment, on-demand layers load what it now shows.
controls.addEventListener('change', () => {
  clearTimeout(onDemandTimer);
  onDemandTimer = window.setTimeout(() => { for (const [id, state] of mapLayers) if (state.on && state.shown) refreshOnDemand(id); }, 400);
});

function setMapLayer(id: string, on: boolean, quiet = false) {
  const state = mapLayers.get(id)!, service = UNDERLAY_SERVICES.find(item => item.id === id)!;
  state.request?.abort(); state.request = undefined;
  for (const piece of state.shown?.values() ?? []) piece.loading?.abort();
  state.shown = undefined; state.highest = undefined; state.low = undefined;
  layerStatus(id, '');
  surfaceScene.removeLayer(id);
  state.on = on && mapsUsable(quiet);
  if (!quiet && !on) rememberModelLayers();
  syncAttribution();
  // One imagery or outdoor map at a time (the geological map can lie over it).
  if (state.on && service.kind === 'xyz' && service.exclusive) for (const other of UNDERLAY_SERVICES) if (other.id !== id && other.kind === 'xyz' && other.exclusive && mapLayers.get(other.id)!.on) setMapLayer(other.id, false);
  syncUnderlayMenu();
  if (!state.on) return;
  surfaceScene.setLayer(id, UNDERLAY_SERVICES.indexOf(service), state.opacity);
  syncAttribution();
  rememberModelLayers();
  if (service.kind === 'xyz' && service.onDemand) {
    const request = state.request = new AbortController();
    state.shown = new Map(); state.failures = 0; state.announced = false;
    void (async () => {
      if (service.apiKey) {
        state.apiKey = mapyKey() || await askMapyKey();
        if (state.request !== request) return;
        if (!state.apiKey) { announce(`${service.title} needs an API key.`, true); setMapLayer(id, false); return; }
      }
      if (service.kind === 'xyz' && service.wms) {
        try { await prepareWms(service.wms, request.signal); } catch { return; }
        if (state.request !== request) return;
      }
      if (service.local) {
        const map = localMaps().find(item => item.id === id);
        try { if (!map) throw new Error('The map file is not on this device any more.'); state.source = await localTiles(map); }
        catch (error) { if (state.request === request) { announce(`${service.title}: ${exceptionMessage(error)}`, true); setMapLayer(id, false); } return; }
        if (state.request !== request) return;
      }
      let tiles: [number, number, number][] = [], quality: MapQuality = 'optimal';
      if (service.offline) {
        // From the zoom that shows the whole surface up to the sharpest near the survey stations.
        const extent = surfaceScene.extent()!, [latitude] = sjtskToWgs84((extent[0] + extent[2]) / 2, (extent[1] + extent[3]) / 2);
        const tile = tileTemplate(service).size;
        state.low = Math.max(service.minZoom ?? 1, zoomFor((extent[2] - extent[0]) / 1024, latitude, tile, service.maxZoom) - 1);
        const plan = offlineTiles(service, surfaceScene.pieces(), stationPoints(), state.low, latitude);
        if (service.offlineMax) {
          // Optimal (as Mapy.com) or Max (the sharpest zoom everywhere): asked when switched on, remembered for restoring.
          const max = offlineTiles(service, surfaceScene.pieces(), stationPoints(), state.low, latitude, true);
          const choice = quiet ? mapQuality(id) : await askQuality(service, plan, max);
          if (state.request !== request) return;
          if (choice === 'cancel') { setMapLayer(id, false); return; }
          quality = choice; setMapQuality(id, choice);
          if (choice === 'max') { state.highest = max.highest; tiles = max.tiles; }
          else if (choice === 'optimal') { state.highest = plan.highest; tiles = plan.tiles; }
          else state.highest = undefined; // online only: any zoom the view needs
        } else { state.highest = plan.highest; tiles = plan.tiles; }
      }
      refreshOnDemand(id);
      if (service.offline && quality !== 'online') void saveOfflineTiles(id, service, tiles, request, state.apiKey ?? '', service.offlineMax && !quiet);
      else if (service.offline) layerStatus(id, 'Online only · nothing saved for use without a signal');
    })();
    return;
  }
  const request = state.request = new AbortController();
  const current = () => state.request === request;
  const back = (message: string) => {
    if (!current()) return;
    announce(message, true); state.request = undefined; state.on = false;
    surfaceScene.removeLayer(id); syncUnderlayMenu();
  };
  const extent = surfaceScene.extent()!, cave = caveGap();
  const maxSide = Math.min(renderer.capabilities.maxTextureSize, isCoarse() ? 2048 : 4096);
  // Each layer within 40 megapixels on a computer and 12 on a phone (graphics memory).
  const plan = service.levels
    ? planPieces(surfaceScene.pieces(), cave, service.levels, isCoarse() ? 12e6 : 40e6, maxSide)
    : planPieces([{ key: 'all', extent }], undefined, [1, 1, 1], Infinity, maxSide);
  const store = service.storeAs ?? service.id;
  const keys = plan.map(piece => underlayKey(store, piece.extent, piece.width));
  const show = (piece: (typeof plan)[number], texture: THREE.Texture) => {
    if (service.levels) surfaceScene.setLayerPiece(id, piece.key, texture, piece.extent);
    else surfaceScene.setLayerImage(id, texture, piece.extent);
  };
  void (async () => {
    // Copies kept on the device first (they work offline), then the service for the rest.
    const stored = await Promise.all(keys.map(key => loadStoredUnderlay(key).catch(() => undefined)));
    if (!current()) return;
    let apiKey = '';
    if (service.kind === 'xyz' && service.apiKey && stored.some(copy => !copy)) {
      apiKey = mapyKey() || await askMapyKey();
      if (!current()) return;
      if (!apiKey) { back(`${service.title} needs an API key.`); return; }
    }
    // The caves' surroundings first: they are the sharpest and the most looked at.
    const gaps = new Map(plan.map(piece => [piece.key, cave ? cave(piece.extent) : 0]));
    const missing = plan.filter((_, i) => !stored[i]).sort((x, y) => gaps.get(x.key)! - gaps.get(y.key)!);
    if (missing.length && !await confirmDownload(service.title, downloadEstimate(service, missing))) { back(`${service.title}: download cancelled.`); return; }
    if (!current()) return;
    for (let i = 0; i < plan.length; i++) {
      const copy = stored[i];
      if (copy) show(plan[i], mapTexture(await createImageBitmap(copy.blob, { imageOrientation: 'none', premultiplyAlpha: 'none' })));
      if (!current()) return;
    }
    let done = 0, failed = 0, succeeded = 0, lastError: unknown;
    const report = () => { if (current()) announce(`Loading ${service.title}… ${done}/${missing.length}`); };
    if (missing.length) report();
    await Promise.all(missing.map(async piece => {
      try {
        const canvas = await fetchMap(service, piece.extent, piece.width, piece.height, request.signal, apiKey);
        if (!current()) return;
        const blob = await toBlob(canvas, service.kind === 'wms' && service.format === 'image/png' ? 'image/png' : 'image/jpeg');
        if (blob) void storeUnderlay(underlayKey(store, piece.extent, piece.width), { blob, width: piece.width, height: piece.height, saved: new Date().toISOString() }).catch(() => undefined);
        if (!current()) return;
        show(piece, mapTexture(canvas)); succeeded++;
      } catch (error) {
        if ((error as Error).name === 'AbortError') throw error;
        failed++; lastError = error;
        if (failed === 1) console.warn(error);
        // A service that refuses everything (no CORS, wrong key) is not asked for every piece.
        if (!succeeded && failed >= 2 && current()) {
          // A refused Mapy.com key: ask for it once more and start again.
          if (service.kind === 'xyz' && service.apiKey && /API key/.test(exceptionMessage(error)) && !keyAskedAgain) {
            keyAskedAgain = true; request.abort(); state.request = undefined;
            void askMapyKey().then(key => { if (key) setMapLayer(id, true); else { state.on = false; surfaceScene.removeLayer(id); syncUnderlayMenu(); } });
            return;
          }
          back(`${service.title}: ${exceptionMessage(error)}`); request.abort();
        }
      } finally { done++; report(); }
    }));
    if (!current()) return;
    if (failed === plan.length) { back(`${service.title}: ${lastError ? exceptionMessage(lastError) : 'the map service did not answer.'}`); return; }
    const saved = plan.length - missing.length;
    announce(`${service.title} ${service.attribution}${failed ? ` · ${failed} pieces missing (no answer)` : ''}${saved ? ` · ${saved === plan.length ? 'saved copy' : `${saved} pieces from the saved copy`}` : ' · saved for offline use'}`);
  })().catch(error => { if ((error as Error).name !== 'AbortError') back(`${service.title}: ${exceptionMessage(error)}`); });
}
syncUnderlayMenu();

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
  if (state.kind === 'fix') { updateMeasuredLocation(state.fix); }
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
  legend.style.visibility = '';
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
  activeBox = bounds.isEmpty() ? new THREE.Box3() : centered; boxWithoutTerrain = undefined;
  worldOrigin.copy(origin); hasModel = !bounds.isEmpty();
  boundingBox.box.copy(centered);
  flashBoundingBox();
  for (const scrap of model.scraps) {
    const positions: number[] = [], colors: number[] = [], indices: number[] = [];
    for (const p of scrap.points) {
      positions.push(...offset(p, origin)); const col = altitudeColor(p[2], model); colors.push(col.r, col.g, col.b);
    }
    for (const triangle of scrap.triangles) indices.push(triangle[0], triangle[1], triangle[2]);
    if (!indices.length) continue;
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3)); g.setIndex(indices); g.computeVertexNormals();
    walls.add(new THREE.Mesh(g, wallMaterial(new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, roughness: .85, metalness: 0 }))));
  }
  updateProjectTitle(model.title, label);
  centreline.setModel(model, origin);
  loxSurfaces = model.surfaces;
  for (const surface of model.surfaces) surfaceScene.add(surface, origin);
  updateLegend(model);
  // A terrain saved as LOX (no cave): the legend shows the terrain's heights.
  if (!model.scraps.length && !model.shots.length && model.surfaces.length) {
    let low = Infinity, high = -Infinity;
    for (const surface of model.surfaces) for (const h of surface.heights) { if (h < low) low = h; if (h > high) high = h; }
    if (low < high) updateLegend({ minZ: low, maxZ: high });
  }
  applyWallCulling();
  setStatusText(status, `${label} · ${model.scraps.length} scraps · ${model.shots.length} centerline segments`);
  setCameraView(camera, controls, activeBox, 'fit');
  deviceLocation.update();
}
async function loadFile(file: File) {
  const id = ++loadId;
  modelKey = `${file.name}|${file.size}`;
  // A section and a map underlay belong to the model they were made for.
  applySection(undefined);
  for (const state of mapLayers.values()) { state.request?.abort(); state.request = undefined; state.on = false; }
  syncUnderlayMenu();
  loxSurfaces = []; terrain = undefined; boxWithoutTerrain = undefined; terrainOnly = false; syncTerrainMenu();
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
        activeBox = new THREE.Box3(new THREE.Vector3(...model.min).sub(origin), new THREE.Vector3(...model.max).sub(origin)); boxWithoutTerrain = undefined;
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
        loxSurfaces.push(message.surface);
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
  void restoreTerrain().finally(restoreModelLayers);
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
  // An elevation GeoTIFF (or the ZIP with it from ZBGIS) becomes the model's terrain.
  const tiff = files.find(file => /\.(tiff?|zip)$/i.test(file.name));
  if (tiff && !files.some(file => modelFileFormat(file.name))) { openTerrain(tiff); return; }
  // Shapefiles and GPX, KML/KMZ, GeoJSON or CSV become point layers.
  if (files.some(file => file.name.toLowerCase().endsWith('.shp') || POINT_FORMATS.some(extension => file.name.toLowerCase().endsWith(extension)))) { void importLayer(files); return; }
  const model = files.find(file => modelFileFormat(file.name));
  if (!model) return;
  void loadFile(model);
  try { localStorage.removeItem(START_EMPTY); localStorage.removeItem(LAST_TERRAIN); } catch { /* Nothing kept. */ }
  // Reopened on the next start, also without a signal.
  void saveLastModel(model).catch(() => { /* No room or no storage: the sample opens next time. */ });
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
/** An empty scene: no model, sample, section, terrain or map layers. */
function newScene() {
  ++loadId; modelKey = ''; terrainOnly = false;
  applySection(undefined);
  for (const state of mapLayers.values()) { state.request?.abort(); state.request = undefined; state.on = false; }
  syncUnderlayMenu(); syncAttribution();
  largeWorker?.terminate(); largeWorker = undefined;
  loadingLargeWalls = false; loadingError = false; preparationPending = false;
  progressiveView?.dispose(); progressiveView = undefined;
  terrain = undefined; syncTerrainMenu();
  draw({ scraps: [], stations: new Map(), stationDetails: [], shots: [], minZ: 0, maxZ: 0, surfaces: [] }, 'New');
  projectTitle.hidden = true; setStatusProgress(status); setStatusText(status, '');
  legend.style.visibility = 'hidden'; // no altitudes to colour
  menus.collapse();
}
async function loadSample() {
  modelKey = ''; terrainOnly = false;
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
const startEmpty = (() => { try { return localStorage.getItem(START_EMPTY) === '1'; } catch { return false; } })();
void loadLastModel().then(file => {
  if (file && loadId === 0) void loadFile(file);
  else if (loadId === 0) {
    const last = (() => { try { return localStorage.getItem(LAST_TERRAIN); } catch { return null; } })();
    const fallback = () => { if (loadId !== 0) return; if (startEmpty) newScene(); else void loadSample(); };
    if (last) void restoreTerrainOnly(last).then(found => { if (!found) fallback(); }); else fallback();
  }
}).catch(() => { if (startEmpty) newScene(); else void loadSample(); });
