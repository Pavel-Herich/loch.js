import * as THREE from 'three';
import { surfacePoint, type Surface, type SurfaceBitmap } from './lox-surface';

// Loch lxSetup defaults: m_srf_transparency = true, m_srf_opacity = 0.5.
export const DEFAULT_SURFACE_OPACITY = 0.5;
const TILE_CELLS = 255;

export function surfaceGeometry(surface: Surface, origin: THREE.Vector3, firstColumn = 0, firstRow = 0,
  columns = surface.width - 1, rows = surface.height - 1) {
  const positions = new Float32Array((columns + 1) * (rows + 1) * 3);
  const indices = new Uint32Array(columns * rows * 6);
  let vertex = 0, triangle = 0;
  for (let row = 0; row <= rows; row++) for (let column = 0; column <= columns; column++) {
    const index = (firstRow + row) * surface.width + firstColumn + column;
    const point = surfacePoint(surface, index, surface.heights[index]);
    if (!point.every(Number.isFinite)) throw new Error('Invalid surface coordinate');
    positions[vertex++] = point[0] - origin.x;
    positions[vertex++] = point[1] - origin.y;
    positions[vertex++] = point[2] - origin.z;
    if (row < rows && column < columns) {
      const a = row * (columns + 1) + column, b = a + 1, c = a + columns + 1, d = c + 1;
      indices.set([a, b, d, a, d, c], triangle); triangle += 6;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  return geometry;
}

/** Invert the bitmap's world calibration, then normalize by its pixel dimensions. */
export function surfaceUV(surface: Surface, bitmap: SurfaceBitmap, width: number, height: number,
  firstColumn: number, firstRow: number, columns: number, rows: number) {
  const [x, y, xx, xy, yx, yy] = bitmap.calibration;
  const determinant = xx * yy - xy * yx;
  const uv = new Float32Array((columns + 1) * (rows + 1) * 2);
  let next = 0;
  for (let row = 0; row <= rows; row++) for (let column = 0; column <= columns; column++) {
    const point = surfacePoint(surface, (firstRow + row) * surface.width + firstColumn + column, 0);
    const dx = point[0] - x, dy = point[1] - y;
    uv[next++] = (yy * dx - xy * dy) / determinant / width;
    uv[next++] = 1 - (xx * dy - yx * dx) / determinant / height;
  }
  return new THREE.BufferAttribute(uv, 2);
}

type SurfaceMaterial = THREE.MeshBasicMaterial | THREE.MeshStandardMaterial;
type SurfaceEntry = { image: THREE.MeshBasicMaterial; lit: THREE.MeshStandardMaterial; meshes: THREE.Mesh<THREE.BufferGeometry, SurfaceMaterial>[] };

export class SurfaceScene {
  transparency = true;
  opacity = DEFAULT_SURFACE_OPACITY;
  imageOverlay = true;
  private entries: SurfaceEntry[] = [];
  private revision = 0;
  private pending = new Map<string, THREE.Texture>();

  constructor(readonly group: THREE.Group, private onChange: () => void, private onError: (error: unknown) => void) {}

  get loading() { return this.pending.size > 0; }

  setAppearance(transparency: boolean, opacity: number) {
    this.transparency = transparency; this.opacity = Math.max(0, Math.min(1, opacity));
    for (const entry of this.entries) { this.applyAppearance(entry.image); this.applyAppearance(entry.lit); }
    this.onChange();
  }
  setImageOverlay(enabled: boolean) {
    this.imageOverlay = enabled;
    for (const entry of this.entries) for (const mesh of entry.meshes) mesh.material = enabled ? entry.image : entry.lit;
    this.onChange();
  }
  private applyAppearance(material: SurfaceMaterial) {
    const transparent = this.transparency && this.opacity < 1;
    if (material.transparent !== transparent) material.needsUpdate = true;
    material.transparent = transparent;
    material.opacity = this.transparency ? this.opacity : 1;
    material.depthWrite = !transparent;
  }

  add(surface: Surface, origin: THREE.Vector3) {
    const material = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
    const lit = new THREE.MeshStandardMaterial({ color: 0xffffff, side: THREE.DoubleSide, flatShading: true, roughness: .85, metalness: 0 });
    const entry: SurfaceEntry = { image: material, lit, meshes: [] };
    for (const surfaceMaterial of [material, lit]) { surfaceMaterial.forceSinglePass = true; this.applyAppearance(surfaceMaterial); }
    this.entries.push(entry);
    const tiles: { geometry: THREE.BufferGeometry; column: number; row: number; columns: number; rows: number }[] = [];
    for (let row = 0; row < surface.height - 1; row += TILE_CELLS) {
      for (let column = 0; column < surface.width - 1; column += TILE_CELLS) {
        const columns = Math.min(TILE_CELLS, surface.width - column - 1), rows = Math.min(TILE_CELLS, surface.height - row - 1);
        const geometry = surfaceGeometry(surface, origin, column, row, columns, rows);
        const mesh = new THREE.Mesh<THREE.BufferGeometry, SurfaceMaterial>(geometry, this.imageOverlay ? material : lit); mesh.name = `Surface ${surface.id}`;
        this.group.add(mesh); entry.meshes.push(mesh); tiles.push({ geometry, column, row, columns, rows });
      }
    }
    if (!surface.bitmap || !tiles.length) return;
    const bitmap = surface.bitmap, revision = this.revision;
    const url = URL.createObjectURL(new Blob([bitmap.data], { type: bitmap.mime }));
    const release = () => { this.pending.delete(url); URL.revokeObjectURL(url); };
    const texture = new THREE.TextureLoader().load(url, texture => {
      release();
      if (revision !== this.revision) { texture.dispose(); return; }
      for (const tile of tiles) tile.geometry.setAttribute('uv', surfaceUV(surface, bitmap, texture.image.width, texture.image.height,
        tile.column, tile.row, tile.columns, tile.rows));
      // surfaceUV already reverses image Y to texture V; avoid a second flip on upload.
      texture.flipY = false;
      texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 4;
      material.map = texture; material.needsUpdate = true; this.onChange();
    }, undefined, () => {
      release(); texture.dispose();
      if (revision === this.revision) this.onError(new Error('Could not decode the LOX surface image.'));
    });
    this.pending.set(url, texture);
  }

  clear() {
    this.revision++;
    for (const [url, texture] of this.pending) { URL.revokeObjectURL(url); texture.dispose(); }
    this.pending.clear();
    for (const child of [...this.group.children]) {
      this.group.remove(child); (child as THREE.Mesh).geometry.dispose();
    }
    for (const entry of this.entries) { entry.image.map?.dispose(); entry.image.dispose(); entry.lit.dispose(); }
    this.entries = [];
  }
}

export function initializeSurfaceControls(surface: SurfaceScene) {
  const visible = document.querySelector<HTMLInputElement>('#surface')!;
  const transparency = document.querySelector<HTMLInputElement>('#surface-transparency')!;
  const overlay = document.querySelector<HTMLInputElement>('#surface-image-overlay')!;
  const opacity = document.querySelector<HTMLInputElement>('#surface-opacity')!;
  const value = document.querySelector<HTMLOutputElement>('#surface-opacity-value')!;
  const slider = document.querySelector<HTMLElement>('#surface-opacity-control')!;
  visible.checked = true; surface.group.visible = true; transparency.checked = true;
  opacity.value = String(DEFAULT_SURFACE_OPACITY * 100);
  overlay.checked = true;
  const update = () => {
    slider.hidden = !transparency.checked; opacity.disabled = !transparency.checked;
    value.value = `${opacity.value}%`;
    surface.setAppearance(transparency.checked, Number(opacity.value) / 100);
  };
  visible.addEventListener('change', () => { surface.group.visible = visible.checked; update(); });
  overlay.addEventListener('change', () => surface.setImageOverlay(overlay.checked));
  transparency.addEventListener('change', update); opacity.addEventListener('input', update);
  update();
}
