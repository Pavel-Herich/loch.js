import { streamLargeLox } from './large-lox';

let acknowledge: (() => void) | undefined;
function send(message: object, transfer: Transferable[] = []) {
  return new Promise<void>(resolve => {
    acknowledge = resolve;
    self.postMessage(message, { transfer });
  });
}
self.onmessage = async (event: MessageEvent<{ file?: File; acknowledge?: boolean }>) => {
  if (event.data.acknowledge) { acknowledge?.(); acknowledge = undefined; return; }
  if (!event.data.file) return;
  try {
    const model = await streamLargeLox(event.data.file, {
      progress: progress => self.postMessage({ type: 'progress', ...progress }),
      ready: model => send({ type: 'ready', model }),
      surface: surface => send({ type: 'surface', surface }, [surface.heights.buffer, ...(surface.bitmap ? [surface.bitmap.data.buffer] : [])]),
      batch: batch => send({ type: 'batch', batch }, [batch.positions.buffer as ArrayBuffer, ...(batch.indices ? [batch.indices.buffer as ArrayBuffer] : [])]),
    });
    self.postMessage({ type: 'done', model });
  } catch (error) {
    const detail = error as Error & { code?: number };
    self.postMessage({ type: 'error', error: { name: detail.name, message: detail.message, stack: detail.stack, code: detail.code } });
  }
};
