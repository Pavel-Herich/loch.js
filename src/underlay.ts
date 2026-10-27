import { sjtskToWgs84 } from './geo';

/**
 * Map underlays for the surface. Base maps (orthophoto, Freemap) replace the LOX image in
 * pieces of about a kilometre, sharper near the cave; overlays (the geological map) lie
 * over whatever base is shown, with adjustable opacity. WMS services are asked in S-JTSK
 * (EPSG:5514); Freemap's Web Mercator tiles are reprojected to S-JTSK on a canvas.
 * Services must allow use from other sites (CORS) for their images to become textures.
 */
export type Extent = [number, number, number, number];
type ServiceBase = {
  id: string; title: string; attribution: string;
  /** Typical download size per pixel of the result (bytes), for the size estimate. */
  bytesPerPixel: number;
  /** Name for copies kept on the device, when older copies must not be used again. */
  storeAs?: string;
};
export type WmsService = ServiceBase & {
  kind: 'wms'; url: string; layers: string; format: string; transparent?: boolean;
  /** Read the layer names from the capabilities instead of using `layers` as given. */
  discover?: boolean;
};
export type XyzService = ServiceBase & {
  kind: 'xyz'; url: string; tileSize: number; maxZoom: number;
  /** The service needs the user's own API key, put into the URL as {apikey}. */
  apiKey?: 'mapy';
};
export type UnderlayService = (WmsService | XyzService) & {
  role: 'base' | 'overlay';
  /** Ground resolution (m/px) near the cave, around it, and far away (base maps). */
  levels?: [number, number, number];
};

export const UNDERLAY_SERVICES: UnderlayService[] = [
  // Only the orthophoto mosaic itself: the service's other layers (sheet outlines) would cover it.
  { id: 'ortho', role: 'base', kind: 'wms', title: 'ZBGIS orthophoto', url: 'https://inspirews.skgeodesy.sk/geoserver/oi/ows', layers: 'OI.OrthoimageCoverage',
    format: 'image/jpeg', attribution: '© ÚGKK SR', bytesPerPixel: .3, levels: [.5, 2, 6], storeAs: 'ortho-mosaic' },
  { id: 'freemap', role: 'base', kind: 'xyz', title: 'Freemap outdoor map', url: 'https://outdoor.tiles.freemap.sk/{z}/{x}/{y}@2x', tileSize: 512, maxZoom: 19,
    attribution: '© Freemap Slovakia, © OpenStreetMap contributors', bytesPerPixel: .45, levels: [1, 2.5, 6] },
  { id: 'mapy-outdoor', role: 'base', kind: 'xyz', title: 'Mapy.com outdoor map', url: 'https://api.mapy.com/v1/maptiles/outdoor/256@2x/{z}/{x}/{y}?apikey={apikey}',
    tileSize: 512, maxZoom: 19, apiKey: 'mapy', attribution: '© Seznam.cz a.s. and others, © OpenStreetMap contributors', bytesPerPixel: .45, levels: [1, 2.5, 6] },
  { id: 'mapy-aerial', role: 'base', kind: 'xyz', title: 'Mapy.com aerial', url: 'https://api.mapy.com/v1/maptiles/aerial/256/{z}/{x}/{y}?apikey={apikey}',
    tileSize: 256, maxZoom: 19, apiKey: 'mapy', attribution: '© Seznam.cz a.s. and others', bytesPerPixel: .3, levels: [.5, 2, 6] },
  { id: 'geology', role: 'overlay', kind: 'wms', title: 'Geological map 1:50 000', url: 'https://ags.geology.sk/arcgis/services/WebServices/GM50/MapServer/WMSServer',
    layers: '0,1,2', discover: true, format: 'image/png', transparent: true, attribution: '© ŠGÚDŠ', bytesPerPixel: .25 },
];

/** WMS 1.1.1 GetMap (x,y axis order for SRS, whatever the CRS definition says). */
export function getMapUrl(service: WmsService, layers: string, bbox: Extent, width: number, height: number) {
  const params = new URLSearchParams({
    SERVICE: 'WMS', VERSION: '1.1.1', REQUEST: 'GetMap', LAYERS: layers, STYLES: '', SRS: 'EPSG:5514',
    BBOX: bbox.map(v => v.toFixed(2)).join(','), WIDTH: String(width), HEIGHT: String(height), FORMAT: service.format,
    TRANSPARENT: service.transparent ? 'TRUE' : 'FALSE', BGCOLOR: '0xFFFFFF',
  });
  return `${service.url}?${params}`;
}

/**
 * Names of the layers to draw from a capabilities document: the named layers nearest the
 * root (all of them, bottom first), or the root itself when it is named.
 */
export function capabilityLayers(xml: string) {
  const document = new DOMParser().parseFromString(xml, 'text/xml');
  const root = document.querySelector('Capability > Layer');
  if (!root) return undefined;
  const nameOf = (layer: Element) => Array.from(layer.children).find(child => child.localName === 'Name')?.textContent?.trim();
  if (nameOf(root)) return nameOf(root);
  let level = Array.from(root.children).filter(child => child.localName === 'Layer');
  while (level.length) {
    const names = level.map(nameOf).filter(Boolean) as string[];
    if (names.length) return [...names].reverse().join(',');
    level = level.flatMap(layer => Array.from(layer.children).filter(child => child.localName === 'Layer'));
  }
  return undefined;
}

const discovered = new Map<string, Promise<string>>();
/** Layer names from the service's capabilities, asked once per session. */
function discoverLayers(service: WmsService, signal?: AbortSignal) {
  if (!service.discover) return Promise.resolve(service.layers);
  let found = discovered.get(service.id);
  if (!found) {
    found = fetch(`${service.url}?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetCapabilities`, { signal })
      .then(async response => response.ok ? capabilityLayers(await response.text()) ?? service.layers : service.layers)
      .catch(() => service.layers);
    discovered.set(service.id, found);
  }
  return found;
}

/** At most a few images load at once, so a big download does not swamp the service or the phone. */
const PARALLEL = 6;
let running = 0;
const waiting: (() => void)[] = [];
async function slot<T>(run: () => Promise<T>) {
  if (running >= PARALLEL) await new Promise<void>(resolve => waiting.push(resolve));
  running++;
  try { return await run(); } finally { running--; waiting.shift()?.(); }
}

function loadImage(url: string, signal?: AbortSignal) {
  return slot(() => new Promise<HTMLImageElement>((resolve, reject) => {
    if (signal?.aborted) { reject(new DOMException('Cancelled', 'AbortError')); return; }
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('The map service did not answer, or does not allow its maps in other apps (CORS).'));
    signal?.addEventListener('abort', () => { image.src = ''; reject(new DOMException('Cancelled', 'AbortError')); });
    image.src = url;
  }));
}

/** WMS requests of at most 1024 px, so services with small size limits still answer. */
const WMS_TILE = 1024;

/** A WMS map for an extent at the given pixel size, assembled on one canvas (north up). */
export async function fetchWms(service: WmsService, extent: Extent, width: number, height: number, signal?: AbortSignal) {
  const [minX, minY, maxX, maxY] = extent, scaleX = width / (maxX - minX), scaleY = height / (maxY - minY);
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d')!;
  if (!service.transparent) { context.fillStyle = '#ffffff'; context.fillRect(0, 0, width, height); }
  const layers = await discoverLayers(service, signal);
  const jobs: Promise<void>[] = [];
  for (let y0 = 0; y0 < height; y0 += WMS_TILE) for (let x0 = 0; x0 < width; x0 += WMS_TILE) {
    const w = Math.min(WMS_TILE, width - x0), h = Math.min(WMS_TILE, height - y0);
    // Canvas rows run from the north edge down.
    const bbox: Extent = [minX + x0 / scaleX, maxY - (y0 + h) / scaleY, minX + (x0 + w) / scaleX, maxY - y0 / scaleY];
    jobs.push(loadImage(getMapUrl(service, layers, bbox, w, h), signal).then(image => context.drawImage(image, x0, y0, w, h)));
  }
  await Promise.all(jobs);
  return canvas;
}

const EARTH = 6378137;
/** Web Mercator pixel position (at zoom z, tiles of `tile` px) of a WGS 84 point. */
export function mercatorPixel(latitude: number, longitude: number, zoom: number, tile: number): [number, number] {
  const size = tile * 2 ** zoom, phi = latitude * Math.PI / 180;
  return [(longitude + 180) / 360 * size, (1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2 * size];
}
/** The lowest zoom whose tiles are at least as sharp as `metresPerPixel` at this latitude. */
export function zoomFor(metresPerPixel: number, latitude: number, tile: number, maxZoom: number) {
  const ground = 2 * Math.PI * EARTH * Math.cos(latitude * Math.PI / 180) / tile;
  return Math.max(1, Math.min(maxZoom, Math.ceil(Math.log2(ground / metresPerPixel) - .05)));
}

/** Tiles fetched in this session, shared by neighbouring pieces. */
const tileCache = new Map<string, Promise<HTMLImageElement | undefined>>();

/**
 * An XYZ (Web Mercator) map for an S-JTSK extent: the tiles covering it are fetched and
 * every output pixel is taken from where its S-JTSK position falls on them. Positions are
 * converted exactly on a coarse grid and interpolated in between (well under a pixel).
 */
export async function fetchXyz(service: XyzService, extent: Extent, width: number, height: number, signal?: AbortSignal, apiKey = '') {
  const [minX, minY, maxX, maxY] = extent;
  const [centreLat] = sjtskToWgs84((minX + maxX) / 2, (minY + maxY) / 2);
  const zoom = zoomFor((maxX - minX) / width, centreLat, service.tileSize, service.maxZoom);
  const STEP = 32, columns = Math.ceil(width / STEP) + 1, rows = Math.ceil(height / STEP) + 1;
  const grid = new Float64Array(columns * rows * 2);
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (let r = 0; r < rows; r++) for (let c = 0; c < columns; c++) {
    const px = Math.min(c * STEP, width), py = Math.min(r * STEP, height);
    const [lat, lon] = sjtskToWgs84(minX + px / width * (maxX - minX), maxY - py / height * (maxY - minY));
    const [mx, my] = mercatorPixel(lat, lon, zoom, service.tileSize);
    grid[(r * columns + c) * 2] = mx; grid[(r * columns + c) * 2 + 1] = my;
    left = Math.min(left, mx); right = Math.max(right, mx); top = Math.min(top, my); bottom = Math.max(bottom, my);
  }
  const t = service.tileSize, tx0 = Math.floor(left / t), ty0 = Math.floor(top / t), tx1 = Math.floor(right / t), ty1 = Math.floor(bottom / t);
  const mosaic = document.createElement('canvas'); mosaic.width = (tx1 - tx0 + 1) * t; mosaic.height = (ty1 - ty0 + 1) * t;
  const context = mosaic.getContext('2d', { willReadFrequently: true })!;
  context.fillStyle = '#ffffff'; context.fillRect(0, 0, mosaic.width, mosaic.height);
  const jobs: Promise<void>[] = [];
  let failed = 0, total = 0;
  for (let ty = ty0; ty <= ty1; ty++) for (let tx = tx0; tx <= tx1; tx++) {
    const url = service.url.replace('{z}', String(zoom)).replace('{x}', String(tx)).replace('{y}', String(ty)).replace('{apikey}', encodeURIComponent(apiKey));
    let tile = tileCache.get(url);
    if (!tile) {
      tile = loadImage(url, signal).catch(error => { if ((error as Error).name === 'AbortError') { tileCache.delete(url); throw error; } return undefined; });
      tileCache.set(url, tile);
    }
    total++;
    jobs.push(tile.then(image => { if (image) context.drawImage(image, (tx - tx0) * t, (ty - ty0) * t); else failed++; }));
  }
  await Promise.all(jobs);
  if (failed === total) throw new Error(await whyTileFailed(service.url.replace('{z}', String(zoom)).replace('{x}', String(tx0)).replace('{y}', String(ty0)).replace('{apikey}', encodeURIComponent(apiKey))));
  const source = context.getImageData(0, 0, mosaic.width, mosaic.height).data, sourceWidth = mosaic.width, sourceHeight = mosaic.height;
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const output = canvas.getContext('2d')!, image = output.createImageData(width, height), data = image.data;
  const ox = tx0 * t, oy = ty0 * t;
  for (let y = 0; y < height; y++) {
    const r = Math.min(Math.floor(y / STEP), rows - 2), v = (y + .5 - r * STEP) / Math.min(STEP, height - r * STEP);
    for (let x = 0; x < width; x++) {
      const c = Math.min(Math.floor(x / STEP), columns - 2), u = (x + .5 - c * STEP) / Math.min(STEP, width - c * STEP);
      const i00 = (r * columns + c) * 2, i10 = i00 + 2, i01 = i00 + columns * 2, i11 = i01 + 2;
      const sx = (grid[i00] * (1 - u) + grid[i10] * u) * (1 - v) + (grid[i01] * (1 - u) + grid[i11] * u) * v - ox;
      const sy = (grid[i00 + 1] * (1 - u) + grid[i10 + 1] * u) * (1 - v) + (grid[i01 + 1] * (1 - u) + grid[i11 + 1] * u) * v - oy;
      const ix = Math.min(sourceWidth - 1, Math.max(0, Math.floor(sx))), iy = Math.min(sourceHeight - 1, Math.max(0, Math.floor(sy)));
      const from = (iy * sourceWidth + ix) * 4, to = (y * width + x) * 4;
      data[to] = source[from]; data[to + 1] = source[from + 1]; data[to + 2] = source[from + 2]; data[to + 3] = 255;
    }
  }
  output.putImageData(image, 0, 0);
  return canvas;
}

export function fetchMap(service: UnderlayService, extent: Extent, width: number, height: number, signal?: AbortSignal, apiKey?: string) {
  return service.kind === 'wms' ? fetchWms(service, extent, width, height, signal) : fetchXyz(service, extent, width, height, signal, apiKey);
}

/** Tells a service that refuses other sites (no CORS) from one that does not answer, or refuses the key. */
async function whyTileFailed(url: string) {
  console.warn('Map tile failed:', url.replace(/apikey=[^&]+/, 'apikey=…'));
  try {
    const response = await fetch(url, { mode: 'cors' });
    if (response.status === 401 || response.status === 403) return `The map service refused the request (${response.status}); check the API key.`;
    if (!response.ok) return `The map service answered ${response.status}.`;
    return 'The map service sent tiles this browser could not read.';
  } catch {
    try {
      await fetch(url, { mode: 'no-cors' });
      return 'The map service answers, but does not allow its maps in other apps (no CORS header), so they cannot be draped on the model.';
    } catch { return 'The map service did not answer (offline, or blocked).'; }
  }
}

/** Horizontal gap between two extents (0 when they touch or overlap). */
export function extentGap(a: Extent, b: Extent) {
  return Math.hypot(Math.max(0, a[0] - b[2], b[0] - a[2]), Math.max(0, a[1] - b[3], b[1] - a[3]));
}

export type PieceRequest = { key: string; extent: Extent; width: number; height: number };
/** Within this distance of the cave the sharpest level is used, within the second the middle one. */
export const NEAR = 250, AROUND = 1500;

/**
 * Pixel sizes for the surface pieces: the sharpest level near the cave (its horizontal
 * extent), a middle one around it and a coarse one far away, all made coarser together
 * when the total would exceed the pixel budget; no side longer than `maxSide`.
 */
export function planPieces(pieces: { key: string; extent: Extent }[], focus: Extent | undefined, levels: [number, number, number],
  budget: number, maxSide: number): PieceRequest[] {
  const level = (extent: Extent) => {
    if (!focus) return levels[1];
    const gap = extentGap(extent, focus);
    return gap <= NEAR ? levels[0] : gap <= AROUND ? levels[1] : levels[2];
  };
  const size = (extent: Extent, metres: number) => {
    const w = extent[2] - extent[0], h = extent[3] - extent[1];
    const scale = Math.min(1 / metres, maxSide / Math.max(w, h));
    return { width: Math.max(16, Math.round(w * scale)), height: Math.max(16, Math.round(h * scale)) };
  };
  const base = pieces.map(piece => level(piece.extent));
  let factor = 1;
  for (let i = 0; i < 20; i++) {
    const total = pieces.reduce((sum, piece, j) => { const s = size(piece.extent, base[j] * factor); return sum + s.width * s.height; }, 0);
    if (total <= budget) break;
    factor *= Math.sqrt(total / budget) * 1.01;
  }
  return pieces.map((piece, j) => ({ key: piece.key, extent: piece.extent, ...size(piece.extent, base[j] * factor) }));
}

/** Expected download for pieces of a service, in bytes. */
export function downloadEstimate(service: UnderlayService, pieces: Pick<PieceRequest, 'width' | 'height'>[]) {
  return pieces.reduce((sum, piece) => sum + piece.width * piece.height, 0) * service.bytesPerPixel;
}
