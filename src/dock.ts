/**
 * Bottom dock shortcuts. Each button drives the matching View/Scene menu
 * control and dispatches its change event, so menu and dock never disagree.
 */

export type LabelCycle = { value: string; badge: string; text: string }[];

/** Entrances: name → altitude → off. */
export const ENTRANCE_LABELS: LabelCycle = [
  { value: 'none', badge: '', text: 'off' },
  { value: 'name', badge: 'N', text: 'names' },
  { value: 'altitude', badge: 'm', text: 'altitudes' },
];

/** Survey stations: number → altitude → survey → off. */
export const STATION_LABELS: LabelCycle = [
  { value: 'none', badge: '', text: 'off' },
  { value: 'number', badge: '#', text: 'numbers' },
  { value: 'altitude', badge: 'm', text: 'altitudes' },
  { value: 'short', badge: 'S', text: 'number@survey' },
];

/** Next step of a cycle; a value set elsewhere (menu) restarts at the first label. */
export function nextLabel(cycle: LabelCycle, current: string) {
  const index = cycle.findIndex(step => step.value === current);
  return cycle[index < 0 ? 1 : (index + 1) % cycle.length];
}

function emit(control: HTMLInputElement | HTMLSelectElement) {
  control.dispatchEvent(new Event('change', { bubbles: true }));
}

function query<T extends Element>(selector: string) {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing ${selector}`);
  return element;
}

function bindToggle(button: HTMLButtonElement, checkbox: HTMLInputElement, describe: (pressed: boolean) => string, invert = false) {
  const sync = () => {
    const pressed = checkbox.checked !== invert;
    button.setAttribute('aria-pressed', String(pressed));
    button.title = describe(pressed); button.setAttribute('aria-label', button.title);
  };
  button.addEventListener('click', () => { checkbox.checked = !checkbox.checked; emit(checkbox); });
  checkbox.addEventListener('change', sync);
  sync();
  return sync;
}

/**
 * `ownsParent`: the label button is the only dock control for its symbols, so
 * its first step shows them and its last step hides them again.
 */
function bindLabels(button: HTMLButtonElement, select: HTMLSelectElement, parent: HTMLInputElement, cycle: LabelCycle, subject: string, ownsParent = false) {
  const badge = button.querySelector<HTMLElement>('.label-badge');
  const sync = () => {
    const step = cycle.find(item => item.value === select.value);
    const text = step?.text ?? select.selectedOptions[0]?.textContent?.toLowerCase() ?? select.value;
    const on = select.value !== 'none' && parent.checked;
    button.classList.toggle('on', on);
    if (badge) badge.textContent = on ? step?.badge ?? '•' : '';
    const next = on || !ownsParent ? nextLabel(cycle, select.value) : cycle[1];
    button.title = `${subject} labels: ${on ? text : 'off'} (click for ${next.text})`;
    button.setAttribute('aria-label', button.title);
  };
  button.addEventListener('click', () => {
    // Labels are useless without their symbols, so the first click also shows them.
    if (!parent.checked) {
      parent.checked = true; emit(parent);
      if (ownsParent || select.value === 'none') { select.value = cycle[1].value; emit(select); }
      return;
    }
    const next = nextLabel(cycle, select.value);
    select.value = next.value; emit(select);
    if (ownsParent && next.value === 'none') { parent.checked = false; emit(parent); }
  });
  select.addEventListener('change', sync); parent.addEventListener('change', sync);
  sync();
}

export function initializeDock() {
  bindToggle(query('#ortho-toggle'), query('#perspective'),
    pressed => pressed ? 'Orthographic view (click for perspective)' : 'Orthographic view', true);
  bindToggle(query('#entrance-toggle'), query('#station-entrance'),
    pressed => pressed ? 'Hide cave entrances' : 'Show cave entrances');
  bindLabels(query('#entrance-label-toggle'), query('#entrance-label'), query('#station-entrance'), ENTRANCE_LABELS, 'Entrance');
  bindLabels(query('#station-label-toggle'), query('#station-label'), query('#station-all'), STATION_LABELS, 'Station', true);
}
