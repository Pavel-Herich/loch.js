import { AnimationWakeLock } from './screen-wake-lock';
import type { PresentationPose, PresentationTimeline } from './presentation-timeline';
export class PresentationPlayer {
  playing = false;
  private previous?: number;
  private seconds = 0;
  private timeline?: PresentationTimeline;
  private wake: AnimationWakeLock;
  constructor(private apply: (pose: PresentationPose) => void, private changed: (playing: boolean) => void, wake = new AnimationWakeLock()) { this.wake = wake; }
  start(timeline: PresentationTimeline, selected = 0) {
    if (!timeline.views.length) return;
    this.timeline = timeline; this.seconds = timeline.viewTimes[selected] ?? 0; this.previous = undefined;
    this.playing = timeline.loop || selected < timeline.views.length - 1 || timeline.views.length === 1;
    this.apply(timeline.sample(this.seconds)); this.wake.enabled = this.playing; this.changed(this.playing);
  }
  stop() { if (!this.playing) return; this.playing = false; this.previous = undefined; this.wake.enabled = false; this.changed(false); }
  resetTime() { this.previous = undefined; }
  update(time: number, suspended: boolean) {
    if (!this.playing || !this.timeline) return;
    if (suspended) { this.previous = undefined; return; }
    if (this.previous !== undefined) this.seconds += Math.max(0, time - this.previous) / 1000;
    this.previous = time; this.apply(this.timeline.sample(this.seconds));
    if (!this.timeline.loop && this.seconds >= this.timeline.duration) this.stop();
  }
}
