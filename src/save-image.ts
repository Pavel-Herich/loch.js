export function imageFilename(name: string) {
  const stem = name.replace(/\.(lox|3d|plt|lxa|tiff?|zip|th|txt)$/i, '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim().replace(/[. ]+$/, '');
  return `${stem || 'loch'}.png`;
}

/** Freeze computed styles so exported indicators match the current theme and viewport. */
function imageElement(element: Element): Element {
  const copy = element.cloneNode(false) as Element;
  const computed = getComputedStyle(element);
  copy.setAttribute('style', Array.from(computed, name => `${name}:${computed.getPropertyValue(name)};`).join(''));
  for (const child of Array.from(element.childNodes)) copy.append(child instanceof Element ? imageElement(child) : child.cloneNode(true));
  return copy;
}

/**
 * Something drawn over an exported image: an element where it lies in the view, an element placed
 * at a position (CSS px of the overlay; its computed look kept), or plain HTML (a panel, a title).
 */
export type ImageOverlay = HTMLElement | { element: HTMLElement; left: number; top: number } | { html: string };
function overlayNode(overlay: ImageOverlay): Element | undefined {
  if ('html' in overlay) { const wrapper = document.createElement('div'); wrapper.innerHTML = overlay.html; return wrapper.firstElementChild ?? undefined; }
  if (overlay instanceof Element) {
    if (overlay.hidden || getComputedStyle(overlay).display === 'none') return;
    return imageElement(overlay);
  }
  const copy = imageElement(overlay.element) as HTMLElement;
  for (const [name, value] of Object.entries({ position: 'absolute', left: `${overlay.left}px`, top: `${overlay.top}px`, right: 'auto', bottom: 'auto', margin: '0', transform: 'none' })) copy.style.setProperty(name, value);
  return copy;
}

function indicatorImage(overlays: ImageOverlay[], width: number, height: number): Promise<HTMLImageElement> | undefined {
  const nodes = overlays.map(overlayNode).filter((node): node is Element => Boolean(node));
  if (!nodes.length) return;
  const root = document.createElement('div');
  root.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
  root.style.cssText = `position:relative;width:${width}px;height:${height}px;`;
  for (const node of nodes) root.append(node);
  const html = new XMLSerializer().serializeToString(root);
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject width="100%" height="100%">${html}</foreignObject></svg>`;
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not render image indicators'));
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`;
  });
}

/** Call immediately after rendering: WebGL's default drawing buffer is transient. */
export async function composeImage(view: HTMLCanvasElement, labels: HTMLCanvasElement | HTMLCanvasElement[], overlays: ImageOverlay[], size = { width: view.clientWidth, height: view.clientHeight }): Promise<HTMLCanvasElement> {
  const canvas = document.createElement('canvas'); canvas.width = view.width; canvas.height = view.height;
  try {
    if (!canvas.width || !canvas.height || !size.width || !size.height) throw new Error('The view is empty');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not create image canvas');
    // Copy the scene and labels synchronously, before any async work or animation frame.
    context.drawImage(view, 0, 0);
    for (const layer of Array.isArray(labels) ? labels : [labels]) if (!layer.hidden && layer.width && layer.height) context.drawImage(layer, 0, 0, canvas.width, canvas.height);
    const indicators = indicatorImage(overlays, size.width, size.height);
    if (indicators) context.drawImage(await indicators, 0, 0, canvas.width, canvas.height);
    return canvas;
  } catch (error) { canvas.width = 0; canvas.height = 0; throw error; }
}

export async function captureImage(view: HTMLCanvasElement, labels: HTMLCanvasElement | HTMLCanvasElement[], overlays: ImageOverlay[], size = { width: view.clientWidth, height: view.clientHeight }): Promise<Blob> {
  const canvas = await composeImage(view, labels, overlays, size);
  try { return await canvasPng(canvas); }
  finally { canvas.width = 0; canvas.height = 0; }
}
export function canvasPng(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not encode PNG image')), 'image/png'));
}
/** JPEG at a high quality (smaller than PNG for shaded models and terrain). */
export function canvasJpeg(canvas: HTMLCanvasElement, quality = .92) {
  return new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Could not encode JPEG image')), 'image/jpeg', quality));
}
export type SaveFormat = 'png' | 'jpg' | 'mp4' | 'lxa';
const FORMATS: Record<SaveFormat, { description: string; mime: string }> = {
  png: { description: 'PNG image', mime: 'image/png' }, jpg: { description: 'JPEG image', mime: 'image/jpeg' },
  mp4: { description: 'MP4 animation', mime: 'video/mp4' }, lxa: { description: 'Loch animation', mime: 'application/xml' },
};

type ImageFile = { createWritable(): Promise<{ write(blob: Blob): Promise<void>; close(): Promise<void>; abort(): Promise<void> }> };
type SaveWindow = Window & { showSaveFilePicker?: (options: {
  suggestedName: string; types: { description: string; accept: Record<string, string[]> }[];
}) => Promise<ImageFile> };

function downloadImage(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = filename; link.hidden = true; document.body.append(link);
  try { link.click(); }
  finally { link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 60_000); }
}

export function initializeSaveFile(button: HTMLButtonElement, capture: () => Promise<Blob>, name: () => string,
  onError: (error: unknown) => void, onFinished?: () => void, getFormat: () => SaveFormat = () => 'png') {
  let busy = false;
  button.addEventListener('click', () => {
    if (busy || button.disabled) return;
    busy = true; button.disabled = true;
    const format = getFormat(), filename = imageFilename(name()).replace(/\.png$/, `.${format}`);
    const { description, mime } = FORMATS[format];
    void (async () => {
      try {
        // Request the picker synchronously, while click activation is still valid.
        const destination = (window as SaveWindow).showSaveFilePicker?.({ suggestedName: filename,
          types: [{ description, accept: { [mime]: format === 'jpg' ? ['.jpg', '.jpeg'] : [`.${format}`] } }] });
        const file = await destination;
        const blob = await capture();
        if (file) {
          const writable = await file.createWritable();
          try { await writable.write(blob); await writable.close(); }
          catch (error) { await writable.abort().catch(() => {}); throw error; }
        } else downloadImage(blob, filename);
      } catch (error) { if (!(error instanceof DOMException && error.name === 'AbortError')) onError(error); }
      finally { busy = false; onFinished?.(); }
    })();
  });
  return { get busy() { return busy; } };
}

export const initializeSaveImage = initializeSaveFile;
