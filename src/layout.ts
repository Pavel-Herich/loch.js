/**
 * Computer layout (mouse, wide window): the menu stays open, the dock's icons stack
 * down the left side under the menu, and the scale sits centred at the bottom.
 * Phones and tablets keep the bottom dock.
 */
export const COMPUTER_QUERY = '(hover: hover) and (pointer: fine) and (min-width: 900px) and (min-height: 600px)';

export function isComputerLayout() { return document.body.classList.contains('computer'); }

export function initializeLayout(onChange: (computer: boolean) => void) {
  const query = window.matchMedia?.(COMPUTER_QUERY);
  const dock = document.querySelector<HTMLElement>('#dock')!, home = dock.parentElement!, next = dock.nextSibling;
  const top = document.querySelector<HTMLElement>('#top')!;
  const apply = () => {
    const computer = Boolean(query?.matches);
    document.body.classList.toggle('computer', computer);
    // The same buttons (and their listeners) move between the bottom dock and the left column.
    if (computer && dock.parentElement !== top) top.append(dock);
    else if (!computer && dock.parentElement !== home) home.insertBefore(dock, next);
    onChange(computer);
  };
  query?.addEventListener?.('change', apply);
  apply();
}
