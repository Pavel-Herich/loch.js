/**
 * Copies a picked map file into the app's private storage on the device (the origin private
 * file system), so it is there at the next start without picking it again. Synchronous file
 * access is only offered to workers (and works in Safari as well as Chrome and Firefox).
 */
self.onmessage = async (event: MessageEvent<{ file: File; name: string }>) => {
  const { file, name } = event.data;
  try {
    const root = await navigator.storage.getDirectory();
    const folder = await root.getDirectoryHandle('maps', { create: true });
    const handle = await folder.getFileHandle(name, { create: true });
    const access = await (handle as FileSystemFileHandle & { createSyncAccessHandle(): Promise<{
      truncate(size: number): void; write(data: Uint8Array, options: { at: number }): number; flush(): void; close(): void;
    }> }).createSyncAccessHandle();
    try {
      access.truncate(0);
      const CHUNK = 8 << 20;
      for (let at = 0; at < file.size; at += CHUNK) {
        const bytes = new Uint8Array(await file.slice(at, at + CHUNK).arrayBuffer());
        let written = 0;
        while (written < bytes.length) written += access.write(bytes.subarray(written), { at: at + written });
        self.postMessage({ type: 'progress', done: Math.min(file.size, at + CHUNK), total: file.size });
      }
      access.flush();
    } finally { access.close(); }
    self.postMessage({ type: 'done' });
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
