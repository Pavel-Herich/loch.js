import { describe, expect, it, vi } from 'vitest';
import { AnimationWakeLock } from '../src/screen-wake-lock';

class Visibility extends EventTarget {
  hidden = false;
  setHidden(hidden: boolean) { this.hidden = hidden; this.dispatchEvent(new Event('visibilitychange')); }
}
class Lock extends EventTarget {
  released = false;
  release = vi.fn(async () => { this.released = true; this.dispatchEvent(new Event('release')); });
  get sentinel() { return this as unknown as WakeLockSentinel; }
}
function setup() {
  const visibility = new Visibility(), locks: Lock[] = [];
  const request = vi.fn(async () => { const lock = new Lock(); locks.push(lock); return lock.sentinel; });
  const wake = new AnimationWakeLock({ request }, visibility);
  return { visibility, locks, request, wake };
}
function deferred() {
  let resolve!: (lock: WakeLockSentinel) => void, reject!: (error: Error) => void;
  const promise = new Promise<WakeLockSentinel>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe('animation screen wake lock', () => {
  it('starts inactive, requests one screen lock during playback, and releases on pause', async () => {
    const { wake, request, locks } = setup();
    wake.enabled = false; expect(request).not.toHaveBeenCalled();
    wake.enabled = true; wake.enabled = true;
    await vi.waitFor(() => expect(request).toHaveBeenCalledExactlyOnceWith('screen'));
    wake.enabled = false;
    await vi.waitFor(() => expect(locks[0].release).toHaveBeenCalledOnce());
    wake.dispose();
  });

  it('releases when hidden, reacquires on return, and stays released when paused', async () => {
    const { wake, visibility, request, locks } = setup();
    visibility.setHidden(true); wake.enabled = true; expect(request).not.toHaveBeenCalled();
    visibility.setHidden(false); await vi.waitFor(() => expect(locks).toHaveLength(1));
    visibility.setHidden(true); await vi.waitFor(() => expect(locks[0].release).toHaveBeenCalledOnce());
    visibility.setHidden(false); await vi.waitFor(() => expect(locks).toHaveLength(2));
    wake.enabled = false; await vi.waitFor(() => expect(locks[1].release).toHaveBeenCalledOnce());
    visibility.setHidden(true); visibility.setHidden(false); expect(request).toHaveBeenCalledTimes(2);
    wake.dispose();
  });

  it.each(['pause', 'dispose'] as const)('releases a late request after %s', async action => {
    const pending = deferred(), lock = new Lock(), visibility = new Visibility();
    const request = vi.fn(() => pending.promise), wake = new AnimationWakeLock({ request }, visibility);
    wake.enabled = true;
    if (action === 'dispose') wake.dispose(); else wake.enabled = false;
    pending.resolve(lock.sentinel);
    await vi.waitFor(() => expect(lock.release).toHaveBeenCalledOnce());
    expect(request).toHaveBeenCalledOnce(); wake.dispose();
  });

  it('keeps a single pending request through rapid start/stop/start', async () => {
    const pending = deferred(), lock = new Lock(), visibility = new Visibility();
    const request = vi.fn(() => pending.promise), wake = new AnimationWakeLock({ request }, visibility);
    wake.enabled = true; wake.enabled = false; wake.enabled = true; pending.resolve(lock.sentinel);
    await Promise.resolve(); await Promise.resolve();
    expect(request).toHaveBeenCalledOnce(); expect(lock.release).not.toHaveBeenCalled();
    wake.dispose(); await vi.waitFor(() => expect(lock.release).toHaveBeenCalledOnce());
  });

  it('retries after returning to the page while an old request is being rejected', async () => {
    const { wake, visibility, request, locks } = setup(), pending = deferred();
    request.mockImplementationOnce(() => pending.promise);
    wake.enabled = true; visibility.setHidden(true); visibility.setHidden(false);
    pending.reject(new Error('Page was hidden'));
    await vi.waitFor(() => expect(locks).toHaveLength(1)); expect(request).toHaveBeenCalledTimes(2);
    wake.dispose();
  });

  it('tolerates denied requests without retry loops and permits a later explicit retry', async () => {
    const { wake, request, locks } = setup(); request.mockRejectedValueOnce(new Error('Power-saving policy'));
    wake.enabled = true; await Promise.resolve(); await Promise.resolve();
    expect(request).toHaveBeenCalledOnce();
    wake.enabled = false; wake.enabled = true;
    await vi.waitFor(() => expect(locks).toHaveLength(1)); wake.dispose();
  });

  it('handles browser-released locks and reacquires when the page becomes visible again', async () => {
    const { wake, request, visibility, locks } = setup();
    wake.enabled = true; await vi.waitFor(() => expect(locks).toHaveLength(1));
    await locks[0].release(); visibility.setHidden(true); visibility.setHidden(false);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    expect(locks[0].release).toHaveBeenCalledOnce(); wake.dispose();
  });

  it('supports browsers without the API and removes its visibility listener on disposal', () => {
    vi.stubGlobal('navigator', {});
    try {
      const visibility = new Visibility(), remove = vi.spyOn(visibility, 'removeEventListener');
      const wake = new AnimationWakeLock(undefined, visibility); wake.enabled = true;
      visibility.setHidden(true); visibility.setHidden(false); wake.dispose();
      expect(remove).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    } finally { vi.unstubAllGlobals(); }
  });
});
