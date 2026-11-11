/** Only existing loch.js controls are interpreted; other XML attributes stay untouched. */
const checks: Record<string, string> = {
  'scene-vis-centerline': 'lines', 'scene-vis-walls': 'walls', 'scene-vis-surface': 'surface', 'scene-vis-bbox': 'bounding-box', 'scene-vis-indicators': 'indicators',
  'scene-vis-centerline-cave': 'centreline-underground', 'scene-vis-centerline-surface': 'centreline-surface', 'scene-vis-centerline-splay': 'centreline-splay',
  'scene-vis-centerline-duplicate': 'centreline-duplicate', 'scene-vis-centerline-station': 'station-all', 'scene-vis-centerline-entrance': 'station-entrance',
  'scene-vis-centerline-fix': 'station-fixed', 'scene-surface-transparency': 'surface-transparency', 'scene-surface-texture': 'surface-image-overlay',
  'scene-walls-transparency': 'walls-transparency',
};
export const presentationControlIds = [...Object.values(checks), 'surface-opacity', 'walls-opacity', 'station-label', 'centreline-color'];
const truth = (value: string) => value === 'true' || value === '1';
/**
 * A setting of this app beyond Loch's (map layers, SHP layers, field objects), kept with each view
 * as a scene-lochjs-<key> attribute, which Loch leaves alone. blend draws it part way to the next
 * view's value while the camera travels there.
 */
export type ExtraSceneControl = { key: string; capture(): string; apply(value: string): void; blend?(from: string, to: string, t: number): void };
const extras: ExtraSceneControl[] = [];
export function registerSceneControl(control: ExtraSceneControl) {
  const at = extras.findIndex(item => item.key === control.key);
  if (at >= 0) extras[at] = control; else extras.push(control);
}
const extraKey = (control: ExtraSceneControl) => `scene-lochjs-${control.key}`;
// Controls this app does not have (wall transparency and opacity) are neither saved nor applied; their XML stays as it was.
export function captureSceneSettings(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, id] of Object.entries(checks)) {
    const control = document.querySelector<HTMLInputElement>(`#${id}`);
    if (control) result[key] = String(control.checked);
  }
  for (const type of ['surface', 'walls']) {
    const control = document.querySelector<HTMLInputElement>(`#${type}-opacity`);
    if (control) result[`scene-${type}-opacity`] = String(Number(control.value) / 100);
  }
  const label = document.querySelector<HTMLSelectElement>('#station-label')!.value;
  result['scene-vis-labels'] = String(label !== 'none');
  result['scene-label-comment'] = String(label === 'comments'); result['scene-label-altitude'] = String(label === 'altitude');
  result['scene-label-name'] = String(['number', 'short', 'full'].includes(label)); result['scene-label-survey'] = String(['short', 'full'].includes(label));
  result['scene-color-mode'] = '1';
  result['scene-color-apply-centerline'] = String(document.querySelector<HTMLSelectElement>('#centreline-color')!.value === 'altitude');
  for (const control of extras) result[extraKey(control)] = control.capture();
  return result;
}
function setControl(id: string, value: string | boolean) {
  const element = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
  if (!element) return;
  const changed = typeof value === 'boolean' ? (element as HTMLInputElement).checked !== value : element.value !== value;
  if (!changed) return;
  if (typeof value === 'boolean') (element as HTMLInputElement).checked = value; else element.value = value;
  element.dispatchEvent(new Event(id.endsWith('-opacity') ? 'input' : 'change', { bubbles: true }));
}
export function applySceneSettings(settings: Record<string, string>) {
  for (const [key, id] of Object.entries(checks)) if (settings[key] !== undefined) setControl(id, truth(settings[key]));
  for (const type of ['surface', 'walls']) {
    const key = `scene-${type}-opacity`, opacity = Number(settings[key]);
    if (settings[key] !== undefined && Number.isFinite(opacity)) setControl(`${type}-opacity`, String(Math.max(0, Math.min(1, opacity)) * 100));
  }
  if (settings['scene-color-apply-centerline'] !== undefined || settings['scene-color-mode'] !== undefined) {
    const mode = settings['scene-color-mode'];
    if (mode === undefined || mode === '0' || mode === '1') setControl('centreline-color', settings['scene-color-apply-centerline'] !== undefined && !truth(settings['scene-color-apply-centerline']) || mode === '0' ? 'default' : 'altitude');
  }
  const modes = ['comment', 'name', 'altitude'].filter(mode => truth(settings[`scene-label-${mode}`] ?? 'false'));
  if (settings['scene-vis-labels'] !== undefined && !truth(settings['scene-vis-labels'])) setControl('station-label', 'none');
  else if (modes.length === 1 && (!truth(settings['scene-label-survey'] ?? '') || modes[0] === 'name')) {
    const label = modes[0] === 'comment' ? 'comments' : modes[0] === 'altitude' ? 'altitude' : truth(settings['scene-label-survey'] ?? '') ? 'full' : 'number';
    setControl('station-label', label);
  } else if (modes.length === 0 && settings['scene-label-name'] !== undefined && !truth(settings['scene-label-survey'] ?? '')) setControl('station-label', 'none');
  for (const control of extras) { const value = settings[extraKey(control)]; if (value !== undefined) control.apply(value); }
}
/**
 * While the camera travels from one view to the next (t from 0 to 1): the surface fades from the
 * first view's visibility and opacity to the next one's (transparent while it does), and the extra
 * settings blend; switches change when the camera arrives.
 */
export function blendSceneSettings(from: Record<string, string>, to: Record<string, string>, t: number) {
  if (!(t > 0)) return;
  const shown = (settings: Record<string, string>) => {
    if (settings['scene-vis-surface'] !== undefined && !truth(settings['scene-vis-surface'])) return 0;
    if (!truth(settings['scene-surface-transparency'] ?? 'false')) return 1;
    const opacity = Number(settings['scene-surface-opacity'] ?? 1);
    return Number.isFinite(opacity) ? Math.max(0, Math.min(1, opacity)) : 1;
  };
  const a = shown(from), b = shown(to);
  if (a !== b && from['scene-vis-surface'] !== undefined && to['scene-vis-surface'] !== undefined) {
    const value = a + (b - a) * Math.min(1, t);
    setControl('surface', true); setControl('surface-transparency', value < 1);
    setControl('surface-opacity', String(Math.round(value * 100)));
  }
  for (const control of extras) {
    const key = extraKey(control), first = from[key], next = to[key];
    if (control.blend && first !== undefined && next !== undefined && first !== next) control.blend(first, next, Math.min(1, t));
  }
}
export function snapshotPresentationControls() {
  const values = presentationControlIds.filter(id => document.getElementById(id)).map(id => {
    const element = document.getElementById(id) as HTMLInputElement | HTMLSelectElement;
    return [id, element instanceof HTMLInputElement && element.type === 'checkbox' ? element.checked : element.value] as const;
  });
  const extraValues = extras.map(control => [control, control.capture()] as const);
  return () => { for (const [id, value] of values) setControl(id, value); for (const [control, value] of extraValues) control.apply(value); };
}
