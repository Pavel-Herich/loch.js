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
    status.hidden = !open && !statusPinned && !pinned;
    toolbar.classList.toggle('collapsed', !open);
    // The model title shows only with the menu open.
    document.body.classList.toggle('menu-open', open || pinned);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
  }

  // On a computer the menu stays open (unless folded with the Menu button); only its dropdowns close.
  let pinned = false;
  function close() {
    closeDropdowns();
    if (!pinned) setOpen(false);
  }

  toggle.addEventListener('click', () => {
    // On a computer the Menu button folds the menu row away (the tools below move up) and back.
    if (pinned) { closeDropdowns(); setOpen(panel.hidden); return; }
    if (!panel.hidden) { close(); return; }
    setOpen(true);
  });
  setOpen(false);
  /**
   * A dropdown ends above the dock's buttons (and the map credits) where it would reach them, and
   * scrolls instead, so no row hides behind a button. On a computer it is drawn above the dock.
   */
  function fitDropdown(group: HTMLDetailsElement) {
    const items = group.querySelector<HTMLElement>(':scope > .menu-items');
    if (!items || !group.open) return;
    items.style.maxHeight = '';
    const box = items.getBoundingClientRect();
    let bottom = (window.visualViewport?.height ?? window.innerHeight) - 8;
    if (!document.body.classList.contains('computer')) {
      for (const obstacle of Array.from(document.querySelectorAll<HTMLElement>('#dock, #map-attribution'))) {
        const r = obstacle.getBoundingClientRect();
        if (!r.width || !r.height || r.left >= box.right || r.right <= box.left || r.top <= box.top) continue;
        bottom = Math.min(bottom, r.top - 6);
      }
    }
    items.style.maxHeight = `${Math.max(96, Math.floor(bottom - box.top))}px`;
  }
  for (const group of groups) {
    group.addEventListener('toggle', () => {
      if (group.open) for (const other of groups) if (other !== group) other.open = false;
      fitDropdown(group);
    });
  }
  const refit = () => { for (const group of groups) fitDropdown(group); };
  window.addEventListener('resize', refit);
  window.visualViewport?.addEventListener('resize', refit);
  document.addEventListener('pointerdown', event => {
    // The Menu button lives in the top bar, outside the panel: it toggles by itself.
    if (!toolbar.contains(event.target as Node) && !toggle.contains(event.target as Node)) close();
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
  for (const button of [document.querySelector('#open')!]) button.addEventListener('click', () => {
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
    /** Close the menu (its dropdowns only, where the menu stays open). */
    close,
    /** Keep the menu open (computer layout) or let it close again. */
    pin(value: boolean) {
      pinned = value; setOpen(value);
    },
    /** Hide the status line again unless the menu is open. */
    collapse() {
      statusPinned = false; setOpen(!panel.hidden);
    },
  };
}
