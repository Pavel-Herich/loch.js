import type { ModelView } from './camera';

type DesktopWindow = { isFullscreen(): Promise<boolean>; setFullscreen(value: boolean): Promise<void> };
type DesktopAPI = { window: { getCurrentWindow(): DesktopWindow } };

export function initializeMenus(onView: (view: ModelView) => void, onError: (error: unknown) => void) {
  const toolbar = document.querySelector<HTMLElement>('#toolbar')!;
  const menus = document.querySelector<HTMLElement>('#menus')!;
  const toggle = document.querySelector<HTMLButtonElement>('#menu-toggle')!;
  const groups = Array.from(menus.querySelectorAll<HTMLDetailsElement>(':scope > details'));
  const fullscreen = document.querySelector<HTMLButtonElement>('#fullscreen')!;
  const desktop = (window as Window & { __TAURI__?: DesktopAPI }).__TAURI__?.window.getCurrentWindow();
  let desktopFullscreen = false;

  function closeDropdowns() {
    menus.querySelectorAll<HTMLDetailsElement>('details').forEach(group => { group.open = false; });
  }

  function close() {
    closeDropdowns();
    if (toolbar.classList.contains('compact')) {
      menus.hidden = true;
      toolbar.classList.add('collapsed');
    }
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', 'Open menu');
  }

  toggle.addEventListener('click', () => {
    if (!menus.hidden) { close(); return; }
    menus.hidden = false;
    toolbar.classList.remove('collapsed');
    toggle.setAttribute('aria-expanded', 'true');
    toggle.setAttribute('aria-label', 'Close menu');
  });
  for (const group of groups) {
    group.addEventListener('toggle', () => {
      if (group.open) for (const other of groups) if (other !== group) other.open = false;
    });
  }
  document.addEventListener('pointerdown', event => {
    if (!toolbar.contains(event.target as Node)) close();
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (groups.some(group => group.open) || (!toggle.hidden && !menus.hidden)) {
      close();
      if (!toggle.hidden) toggle.focus();
    } else if (desktopFullscreen) {
      void setDesktopFullscreen(false).catch(onError);
    }
  });

  const chooser = document.querySelector<HTMLInputElement>('#file')!;
  document.querySelector('#open')!.addEventListener('click', () => {
    closeDropdowns();
    chooser.value = '';
    chooser.click();
  });
  for (const button of Array.from(menus.querySelectorAll<HTMLButtonElement>('[data-view]'))) {
    button.addEventListener('click', () => {
      onView(button.dataset.view as ModelView);
      closeDropdowns();
    });
  }

  async function setDesktopFullscreen(value: boolean) {
    await desktop!.setFullscreen(value);
    desktopFullscreen = value;
    fullscreen.textContent = value ? 'Exit full screen' : 'Full screen';
  }
  fullscreen.disabled = !desktop && !document.fullscreenEnabled;
  fullscreen.addEventListener('click', () => {
    closeDropdowns();
    const change = desktop
      ? desktop.isFullscreen().then(value => setDesktopFullscreen(!value))
      : document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
    void change.catch(onError);
  });
  document.addEventListener('fullscreenchange', () => {
    fullscreen.textContent = document.fullscreenElement ? 'Exit full screen' : 'Full screen';
  });

  return {
    collapse() {
      toolbar.classList.add('compact');
      toggle.hidden = false;
      close();
    },
  };
}
