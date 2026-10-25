import * as THREE from 'three';
import type { PointLayer } from './layers';

export type LayerHighlight = { layerId: string; index: number } | null;

type Options = {
  getLayers: () => PointLayer[];
  removeLayer: (id: string) => Promise<void>;
  heightAt: (east: number, north: number) => number | undefined;
  /** Scene origin in file coordinates when the model is in S-JTSK. */
  getOrigin: () => THREE.Vector3 | undefined;
  /** Bring a scene point to the view centre (and zoom in if far out). */
  focus: (local: THREE.Vector3) => void;
  setHighlight: (highlight: LayerHighlight) => void;
};

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;

/** One entry per shape: points as they are, lines and polygons by their first vertex. */
export function browsablePoints(layer: PointLayer) {
  const indices: number[] = [];
  layer.points.forEach((point, index) => {
    if (point.record === undefined || index === 0 || layer.points[index - 1].record !== point.record) indices.push(index);
  });
  return indices;
}

/** File → SHP files…: pick a layer, step through its points, read their attributes, show one in the model. */
export class LayerBrowser {
  private layerId = '';
  private position = 0;
  private keepHighlight = false;

  constructor(private options: Options) {
    const dialog = $<HTMLDialogElement>('#layers-dialog');
    $<HTMLButtonElement>('#layers-open').addEventListener('click', () => {
      document.querySelectorAll<HTMLDetailsElement>('#menus details').forEach(group => { group.open = false; });
      this.render(); dialog.showModal();
    });
    $<HTMLButtonElement>('#layers-close').addEventListener('click', () => dialog.close());
    // The close event arrives after Show in model has marked its point; keep that mark.
    dialog.addEventListener('close', () => { if (!this.keepHighlight) options.setHighlight(null); this.keepHighlight = false; });
    $<HTMLElement>('#layers-list').addEventListener('click', event => {
      const item = (event.target as HTMLElement).closest<HTMLElement>('li[data-id]');
      if (!item || item.dataset.id === this.layerId) return;
      this.layerId = item.dataset.id!; this.position = 0; this.render();
    });
    $<HTMLSelectElement>('#layer-point').addEventListener('change', event => {
      this.position = Number((event.target as HTMLSelectElement).value); this.render();
    });
    $<HTMLButtonElement>('#layer-prev').addEventListener('click', () => this.step(-1));
    $<HTMLButtonElement>('#layer-next').addEventListener('click', () => this.step(1));
    $<HTMLButtonElement>('#layer-show').addEventListener('click', () => {
      const local = this.localPoint();
      if (!local) return;
      this.keepHighlight = true; dialog.close(); options.focus(local);
      // Keep the shown point marked after the dialog closes, until the next browse.
      options.setHighlight({ layerId: this.layerId, index: this.pointIndex() });
    });
    const remove = $<HTMLButtonElement>('#layer-remove');
    remove.addEventListener('click', () => {
      // Confirm inside the dialog: browser confirm() is unreliable in installed apps.
      if (remove.dataset.armed !== 'true') { remove.dataset.armed = 'true'; remove.textContent = 'Remove?'; return; }
      void options.removeLayer(this.layerId).then(() => { this.layerId = ''; this.render(); });
    });
  }

  private layer() {
    const layers = this.options.getLayers();
    return layers.find(layer => layer.id === this.layerId) ?? layers[0];
  }
  private pointIndex() {
    const layer = this.layer();
    return layer ? browsablePoints(layer)[this.position] ?? 0 : 0;
  }
  private step(step: number) {
    const layer = this.layer();
    if (!layer) return;
    const count = browsablePoints(layer).length;
    this.position = (this.position + step + count) % count; this.render();
  }
  private localPoint() {
    const layer = this.layer(), origin = this.options.getOrigin();
    if (!layer || !origin) return undefined;
    const point = layer.points[this.pointIndex()];
    const z = point.z ?? this.options.heightAt(point.east, point.north) ?? origin.z;
    return new THREE.Vector3(point.east - origin.x, point.north - origin.y, z - origin.z);
  }

  private render() {
    const layers = this.options.getLayers(), layer = this.layer();
    const list = $<HTMLElement>('#layers-list'), pointSelect = $<HTMLSelectElement>('#layer-point');
    const table = $<HTMLElement>('#layer-attributes'), remove = $<HTMLButtonElement>('#layer-remove');
    remove.dataset.armed = 'false'; remove.textContent = 'Remove layer';
    $<HTMLElement>('#layers-empty').hidden = Boolean(layer);
    $<HTMLElement>('#layers-body').hidden = !layer;
    if (!layer) { this.options.setHighlight(null); return; }
    this.layerId = layer.id;
    list.replaceChildren(...layers.map(item => {
      const row = document.createElement('li'), swatch = document.createElement('span'), name = document.createElement('span'), count = document.createElement('span');
      row.dataset.id = item.id; row.setAttribute('role', 'option'); row.setAttribute('aria-selected', String(item.id === layer.id));
      swatch.className = 'layer-swatch'; swatch.style.background = item.color;
      name.textContent = item.name; count.className = 'count'; count.textContent = String(browsablePoints(item).length);
      row.append(swatch, name, count); return row;
    }));
    list.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
    const indices = browsablePoints(layer);
    this.position = Math.min(this.position, indices.length - 1);
    pointSelect.replaceChildren(...indices.map((index, position) => new Option(layer.points[index].label || `#${position + 1}`, String(position), false, position === this.position)));
    $<HTMLElement>('#layers-source').textContent = `${layer.source}`;
    $<HTMLElement>('#layers-swatch').style.background = layer.color;
    const point = layer.points[indices[this.position]];
    const terrain = this.options.heightAt(point.east, point.north);
    const rows: [string, string][] = [
      ['Point', `${this.position + 1} / ${indices.length}`],
      ['x  y', `${Math.round(point.east)}  ${Math.round(point.north)}`],
      ['Terrain height', terrain === undefined ? 'outside the model surface' : `${Math.round(terrain)} m`],
      ...(point.z === null ? [] : [['File Z', `${point.z.toFixed(2)} m`] as [string, string]]),
      ...Object.entries(point.attributes ?? {}).filter(([, value]) => value !== ''),
    ];
    table.replaceChildren(...rows.map(([key, value]) => {
      const row = document.createElement('tr'), th = document.createElement('th'), td = document.createElement('td');
      th.scope = 'row'; th.textContent = key; td.textContent = value;
      row.append(th, td); return row;
    }));
    $<HTMLButtonElement>('#layer-show').disabled = !this.options.getOrigin();
    this.options.setHighlight({ layerId: layer.id, index: indices[this.position] });
  }
}
