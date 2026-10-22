import type { ModelView } from './camera';

type DesktopWindow = { isFullscreen(): Promise<boolean>; setFullscreen(value: boolean): Promise<void> };
type DesktopAPI = { window: { getCurrentWindow(): DesktopWindow } };

export function initializeMenus(onView: (view: ModelView) => void, onError: (error: unknown) => void) {
  const toolbar = document.querySelector<HTMLElement>('#toolbar')!;
  const menus = document.querySelector<HTMLElement>('#menus')!;
  const panel = document.querySelector<HTMLElement>('#menu-panel')!;
  const status = document.querySelector<HTMLElement>('#status')!;
  const toggle = document.querySelector<HTMLButtonElement>('#menu-toggle')!;
  const groups = Array.from(menus.querySelectorAll<HTMLDetailsElement>(':scope > details'));
  const fullscreen = document.querySelector<HTMLButtonElement>('#fullscreen')!;
  const desktop = (window as Window & { __TAURI__?: DesktopAPI }).__TAURI__?.window.getCurrentWindow();
  let desktopFullscreen = false;

  function closeDropdowns() {
    menus.querySelectorAll<HTMLDetailsElement>('details').forEach(group => { group.open = false; });
  }

  /** The menu panel sits above the bottom dock and starts closed. */
  let statusPinned = true;
  function setOpen(open: boolean) {
    panel.hidden = !open;
    // The status line shows with the menu, and on its own while a file loads or reports an error.
    status.hidden = !open && !statusPinned;
    toolbar.classList.toggle('collapsed', !open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  }

  function close() {
    closeDropdowns();
    setOpen(false);
  }

  toggle.addEventListener('click', () => {
    if (!panel.hidden) { close(); return; }
    setOpen(true);
  });
  setOpen(false);
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
    if (groups.some(group => group.open) || !panel.hidden) {
      close();
      toggle.focus();
    } else if (desktopFullscreen) {
      void setDesktopFullscreen(false).catch(onError);
    }
  });

  const chooser = document.querySelector<HTMLInputElement>('#file')!;
  for (const button of [document.querySelector('#open')!, document.querySelector('#open-toggle')!]) button.addEventListener('click', () => {
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
    /** Show the status line (progress or errors) without opening the menu. */
    expand() {
      statusPinned = true; setOpen(!panel.hidden);
    },
    /** Hide the status line again unless the menu is open. */
    collapse() {
      statusPinned = false; setOpen(!panel.hidden);
    },
  };
}
