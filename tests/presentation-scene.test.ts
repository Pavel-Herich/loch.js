import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applySceneSettings, blendSceneSettings, captureSceneSettings, presentationControlIds, registerSceneControl, snapshotPresentationControls } from '../src/presentation-scene';

class Control extends EventTarget {
  type = 'checkbox'; checked = true; value = ''; events: string[] = [];
  constructor() { super(); for (const name of ['input', 'change']) this.addEventListener(name, () => this.events.push(name)); }
}
let controls: Record<string, Control>;
beforeEach(() => {
  controls = Object.fromEntries(presentationControlIds.map(id => [id, new Control()]));
  for (const id of ['surface-opacity', 'walls-opacity', 'station-label', 'centreline-color']) controls[id].type = 'select';
  controls['surface-opacity'].value = '50'; controls['station-label'].value = 'comments'; controls['centreline-color'].value = 'altitude';
  controls['walls-transparency'].checked = false; controls['walls-opacity'].value = '50';
  vi.stubGlobal('HTMLInputElement', Control);
  vi.stubGlobal('document', { getElementById: (id: string) => controls[id], querySelector: (selector: string) => controls[selector.slice(1)] });
});
afterEach(() => vi.unstubAllGlobals());

describe('presentation scene settings', () => {
  it('applies existing scene controls and restores their exact prior values after export', () => {
    const restore = snapshotPresentationControls();
    applySceneSettings({ 'scene-vis-walls': 'false', 'scene-vis-centerline-fix': '0', 'scene-surface-opacity': '.25',
      'scene-walls-transparency': 'true', 'scene-walls-opacity': '.3',
      'scene-label-name': 'true', 'scene-label-survey': 'true', 'scene-color-mode': '1', 'scene-color-apply-centerline': 'false' });
    expect(controls.walls.checked).toBe(false); expect(controls['station-fixed'].checked).toBe(false);
    expect(controls['surface-opacity'].value).toBe('25'); expect(controls['surface-opacity'].events).toEqual(['input']);
    expect(controls['station-label'].value).toBe('full'); expect(controls['centreline-color'].value).toBe('default');
    expect(controls['walls-transparency'].checked).toBe(true); expect(controls['walls-opacity'].value).toBe('30');
    expect(controls['walls-opacity'].events).toEqual(['input']);
    expect(captureSceneSettings()['scene-walls-opacity']).toBe('0.3');
    restore();
    expect(controls.walls.checked).toBe(true); expect(controls['station-fixed'].checked).toBe(true);
    expect(controls['surface-opacity'].value).toBe('50'); expect(controls['station-label'].value).toBe('comments');
    expect(controls['centreline-color'].value).toBe('altitude');
    expect(controls['walls-transparency'].checked).toBe(false); expect(controls['walls-opacity'].value).toBe('50');
  });
  it('ignores unsupported settings, label combinations and color modes', () => {
    applySceneSettings({ 'scene-vis-grid': 'true', 'scene-walls-inner-coloring': '.1',
      'scene-surface-lighting': 'false', 'scene-color-mode': '3', 'scene-color-apply-centerline': 'true',
      'scene-label-name': 'true', 'scene-label-comment': 'true', 'scene-vis-labels': 'true' });
    expect(Object.values(controls).flatMap(control => control.events)).toEqual([]);
    applySceneSettings({ 'scene-label-comment': 'true', 'scene-label-survey': 'true' });
    expect(controls['station-label'].events).toEqual([]);
    const captured = captureSceneSettings();
    expect(captured['scene-vis-grid']).toBeUndefined(); expect(captured['scene-walls-inner-coloring']).toBeUndefined();
    expect(captured['scene-label-comment']).toBe('true'); expect(captured['scene-surface-opacity']).toBe('0.5');
  });
  it('hides labels for the master flag, clamps opacity and leaves omitted fields unchanged', () => {
    applySceneSettings({ 'scene-vis-labels': 'false', 'scene-label-name': 'true', 'scene-surface-opacity': '9' });
    expect(controls['station-label'].value).toBe('none'); expect(controls['surface-opacity'].value).toBe('100');
    expect(controls.walls.events).toEqual([]);
    applySceneSettings({ 'scene-surface-opacity': 'invalid' }); expect(controls['surface-opacity'].value).toBe('100');
  });
  it('fades the surface between views and switches when the camera arrives', () => {
    controls.surface.checked = true; controls['surface-transparency'].checked = false; controls['surface-opacity'].value = '50';
    const opaque = { 'scene-vis-surface': 'true', 'scene-surface-transparency': 'false', 'scene-surface-opacity': '0.5' };
    const faint = { 'scene-vis-surface': 'true', 'scene-surface-transparency': 'true', 'scene-surface-opacity': '0.2' };
    const hidden = { 'scene-vis-surface': 'false', 'scene-surface-transparency': 'false', 'scene-surface-opacity': '0.5' };
    blendSceneSettings(opaque, faint, 0);
    expect(controls['surface-transparency'].checked).toBe(false);
    blendSceneSettings(opaque, faint, .5);
    expect(controls['surface-transparency'].checked).toBe(true); expect(controls['surface-opacity'].value).toBe('60');
    blendSceneSettings(faint, hidden, .5);
    expect(controls.surface.checked).toBe(true); expect(controls['surface-opacity'].value).toBe('10');
    applySceneSettings(hidden);
    expect(controls.surface.checked).toBe(false);
  });
  it('keeps, applies, blends and restores settings of this app beyond Loch’s', () => {
    let value = 'a:1', blended = '';
    registerSceneControl({ key: 'test', capture: () => value, apply: next => { value = next; }, blend: (from, to, t) => { blended = `${from}>${to}@${t}`; } });
    expect(captureSceneSettings()['scene-lochjs-test']).toBe('a:1');
    const restore = snapshotPresentationControls();
    applySceneSettings({ 'scene-lochjs-test': 'b:.5' });
    expect(value).toBe('b:.5');
    blendSceneSettings({ 'scene-lochjs-test': 'b:.5' }, { 'scene-lochjs-test': 'c:1' }, .25);
    expect(blended).toBe('b:.5>c:1@0.25');
    restore();
    expect(value).toBe('a:1');
  });
});
