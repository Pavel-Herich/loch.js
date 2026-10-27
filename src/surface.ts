import { nearestHorizontalSurfacePoint, nearestSurfacePoint } from './measure';
import * as THREE from 'three';
import { surfaceHeightAt, surfacePoint, type Calibration, type Surface, type SurfaceBitmap } from './lox-surface';

// Loch lxSetup defaults: m_srf_transparency = true, m_srf_opacity = 0.5.
export const DEFAULT_SURFACE_OPACITY = 0.5;
/** Surface meshes are about this many metres across, so map pieces can differ in sharpness. */
const PIECE_METRES = 1000;
const MAX_TILE_CELLS = 255, MIN_TILE_CELLS = 16;
export function tileCells(calibration: Calibration) {
  const cell = Math.max(Math.hypot(calibration[2], calibration[4]), Math.hypot(calibration[3], calibration[5]));
  return Math.max(MIN_TILE_CELLS, Math.min(MAX_TILE_CELLS, Math.round(PIECE_METRES / cell)));
}

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
type Extent = [number, number, number, number];
type SurfaceTile = {
  geometry: THREE.BufferGeometry; mesh: THREE.Mesh<THREE.BufferGeometry, SurfaceMaterial>;
  column: number; row: number; columns: number; rows: number;
  /** [minEast, minNorth, maxEast, maxNorth] in file coordinates. */
  extent: Extent;
  /** Texture coordinates of the LOX image. */
  loxUV?: THREE.BufferAttribute;
  /** Map pieces of the layers over the base, by layer. */
  pieces: Map<string, LayerImage>;
  /** The tile's own material when map layers lie over it, and what it was built for. */
  own?: { material: SurfaceMaterial; signature: string };
};
/** A map image and where it lies: scene x/y → texture u/v as (xy − offset) × scale. */
type LayerImage = { texture: THREE.Texture; transform: THREE.Vector4 };
type Layer = { order: number; opacity: { value: number }; whole?: LayerImage };
type SurfaceEntry = {
  image: THREE.MeshBasicMaterial; lit: THREE.MeshStandardMaterial; meshes: THREE.Mesh<THREE.BufferGeometry, SurfaceMaterial>[];
  surface: Surface; tiles: SurfaceTile[]; frontUp: { value: number };
  /** The LOX file's own image, kept to come back to from a map-service underlay. */
  lox?: { texture: THREE.Texture; bitmap: SurfaceBitmap };
};

/** Earth brown for the terrain seen from below, mixed into its own colour so the relief still reads. */
const UNDERSIDE = 'vec3(.56, .36, .22)';

/**
 * Seen from below, the surface turns brown and (by default) opaque, so a view up from
 * the cave is told apart from a view down onto the terrain.
 */
type LayerUniforms = { map: THREE.Texture; transform: THREE.Vector4; opacity: { value: number } };
/**
 * Seen from below, the surface turns brown and (by default) opaque, so a view up from
 * the cave is told apart from a view down onto the terrain. Map layers are laid over the
 * base colour in order, each placed by the vertex position (scene x/y) and with its opacity.
 */
function shadeSurface(material: THREE.Material, frontUp: { value: number }, opaque: { value: number }, below: { value: number }, layers: LayerUniforms[] = []) {
  material.onBeforeCompile = shader => {
    shader.uniforms.surfaceFrontUp = frontUp; shader.uniforms.surfaceUndersideOpaque = opaque; shader.uniforms.surfaceCameraBelow = below;
    layers.forEach((layer, i) => {
      shader.uniforms[`layerMap${i}`] = { value: layer.map };
      shader.uniforms[`layerTransform${i}`] = { value: layer.transform };
      shader.uniforms[`layerOpacity${i}`] = layer.opacity;
    });
    const declarations = layers.map((_, i) => `uniform sampler2D layerMap${i};\nuniform vec4 layerTransform${i};\nuniform float layerOpacity${i};`).join('\n');
    const blend = layers.map((_, i) => `  {
    vec2 layerUv = (vSurfaceXY - layerTransform${i}.xy) * layerTransform${i}.zw;
    if (layerOpacity${i} > 0. && all(greaterThanEqual(layerUv, vec2(0.))) && all(lessThanEqual(layerUv, vec2(1.)))) {
      vec4 layerColor = texture2D(layerMap${i}, layerUv);
      diffuseColor.rgb = mix(diffuseColor.rgb, layerColor.rgb, layerOpacity${i} * layerColor.a);
    }
  }`).join('\n');
    if (layers.length) {
      shader.vertexShader = shader.vertexShader
        .replace('void main() {', 'varying vec2 vSurfaceXY;\nvoid main() {')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vSurfaceXY = position.xy;');
      shader.fragmentShader = shader.fragmentShader
        .replace('void main() {', `varying vec2 vSurfaceXY;\n${declarations}\nvoid main() {`)
        .replace('#include <map_fragment>', `#include <map_fragment>\n${blend}`);
    }
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
  material.customProgramCacheKey = () => `surface-layers-${layers.length}`;
}

export class SurfaceScene {
  transparency = true;
  opacity = DEFAULT_SURFACE_OPACITY;
  imageOverlay = true;
  private undersideOpaque = { value: 0 };
  private cameraBelow = { value: 0 };
  private origin = new THREE.Vector3();
  private lowest = Infinity;
  private entries: SurfaceEntry[] = [];
  private revision = 0;
  private pending = new Map<string, THREE.Texture>();
  private grids: Pick<Surface, 'width' | 'height' | 'calibration' | 'heights'>[] = [];
  private layers = new Map<string, Layer>();

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
    for (const entry of this.entries) {
      this.applyAppearance(entry.image); this.applyAppearance(entry.lit);
      for (const tile of entry.tiles) if (tile.own) this.applyAppearance(tile.own.material);
    }
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
    this.reassign();
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
    // Cells wind a → b → d; whether that faces up depends on the grid's handedness.
    const [, , xx, xy, yx, yy] = surface.calibration;
    const frontUp = { value: xx * yy - xy * yx > 0 ? 1 : 0 };
    const entry: SurfaceEntry = { image: material, lit, meshes: [], surface, tiles: [], frontUp };
    this.grids.push({ width: surface.width, height: surface.height, calibration: surface.calibration, heights: surface.heights });
    this.origin.copy(origin);
    for (const h of surface.heights) if (h < this.lowest) this.lowest = h;
    for (const surfaceMaterial of [material, lit]) this.prepare(surfaceMaterial, frontUp);
    this.entries.push(entry);
    const tiles = entry.tiles, cells = tileCells(surface.calibration);
    for (let row = 0; row < surface.height - 1; row += cells) {
      for (let column = 0; column < surface.width - 1; column += cells) {
        const columns = Math.min(cells, surface.width - column - 1), rows = Math.min(cells, surface.height - row - 1);
        const geometry = surfaceGeometry(surface, origin, column, row, columns, rows);
        const mesh = new THREE.Mesh<THREE.BufferGeometry, SurfaceMaterial>(geometry, this.imageOverlay ? material : lit); mesh.name = `Surface ${surface.id}`;
        this.group.add(mesh); entry.meshes.push(mesh);
        tiles.push({ geometry, mesh, column, row, columns, rows, extent: tileExtent(surface, column, row, columns, rows), pieces: new Map() });
      }
    }
    if (!surface.bitmap || !tiles.length) return;
    const bitmap = surface.bitmap, revision = this.revision;
    const url = URL.createObjectURL(new Blob([bitmap.data], { type: bitmap.mime }));
    const release = () => { this.pending.delete(url); URL.revokeObjectURL(url); };
    const texture = new THREE.TextureLoader().load(url, texture => {
      release();
      if (revision !== this.revision) { texture.dispose(); return; }
      // surfaceUV already reverses image Y to texture V; avoid a second flip on upload.
      texture.flipY = false;
      texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = 4;
      entry.lox = { texture, bitmap };
      for (const tile of entry.tiles) {
        tile.loxUV = surfaceUV(entry.surface, bitmap, texture.image.width, texture.image.height, tile.column, tile.row, tile.columns, tile.rows);
        tile.geometry.setAttribute('uv', tile.loxUV);
      }
      entry.image.map = texture; entry.image.needsUpdate = true;
      for (const tile of entry.tiles) this.assign(entry, tile, true);
      this.onChange();
    }, undefined, () => {
      release(); texture.dispose();
      if (revision === this.revision) this.onError(new Error('Could not decode the LOX surface image.'));
    });
    this.pending.set(url, texture);
  }

  private prepare(material: SurfaceMaterial, frontUp: { value: number }, layers?: LayerUniforms[]) {
    material.forceSinglePass = true; this.applyAppearance(material);
    shadeSurface(material, frontUp, this.undersideOpaque, this.cameraBelow, layers);
  }
  /**
   * The tile's material: the shared base (LOX image or plain shading) when no map lies over
   * it, otherwise its own copy of the base with the map layers laid over it in order.
   */
  private assign(entry: SurfaceEntry, tile: SurfaceTile, rebuild = false) {
    const base = this.imageOverlay ? entry.image : entry.lit;
    const layers = [...this.layers.entries()].sort((a, b) => a[1].order - b[1].order)
      .map(([id, layer]) => ({ id, layer, image: tile.pieces.get(id) ?? layer.whole }))
      .filter(item => item.image) as { id: string; layer: Layer; image: LayerImage }[];
    if (!layers.length) { this.dropOwn(tile); tile.mesh.material = base; return; }
    const signature = `${this.imageOverlay}|${layers.map(item => `${item.id}:${item.image.texture.uuid}`).join(',')}`;
    if (tile.own && tile.own.signature === signature && !rebuild) { tile.mesh.material = tile.own.material; return; }
    this.dropOwn(tile);
    const material = base.clone() as SurfaceMaterial;
    material.map = base.map;
    this.prepare(material, entry.frontUp, layers.map(item => ({ map: item.image.texture, transform: item.image.transform, opacity: item.layer.opacity })));
    tile.own = { material, signature };
    tile.mesh.material = material;
  }
  private dropOwn(tile: SurfaceTile) { tile.own?.material.dispose(); tile.own = undefined; }

  /** Extent of all surfaces in file coordinates: [minEast, minNorth, maxEast, maxNorth]. */
  extent(): Extent | undefined {
    if (!this.grids.length) return undefined;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const grid of this.grids) for (const [c, r] of [[0, 0], [grid.width - 1, 0], [0, grid.height - 1], [grid.width - 1, grid.height - 1]]) {
      const [x0, y0, xx, xy, yx, yy] = grid.calibration, x = x0 + xx * c + xy * r, y = y0 + yx * c + yy * r;
      minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
    return [minX, minY, maxX, maxY];
  }

  /** The surface pieces a map layer is draped on, one per mesh, keyed by surface and position. */
  pieces() {
    return this.entries.flatMap((entry, e) => entry.tiles.map(tile => ({ key: `${e}:${tile.column}:${tile.row}`, extent: tile.extent })));
  }
  private image(texture: THREE.Texture, extent: Extent): LayerImage {
    const [minX, minY, maxX, maxY] = extent;
    // Canvas rows run from the north edge; texture v grows with them (no flip on upload).
    return { texture, transform: new THREE.Vector4(minX - this.origin.x, maxY - this.origin.y, 1 / (maxX - minX), -1 / (maxY - minY)) };
  }
  /** A map layer over the base, drawn above layers of lower order; opacity 0–1. */
  setLayer(id: string, order: number, opacity: number) {
    const layer = this.layers.get(id);
    if (layer) { layer.order = order; layer.opacity.value = opacity; }
    else this.layers.set(id, { order, opacity: { value: opacity } });
    this.onChange();
  }
  setLayerOpacity(id: string, opacity: number) {
    const layer = this.layers.get(id);
    if (layer) { layer.opacity.value = Math.max(0, Math.min(1, opacity)); this.onChange(); }
  }
  /** One piece of a layer's map (north up, covering `extent` in file coordinates). */
  setLayerPiece(id: string, key: string, texture: THREE.Texture, extent: Extent) {
    const [e, column, row] = key.split(':').map(Number), entry = this.entries[e];
    const tile = entry?.tiles.find(item => item.column === column && item.row === row);
    if (!entry || !tile || !this.layers.has(id)) { texture.dispose(); return; }
    tile.pieces.get(id)?.texture.dispose();
    tile.pieces.set(id, this.image(texture, extent));
    this.assign(entry, tile);
    this.onChange();
  }
  /** One map for the whole surface (north up, covering `extent` in file coordinates). */
  setLayerImage(id: string, texture: THREE.Texture, extent: Extent) {
    const layer = this.layers.get(id);
    if (!layer) { texture.dispose(); return; }
    layer.whole?.texture.dispose();
    layer.whole = this.image(texture, extent);
    this.reassign();
  }
  /** Takes a layer off the surface and frees its images. */
  removeLayer(id: string) {
    const layer = this.layers.get(id);
    if (!layer) return;
    this.layers.delete(id); layer.whole?.texture.dispose();
    for (const entry of this.entries) for (const tile of entry.tiles) { tile.pieces.get(id)?.texture.dispose(); tile.pieces.delete(id); }
    this.reassign();
  }
  private reassign() {
    for (const entry of this.entries) for (const tile of entry.tiles) this.assign(entry, tile);
    this.onChange();
  }

  clear() {
    for (const id of [...this.layers.keys()]) this.removeLayer(id);
    for (const entry of this.entries) for (const tile of entry.tiles) this.dropOwn(tile);
    this.revision++;
    this.grids = []; this.lowest = Infinity; this.cameraBelow.value = 0;
    for (const [url, texture] of this.pending) { URL.revokeObjectURL(url); texture.dispose(); }
    this.pending.clear();
    for (const child of [...this.group.children]) {
      this.group.remove(child); (child as THREE.Mesh).geometry.dispose();
    }
    for (const entry of this.entries) { entry.image.map?.dispose(); entry.lox?.texture.dispose(); entry.image.dispose(); entry.lit.dispose(); }
    this.entries = [];
  }
}

function tileExtent(surface: Surface, column: number, row: number, columns: number, rows: number): Extent {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [c, r] of [[column, row], [column + columns, row], [column, row + rows], [column + columns, row + rows]]) {
    const [x, y] = surfacePoint(surface, r * surface.width + c, 0);
    minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return [minX, minY, maxX, maxY];
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
