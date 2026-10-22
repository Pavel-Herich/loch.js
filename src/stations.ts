import * as THREE from 'three';
import { StationLabels, type StationMarker } from './station-labels';
import { STATION_SURFACE, STATION_ENTRANCE, STATION_FIXED, STATION_CONTINUATION, temporaryStation, type Station, type StationLabel } from './lox-stations';

export type StationOptions = { stations: boolean; entrance: boolean; fixed: boolean; continuation: boolean; label: StationLabel; entranceLabel: StationLabel; surface: boolean; underground: boolean; splay: boolean };
type Entry = { independent: boolean; points: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial> };
export function stationMarker(station: Station, options: StationOptions): StationMarker | undefined {
  if (temporaryStation(station)) return;
  if (options.entrance && station.flags & STATION_ENTRANCE) return 'entrance';
  if (options.fixed && station.flags & STATION_FIXED) return 'fixed';
  if (options.continuation && station.flags & STATION_CONTINUATION
    && (station.flags & (STATION_SURFACE | STATION_ENTRANCE | STATION_FIXED) || options.underground)) return 'continuation';
}
export function stationVisible(station: Station, options: StationOptions) {
  return !temporaryStation(station) && Boolean(stationMarker(station, options)
    || options.stations && (station.flags & (STATION_SURFACE | STATION_ENTRANCE | STATION_FIXED) || options.underground));
}
/** Entrance symbols use their own label mode; every other visible station uses the station label. */
export function stationLabelMode(station: Station, options: StationOptions): StationLabel {
  return stationMarker(station, options) === 'entrance' ? options.entranceLabel : options.label;
}
function overlayVisible(options: StationOptions) {
  return options.entrance || options.fixed || options.continuation || options.stations && options.label !== 'none';
}

/** One point draw per station type and one screen canvas for labels, regardless of station count. */
export class StationScene {
  private entries: Entry[] = [];
  private origin = new THREE.Vector3();
  private options: StationOptions = { stations: false, entrance: false, fixed: false, continuation: false, label: 'none', entranceLabel: 'none', surface: true, underground: true, splay: true };
  private labels: StationLabels;
  constructor(private group: THREE.Group, canvas?: HTMLCanvasElement) { this.labels = new StationLabels(canvas); }

  setModel(stations: Station[], origin: THREE.Vector3) {
    this.clear(); this.labels.setStations(stations); this.origin.copy(origin);
    const buckets = new Map<number, Station[]>();
    for (const station of stations) {
      if (temporaryStation(station)) continue;
      const key = station.flags & (STATION_SURFACE | STATION_ENTRANCE | STATION_FIXED);
      const bucket = buckets.get(key);
      if (bucket) bucket.push(station); else buckets.set(key, [station]);
    }
    for (const [key, stations] of buckets) {
      const positions = new Float32Array(stations.length * 3);
      stations.forEach((station, index) => positions.set(station.position.map((value, axis) => value - origin.getComponent(axis)), index * 3));
      const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const material = new THREE.PointsMaterial({ color: 0xffffff, size: 3, sizeAttenuation: false, toneMapped: false });
      material.onBeforeCompile = shader => {
        shader.fragmentShader = shader.fragmentShader.replace('#include <clipping_planes_fragment>',
          '#include <clipping_planes_fragment>\nif (length(gl_PointCoord - vec2(0.5)) > 0.5) discard;');
      };
      const points = new THREE.Points(geometry, material); points.name = `Stations ${key}`;
      this.group.add(points); this.entries.push({ independent: Boolean(key), points });
    }
    this.setOptions(this.options);
  }

  setOptions(options: StationOptions) {
    this.options = { ...options };
    for (const entry of this.entries) entry.points.visible = options.stations
      && (entry.independent || options.underground);
    this.labels.setVisible(this.group.visible && overlayVisible(options));
  }

  updateLabels(camera: THREE.Camera, width: number, height: number) {
    const visible = this.group.visible && overlayVisible(this.options);
    this.labels.setVisible(visible);
    if (visible) this.labels.draw(camera, width, height, this.origin, station => stationLabelMode(station, this.options), station => stationVisible(station, this.options), (this.options.entrance || this.options.fixed || this.options.continuation) ? station => stationMarker(station, this.options) : undefined);
  }

  clear() {
    for (const { points } of this.entries) { this.group.remove(points); points.geometry.dispose(); points.material.dispose(); }
    this.entries = [];
    this.labels.clear();
  }
}
