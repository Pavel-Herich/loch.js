/**
 * Animation labels as map callouts: a ringed anchor on the place, a thin leader up to a rounded
 * card with a coloured badge (the icon in white) and the text. On a light (white) background the
 * card is light with dark text. While a label fades in it also rises a little into place.
 */
export type CardIcon = 'none' | 'peak' | 'entrance' | 'spring' | 'sinkhole' | 'point';

const ACCENT: Record<CardIcon, string> = {
  peak: '#c4573f', entrance: '#3f8f5a', spring: '#2a7fc9', sinkhole: '#8a6640', point: '#c9971c', none: '#5f7d92',
};
const FONT = '600 14px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const HEIGHT = 30, BADGE = 22, PAD = 5, GAP = 7, LEADER = 20, ANCHOR = 4.5, MARGIN = 4;
const MAX_TEXT = 320;

export type CardBox = { left: number; top: number; right: number; bottom: number };

// The cave-entrance glyph of the dock's entrance-label button (24 × 24 units).
const ENTRANCE = 'M3.5 19.5h4.4c0-2-3-3-3-6.4 0-4 3.2-6.6 6.6-6.6 3.6 0 5.7 2.8 5.4 6.2-.3 3-1.9 4.8-3.5 6.3v.5h4.6';
let entrancePath: Path2D | undefined;

/** The icon in white, centred on x, y, inside a badge of BADGE px. */
function glyph(context: CanvasRenderingContext2D, icon: CardIcon, x: number, y: number) {
  context.fillStyle = '#ffffff'; context.strokeStyle = '#ffffff';
  context.lineJoin = 'round'; context.lineCap = 'round';
  context.beginPath();
  if (icon === 'peak') {
    // Two summits, the higher with a snow line.
    context.moveTo(x - 7.5, y + 5); context.lineTo(x - 2.5, y - 2.5); context.lineTo(x - .5, y + .3);
    context.lineTo(x + 2.5, y - 5.5); context.lineTo(x + 7.5, y + 5); context.closePath(); context.fill();
  } else if (icon === 'entrance') {
    if (typeof Path2D !== 'undefined') {
      entrancePath ??= new Path2D(ENTRANCE);
      context.save(); context.translate(x - 7.2, y - 7.6); context.scale(.6, .6);
      context.lineWidth = 3.4; context.stroke(entrancePath); context.restore();
    }
  } else if (icon === 'spring') {
    context.moveTo(x, y - 6.8);
    context.bezierCurveTo(x + 5.4, y - 1, x + 5.2, y + 5.6, x, y + 5.6);
    context.bezierCurveTo(x - 5.2, y + 5.6, x - 5.4, y - 1, x, y - 6.8); context.fill();
  } else if (icon === 'sinkhole') {
    // A funnel seen from above: two rings closing in on a dot.
    context.lineWidth = 1.6; context.arc(x, y, 6, 0, Math.PI * 2); context.stroke();
    context.beginPath(); context.arc(x, y, 3.4, 0, Math.PI * 2); context.stroke();
    context.beginPath(); context.arc(x, y, 1.3, 0, Math.PI * 2); context.fill();
  } else if (icon === 'point') {
    context.arc(x, y, 3.6, 0, Math.PI * 2); context.fill();
  }
}

function roundedRect(context: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  context.beginPath();
  context.moveTo(x + r, y); context.arcTo(x + w, y, x + w, y + h, r); context.arcTo(x + w, y + h, x, y + h, r);
  context.arcTo(x, y + h, x, y, r); context.arcTo(x, y, x + w, y, r); context.closePath();
}

/** Text fitted to MAX_TEXT px with an ellipsis. */
function fitted(context: CanvasRenderingContext2D, text: string) {
  if (context.measureText(text).width <= MAX_TEXT) return text;
  let low = 0, high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (context.measureText(text.slice(0, mid) + '…').width <= MAX_TEXT) low = mid; else high = mid - 1;
  }
  return text.slice(0, low).replace(/[\uD800-\uDBFF]$/, '') + '…';
}

/**
 * Draws one label anchored at x, y (CSS px) on a view of `width` × `height`; returns the box it
 * covers (anchor, leader and card) for decluttering.
 */
export function drawLabelCard(context: CanvasRenderingContext2D, name: string, icon: CardIcon, x: number, y: number,
  width: number, height: number, alpha: number, light: boolean): CardBox {
  const accent = ACCENT[icon] ?? ACCENT.none;
  context.save();
  context.globalAlpha *= Math.max(0, Math.min(1, alpha));
  context.font = FONT; context.textBaseline = 'middle';
  const text = fitted(context, name.replace(/\s+/g, ' ').trim().slice(0, 200));
  const textWidth = context.measureText(text).width;
  const badge = icon !== 'none';
  const cardWidth = Math.ceil((badge ? PAD + BADGE + GAP : 12) + textWidth + 12);
  // Above the place; below it where the top of the view leaves no room. Rising into place as it fades in.
  const rise = (1 - Math.max(0, Math.min(1, alpha))) * 8;
  let top = y - ANCHOR - LEADER - HEIGHT + rise;
  const below = top < MARGIN;
  if (below) top = y + ANCHOR + LEADER - rise;
  const left = Math.max(MARGIN, Math.min(width - cardWidth - MARGIN, x - cardWidth / 2));

  // Leader from the anchor to the card's edge.
  const edge = below ? top : top + HEIGHT;
  context.strokeStyle = light ? 'rgba(19, 33, 44, .75)' : 'rgba(255, 255, 255, .85)'; context.lineWidth = 1.5;
  context.beginPath(); context.moveTo(x, y + (below ? ANCHOR : -ANCHOR)); context.lineTo(Math.max(left + 8, Math.min(left + cardWidth - 8, x)), edge); context.stroke();

  // Anchor: the accent colour ringed in white (dark on white).
  context.beginPath(); context.arc(x, y, ANCHOR, 0, Math.PI * 2);
  context.fillStyle = accent; context.fill();
  context.lineWidth = 2; context.strokeStyle = light ? '#13212c' : '#ffffff'; context.stroke();

  // The card, with a soft shadow.
  context.save();
  context.shadowColor = light ? 'rgba(0, 0, 0, .18)' : 'rgba(0, 0, 0, .45)'; context.shadowBlur = 10; context.shadowOffsetY = 2;
  roundedRect(context, left, top, cardWidth, HEIGHT, HEIGHT / 2);
  context.fillStyle = light ? 'rgba(255, 255, 255, .95)' : 'rgba(13, 22, 31, .84)'; context.fill();
  context.restore();
  roundedRect(context, left + .5, top + .5, cardWidth - 1, HEIGHT - 1, HEIGHT / 2 - .5);
  context.lineWidth = 1; context.strokeStyle = light ? 'rgba(19, 33, 44, .22)' : 'rgba(255, 255, 255, .16)'; context.stroke();

  let textLeft = left + 12;
  if (badge) {
    const cx = left + PAD + BADGE / 2, cy = top + HEIGHT / 2;
    context.beginPath(); context.arc(cx, cy, BADGE / 2, 0, Math.PI * 2); context.fillStyle = accent; context.fill();
    glyph(context, icon, cx, cy);
    textLeft = left + PAD + BADGE + GAP;
  }
  context.fillStyle = light ? '#13212c' : '#ffffff';
  context.font = FONT; context.textBaseline = 'middle';
  context.fillText(text, textLeft, top + HEIGHT / 2 + .5);
  context.restore();
  return { left: Math.min(left, x - ANCHOR), top: Math.min(top, y - ANCHOR), right: Math.max(left + cardWidth, x + ANCHOR), bottom: Math.max(top + HEIGHT, y + ANCHOR) };
}
