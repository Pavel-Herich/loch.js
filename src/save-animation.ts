import { Vector3 } from 'three';
import type { ViewCamera } from './camera';
import { AUTOROTATE_PERIOD_SECONDS } from './autorotate';
import { imageCamera } from './render-image';
import type { AnimationQuality, AnimationSettings, ImageSize } from './image-size';

export const ANIMATION_FPS = 30;
export const ANIMATION_FRAMES = AUTOROTATE_PERIOD_SECONDS * ANIMATION_FPS;

/** Sample a full Z-up orbit without repeating the first frame at the end. */
export function animationCamera(camera: ViewCamera, target: Vector3, size: ImageSize, frame: number, direction: 1 | -1, fps = ANIMATION_FPS) {
  const copy = imageCamera(camera, size);
  const offset = camera.position.clone().sub(target).applyAxisAngle(new Vector3(0, 0, 1), -direction * frame / (AUTOROTATE_PERIOD_SECONDS * fps) * 2 * Math.PI);
  copy.position.copy(target).add(offset); copy.lookAt(target); copy.updateMatrixWorld(); return copy;
}

export function animationBitrate(size: ImageSize, fps: number, quality: AnimationQuality) {
  const factor = quality === 'high' ? 1.5 : quality === 'low' ? .5 : 1;
  return Math.min(20_000_000 * factor, Math.max(2_000_000 * factor, size.width * size.height * fps * .1 * factor));
}

export async function encodeAnimation(size: ImageSize, render: (frame: number) => Promise<HTMLCanvasElement>,
  signal: AbortSignal, progress: (completed: number, total: number) => void, settings: AnimationSettings = { fps: ANIMATION_FPS, quality: 'high' }, frames?: number): Promise<Blob> {
  signal.throwIfAborted();
  const { fps } = settings, frameCount = frames ?? AUTOROTATE_PERIOD_SECONDS * fps;
  if (!Number.isInteger(fps) || fps < 1 || fps > 120 || !['low', 'medium', 'high'].includes(settings.quality)) throw new Error('Choose FPS from 1 to 120 and a supported quality.');
  if (!Number.isSafeInteger(frameCount) || frameCount <= 0) throw new Error('Invalid animation frame count');
  if (typeof VideoEncoder === 'undefined') throw new Error('MP4 encoding is unavailable in this browser. Open loch.js in a current Chrome or Edge browser.');
  const { Output, Mp4OutputFormat, BufferTarget, CanvasSource, Quality, getFirstEncodableVideoCodec } = await import('mediabunny');
  const quality = new Quality({ bitrate: animationBitrate(size, fps, settings.quality) });
  const codec = await getFirstEncodableVideoCodec(['avc', 'vp9', 'av1'], { ...size, quality, frameRate: fps });
  signal.throwIfAborted();
  if (!codec) throw new Error(`MP4 encoding at ${size.width} × ${size.height} is unavailable. Try a smaller resolution or a current Chrome/Edge browser.`);
  const canvas = document.createElement('canvas'); canvas.width = size.width; canvas.height = size.height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Could not create animation canvas');
  const target = new BufferTarget(), output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target });
  const source = new CanvasSource(canvas, { codec, quality, keyFrameInterval: 2 });
  output.addVideoTrack(source, { frameRate: fps });
  try {
    await output.start();
    progress(0, frameCount);
    for (let frame = 0; frame < frameCount; frame++) {
      signal.throwIfAborted();
      const image = await render(frame);
      try {
        signal.throwIfAborted();
        context.drawImage(image, 0, 0);
        await source.add(frame / fps, 1 / fps);
      } finally { image.width = 0; image.height = 0; }
      progress(frame + 1, frameCount);
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    signal.throwIfAborted(); source.close(); await output.finalize(); signal.throwIfAborted();
    if (!target.buffer) throw new Error('MP4 encoding produced no data');
    return new Blob([target.buffer], { type: 'video/mp4' });
  } finally {
    if (output.state !== 'finalized' && output.state !== 'canceled') await output.cancel();
    canvas.width = 0; canvas.height = 0;
  }
}
