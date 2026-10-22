import * as THREE from 'three';
import { SHOT_DUPLICATE, SHOT_SPLAY, SHOT_SURFACE, type Shot } from './lox-shots';
import { StationScene, type StationOptions } from './stations';
import type { Station, StationLabel } from './lox-stations';

type AltitudeRange = { minZ: number; maxZ: number };
export type CentrelineOptions = StationOptions & { color: 'altitude' | 'default'; duplicate: boolean };
export const DEFAULT_CENTRELINE_OPTIONS: CentrelineOptions = { surface: true, underground: true, color: 'altitude', splay: true, duplicate: true, stations: false, entrance: false, fixed: false, continuation: false, label: 'none', entranceLabel: 'none' };

export function centrelineVisible(flags: number, options: CentrelineOptions) {
  return Boolean((flags & SHOT_SURFACE ? options.surface : options.underground)
    && (!(flags & SHOT_SPLAY) || options.splay) && (!(flags & SHOT_DUPLICATE) || options.duplicate));
}

export function centrelineColor(z: number, flags: number, range: AltitudeRange, mode: CentrelineOptions['color'], color = new THREE.Color()) {
  // Surface shots stay neutral in both modes, including surface duplicates/splays.
  if (flags & SHOT_SURFACE) return color.setHex(0x808080);
  const splay = Boolean(flags & SHOT_SPLAY);
  if (mode === 'default') return color.setRGB(splay ? .5 : 1, splay ? .5 : 1, splay ? .5 : 1);
  const t = range.maxZ === range.minZ ? .5 : THREE.MathUtils.clamp((z - range.minZ) / (range.maxZ - range.minZ), 0, 1);
  // Half saturation and lightness keep splays muted and darker than survey legs.
  return color.setHSL((1 - t) * .68, splay ? .41 : .82, splay ? .27 : .54);
}

type Entry = { flags: number; lines: THREE.LineSegments<THREE.BufferGeometry, THREE.LineBasicMaterial> };
export class CentrelineScene {
  options = { ...DEFAULT_CENTRELINE_OPTIONS };
  private entries: Entry[] = [];
  private range: AltitudeRange = { minZ: 0, maxZ: 0 };
  private originZ = 0;
  private stations: StationScene;
  constructor(readonly group: THREE.Group, private onChange: () => void, labels?: HTMLCanvasElement) {
    this.stations = new StationScene(group, labels);
  }

  updateLabels(camera: THREE.Camera, width: number, height: number) { this.stations.updateLabels(camera, width, height); }

  setModel(model: AltitudeRange & { shots: Shot[]; stationDetails?: Station[] }, origin: THREE.Vector3) {
    this.clear(); this.range = { minZ: model.minZ, maxZ: model.maxZ }; this.originZ = origin.z;
    const buckets = new Map<number, Shot[]>();
    for (const shot of model.shots) {
      const flags = shot.flags & (SHOT_SURFACE | SHOT_SPLAY | SHOT_DUPLICATE);
      const bucket = buckets.get(flags);
      if (bucket) bucket.push(shot); else buckets.set(flags, [shot]);
    }
    const material = new THREE.LineBasicMaterial({ vertexColors: true, toneMapped: false });
    for (const [flags, shots] of buckets) {
      const positions = new Float32Array(shots.length * 6);
      let offset = 0;
      for (const shot of shots) for (const point of [shot.from, shot.to]) {
        positions[offset++] = point[0] - origin.x;
        positions[offset++] = point[1] - origin.y;
        positions[offset++] = point[2] - origin.z;
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geometry.setAttribute('color', new THREE.BufferAttribute(new Float32Array(positions.length), 3));
      const lines = new THREE.LineSegments(geometry, material);
      lines.name = `Centreline ${flags}`;
      this.group.add(lines); this.entries.push({ flags, lines });
    }
    if (!this.entries.length) material.dispose();
    this.stations.setModel(model.stationDetails ?? [], origin);
    this.updateColors(); this.updateVisibility();
  }

  setOptions(options: CentrelineOptions) {
    const recolor = options.color !== this.options.color;
    this.options = { ...options };
    if (recolor) this.updateColors();
    this.updateVisibility(); this.onChange();
  }
  private updateVisibility() {
    for (const entry of this.entries) entry.lines.visible = centrelineVisible(entry.flags, this.options);
    this.stations.setOptions(this.options);
  }
  private updateColors() {
    const color = new THREE.Color();
    for (const { flags, lines } of this.entries) {
      const positions = lines.geometry.getAttribute('position'), colors = lines.geometry.getAttribute('color');
      for (let i = 0; i < positions.count; i++) {
        centrelineColor(positions.getZ(i) + this.originZ, flags, this.range, this.options.color, color);
        colors.setXYZ(i, color.r, color.g, color.b);
      }
      colors.needsUpdate = true;
    }
  }
  clear() {
    this.stations.clear();
    const materials = new Set<THREE.Material>();
    for (const { lines } of this.entries) { this.group.remove(lines); lines.geometry.dispose(); materials.add(lines.material); }
    for (const material of materials) material.dispose();
    this.entries = [];
  }
}

export function initializeCentrelineControls(centreline: CentrelineScene) {
  const controls = {
    surface: document.querySelector<HTMLInputElement>('#centreline-surface')!,
    underground: document.querySelector<HTMLInputElement>('#centreline-underground')!,
    splay: document.querySelector<HTMLInputElement>('#centreline-splay')!,
    duplicate: document.querySelector<HTMLInputElement>('#centreline-duplicate')!,
    stations: document.querySelector<HTMLInputElement>('#station-all')!,
    entrance: document.querySelector<HTMLInputElement>('#station-entrance')!,
    fixed: document.querySelector<HTMLInputElement>('#station-fixed')!,
    continuation: document.querySelector<HTMLInputElement>('#station-continuation')!,
  };
  const color = document.querySelector<HTMLSelectElement>('#centreline-color')!;
  const label = document.querySelector<HTMLSelectElement>('#station-label')!;
  const entranceLabel = document.querySelector<HTMLSelectElement>('#entrance-label')!;
  label.value = 'none'; entranceLabel.value = 'none';
  color.value = 'altitude';
  for (const [key, control] of Object.entries(controls)) control.checked = DEFAULT_CENTRELINE_OPTIONS[key as keyof typeof controls];
  const update = () => centreline.setOptions({
    surface: controls.surface.checked, underground: controls.underground.checked,
    color: color.value === 'default' ? 'default' : 'altitude', splay: controls.splay.checked, duplicate: controls.duplicate.checked,
    stations: controls.stations.checked, entrance: controls.entrance.checked, fixed: controls.fixed.checked,
    continuation: controls.continuation.checked, label: label.value as StationLabel,
    entranceLabel: entranceLabel.value as StationLabel,
  });
  for (const control of [...Object.values(controls), color, label, entranceLabel]) control.addEventListener('change', update);
  update();
}
