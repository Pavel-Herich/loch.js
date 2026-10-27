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
  /**
   * Ground resolution (m/px) near the cave, around it, and far away: the map is draped in
   * pieces of the surface. Without levels it is one image over the whole surface.
   */
  levels?: [number, number, number];
  /** Opacity over the LOX image when first shown (0–1). */
  opacity: number;
};

/** All map layers lie over the LOX image, in this order (later ones on top). */
export const UNDERLAY_SERVICES: UnderlayService[] = [
  // Only the orthophoto mosaic itself: the service's other layers (sheet outlines) would cover it.
  { id: 'ortho', kind: 'wms', title: 'ZBGIS orthophoto', url: 'https://inspirews.skgeodesy.sk/geoserver/oi/ows', layers: 'OI.OrthoimageCoverage',
    format: 'image/jpeg', attribution: '© ÚGKK SR', bytesPerPixel: .3, levels: [.5, 2, 6], opacity: 1, storeAs: 'ortho-mosaic' },
  { id: 'mapy-aerial', kind: 'xyz', title: 'Mapy.com aerial', url: 'https://api.mapy.com/v1/maptiles/aerial/256/{z}/{x}/{y}?apikey={apikey}',
    tileSize: 256, maxZoom: 19, apiKey: 'mapy', attribution: '© Seznam.cz a.s. and others', bytesPerPixel: .3, levels: [.5, 2, 6], opacity: 1 },
  { id: 'freemap', kind: 'xyz', title: 'Freemap outdoor map', url: 'https://outdoor.tiles.freemap.sk/{z}/{x}/{y}@2x', tileSize: 512, maxZoom: 19,
    attribution: '© Freemap Slovakia, © OpenStreetMap contributors', bytesPerPixel: .45, levels: [1, 2.5, 6], opacity: 1 },
  { id: 'mapy-outdoor', kind: 'xyz', title: 'Mapy.com outdoor map', url: 'https://api.mapy.com/v1/maptiles/outdoor/256@2x/{z}/{x}/{y}?apikey={apikey}',
    tileSize: 512, maxZoom: 19, apiKey: 'mapy', attribution: '© Seznam.cz a.s. and others, © OpenStreetMap contributors', bytesPerPixel: .45, levels: [1, 2.5, 6], opacity: 1 },
  { id: 'geology', kind: 'wms', title: 'Geological map 1:50 000', url: 'https://ags.geology.sk/arcgis/services/WebServices/GM50/MapServer/WMSServer',
    layers: '0,1,2', discover: true, format: 'image/png', transparent: true, attribution: '© ŠGÚDŠ', bytesPerPixel: .25, opacity: .5 },
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

const pause = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('Cancelled', 'AbortError')); });
});
/** Did the whole image arrive? A JPEG ends with its EOI marker, a PNG with its IEND chunk. */
export function imageComplete(bytes: Uint8Array, type: string) {
  const n = bytes.length;
  if (type.includes('jpeg') || (bytes[0] === 0xff && bytes[1] === 0xd8)) {
    // Some encoders pad after the end marker; look at the last few bytes.
    for (let i = n - 2; i >= Math.max(0, n - 16); i--) if (bytes[i] === 0xff && bytes[i + 1] === 0xd9) return true;
    return false;
  }
  if (type.includes('png') || bytes[1] === 0x50) return n >= 12 && String.fromCharCode(...bytes.subarray(n - 8, n - 4)) === 'IEND';
  return n > 0;
}
/**
 * One map image, checked to have arrived whole (a cut-off JPEG would otherwise show its
 * missing lower part as an empty band); asked again up to three times.
 */
function loadImage(url: string, signal?: AbortSignal) {
  return slot(async () => {
    let problem = 'The map service did not answer.';
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await pause(500 * attempt, signal);
      let response: Response;
      try { response = await fetch(url, { signal, mode: 'cors' }); }
      catch (error) {
        if ((error as Error).name === 'AbortError') throw error;
        problem = 'The map service did not answer, or does not allow its maps in other apps (CORS).'; continue;
      }
      const type = response.headers.get('content-type') ?? '';
      if (!response.ok || !type.startsWith('image/')) {
        // WMS errors come back as XML with the reason.
        const text = await response.text().catch(() => '');
        const reason = /<ServiceException[^>]*>([\s\S]*?)<\/ServiceException>/.exec(text)?.[1]?.trim();
        console.warn('Map image refused:', url, response.status, reason ?? text.slice(0, 200));
        problem = reason ? `The map service says: ${reason.slice(0, 160)}` : `The map service answered ${response.status}.`;
        if (response.status >= 400 && response.status < 500 && response.status !== 429) break;
        continue;
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!imageComplete(bytes, type)) { console.warn('Map image cut off, asking again:', url); problem = 'The map service sent incomplete images.'; continue; }
      return await createImageBitmap(new Blob([bytes], { type }));
    }
    throw new Error(problem);
  });
}

/** Sizes of `count` equal parts of `total` pixels (the first ones a pixel larger when it does not divide). */
export function split(total: number, most: number) {
  const count = Math.ceil(total / most), base = Math.floor(total / count), extra = total - base * count;
  return Array.from({ length: count }, (_, i) => base + (i < extra ? 1 : 0));
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
  // Equal, nearly square requests (no thin leftover strips).
  let y0 = 0;
  for (const h of split(height, WMS_TILE)) {
    let x0 = 0;
    for (const w of split(width, WMS_TILE)) {
      // Canvas rows run from the north edge down.
      const bbox: Extent = [minX + x0 / scaleX, maxY - (y0 + h) / scaleY, minX + (x0 + w) / scaleX, maxY - y0 / scaleY];
      const x = x0, y = y0;
      jobs.push(loadImage(getMapUrl(service, layers, bbox, w, h), signal).then(image => { context.drawImage(image, x, y, w, h); image.close(); }));
      x0 += w;
    }
    y0 += h;
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
const tileCache = new Map<string, Promise<ImageBitmap | undefined>>();

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
    if (tile) tileCache.delete(url); // Most recently used last.
    else tile = loadImage(url, signal).catch(error => { if ((error as Error).name === 'AbortError') { tileCache.delete(url); throw error; } return undefined; });
    tileCache.set(url, tile);
    // Only recent tiles stay (dropped ones are freed by the browser once drawn).
    while (tileCache.size > 96) tileCache.delete(tileCache.keys().next().value!);
    total++;
    jobs.push(tile.then(image => { if (image) context.drawImage(image, (tx - tx0) * t, (ty - ty0) * t, t, t); else failed++; }));
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
export function planPieces(pieces: { key: string; extent: Extent }[], focus: Extent | ((extent: Extent) => number) | undefined,
  levels: [number, number, number], budget: number, maxSide: number): PieceRequest[] {
  const level = (extent: Extent) => {
    if (!focus) return levels[1];
    const gap = typeof focus === 'function' ? focus(extent) : extentGap(extent, focus);
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

/** Distance from an extent to the nearest of some points (x, y pairs), for planning by the survey stations. */
export function nearestPointGap(points: Float64Array) {
  return (extent: Extent) => {
    let best = Infinity;
    for (let i = 0; i < points.length; i += 2) {
      const dx = Math.max(0, extent[0] - points[i], points[i] - extent[2]), dy = Math.max(0, extent[1] - points[i + 1], points[i + 1] - extent[3]);
      const d = dx * dx + dy * dy;
      if (d < best) { best = d; if (!d) break; }
    }
    return Math.sqrt(best);
  };
}

/** Expected download for pieces of a service, in bytes. */
export function downloadEstimate(service: UnderlayService, pieces: Pick<PieceRequest, 'width' | 'height'>[]) {
  return pieces.reduce((sum, piece) => sum + piece.width * piece.height, 0) * service.bytesPerPixel;
}
