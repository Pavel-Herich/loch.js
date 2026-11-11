let override: number | undefined;
/** Pixel ratio of the overlay canvases: the screen's, or an image export's while one is drawn. */
export function overlayRatio(screen: number) { return override ?? screen; }
/** Set while an image or animation frame draws its overlays at the export's resolution; undefined afterwards. */
export function setOverlayRatio(value?: number) { override = value; }
