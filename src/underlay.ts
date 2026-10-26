/**
 * Map-service underlays for the surface, requested as WMS images in S-JTSK (EPSG:5514) for the
 * surface's extent and assembled from tiles on a canvas. Layer names are read from the
 * service's capabilities when the browser may fetch them; otherwise known names are used.
 * Services must allow use from other sites (CORS) for the image to become a texture.
 */
export type UnderlayService = { id: string; title: string; url: string; layers: string; format: string; attribution: string };

export const UNDERLAY_SERVICES: UnderlayService[] = [
  { id: 'ortho', title: 'ZBGIS orthophoto', url: 'https://inspirews.skgeodesy.sk/geoserver/oi/ows', layers: 'OI.OrthoimageCoverage', format: 'image/jpeg', attribution: '© ÚGKK SR' },
  { id: 'zbgis', title: 'ZBGIS base map', url: 'https://zbgisws.skgeodesy.sk/zbgis_wms_featureinfo/service.svc/get', layers: '0', format: 'image/png', attribution: '© ÚGKK SR' },
  { id: 'geology', title: 'Geological map 1:50 000', url: 'https://ags.geology.sk/arcgis/services/WebServices/GM50/MapServer/WMSServer', layers: '0,1,2', format: 'image/png', attribution: '© ŠGÚDŠ' },
];

/** WMS 1.1.1 GetMap (x,y axis order for SRS, whatever the CRS definition says). */
export function getMapUrl(service: UnderlayService, layers: string, bbox: [number, number, number, number], width: number, height: number) {
  const params = new URLSearchParams({
    SERVICE: 'WMS', VERSION: '1.1.1', REQUEST: 'GetMap', LAYERS: layers, STYLES: '', SRS: 'EPSG:5514',
    BBOX: bbox.map(v => v.toFixed(2)).join(','), WIDTH: String(width), HEIGHT: String(height), FORMAT: service.format,
    TRANSPARENT: 'FALSE', BGCOLOR: '0xFFFFFF',
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

async function discoverLayers(service: UnderlayService, signal?: AbortSignal) {
  try {
    const response = await fetch(`${service.url}?SERVICE=WMS&VERSION=1.1.1&REQUEST=GetCapabilities`, { signal });
    if (!response.ok) return service.layers;
    return capabilityLayers(await response.text()) ?? service.layers;
  } catch { return service.layers; }
}

function loadImage(url: string, signal?: AbortSignal) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('The map service did not answer, or does not allow its maps in other apps (CORS).'));
    signal?.addEventListener('abort', () => { image.src = ''; reject(new DOMException('Cancelled', 'AbortError')); });
    image.src = url;
  });
}

/** Tiles of at most 1024 px, so services with small size limits still answer. */
const TILE = 1024;

/** Fetch the map for an extent, `maxSize` pixels on the longer side, as one canvas. */
export async function fetchUnderlay(service: UnderlayService, extent: [number, number, number, number], maxSize: number,
  onProgress?: (done: number, total: number) => void, signal?: AbortSignal) {
  const [minX, minY, maxX, maxY] = extent, spanX = maxX - minX, spanY = maxY - minY;
  const scale = maxSize / Math.max(spanX, spanY);
  const width = Math.max(1, Math.round(spanX * scale)), height = Math.max(1, Math.round(spanY * scale));
  const columns = Math.ceil(width / TILE), rows = Math.ceil(height / TILE);
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d')!;
  context.fillStyle = '#ffffff'; context.fillRect(0, 0, width, height);
  const layers = await discoverLayers(service, signal);
  let done = 0;
  const jobs: Promise<void>[] = [];
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
    const x0 = column * TILE, y0 = row * TILE, w = Math.min(TILE, width - x0), h = Math.min(TILE, height - y0);
    // Canvas rows run from the north edge down.
    const bbox: [number, number, number, number] = [minX + x0 / scale, maxY - (y0 + h) / scale, minX + (x0 + w) / scale, maxY - y0 / scale];
    jobs.push(loadImage(getMapUrl(service, layers, bbox, w, h), signal).then(image => {
      context.drawImage(image, x0, y0, w, h);
      onProgress?.(++done, columns * rows);
    }));
  }
  await Promise.all(jobs);
  return { canvas, width, height, layers };
}
