import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export const AUTOROTATE_PERIOD_SECONDS = 15;

export class AutoRotation {
  private active = false;
  private interacting = false;
  private previousTime?: number;
  constructor(private controls: OrbitControls) {
    // OrbitControls speed 1 is one turn per 60 seconds.
    controls.autoRotateSpeed = 60 / AUTOROTATE_PERIOD_SECONDS;
    controls.autoRotate = false;
    controls.addEventListener('start', this.startInteraction);
    controls.addEventListener('end', this.endInteraction);
  }
  get enabled() { return this.active; }
  set enabled(enabled: boolean) { this.active = enabled; this.resetTime(); }
  resetTime() { this.previousTime = undefined; }

  update(time: number, suspended = false) {
    const rotating = this.active && !this.interacting && !suspended;
    const seconds = !rotating || this.previousTime === undefined ? 0 : Math.max(0, (time - this.previousTime) / 1000);
    this.previousTime = rotating ? time : undefined;
    const previous = this.controls.autoRotate;
    // Only timed frame updates may add a turn. Fit, Walker and projection changes
    // also call controls.update(), and must not add a frame-dependent rotation.
    this.controls.autoRotate = rotating;
    try { this.controls.update(seconds); }
    finally { this.controls.autoRotate = previous; }
  }
  private startInteraction = () => { this.interacting = true; this.resetTime(); };
  private endInteraction = () => { this.interacting = false; this.resetTime(); };
  dispose() {
    this.enabled = false;
    this.controls.removeEventListener('start', this.startInteraction);
    this.controls.removeEventListener('end', this.endInteraction);
  }
}

export function initializeAutorotateControls(controls: OrbitControls) {
  const rotation = new AutoRotation(controls);
  const checkbox = document.querySelector<HTMLInputElement>('#autorotate')!;
  const button = document.querySelector<HTMLButtonElement>('#autorotate-toggle')!;
  const symbol = document.querySelector<SVGPathElement>('#autorotate-symbol')!;
  function setEnabled(enabled: boolean) {
    rotation.enabled = enabled; checkbox.checked = enabled;
    button.setAttribute('aria-pressed', String(enabled));
    button.title = enabled ? 'Pause autorotation' : 'Start autorotation';
    button.setAttribute('aria-label', button.title);
    symbol.setAttribute('d', enabled ? 'M7 5h4v14H7zm7 0h4v14h-4z' : 'M8 5v14l11-7z');
  }
  checkbox.addEventListener('change', () => setEnabled(checkbox.checked));
  button.addEventListener('click', () => setEnabled(!rotation.enabled));
  document.addEventListener('visibilitychange', () => rotation.resetTime());
  setEnabled(false);
  return rotation;
}
