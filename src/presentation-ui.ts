import { LABEL_ICONS, Presentation, type AnimationLabel, type LabelIcon, type LxaCamera } from './presentation';
import type { PositionLabel } from './station-labels';
import { PresentationTimeline, type PresentationPose } from './presentation-timeline';
import { PresentationPlayer } from './presentation-player';
import { applySceneSettings, blendSceneSettings, captureSceneSettings } from './presentation-scene';
import { initializeSaveFile } from './save-image';
import { readPresentationXml } from './presentation-file';

type Host = { capture(): LxaCamera; walker(): boolean; apply(pose: PresentationPose): void; canPlay(): boolean;
  playing(active: boolean): void; error(error: unknown, file?: File): void;
  /** Overall speed (1 = as saved): every duration is divided by it for playing and exporting; the file keeps its own. */
  speed?(): number;
  /** A place picked in the model (S-JTSK), for a label; undefined when cancelled. */
  pick?(): Promise<[number, number, number] | undefined> };
export function initializePresentation(host: Host) {
  let document = Presentation.create(), timeline = new PresentationTimeline([], true), filename = 'presentation.lxa', dirty = false, appliedScene = -1;
  const panel = globalThis.document.querySelector<HTMLDialogElement>('#presentation-panel')!;
  const panelToggle = globalThis.document.querySelector<HTMLButtonElement>('#animation-toggle')!;
  const list = globalThis.document.querySelector<HTMLSelectElement>('#presentation-views')!;
  const loop = globalThis.document.querySelector<HTMLInputElement>('#presentation-loop')!;
  const sceneChanges = globalThis.document.querySelector<HTMLInputElement>('#presentation-scene-changes')!;
  const caption = globalThis.document.querySelector<HTMLInputElement>('#presentation-caption');
  const title = globalThis.document.querySelector<HTMLElement>('#presentation-title')!;
  const summary = globalThis.document.querySelector<HTMLElement>('#presentation-summary')!;
  const checkbox = globalThis.document.querySelector<HTMLInputElement>('#play-presentation')!;
  const play = globalThis.document.querySelector<HTMLButtonElement>('#presentation-play')!;
  const input = globalThis.document.querySelector<HTMLInputElement>('#presentation-file')!;
  const edit = globalThis.document.querySelector<HTMLDialogElement>('#presentation-edit-dialog')!;
  const fields = Object.fromEntries(['name', 'duration', 'rotations', 'rotation-duration', 'walker', 'transition'].map(name =>
    [name, globalThis.document.querySelector<HTMLInputElement>(`#presentation-${name}`)!])) as Record<string, HTMLInputElement>;
  const player = new PresentationPlayer(pose => {
    if (document.sceneChanges && appliedScene !== pose.sceneIndex) { applySceneSettings(timeline.views[pose.sceneIndex].scene); appliedScene = pose.sceneIndex; }
    if (document.sceneChanges && pose.nextIndex !== undefined && pose.nextIndex !== pose.sceneIndex)
      blendSceneSettings(timeline.views[pose.sceneIndex].scene, timeline.views[pose.nextIndex].scene, pose.blend ?? 0);
    host.apply(pose);
    if (list.selectedIndex !== pose.sceneIndex) list.selectedIndex = pose.sceneIndex;
  }, active => { checkbox.checked = active; play.textContent = active ? 'Stop' : 'Play'; host.playing(active); });
  function refresh() {
    const selected = list.selectedIndex >= 0, ready = host.canPlay();
    panelToggle.hidden = !timeline.views.length;
    panelToggle.setAttribute('aria-pressed', String(panel.open));
    panelToggle.setAttribute('aria-expanded', String(panel.open));
    panelToggle.title = panel.open ? 'Hide animation' : 'Show animation';
    panelToggle.setAttribute('aria-label', panelToggle.title);
    play.disabled = checkbox.disabled = !ready || !timeline.views.length;
    for (const id of ['mark', 'update']) globalThis.document.querySelector<HTMLButtonElement>(`#presentation-${id}`)!.disabled = !ready || id === 'update' && !selected;
    for (const id of ['edit', 'delete', 'up', 'down']) globalThis.document.querySelector<HTMLButtonElement>(`#presentation-${id}`)!.disabled = !selected
      || id === 'up' && list.selectedIndex === 0 || id === 'down' && list.selectedIndex === timeline.views.length - 1;
    globalThis.document.querySelector<HTMLButtonElement>('#presentation-save')!.disabled = !timeline.views.length;
    if (labelList) {
      labelAdd!.disabled = !ready || !timeline.views.length || !host.pick;
      labelEdit!.disabled = labelDelete!.disabled = labelList.selectedIndex < 0;
    }
  }
  // Labels pinned to the model, shown between two views.
  const labelList = globalThis.document.querySelector<HTMLSelectElement>('#presentation-labels');
  const labelAdd = globalThis.document.querySelector<HTMLButtonElement>('#label-add');
  const labelEdit = globalThis.document.querySelector<HTMLButtonElement>('#label-edit');
  const labelDelete = globalThis.document.querySelector<HTMLButtonElement>('#label-delete');
  const labelDialog = globalThis.document.querySelector<HTMLDialogElement>('#label-dialog');
  const labelField = (name: string) => globalThis.document.querySelector<HTMLInputElement & HTMLSelectElement>(`#label-${name}`)!;
  let labelEditing = -1;
  const viewName = (index: number) => timeline.views[index]?.name ?? String(index);
  function rebuildLabels(selected = labelList?.selectedIndex ?? -1) {
    if (!labelList) return;
    const labels = document.labels();
    labelList.replaceChildren(...labels.map((label, index) => {
      const option = globalThis.document.createElement('option'); option.value = String(index);
      option.textContent = `${label.text || '(no text)'} · ${label.from === label.to ? viewName(label.from) : `${viewName(label.from)} – ${viewName(label.to)}`}`;
      return option;
    }));
    labelList.selectedIndex = Math.max(-1, Math.min(selected, labels.length - 1));
  }
  function openLabel(label: AnimationLabel, index: number) {
    if (!labelDialog) return;
    labelEditing = index;
    for (const name of ['from', 'to']) labelField(name).replaceChildren(...timeline.views.map((view, i) => new Option(view.name, String(i))));
    labelField('text').value = label.text; labelField('icon').value = label.icon;
    labelField('from').value = String(label.from); labelField('to').value = String(label.to);
    (['x', 'y', 'z'] as const).forEach((axis, i) => { labelField(axis).value = label.position[i].toFixed(2); });
    labelDialog.showModal();
  }
  labelDialog?.querySelector('form')!.addEventListener('submit', event => {
    event.preventDefault(); if (!(event.currentTarget as HTMLFormElement).reportValidity()) return;
    const from = Number(labelField('from').value), to = Number(labelField('to').value), icon = labelField('icon').value as LabelIcon;
    const label: AnimationLabel = { text: labelField('text').value.trim(), icon: LABEL_ICONS.includes(icon) ? icon : 'peak',
      position: (['x', 'y', 'z'] as const).map(axis => labelField(axis).valueAsNumber) as [number, number, number], from: Math.min(from, to), to: Math.max(from, to) };
    const labels = document.labels();
    if (labelEditing < 0) labels.push(label); else labels[labelEditing] = label;
    document.setLabels(labels); dirty = true; title.textContent = 'Animation *';
    labelDialog.close(); rebuildLabels(labelEditing < 0 ? labels.length - 1 : labelEditing); refresh();
  });
  globalThis.document.querySelector('#label-cancel')?.addEventListener('click', () => labelDialog?.close());
  labelDialog?.addEventListener('keydown', event => { if (event.key !== 'Escape') event.stopPropagation(); });
  labelAdd?.addEventListener('click', () => {
    player.stop();
    const at = Math.max(0, list.selectedIndex);
    void host.pick?.().then(position => { if (position) openLabel({ text: '', icon: 'peak', position, from: at, to: at }, -1); });
  });
  labelEdit?.addEventListener('click', () => { const label = document.labels()[labelList!.selectedIndex]; if (label) openLabel(label, labelList!.selectedIndex); });
  labelDelete?.addEventListener('click', () => {
    const labels = document.labels(); labels.splice(labelList!.selectedIndex, 1);
    document.setLabels(labels); dirty = true; title.textContent = 'Animation *'; rebuildLabels(); refresh();
  });
  labelList?.addEventListener('change', () => refresh());
  labelList?.addEventListener('dblclick', () => labelEdit?.click());
  /**
   * The labels to draw now: at a time of the animation (a film's frame), while it plays at the
   * player's time, and while it is stopped those of the selected view (only with the editor open).
   */
  function labelsAt(seconds?: number): PositionLabel[] {
    const labels = document.labels();
    if (!labels.length || !timeline.views.length) return [];
    const time = seconds ?? (player.playing ? player.time : undefined);
    if (time === undefined) {
      const selected = list.selectedIndex;
      if (!panel.open || selected < 0) return [];
      return labels.filter(label => label.from <= selected && selected <= label.to)
        .map(label => ({ name: label.text, position: [...label.position] as [number, number, number], icon: label.icon, alpha: 1 }));
    }
    return labels.map(label => ({ name: label.text, position: [...label.position] as [number, number, number], icon: label.icon, alpha: timeline.labelAlpha(label, time) }))
      .filter(label => label.alpha > 0);
  }

  function rebuild(selected = list.selectedIndex) {
    const speed = host.speed?.() ?? 1;
    const views = document.views().map(view => speed === 1 ? view : { ...view, duration: view.duration / speed, rotationDuration: view.rotationDuration / speed });
    timeline = new PresentationTimeline(views, document.loop, document.sceneChanges, 15 / speed); appliedScene = -1;
    list.replaceChildren();
    timeline.views.forEach((view, index) => {
      const option = globalThis.document.createElement('option'); option.value = String(index);
      const time = timeline.viewTimes[index]; option.textContent = `${view.name} — ${Math.floor(time / 60)}:${(time % 60).toFixed(1).padStart(4, '0')}`;
      list.append(option);
    });
    list.selectedIndex = Math.max(-1, Math.min(selected, timeline.views.length - 1));
    loop.checked = document.loop; sceneChanges.checked = document.sceneChanges;
    if (caption && globalThis.document.activeElement !== caption) caption.value = document.caption;
    title.textContent = `Animation${dirty ? ' *' : ''}`;
    rebuildLabels();
    summary.textContent = `${timeline.views.length} views · ${timeline.duration.toFixed(2).replace(/\.00$/, '')} seconds${document.loop ? ' · loop' : ''}${speed === 1 ? '' : ` · speed ${speed}×`}`;
    refresh();
  }
  function select() {
    player.stop(); appliedScene = -1;
    const index = list.selectedIndex, view = timeline.views[index]; if (!view || !host.canPlay()) return;
    if (document.sceneChanges) { applySceneSettings(view.scene); appliedScene = index; }
    host.apply({ ...view, center: [...view.center], sceneIndex: index }); refresh();
  }
  function toggle() {
    if (player.playing) player.stop();
    else if (host.canPlay()) { appliedScene = -1; player.start(timeline, Math.max(0, list.selectedIndex)); }
  }
  function mutate(action: () => number | void) {
    player.stop(); const selected = action(); dirty = true; rebuild(typeof selected === 'number' ? selected : list.selectedIndex);
  }
  globalThis.document.querySelector('#animation-editor')!.addEventListener('click', () => { if (!panel.open) panel.show(); refresh(); });
  panelToggle.addEventListener('click', () => { if (panel.open) panel.close(); else panel.show(); refresh(); });
  globalThis.document.querySelector('#presentation-close')!.addEventListener('click', () => panel.close());
  play.addEventListener('click', toggle); checkbox.checked = false; checkbox.addEventListener('change', toggle);
  list.addEventListener('change', select);
  globalThis.document.querySelector('#presentation-mark')!.addEventListener('click', () => mutate(() => document.add(host.capture(), host.walker(), captureSceneSettings(), list.selectedIndex < 0 ? document.count - 1 : list.selectedIndex)));
  globalThis.document.querySelector('#presentation-update')!.addEventListener('click', () => mutate(() => document.update(list.selectedIndex, host.capture(), host.walker(), captureSceneSettings())));
  globalThis.document.querySelector('#presentation-delete')!.addEventListener('click', () => mutate(() => { document.remove(list.selectedIndex); }));
  for (const [id, delta] of [['up', -1], ['down', 1]] as const) globalThis.document.querySelector(`#presentation-${id}`)!.addEventListener('click', () => mutate(() => document.move(list.selectedIndex, delta)));
  globalThis.document.querySelector('#presentation-new')!.addEventListener('click', () => mutate(() => { document = Presentation.create(); filename = 'presentation.lxa'; return -1; }));
  for (const control of [loop, sceneChanges]) control.addEventListener('change', () => mutate(() => { document.loop = loop.checked; document.sceneChanges = sceneChanges.checked; }));
  caption?.addEventListener('input', () => { document.caption = caption.value; dirty = true; title.textContent = 'Animation *'; });
  caption?.addEventListener('keydown', event => event.stopPropagation());
  globalThis.document.querySelector('#presentation-edit')!.addEventListener('click', () => {
    player.stop(); const view = timeline.views[list.selectedIndex]; if (!view) return;
    fields.name.value = view.name; fields.duration.value = String(view.duration); fields.rotations.value = String(view.rotations);
    fields['rotation-duration'].value = String(view.rotationDuration); fields.walker.checked = view.walker; fields.transition.checked = view.transition; edit.showModal();
  });
  edit.querySelector('form')!.addEventListener('submit', event => {
    event.preventDefault(); if (!(event.currentTarget as HTMLFormElement).reportValidity()) return;
    mutate(() => document.edit(list.selectedIndex, { name: fields.name.value, duration: fields.duration.valueAsNumber,
      rotations: fields.rotations.valueAsNumber, rotationDuration: fields['rotation-duration'].valueAsNumber, walker: fields.walker.checked, transition: fields.transition.checked }));
    edit.close(); select();
  });
  globalThis.document.querySelector('#presentation-edit-cancel')!.addEventListener('click', () => edit.close());
  async function loadFile(file: File, xml?: string) {
    player.stop();
    try {
      const source = xml ?? await readPresentationXml(file);
      if (source === undefined) throw new Error('Not a LochPresentation animation XML file.');
      const next = Presentation.parse(source, host.capture());
      document = next; filename = file.name; dirty = false; rebuild(0); select();
      if (!panel.open) panel.show();
    } catch (error) { host.error(error, file); }
  }
  input.addEventListener('change', () => { if (input.files?.[0]) void loadFile(input.files[0]); });
  globalThis.document.querySelector('#presentation-load')!.addEventListener('click', () => { player.stop(); input.value = ''; input.click(); });
  let captured = false, failed = false;
  const save = globalThis.document.querySelector<HTMLButtonElement>('#presentation-save')!;
  save.addEventListener('click', () => { captured = failed = false; });
  initializeSaveFile(save, async () => { captured = true; return new Blob([document.xml()], { type: 'application/xml' }); }, () => filename,
    error => { failed = true; host.error(error); }, () => { if (captured && !failed) dirty = false; rebuild(); }, () => 'lxa');
  globalThis.document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || globalThis.document.querySelector('dialog:modal')) return;
    if (player.playing) { player.stop(); event.preventDefault(); }
    else if (panel.open) { panel.close(); event.preventDefault(); }
  });
  rebuild();
  return { player, loadFile, refresh, toggle, timeline: () => timeline, resetScene() { appliedScene = -1; },
    /** Rebuild the timeline (after a speed change), keeping the selected view. */
    rebuild() { player.stop(); rebuild(); },
    labelsAt,
    /** The film's caption (empty: the model's name). */
    caption: () => document.caption.trim() };
}
