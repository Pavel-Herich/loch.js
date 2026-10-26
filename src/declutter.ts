/**
 * Overlap hiding for object symbols (entrances, field objects, SHP points). While symbols are
 * small (zoomed out, up to 60 % of full size), a symbol that would touch one already drawn
 * this frame is hidden behind it; the next one shows only where it touches none. Larger
 * symbols always draw, and every drawn symbol keeps its place for the ones after it.
 */
export const DECLUTTER_UP_TO = .6;
const CELL = 24;

type Circle = { x: number; y: number; r: number };
let cells = new Map<string, Circle[]>();
let hidden = new WeakSet<object>();

/** Start a frame: nothing drawn, nothing hidden. */
export function resetSymbolSpace() { cells = new Map(); hidden = new WeakSet(); }

function around(x: number, y: number, r: number, visit: (key: string) => boolean | void) {
  for (let cy = Math.floor((y - r) / CELL); cy <= Math.floor((y + r) / CELL); cy++)
    for (let cx = Math.floor((x - r) / CELL); cx <= Math.floor((x + r) / CELL); cx++) if (visit(`${cx},${cy}`)) return true;
  return false;
}

/** May a symbol of this screen radius and size (fraction of full) be drawn here? Draws reserve their place. */
export function claimSymbol(key: object, x: number, y: number, radius: number, size: number) {
  const touches = size <= DECLUTTER_UP_TO && around(x, y, radius * 2, cell => cells.get(cell)?.some(other => Math.hypot(other.x - x, other.y - y) < other.r + radius));
  if (touches) { hidden.add(key); return false; }
  const circle = { x, y, r: radius };
  around(x, y, radius, cell => { const list = cells.get(cell); if (list) list.push(circle); else cells.set(cell, [circle]); });
  return true;
}

/** Was this symbol hidden behind another in the last frame? */
export function symbolHidden(key: object) { return hidden.has(key); }
