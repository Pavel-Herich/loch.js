import { nearestHorizontalSurfacePoint, nearestSurfacePoint } from './measure';
import * as THREE from 'three';
import { surfaceHeightAt, surfacePoint, type Surface, type SurfaceBitmap } from './lox-surface';

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

/** Earth brown for the terrain seen from below, mixed into its own colour so the relief still reads. */
const UNDERSIDE = 'vec3(.56, .36, .22)';

/**
 * Seen from below, the surface turns brown and (by default) opaque, so a view up from
 * the cave is told apart from a view down onto the terrain.
 */
function shadeUnderside(material: THREE.Material, frontUp: { value: number }, opaque: { value: number }, below: { value: number }) {
  material.onBeforeCompile = shader => {
    shader.uniforms.surfaceFrontUp = frontUp; shader.uniforms.surfaceUndersideOpaque = opaque; shader.uniforms.surfaceCameraBelow = below;
    // Only while the camera is under the terrain: from above, the backs of far slopes
    // (higher than the camera, seen through the transparent surface) keep their normal look.
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', 'uniform float surfaceFrontUp;\nuniform float surfaceUndersideOpaque;\nuniform float surfaceCameraBelow;\nvoid main() {')
      .replace('#include <dithering_fragment>', `#include <dithering_fragment>
  if (surfaceCameraBelow > .5 && gl_FrontFacing != (surfaceFrontUp > .5)) {
    gl_FragColor.rgb = mix(gl_FragColor.rgb, ${UNDERSIDE}, .6) * .85;
    gl_FragColor.a = mix(gl_FragColor.a, 1.0, surfaceUndersideOpaque);
  }`);
  };
  material.customProgramCacheKey = () => 'surface-underside';
}

export class SurfaceScene {
  transparency = true;
  opacity = DEFAULT_SURFACE_OPACITY;
  imageOverlay = true;
  private undersideOpaque = { value: 0 };
  private cameraBelow = { value: 0 };
  private origin = new THREE.Vector3();
  private lowest = Infinity;
  /** Smallest grid step, for sampling sight lines. */
  private cell = Infinity;
  private entries: SurfaceEntry[] = [];
  private revision = 0;
  private pending = new Map<string, THREE.Texture>();
  private grids: Pick<Surface, 'width' | 'height' | 'calibration' | 'heights'>[] = [];

  constructor(readonly group: THREE.Group, private onChange: () => void, private onError: (error: unknown) => void) {}

  get loading() { return this.pending.size > 0; }

  /** Closest terrain point to a world position (3D), from the surface above or below it. */
  nearestPoint(x: number, y: number, z: number) {
    for (const grid of this.grids) {
      const above = surfaceHeightAt(grid, x, y);
      if (above !== undefined) return nearestSurfacePoint(grid, x, y, z, above);
    }
    let best: ReturnType<typeof nearestSurfacePoint>;
    for (const grid of this.grids) {
      const found = nearestSurfacePoint(grid, x, y, z);
      if (found && (!best || found.distance < best.distance)) best = found;
    }
    return best;
  }

  /**
   * Does the terrain hide `to` from `from` (both in file coordinates)? The last few
   * metres before `to` do not count, so symbols on or just under the ground stay clear.
   */
  hides(fromX: number, fromY: number, fromZ: number, toX: number, toY: number, toZ: number) {
    if (!this.grids.length || !this.group.visible) return false;
    const dx = toX - fromX, dy = toY - fromY, dz = toZ - fromZ;
    const length = Math.hypot(dx, dy, dz);
    if (length < 8) return false;
    const end = 1 - 4 / length, samples = Math.max(4, Math.min(32, Math.ceil(Math.hypot(dx, dy) / (2 * this.cell))));
    // Hidden only where the sight line passes through the terrain (changes sides),
    // not where both ends are under it, as when looking along a cave.
    let side = 0;
    for (let i = 0; i <= samples; i++) {
      const t = end * i / samples, z = fromZ + dz * t;
      const ground = this.heightAt(fromX + dx * t, fromY + dy * t);
      if (ground === undefined) continue;
      const here = z > ground + 1 ? 1 : z < ground - 1 ? -1 : 0;
      if (!here) continue;
      if (side && here !== side) return true;
      side = here;
    }
    // From above (or below) the edge of the surface towards a point under (or over) it.
    if (side) { const ground = this.heightAt(toX, toY); if (ground !== undefined && (toZ - ground) * side < -4) return true; }
    return false;
  }

  /** How much of a symbol hidden by the terrain still shows through it: 0 hidden, up to 1. */
  get seeThrough() {
    if (!this.group.visible) return 1;
    if (this.cameraBelow.value && this.undersideOpaque.value) return 0;
    return this.transparency && this.opacity < 1 ? 1 - this.opacity : 0;
  }

  /** Nearest point where the terrain passes this height, measured horizontally. */
  nearestHorizontalPoint(x: number, y: number, z: number) {
    let best: ReturnType<typeof nearestHorizontalSurfacePoint>;
    for (const grid of this.grids) {
      const found = nearestHorizontalSurfacePoint(grid, x, y, z);
      if (found && (!best || found.distance < best.distance)) best = found;
    }
    return best;
  }

  /** Terrain height at a world (model file) position, from the first surface that covers it. */
  heightAt(x: number, y: number): number | undefined {
    for (const grid of this.grids) { const h = surfaceHeightAt(grid, x, y); if (h !== undefined) return h; }
    return undefined;
  }

  setAppearance(transparency: boolean, opacity: number) {
    this.transparency = transparency; this.opacity = Math.max(0, Math.min(1, opacity));
    for (const entry of this.entries) { this.applyAppearance(entry.image); this.applyAppearance(entry.lit); }
    this.onChange();
  }
  /**
   * Is the camera (scene coordinates) under the terrain? Over the surface it is compared with
   * the height there; beside it, with the lowest terrain point.
   */
  updateCamera(position: THREE.Vector3) {
    if (!this.grids.length) return;
    const east = position.x + this.origin.x, north = position.y + this.origin.y, z = position.z + this.origin.z;
    const ground = this.heightAt(east, north) ?? this.lowest;
    this.cameraBelow.value = z < ground ? 1 : 0;
  }

  setOpaqueUnderside(opaque: boolean) {
    this.undersideOpaque.value = opaque ? 1 : 0;
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
    this.grids.push({ width: surface.width, height: surface.height, calibration: surface.calibration, heights: surface.heights });
    this.origin.copy(origin);
    for (const h of surface.heights) if (h < this.lowest) this.lowest = h;
    const [, , cx, cy, rx, ry] = surface.calibration;
    this.cell = Math.min(this.cell, Math.hypot(cx, rx), Math.hypot(cy, ry));
    // Cells wind a → b → d; whether that faces up depends on the grid's handedness.
    const [, , xx, xy, yx, yy] = surface.calibration;
    const frontUp = { value: xx * yy - xy * yx > 0 ? 1 : 0 };
    for (const surfaceMaterial of [material, lit]) {
      surfaceMaterial.forceSinglePass = true; this.applyAppearance(surfaceMaterial);
      shadeUnderside(surfaceMaterial, frontUp, this.undersideOpaque, this.cameraBelow);
    }
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
    this.grids = []; this.lowest = Infinity; this.cell = Infinity; this.cameraBelow.value = 0;
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
  const underside = document.querySelector<HTMLInputElement>('#surface-opaque-underside')!;
  underside.checked = false;
  underside.addEventListener('change', () => surface.setOpaqueUnderside(underside.checked));
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
