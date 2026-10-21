import * as THREE from 'three';
import { StationLabels } from './station-labels';
import { STATION_SURFACE, temporaryStation, type Station, type StationLabel } from './lox-stations';

export type StationOptions = { stations: boolean; label: StationLabel; surface: boolean; underground: boolean; splay: boolean };
type Entry = { surface: boolean; points: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial> };
export function stationVisible(station: Station, options: StationOptions) {
  return options.stations && (station.flags & STATION_SURFACE ? options.surface : options.underground)
    && !temporaryStation(station);
}

/** One point draw per station type and one screen canvas for labels, regardless of station count. */
export class StationScene {
  private entries: Entry[] = [];
  private origin = new THREE.Vector3();
  private options: StationOptions = { stations: false, label: 'none', surface: true, underground: true, splay: true };
  private labels: StationLabels;
  constructor(private group: THREE.Group, canvas?: HTMLCanvasElement) { this.labels = new StationLabels(canvas); }

  setModel(stations: Station[], origin: THREE.Vector3) {
    this.clear(); this.labels.setStations(stations); this.origin.copy(origin);
    const buckets = new Map<number, Station[]>();
    for (const station of stations) {
      if (temporaryStation(station)) continue;
      const key = station.flags & STATION_SURFACE ? 1 : 0;
      const bucket = buckets.get(key);
      if (bucket) bucket.push(station); else buckets.set(key, [station]);
    }
    for (const [key, stations] of buckets) {
      const positions = new Float32Array(stations.length * 3);
      stations.forEach((station, index) => positions.set(station.position.map((value, axis) => value - origin.getComponent(axis)), index * 3));
      const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const material = new THREE.PointsMaterial({ color: key & 1 ? 0x808080 : 0xffffff, size: 3, sizeAttenuation: false, toneMapped: false });
      material.onBeforeCompile = shader => {
        shader.fragmentShader = shader.fragmentShader.replace('#include <clipping_planes_fragment>',
          '#include <clipping_planes_fragment>\nif (length(gl_PointCoord - vec2(0.5)) > 0.5) discard;');
      };
      const points = new THREE.Points(geometry, material); points.name = `Stations ${key}`;
      this.group.add(points); this.entries.push({ surface: Boolean(key & 1), points });
    }
    this.setOptions(this.options);
  }

  setOptions(options: StationOptions) {
    this.options = { ...options };
    for (const entry of this.entries) entry.points.visible = options.stations
      && (entry.surface ? options.surface : options.underground);
    this.labels.setVisible(this.group.visible && options.stations && options.label !== 'none');
  }

  updateLabels(camera: THREE.Camera, width: number, height: number) {
    const visible = this.group.visible && this.options.stations && this.options.label !== 'none';
    this.labels.setVisible(visible);
    if (visible) this.labels.draw(camera, width, height, this.origin, this.options.label, station => stationVisible(station, this.options));
  }

  clear() {
    for (const { points } of this.entries) { this.group.remove(points); points.geometry.dispose(); points.material.dispose(); }
    this.entries = [];
    this.labels.clear();
  }
}
