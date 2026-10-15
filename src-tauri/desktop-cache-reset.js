// Injected by the native app before page scripts, including scripts from a cached page.
(async () => {
  if (location.hostname !== 'tauri.localhost' && location.protocol !== 'tauri:') return;
  if (!('serviceWorker' in navigator)) return;

  const registrations = await navigator.serviceWorker.getRegistrations();
  if (!registrations.length) return;

  await Promise.all(registrations.map(registration => registration.unregister()));
  if ('caches' in globalThis) {
    await Promise.all((await caches.keys()).map(key => caches.delete(key)));
  }
  // A controlled page keeps its worker until navigation, even after unregistering it.
  location.reload();
})().catch(error => console.error('Cannot reset legacy desktop PWA cache:', error));
