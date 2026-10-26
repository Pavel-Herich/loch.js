import * as THREE from 'three';
import { sjtskToWgs84, wgs84ToSJTSK } from './geo';
import { errorMessage } from './location';
import { symbolAlphaAt, symbolSizeAt } from './station-labels';
import { exportTherion, objectName, ObjectStore, removeDiacritics, type FieldObject, type FieldPhoto, type FieldPosition } from './objects';

type Options = {
  store: ObjectStore;
  heightAt: (east: number, north: number) => number | undefined;
  /** File coordinates of the scene origin when the model is in S-JTSK, else undefined. */
  getOrigin: () => THREE.Vector3 | undefined;
  onChange: () => void;
  /** Entrance symbol controls (dock Ω and its label button) also drive field object markers. */
  getSymbols: () => SymbolOptions;
  /** Called after an object is saved, e.g. to make the symbols visible. */
  onSaved?: () => void;
  /** Let the user tap a point in the model; resolves with scene coordinates, or undefined when cancelled. */
  pickPoint: () => Promise<THREE.Vector3 | undefined>;
  geolocation?: Pick<Geolocation, 'watchPosition' | 'clearWatch'>;
};


export type SymbolOptions = { visible: boolean; label: 'none' | 'name' | 'altitude' | string };

const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;

export function formatPosition(position: FieldPosition) {
  const source = { surface: '(terrain)', gps: '(GPS)', model: '(model)' } as const;
  const height = position.height === null ? '' : ` · ${Math.round(position.height)} m ${position.heightSource ? source[position.heightSource] : ''}`;
  const where = position.source === 'model' ? 'Picked in model'
    : `±${position.accuracy < 10 ? position.accuracy.toFixed(1) : Math.round(position.accuracy)} m`;
  return `${where} · x ${Math.round(position.east)}  y ${Math.round(position.north)}${height}`;
}

/** Replace text in a field without diacritics, keeping the caret where the user is typing. */
function stripField(field: HTMLInputElement | HTMLTextAreaElement) {
  const clean = removeDiacritics(field.value);
  if (clean === field.value) return;
  const caret = removeDiacritics(field.value.slice(0, field.selectionStart ?? field.value.length)).length;
  field.value = clean;
  try { field.setSelectionRange(caret, caret); } catch { /* Not focusable right now. */ }
}

const roundOrNull = (value: number | null) => value === null ? null : Math.round(value);

function newId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/** Field objects: record dialog, list with export/delete, and markers drawn over the model. */
export class FieldObjects {
  objects: FieldObject[] = [];
  private watch: number | undefined;
  private position: FieldPosition | null = null;
  private photos: FieldPhoto[] = [];
  private urls: string[] = [];
  private markers = $<HTMLElement>('#object-markers');
  private markersVisible = true;
  private picking = false;
  /** Object being edited, or null while recording a new one. */
  private editing: FieldObject | null = null;
  /** Reopen the list after editing an object opened from it. */
  private returnToList = false;

  constructor(private options: Options) {
    const recorder = $<HTMLDialogElement>('#object-dialog');
    const title = $<HTMLInputElement>('#object-title'), note = $<HTMLTextAreaElement>('#object-note');
    const photoInput = $<HTMLInputElement>('#object-photo');
    $<HTMLButtonElement>('#object-add').addEventListener('click', () => this.openRecorder());
    const viewer = $<HTMLDialogElement>('#photo-viewer');
    $<HTMLButtonElement>('#photo-viewer-close').addEventListener('click', () => viewer.close());
    $<HTMLButtonElement>('#photo-viewer-prev').addEventListener('click', () => this.stepPhoto(-1));
    $<HTMLButtonElement>('#photo-viewer-next').addEventListener('click', () => this.stepPhoto(1));
    viewer.addEventListener('close', () => { URL.revokeObjectURL($<HTMLImageElement>('#photo-viewer-img').src); });
    title.addEventListener('input', () => { stripField(title); this.updatePreview(); });
    note.addEventListener('input', () => stripField(note));
    $<HTMLButtonElement>('#object-pick').addEventListener('click', () => void this.pickInModel());
    $<HTMLButtonElement>('#object-use-gps').addEventListener('click', () => { this.position = null; this.startGps(); });
    photoInput.addEventListener('change', () => {
      for (const file of Array.from(photoInput.files ?? [])) this.photos.push({ name: file.name, type: file.type || 'image/jpeg', blob: file });
      photoInput.value = ''; this.renderPhotos();
    });
    $<HTMLButtonElement>('#object-cancel').addEventListener('click', () => recorder.close());
    $<HTMLButtonElement>('#object-edit').addEventListener('click', () => { this.setViewing(false); title.focus(); });
    recorder.addEventListener('close', () => {
      if (this.picking) return;
      this.stopGps();
      if (this.returnToList) { this.returnToList = false; this.renderList(); $<HTMLDialogElement>('#objects-dialog').showModal(); }
    });
    $<HTMLFormElement>('#object-form').addEventListener('submit', event => {
      event.preventDefault();
      if (!title.value.trim()) { title.focus(); return; }
      void this.save(title.value, note.value).then(() => recorder.close()).catch(error => {
        $<HTMLElement>('#object-error').textContent = error instanceof Error ? error.message : String(error);
      });
    });
    const list = $<HTMLDialogElement>('#objects-dialog');
    $<HTMLButtonElement>('#objects-open').addEventListener('click', () => {
      document.querySelectorAll<HTMLDetailsElement>('#menus details').forEach(group => { group.open = false; });
      this.renderList(); list.showModal();
    });
    $<HTMLButtonElement>('#objects-close').addEventListener('click', () => list.close());
    $<HTMLButtonElement>('#objects-export').addEventListener('click', () => void this.export());
    // Surveyed by starts empty (only a faint "Name" hint); it is typed for each export.
    const team = $<HTMLInputElement>('#objects-team');
    team.value = '';
    team.addEventListener('input', () => stripField(team));
    const visible = $<HTMLInputElement>('#objects-visible');
    visible.checked = true;
    visible.addEventListener('change', () => { this.markersVisible = visible.checked; options.onChange(); });
    void this.reload();
  }

  async reload() {
    try { this.objects = await this.options.store.list(); } catch { this.objects = []; }
    this.renderMarkers(); this.options.onChange();
  }

  /** View an object, e.g. after tapping its marker; Edit makes it editable. */
  open(object: FieldObject) { this.openRecorder(object); }

  /** Read-only view of a saved object: no typing, picking or photo changes until Edit. */
  private setViewing(viewing: boolean) {
    $<HTMLDialogElement>('#object-dialog').classList.toggle('viewing', viewing);
    $<HTMLInputElement>('#object-title').readOnly = viewing;
    $<HTMLTextAreaElement>('#object-note').readOnly = viewing;
    $<HTMLButtonElement>('#object-edit').hidden = !viewing;
    $<HTMLButtonElement>('#object-save').hidden = viewing;
    $<HTMLButtonElement>('#object-cancel').textContent = viewing ? 'Close' : 'Cancel';
  }

  /** New object at the current GPS position, or an existing one to view and edit. */
  private openRecorder(object?: FieldObject) {
    const recorder = $<HTMLDialogElement>('#object-dialog');
    this.editing = object ?? null;
    $<HTMLInputElement>('#object-title').value = object?.title ?? '';
    $<HTMLTextAreaElement>('#object-note').value = object?.note ?? '';
    $<HTMLElement>('#object-error').textContent = '';
    $<HTMLButtonElement>('#object-save').textContent = object ? 'Save changes' : 'Save';
    // A saved object opens for viewing; a new one straight for typing.
    this.setViewing(Boolean(object));
    this.photos = object ? [...object.photos] : []; this.position = object?.position ?? null;
    this.renderPhotos(); this.updatePreview();
    if (object) {
      // Keep the recorded position unless the user picks a new one or switches to GPS.
      this.stopGps();
      $<HTMLElement>('#object-position').textContent = this.position ? formatPosition(this.position) : 'No position';
      $<HTMLButtonElement>('#object-use-gps').hidden = false;
      $<HTMLButtonElement>('#object-pick').disabled = !this.options.getOrigin();
    } else this.startGps();
    recorder.showModal();
    // Viewing: keep the focus (and its ring) off the read-only name.
    if (object) $<HTMLButtonElement>('#object-cancel').focus(); else $<HTMLInputElement>('#object-title').focus();
  }

  private viewerPhotos: FieldPhoto[] = [];
  private viewerIndex = 0;
  /** Full-size photo view with previous/next for objects with several photos. */
  private showPhoto(photos: FieldPhoto[], index: number) {
    this.viewerPhotos = photos; this.viewerIndex = index;
    const viewer = $<HTMLDialogElement>('#photo-viewer');
    this.stepPhoto(0);
    if (!viewer.open) viewer.showModal();
  }
  private stepPhoto(step: number) {
    if (!this.viewerPhotos.length) return;
    this.viewerIndex = (this.viewerIndex + step + this.viewerPhotos.length) % this.viewerPhotos.length;
    const image = $<HTMLImageElement>('#photo-viewer-img'), photo = this.viewerPhotos[this.viewerIndex];
    URL.revokeObjectURL(image.src);
    image.src = URL.createObjectURL(photo.blob); image.alt = photo.name;
    $<HTMLElement>('#photo-viewer-count').textContent = this.viewerPhotos.length > 1 ? `${this.viewerIndex + 1} / ${this.viewerPhotos.length}` : '';
    $<HTMLButtonElement>('#photo-viewer-prev').hidden = $<HTMLButtonElement>('#photo-viewer-next').hidden = this.viewerPhotos.length < 2;
  }

  private startGps() {
    this.stopGps();
    $<HTMLButtonElement>('#object-use-gps').hidden = true;
    $<HTMLButtonElement>('#object-pick').disabled = !this.options.getOrigin();
    $<HTMLButtonElement>('#object-pick').title = this.options.getOrigin() ? 'Tap a point in the model instead of using GPS' : 'Open a model in S-JTSK to pick a point in it';
    const output = $<HTMLElement>('#object-position');
    const geolocation = this.options.geolocation ?? navigator.geolocation;
    if (!geolocation || !window.isSecureContext) { output.textContent = 'No GPS here: open the app over HTTPS. You can still save the note and photos.'; return; }
    output.textContent = 'Waiting for GPS fix…';
    this.watch = geolocation.watchPosition(({ coords }) => {
      const [east, north] = wgs84ToSJTSK(coords.latitude, coords.longitude, coords.altitude ?? 0);
      const terrain = this.options.getOrigin() ? this.options.heightAt(east, north) : undefined;
      this.position = {
        // Positions taken in the app are kept to whole metres.
        latitude: coords.latitude, longitude: coords.longitude, gpsAltitude: coords.altitude, accuracy: coords.accuracy,
        east: Math.round(east), north: Math.round(north), height: roundOrNull(terrain ?? coords.altitude),
        heightSource: terrain !== undefined ? 'surface' : coords.altitude !== null ? 'gps' : null,
        source: 'gps',
      };
      output.textContent = formatPosition(this.position);
    }, error => {
      if (error.code !== 3 || !this.position) output.textContent = `${errorMessage(error)} You can still save the note and photos.`;
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
  }

  /** Hide the form, let the user tap the model, then come back with that point as the position. */
  private async pickInModel() {
    const recorder = $<HTMLDialogElement>('#object-dialog'), origin = this.options.getOrigin();
    if (!origin) return;
    this.picking = true; recorder.close();
    try {
      const local = await this.options.pickPoint();
      if (local) {
        this.stopGps();
        const east = Math.round(local.x + origin.x), north = Math.round(local.y + origin.y), height = Math.round(local.z + origin.z);
        const [latitude, longitude] = sjtskToWgs84(east, north, height);
        this.position = { latitude, longitude, gpsAltitude: null, accuracy: 0, east, north, height, heightSource: 'model', source: 'model' };
        $<HTMLElement>('#object-position').textContent = formatPosition(this.position);
        $<HTMLButtonElement>('#object-use-gps').hidden = false;
      }
    } finally {
      this.picking = false; recorder.showModal();
    }
  }

  private stopGps() {
    if (this.watch !== undefined) (this.options.geolocation ?? navigator.geolocation).clearWatch(this.watch);
    this.watch = undefined;
  }

  private updatePreview() {
    const title = $<HTMLInputElement>('#object-title').value;
    // An edited object keeps its original save time in the name.
    const time = this.editing ? new Date(this.editing.created) : new Date();
    $<HTMLElement>('#object-name-preview').textContent = title.trim() ? objectName(title, time) : 'Name + date and time of saving';
    $<HTMLButtonElement>('#object-save').disabled = !title.trim();
  }

  private renderPhotos() {
    const container = $<HTMLElement>('#object-photos');
    for (const url of this.urls) URL.revokeObjectURL(url);
    this.urls = [];
    container.replaceChildren(...this.photos.map((photo, index) => {
      const figure = document.createElement('figure'), image = document.createElement('img'), remove = document.createElement('button');
      const url = URL.createObjectURL(photo.blob); this.urls.push(url);
      image.src = url; image.alt = photo.name;
      image.addEventListener('click', () => this.showPhoto(this.photos, index));
      remove.type = 'button'; remove.textContent = '×'; remove.setAttribute('aria-label', `Remove ${photo.name}`);
      remove.addEventListener('click', () => { this.photos.splice(index, 1); this.renderPhotos(); });
      figure.append(image, remove);
      return figure;
    }));
  }

  private async save(title: string, note: string) {
    const editing = this.editing;
    const created = editing ? new Date(editing.created) : new Date();
    const object: FieldObject = {
      id: editing?.id ?? newId(), title: title.trim(), name: objectName(title, created), created: created.toISOString(),
      position: this.position, note: note.trim(), photos: this.photos,
    };
    await this.options.store.put(object);
    this.objects = editing ? this.objects.map(other => other.id === object.id ? object : other) : [...this.objects, object];
    this.editing = null;
    this.renderMarkers(); if (!editing) this.options.onSaved?.(); this.options.onChange();
  }

  private renderList() {
    const list = $<HTMLElement>('#objects-list');
    $<HTMLElement>('#objects-count').textContent = String(this.objects.length);
    const positioned = this.objects.filter(object => object.position).length;
    $<HTMLButtonElement>('#objects-export').disabled = !positioned;
    $<HTMLElement>('#objects-skipped').textContent = positioned < this.objects.length
      ? `${this.objects.length - positioned} without a position will be left out of the Therion export.` : '';
    for (const image of Array.from(list.querySelectorAll('img'))) URL.revokeObjectURL(image.src);
    if (!this.objects.length) {
      const empty = document.createElement('p'); empty.className = 'objects-empty';
      empty.textContent = 'No objects yet. Use the + pin button in the bottom bar to record one where you stand.';
      list.replaceChildren(empty); return;
    }
    list.replaceChildren(...[...this.objects].reverse().map(object => {
      const item = document.createElement('li'), text = document.createElement('div');
      if (object.photos[0]) {
        const image = document.createElement('img'); image.src = URL.createObjectURL(object.photos[0].blob); image.alt = `Photo of ${object.name}`;
        image.addEventListener('click', event => { event.stopPropagation(); this.showPhoto(object.photos, 0); });
        item.append(image);
      }
      const name = document.createElement('strong'); name.textContent = object.name;
      const where = document.createElement('span'); where.textContent = object.position ? formatPosition(object.position) : 'No position';
      text.append(name, where);
      if (object.note) { const note = document.createElement('span'); note.className = 'object-note'; note.textContent = object.note; text.append(note); }
      if (object.photos.length > 1) { const more = document.createElement('span'); more.textContent = `${object.photos.length} photos`; text.append(more); }
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Delete';
      remove.addEventListener('click', () => {
        // Confirm inside the list: browser confirm() dialogs are unreliable in installed apps.
        if (remove.dataset.armed !== 'true') { remove.dataset.armed = 'true'; remove.textContent = 'Delete?'; return; }
        void this.options.store.delete(object.id).then(() => {
          this.objects = this.objects.filter(other => other.id !== object.id);
          this.renderList(); this.renderMarkers(); this.options.onChange();
        });
      });
      // Tap an object to view and edit it; the list comes back afterwards.
      const edit = document.createElement('button'); edit.type = 'button'; edit.textContent = 'Open';
      edit.addEventListener('click', () => this.openFromList(object));
      text.addEventListener('click', () => this.openFromList(object));
      const actions = document.createElement('span'); actions.className = 'object-actions'; actions.append(edit, remove);
      item.append(text, actions);
      return item;
    }));
  }

  private openFromList(object: FieldObject) {
    this.returnToList = true;
    $<HTMLDialogElement>('#objects-dialog').close();
    this.openRecorder(object);
  }

  private async export() {
    const button = $<HTMLButtonElement>('#objects-export');
    button.disabled = true; button.textContent = 'Preparing…';
    try {
      const blob = await exportTherion(this.objects, $<HTMLInputElement>('#objects-team').value.trim());
      const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'j_mobil.zip';
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
    } finally { button.textContent = 'Export to Therion'; button.disabled = !this.objects.some(object => object.position); }
  }

  private renderMarkers() {
    this.markers.replaceChildren(...this.objects.filter(object => object.position).map(object => {
      const marker = document.createElement('div'); marker.className = 'object-marker'; marker.dataset.id = object.id;
      const label = document.createElement('span'); label.textContent = object.title;
      marker.title = object.name; marker.append(label);
      return marker;
    }));
  }

  /** Place markers over the model; positions are in S-JTSK, so only georeferenced models show them. */
  updateMarkers(camera: THREE.Camera, width: number, height: number) {
    const origin = this.options.getOrigin();
    const symbols = this.options.getSymbols();
    this.markers.hidden = !origin || !this.markersVisible || !symbols.visible || !this.objects.length;
    if (this.markers.hidden || !origin) return;
    const point = new THREE.Vector3();
    for (const element of Array.from(this.markers.children) as HTMLElement[]) {
      const object = this.objects.find(item => item.id === element.dataset.id);
      const position = object?.position;
      if (!position) { element.hidden = true; continue; }
      const z = this.options.heightAt(position.east, position.north) ?? position.height ?? origin.z;
      point.set(position.east - origin.x, position.north - origin.y, z - origin.z);
      // Same distance scaling as entrance symbols.
      // Depth in front of the camera; perspective w equals it.
      const depth = -point.clone().applyMatrix4(camera.matrixWorldInverse).z;
      element.style.setProperty('--s', symbolSizeAt(depth).toFixed(3));
      point.project(camera);
      // Dimmed or hidden behind the terrain, like the other symbols.
      const alpha = symbolAlphaAt(position.east, position.north, z);
      const visible = alpha > 0 && point.z >= -1 && point.z <= 1 && Math.abs(point.x) <= 1 && Math.abs(point.y) <= 1;
      element.hidden = !visible;
      element.style.opacity = alpha < 1 ? alpha.toFixed(2) : '';
      const label = element.firstElementChild as HTMLElement;
      label.textContent = symbols.label === 'name' ? object!.title : symbols.label === 'altitude' ? `${Math.round(z)} m` : '';
      if (visible) element.style.transform = `translate(${(point.x + 1) / 2 * width}px, ${(1 - point.y) / 2 * height}px)`;
    }
  }
}
