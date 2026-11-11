import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applySceneSettings, captureSceneSettings, presentationControlIds, snapshotPresentationControls } from '../src/presentation-scene';

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
});
