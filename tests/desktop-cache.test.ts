import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const script = readFileSync(new URL('../src-tauri/desktop-cache-reset.js', import.meta.url), 'utf8');

function environment(hostname = 'tauri.localhost', protocol = 'http:') {
  return {
    location: { hostname, protocol, reload: vi.fn() },
    navigator: { serviceWorker: { getRegistrations: vi.fn().mockResolvedValue([]) } },
    caches: { keys: vi.fn().mockResolvedValue(['workbox-precache-old']), delete: vi.fn().mockResolvedValue(true) },
    console: { error: vi.fn() },
  };
}

describe('native desktop cache migration', () => {
  it.each([['tauri.localhost', 'http:'], ['localhost', 'tauri:']])(
    'removes legacy workers and caches before reloading on %s (%s)', async (hostname, protocol) => {
      const env = environment(hostname, protocol);
      const unregister = vi.fn().mockResolvedValue(true);
      env.navigator.serviceWorker.getRegistrations.mockResolvedValue([{ unregister }]);
      env.location.reload.mockImplementation(() => {
        expect(unregister).toHaveBeenCalledOnce();
        expect(env.caches.delete).toHaveBeenCalledWith('workbox-precache-old');
      });
      await runInNewContext(script, env);
      expect(env.location.reload).toHaveBeenCalledOnce();
    },
  );

  it('does not clear caches or reload again after migration', async () => {
    const env = environment();
    await runInNewContext(script, env);
    expect(env.caches.keys).not.toHaveBeenCalled();
    expect(env.location.reload).not.toHaveBeenCalled();
  });

  it('leaves browser and development PWA storage alone', async () => {
    for (const hostname of ['smudrak.github.io', 'localhost']) {
      const env = environment(hostname);
      await runInNewContext(script, env);
      expect(env.navigator.serviceWorker.getRegistrations).not.toHaveBeenCalled();
      expect(env.caches.keys).not.toHaveBeenCalled();
    }
  });

  it('reports cleanup failures without a reload loop', async () => {
    const env = environment();
    env.navigator.serviceWorker.getRegistrations.mockRejectedValue(new Error('Storage unavailable'));
    await runInNewContext(script, env);
    expect(env.console.error).toHaveBeenCalledOnce();
    expect(env.location.reload).not.toHaveBeenCalled();
  });
});
