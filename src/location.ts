import * as THREE from 'three';
import { looksLikeSJTSK, wgs84ToSJTSK } from './geo';

export type LocationFix = {
  /** EPSG:5514 / Therion ijtsk, metres. */
  east: number; north: number;
  /** Height used for the marker and where it came from. */
  height: number; heightSource: 'surface' | 'gps' | 'model';
  accuracy: number;
  /** Marker position in scene coordinates (file coordinates minus the model origin). */
  local: THREE.Vector3;
  /** Horizontal distance from the model's bounding box, 0 when inside. */
  outside: number;
};

export type LocationState =
  | { kind: 'off' }
  | { kind: 'waiting' }
  | { kind: 'fix'; fix: LocationFix }
  | { kind: 'error'; message: string };

/** The first fix recentres the view only within this distance of the model. */
const RECENTER_LIMIT_M = 1000;

type GeolocationLike = Pick<Geolocation, 'watchPosition' | 'clearWatch'>;

type Options = {
  scene: THREE.Object3D;
  /** Model origin in file coordinates and the model box in scene coordinates. */
  getModel: () => { origin: THREE.Vector3; box: THREE.Box3 } | undefined;
  heightAt: (east: number, north: number) => number | undefined;
  onState: (state: LocationState) => void;
  /** Called once per start, on the first fix inside the model or within 1 km of it. */
  onFirstFix?: (fix: LocationFix) => void;
  geolocation?: GeolocationLike | undefined;
  secure?: boolean;
};

function embedded() {
  try { return typeof window !== 'undefined' && window.top !== window.self; } catch { return true; }
}

export function errorMessage(error: Pick<GeolocationPositionError, 'code' | 'message'>, isEmbedded = embedded()) {
  // Pages shown inside another site's frame are usually refused without any prompt.
  if (error.code === 1 && isEmbedded) return 'Location is blocked inside this embedded view. Open the app at its own address (e.g. GitHub Pages) to use GPS.';
  if (error.code === 1) return 'Location permission denied. Allow location for this site in the browser settings.';
  if (error.code === 2) return 'Location unavailable. Turn on GPS/location services and try again outdoors.';
  return 'Still waiting for a GPS fix…';
}

/** Marker for the device position: an on-screen dot plus an accuracy disc on the terrain. */
export class DeviceLocation {
  readonly group = new THREE.Group();
  private disc: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>;
  private watch: number | undefined;
  private first = true;
  private last: { latitude: number; longitude: number; altitude: number | null; accuracy: number } | undefined;
  state: LocationState = { kind: 'off' };

  constructor(private options: Options) {
    this.group.name = 'Device location';
    this.group.visible = false;
    this.group.renderOrder = 10;
    this.disc = new THREE.Mesh(new THREE.CircleGeometry(1, 48), new THREE.MeshBasicMaterial({
      color: 0x4fb3ff, transparent: true, opacity: .22, depthTest: false, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
    }));
    this.disc.renderOrder = 10;
    this.group.add(this.disc);
    options.scene.add(this.group);
  }

  get active() { return this.watch !== undefined; }

  start() {
    if (this.active) return;
    const geolocation = this.options.geolocation ?? (typeof navigator !== 'undefined' ? navigator.geolocation : undefined);
    const secure = this.options.secure ?? (typeof window === 'undefined' || window.isSecureContext);
    if (!geolocation || !secure) {
      this.setState({ kind: 'error', message: 'Location needs the app to be opened over HTTPS (or installed from there).' });
      return;
    }
    const model = this.options.getModel();
    if (!model || !looksLikeSJTSK(model.origin.x, model.origin.y)) {
      this.setState({ kind: 'error', message: 'This model has no S-JTSK coordinates (Therion cs ijtsk), so your position cannot be placed on it.' });
      return;
    }
    this.first = true;
    this.setState({ kind: 'waiting' });
    this.watch = geolocation.watchPosition(position => {
      const { latitude, longitude, altitude, accuracy } = position.coords;
      this.last = { latitude, longitude, altitude, accuracy };
      this.update();
    }, error => {
      // A timeout only means no new fix yet; keep watching and keep the last one.
      if (error.code === 3) { if (!this.last) this.setState({ kind: 'waiting' }); return; }
      this.stop();
      this.setState({ kind: 'error', message: errorMessage(error) });
    }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 });
  }

  stop() {
    if (this.watch !== undefined) (this.options.geolocation ?? navigator.geolocation).clearWatch(this.watch);
    this.watch = undefined; this.last = undefined;
    this.group.visible = false;
    if (this.state.kind !== 'error') this.setState({ kind: 'off' });
  }

  /** Re-place the marker, e.g. after another model or surface was loaded. */
  update() {
    const model = this.options.getModel();
    if (!this.last || !model) { this.group.visible = false; return; }
    if (!looksLikeSJTSK(model.origin.x, model.origin.y)) {
      this.stop();
      this.setState({ kind: 'error', message: 'This model has no S-JTSK coordinates (Therion cs ijtsk), so your position cannot be placed on it.' });
      return;
    }
    const { latitude, longitude, altitude, accuracy } = this.last;
    const [east, north] = wgs84ToSJTSK(latitude, longitude, altitude ?? 0);
    const surface = this.options.heightAt(east, north);
    const height = surface ?? altitude ?? model.origin.z;
    const heightSource: LocationFix['heightSource'] = surface !== undefined ? 'surface' : altitude !== null ? 'gps' : 'model';
    const local = new THREE.Vector3(east - model.origin.x, north - model.origin.y, height - model.origin.z);
    const dx = Math.max(model.box.min.x - local.x, 0, local.x - model.box.max.x);
    const dy = Math.max(model.box.min.y - local.y, 0, local.y - model.box.max.y);
    const fix: LocationFix = { east, north, height, heightSource, accuracy, local, outside: Math.hypot(dx, dy) };
    this.group.position.copy(local);
    this.disc.scale.setScalar(Math.max(accuracy, .5));
    this.group.visible = true;
    this.setState({ kind: 'fix', fix });
    if (this.first) {
      this.first = false;
      // Far away from the cave the view stays put; the info line gives the distance instead.
      if (fix.outside <= RECENTER_LIMIT_M) this.options.onFirstFix?.(fix);
    }
  }

  private setState(state: LocationState) { this.state = state; this.options.onState(state); }

  dispose() { this.stop(); this.group.removeFromParent(); this.disc.geometry.dispose(); this.disc.material.dispose(); }
}

/** Screen position of the marker in CSS pixels, or undefined when off-screen or behind the camera. */
export function markerScreenPosition(local: THREE.Vector3, camera: THREE.Camera, width: number, height: number) {
  const p = local.clone().project(camera);
  if (p.z < -1 || p.z > 1) return undefined;
  return { x: (p.x + 1) / 2 * width, y: (1 - p.y) / 2 * height, onScreen: Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1 };
}

export function formatFix(fix: LocationFix) {
  const distance = fix.outside >= 1000 ? `${(fix.outside / 1000).toFixed(1)} km` : `${Math.round(fix.outside)} m`;
  const height = `${Math.round(fix.height)} m ${fix.heightSource === 'surface' ? '(terrain)' : fix.heightSource === 'gps' ? '(GPS)' : '(model centre)'}`;
  return {
    accuracy: `±${fix.accuracy < 10 ? fix.accuracy.toFixed(1) : Math.round(fix.accuracy)} m`,
    // Same coordinate system as the model (Therion cs ijtsk / EPSG:5514).
    coordinates: `x ${fix.east.toFixed(1)}  y ${fix.north.toFixed(1)}`,
    height,
    outside: fix.outside > 0 ? `${distance} outside the model` : '',
  };
}
