type Visibility = Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'>;

/** Hold a screen wake lock only while animation is enabled and the page is visible. */
export class AnimationWakeLock {
  private active = false;
  private disposed = false;
  private lock?: WakeLockSentinel;
  private requesting = false;
  private revision = 0;

  constructor(private source: Pick<WakeLock, 'request'> | undefined = globalThis.navigator?.wakeLock, private visibility: Visibility = document) {
    visibility.addEventListener('visibilitychange', this.visibilityChanged);
  }

  set enabled(enabled: boolean) {
    if (this.disposed) return;
    this.active = enabled; this.revision++;
    void this.update();
  }

  private visibilityChanged = () => { this.revision++; void this.update(); };

  private async update() {
    if (!this.active || this.visibility.hidden) {
      const lock = this.lock; this.lock = undefined;
      if (lock) await lock.release().catch(() => {});
      return;
    }
    if (!this.source || this.lock || this.requesting) return;
    this.requesting = true;
    const revision = this.revision;
    try {
      const lock = await this.source.request('screen');
      if (!this.active || this.visibility.hidden || this.disposed) {
        await lock.release();
      } else if (!lock.released) {
        this.lock = lock;
        lock.addEventListener('release', () => { if (this.lock === lock) this.lock = undefined; }, { once: true });
      }
    } catch {
      // Unsupported browsers, power-saving policies and denied requests must not interrupt animation.
    } finally {
      this.requesting = false;
      // Visibility or the play/pause state may have changed while a request was pending.
      if (revision !== this.revision) void this.update();
    }
  }

  dispose() {
    this.enabled = false; this.disposed = true;
    this.visibility.removeEventListener('visibilitychange', this.visibilityChanged);
  }
}
