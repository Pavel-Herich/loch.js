import * as THREE from 'three';
import { STATION_SURFACE, stationLabel, temporaryStation, type Station, type StationLabel } from './lox-stations';

export type StationOptions = { stations: boolean; label: StationLabel; surface: boolean; underground: boolean; splay: boolean };
type Entry = { surface: boolean; temporary: boolean; points: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial> };
export function stationVisible(station: Station, options: StationOptions) {
  return options.stations && (station.flags & STATION_SURFACE ? options.surface : options.underground)
    && (!temporaryStation(station) || options.splay);
}

/** One point draw per station type and one screen canvas for labels, regardless of station count. */
export class StationScene {
  private entries: Entry[] = [];
  private stations: Station[] = [];
  private origin = new THREE.Vector3();
  private options: StationOptions = { stations: true, label: 'none', surface: true, underground: true, splay: true };
  constructor(private group: THREE.Group, private canvas?: HTMLCanvasElement) {}

  setModel(stations: Station[], origin: THREE.Vector3) {
    this.clear(); this.stations = stations; this.origin.copy(origin);
    const buckets = new Map<number, Station[]>();
    for (const station of stations) {
      const key = (station.flags & STATION_SURFACE ? 1 : 0) | (temporaryStation(station) ? 2 : 0);
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
      this.group.add(points); this.entries.push({ surface: Boolean(key & 1), temporary: Boolean(key & 2), points });
    }
    this.setOptions(this.options);
  }

  setOptions(options: StationOptions) {
    this.options = { ...options };
    for (const entry of this.entries) entry.points.visible = options.stations
      && (entry.surface ? options.surface : options.underground) && (!entry.temporary || options.splay);
    if (this.canvas) this.canvas.hidden = !this.group.visible || !options.stations || options.label === 'none';
  }

  updateLabels(camera: THREE.Camera, width: number, height: number) {
    if (!this.canvas) return;
    this.canvas.hidden = !this.group.visible || !this.options.stations || this.options.label === 'none';
    if (this.canvas.hidden || !width || !height) return;
    const ratio = Math.min(devicePixelRatio, 2);
    if (this.canvas.width !== Math.round(width * ratio) || this.canvas.height !== Math.round(height * ratio)) {
      this.canvas.width = Math.round(width * ratio); this.canvas.height = Math.round(height * ratio);
    }
    const context = this.canvas.getContext('2d');
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0); context.clearRect(0, 0, width, height);
    context.font = '12px system-ui, sans-serif'; context.textBaseline = 'middle';
    context.lineWidth = 3; context.strokeStyle = '#09131c'; context.lineJoin = 'round';
    camera.updateMatrixWorld();
    const matrix = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const point = new THREE.Vector4();
    for (const station of this.stations) {
      if (!stationVisible(station, this.options)) continue;
      const text = stationLabel(station, this.options.label);
      if (!text) continue;
      point.set(station.position[0] - this.origin.x, station.position[1] - this.origin.y, station.position[2] - this.origin.z, 1).applyMatrix4(matrix);
      if (point.w <= 0 || Math.abs(point.x) > point.w || Math.abs(point.y) > point.w || Math.abs(point.z) > point.w) continue;
      const x = (point.x / point.w + 1) * width / 2 + 5, y = (1 - point.y / point.w) * height / 2;
      context.fillStyle = station.flags & STATION_SURFACE ? '#808080' : '#ffffff';
      context.strokeText(text, x, y); context.fillText(text, x, y);
    }
  }

  clear() {
    for (const { points } of this.entries) { this.group.remove(points); points.geometry.dispose(); points.material.dispose(); }
    this.entries = []; this.stations = [];
    if (this.canvas) { this.canvas.hidden = true; this.canvas.getContext('2d')?.clearRect(0, 0, this.canvas.width, this.canvas.height); }
  }
}
