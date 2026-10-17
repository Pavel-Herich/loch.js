import * as THREE from 'three';
import { SHOT_DUPLICATE, SHOT_SPLAY, SHOT_SURFACE, type Shot } from './lox-shots';

type AltitudeRange = { minZ: number; maxZ: number };
export type CentrelineOptions = { surface: boolean; underground: boolean; color: 'altitude' | 'default'; splay: boolean; duplicate: boolean };
export const DEFAULT_CENTRELINE_OPTIONS: CentrelineOptions = { surface: true, underground: true, color: 'altitude', splay: true, duplicate: true };

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
  constructor(readonly group: THREE.Group, private onChange: () => void) {}

  setModel(model: AltitudeRange & { shots: Shot[] }, origin: THREE.Vector3) {
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
  };
  const color = document.querySelector<HTMLSelectElement>('#centreline-color')!;
  color.value = 'altitude';
  for (const control of Object.values(controls)) control.checked = true;
  const update = () => centreline.setOptions({
    surface: controls.surface.checked, underground: controls.underground.checked,
    color: color.value === 'default' ? 'default' : 'altitude', splay: controls.splay.checked, duplicate: controls.duplicate.checked,
  });
  for (const control of [...Object.values(controls), color]) control.addEventListener('change', update);
  update();
}
