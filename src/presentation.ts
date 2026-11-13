export type LxaCamera = { facing: number; tilt: number; center: [number, number, number]; distance: number; focus: number; perspective: boolean };
export type LxaView = LxaCamera & { name: string; duration: number; rotations: number; rotationDuration: number; walker: boolean; transition: boolean; scene: Record<string, string> };
/** A symbol for an animation label (none: the text alone). */
export type LabelIcon = 'none' | 'peak' | 'entrance' | 'spring' | 'sinkhole' | 'point';
export const LABEL_ICONS: LabelIcon[] = ['peak', 'entrance', 'spring', 'sinkhole', 'point', 'none'];
/**
 * A label pinned to a place of the model (S-JTSK, as the views' cameras), shown from the camera's
 * arrival at view `from` until it reaches the view after `to` (indices), fading in and out.
 */
export type AnimationLabel = { text: string; icon: LabelIcon; position: [number, number, number]; from: number; to: number };
export const DEFAULT_LXA_CAMERA: LxaCamera = { facing: 0, tilt: 0, center: [0, 0, 0], distance: 10, focus: 50, perspective: true };
const cameraFields = ['CameraFacing', 'CameraTilt', 'CameraCenterX', 'CameraCenterY', 'CameraCenterZ', 'CameraDistance', 'CameraFocus', 'CameraPerspective'];
const children = (element: Element) => Array.from(element.childNodes).filter((node): node is Element => node.nodeType === 1);
const truth = (value: string | null) => value === 'true' || value === '1';
const positive = (value: string | null, fallback: number) => value !== null && Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
const integer = (value: string | null) => value !== null && value.trim() && Number.isSafeInteger(Number(value)) ? Number(value) : 0;

/** Retain the XML document so unknown attributes/elements survive every edit and save. */
export class Presentation {
  private constructor(readonly document: XMLDocument, private defaults: LxaCamera) {}
  static parse(xml: string, defaults = DEFAULT_LXA_CAMERA) {
    if (xml.length > 5 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Invalid or oversized animation XML');
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    if (doc.documentElement?.tagName !== 'LochPresentation' || doc.getElementsByTagName('parsererror').length) throw new Error('Invalid Loch animation (.lxa) file');
    const result = new Presentation(doc, defaults);
    if (result.elements.length > 10000) throw new Error('Animation has too many views');
    result.views(); // Validate before replacing an existing animation.
    return result;
  }
  static create() { return Presentation.parse('<LochPresentation loop-animation="true" scene-changes="false"/>'); }
  private get root() { return this.document.documentElement; }
  private get elements() { return children(this.root).filter(node => node.tagName === 'Scene'); }
  get count() { return this.elements.length; }
  get loop() { return !['false', '0'].includes(this.root.getAttribute('loop-animation') ?? 'true'); }
  set loop(value: boolean) { this.root.setAttribute('loop-animation', String(value)); }
  get sceneChanges() { return truth(this.root.getAttribute('scene-changes')); }
  set sceneChanges(value: boolean) { this.root.setAttribute('scene-changes', String(value)); }
  /** Text shown at the bottom of the film instead of the model's name (an attribute Loch leaves alone). */
  get caption() { return this.root.getAttribute('caption') ?? ''; }
  set caption(value: string) { if (value.trim()) this.root.setAttribute('caption', value); else this.root.removeAttribute('caption'); }
  /** Labels, kept as LochJsLabel elements (which Loch leaves alone). */
  labels(): AnimationLabel[] {
    const count = this.count;
    return children(this.root).filter(node => node.tagName === 'LochJsLabel').map(node => {
      const index = (name: string) => Math.max(0, Math.min(Math.max(0, count - 1), integer(node.getAttribute(name))));
      const icon = node.getAttribute('icon') as LabelIcon;
      return { text: node.getAttribute('text') ?? '', icon: LABEL_ICONS.includes(icon) ? icon : 'peak',
        position: (['x', 'y', 'z'] as const).map(axis => Number(node.getAttribute(axis)) || 0) as [number, number, number],
        from: Math.min(index('from'), index('to')), to: Math.max(index('from'), index('to')) };
    });
  }
  setLabels(labels: AnimationLabel[]) {
    for (const node of children(this.root).filter(item => item.tagName === 'LochJsLabel')) this.root.removeChild(node);
    for (const label of labels) {
      const node = this.document.createElement('LochJsLabel');
      for (const [name, value] of Object.entries({ text: label.text, icon: label.icon, x: label.position[0].toFixed(3), y: label.position[1].toFixed(3),
        z: label.position[2].toFixed(3), from: label.from, to: label.to })) node.setAttribute(name, String(value));
      this.root.appendChild(node);
    }
  }
  /** Keep labels on the same views when a view is added (+1 from `index` on) or removed (−1 after it). */
  private shiftLabels(index: number, delta: 1 | -1) {
    this.setLabels(this.labels().map(label => {
      const shift = (value: number) => delta > 0 ? (value >= index ? value + 1 : value) : (value > index ? value - 1 : value);
      return { ...label, from: shift(label.from), to: shift(label.to) };
    }));
  }
  views(): LxaView[] {
    let fallback = this.defaults;
    return this.elements.map((element, index) => {
      const text = new Map(children(element).map(child => [child.tagName, child.textContent ?? '']));
      const number = (key: string, initial: number) => {
        const raw = text.get(key); if (raw === undefined) return initial;
        if (!raw.trim() || !Number.isFinite(Number(raw))) throw new Error(`Invalid ${key} in animation view ${index + 1}`);
        return Number(raw);
      };
      const camera: LxaCamera = { facing: number('CameraFacing', fallback.facing), tilt: number('CameraTilt', fallback.tilt),
        center: [number('CameraCenterX', fallback.center[0]), number('CameraCenterY', fallback.center[1]), number('CameraCenterZ', fallback.center[2])],
        distance: number('CameraDistance', fallback.distance), focus: number('CameraFocus', fallback.focus),
        perspective: text.has('CameraPerspective') ? text.get('CameraPerspective') === 'true' : fallback.perspective };
      if (camera.distance <= 0 || camera.tilt < -90 || camera.tilt > 90) throw new Error(`Invalid camera in animation view ${index + 1}`);
      camera.focus = Math.max(20, Math.min(2000, camera.focus)); fallback = camera;
      return { ...camera, name: element.getAttribute('name') || String(index).padStart(4, '0'),
        duration: positive(element.getAttribute('duration'), 3), rotations: integer(element.getAttribute('rotations')),
        rotationDuration: positive(element.getAttribute('rotation-duration'), 15), walker: truth(element.getAttribute('walker-mode')),
        transition: truth(element.getAttribute('transition-view')), scene: Object.fromEntries(Array.from(element.attributes).filter(attr => attr.name.startsWith('scene-')).map(attr => [attr.name, attr.value])) };
    });
  }
  add(camera: LxaCamera, walker: boolean, scene: Record<string, string>, after = this.count - 1) {
    const node = this.document.createElement('Scene'), elements = this.elements;
    this.root.insertBefore(node, after < 0 ? elements[0] ?? null : elements[after]?.nextSibling ?? null);
    const index = this.elements.indexOf(node);
    if (index < this.count - 1) this.shiftLabels(index, 1);
    this.edit(index, { name: String(index).padStart(4, '0'), duration: 3, rotations: 0, rotationDuration: 15, walker, transition: true });
    this.update(index, camera, walker, scene); return index;
  }
  update(index: number, camera: LxaCamera, walker: boolean, scene: Record<string, string>) {
    const node = this.elements[index]; if (!node) return;
    const values = [camera.facing, camera.tilt, ...camera.center, camera.distance, camera.focus, camera.perspective];
    cameraFields.forEach((name, i) => {
      let child = children(node).find(element => element.tagName === name);
      if (!child) { child = this.document.createElement(name); node.appendChild(child); }
      child.textContent = typeof values[i] === 'boolean' ? String(values[i]) : Number(values[i]).toFixed(4);
    });
    node.setAttribute('walker-mode', String(walker));
    const labelModes = ['comment', 'name', 'altitude'].filter(mode => truth(node.getAttribute(`scene-label-${mode}`)));
    const unsupportedLabels = labelModes.length > 1 || truth(node.getAttribute('scene-label-survey')) && (labelModes.length !== 1 || labelModes[0] !== 'name');
    const unsupportedColor = node.hasAttribute('scene-color-mode') && !['0', '1'].includes(node.getAttribute('scene-color-mode')!);
    for (const [name, value] of Object.entries(scene)) {
      if (unsupportedLabels && name.startsWith('scene-label-') || unsupportedColor && name === 'scene-color-mode') continue;
      node.setAttribute(name, value);
    }
  }
  edit(index: number, view: Pick<LxaView, 'name' | 'duration' | 'rotations' | 'rotationDuration' | 'walker' | 'transition'>) {
    const node = this.elements[index]; if (!node) return;
    for (const [name, value] of Object.entries({ name: view.name, duration: view.duration, rotations: view.rotations,
      'rotation-duration': view.rotationDuration, 'walker-mode': view.walker, 'transition-view': view.transition })) node.setAttribute(name, String(value));
  }
  remove(index: number) {
    const node = this.elements[index];
    if (!node) return;
    const labels = this.labels(); node.parentNode?.removeChild(node);
    this.setLabels(labels.map(label => ({ ...label, from: label.from > index ? label.from - 1 : label.from, to: label.to > index || label.to === index && label.to > label.from ? label.to - 1 : label.to }))
      .map(label => ({ ...label, from: Math.max(0, Math.min(label.from, this.count - 1)), to: Math.max(0, Math.min(label.to, this.count - 1)) })));
  }
  move(index: number, delta: -1 | 1) {
    const elements = this.elements, node = elements[index], other = elements[index + delta];
    if (!node || !other) return index;
    // Labels stay with their views.
    const swap = (value: number) => value === index ? index + delta : value === index + delta ? index : value;
    this.setLabels(this.labels().map(label => { const a = swap(label.from), b = swap(label.to); return { ...label, from: Math.min(a, b), to: Math.max(a, b) }; }));
    this.root.insertBefore(node, delta < 0 ? other : other.nextSibling); return index + delta;
  }
  xml() {
    const xml = new XMLSerializer().serializeToString(this.document);
    return /^<\?xml\b/.test(xml) ? xml : `<?xml version="1.0" encoding="UTF-8"?>\n${xml}`;
  }
}
