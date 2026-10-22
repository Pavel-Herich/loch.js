import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { AnimationWakeLock } from './screen-wake-lock';

export const AUTOROTATE_PERIOD_SECONDS = 15;
export const AUTOROTATE_DIRECTION_KEY = 'loch.js.autorotate-direction';

export class AutoRotation {
  private active = false;
  private interacting = false;
  private previousTime?: number;
  private startedAt?: number;
  constructor(private controls: OrbitControls, private rotationDirection: 1 | -1 = 1) {
    // OrbitControls speed 1 is one turn per 60 seconds.
    controls.autoRotateSpeed = rotationDirection * 60 / AUTOROTATE_PERIOD_SECONDS;
    controls.autoRotate = false;
    controls.addEventListener('start', this.startInteraction);
    controls.addEventListener('end', this.endInteraction);
  }
  get enabled() { return this.active; }
  set enabled(enabled: boolean) { this.setEnabled(enabled); }
  get direction() { return this.rotationDirection; }
  setEnabled(enabled: boolean, time = performance.now()) {
    if (enabled === this.active) return;
    if (enabled && this.startedAt !== undefined && time >= this.startedAt && time - this.startedAt <= 1000) {
      this.rotationDirection = this.rotationDirection === 1 ? -1 : 1;
      this.controls.autoRotateSpeed = this.rotationDirection * 60 / AUTOROTATE_PERIOD_SECONDS;
    }
    if (enabled) this.startedAt = time;
    this.active = enabled; this.resetTime();
  }
  resetTime() { this.previousTime = undefined; }

  update(time: number, suspended = false) {
    const rotating = this.active && !this.interacting && !suspended;
    const seconds = !rotating || this.previousTime === undefined ? 0 : Math.max(0, (time - this.previousTime) / 1000);
    this.previousTime = rotating ? time : undefined;
    const previous = this.controls.autoRotate;
    // Only timed frame updates may add a turn. Fit and projection changes
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
  let direction: 1 | -1 = 1;
  try { if (localStorage.getItem(AUTOROTATE_DIRECTION_KEY) === '-1') direction = -1; } catch { /* Storage may be disabled. */ }
  const rotation = new AutoRotation(controls, direction);
  const wakeLock = new AnimationWakeLock();
  const checkbox = document.querySelector<HTMLInputElement>('#autorotate')!;
  // The floating play/pause button is optional; the View menu checkbox is always present.
  const button = document.querySelector<HTMLButtonElement>('#autorotate-toggle');
  const symbol = document.querySelector<SVGPathElement>('#autorotate-symbol');
  function setEnabled(enabled: boolean) {
    rotation.enabled = enabled; checkbox.checked = enabled;
    wakeLock.enabled = enabled;
    try { localStorage.setItem(AUTOROTATE_DIRECTION_KEY, String(rotation.direction)); } catch { /* Keep the session preference. */ }
    if (button) {
      button.setAttribute('aria-pressed', String(enabled));
      button.title = enabled ? 'Pause autorotation' : 'Start autorotation';
      button.setAttribute('aria-label', button.title);
    }
    symbol?.setAttribute('d', enabled ? 'M7 5h4v14H7zm7 0h4v14h-4z' : 'M8 5v14l11-7z');
  }
  checkbox.addEventListener('change', () => setEnabled(checkbox.checked));
  button?.addEventListener('click', () => setEnabled(!rotation.enabled));
  document.addEventListener('visibilitychange', () => rotation.resetTime());
  window.addEventListener('pagehide', () => { wakeLock.enabled = false; });
  window.addEventListener('pageshow', () => { wakeLock.enabled = rotation.enabled; });
  setEnabled(false);
  return rotation;
}
