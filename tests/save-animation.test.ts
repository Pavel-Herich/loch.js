import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OrthographicCamera, PerspectiveCamera, Vector3 } from 'three';
import { ANIMATION_FPS, ANIMATION_FRAMES, animationBitrate, animationCamera, encodeAnimation } from '../src/save-animation';
const encoder = vi.hoisted(() => ({ codec: vi.fn(), add: vi.fn(), cancel: vi.fn(), finalize: vi.fn(), close: vi.fn(), quality: vi.fn(), track: vi.fn() }));
vi.mock('mediabunny', () => ({
  Quality: class { constructor(options: unknown) { encoder.quality(options); } }, Mp4OutputFormat: class {}, BufferTarget: class { buffer: ArrayBuffer | null = null; },
  CanvasSource: class { add = encoder.add; close = encoder.close; },
  Output: class {
    state = 'pending'; target: { buffer: ArrayBuffer | null };
    constructor(options: { target: { buffer: ArrayBuffer | null } }) { this.target = options.target; }
    addVideoTrack(_source: unknown, options: unknown) { encoder.track(options); }
    async start() { this.state = 'started'; }
    async finalize() { encoder.finalize(); this.state = 'finalized'; this.target.buffer = new ArrayBuffer(16); }
    async cancel() { encoder.cancel(); this.state = 'canceled'; }
  }, getFirstEncodableVideoCodec: encoder.codec,
}));
beforeEach(() => {
  vi.clearAllMocks(); encoder.codec.mockResolvedValue('avc'); encoder.add.mockResolvedValue(undefined);
  vi.stubGlobal('VideoEncoder', class {});
  vi.stubGlobal('document', { createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage: vi.fn() }) }) });
});
afterEach(() => vi.unstubAllGlobals());

describe('360-degree MP4 animation', () => {
  it.each([false, true])('orbits the current pivot around Z while preserving tilt, distance, zoom and live camera (orthographic %s)', ortho => {
    const camera = ortho ? new OrthographicCamera(-4, 4, 3, -3, .01, 1000) : new PerspectiveCamera(45, 4 / 3, .01, 1000);
    camera.up.set(0, 0, 1); camera.position.set(10, 0, 4); camera.zoom = 2;
    const target = new Vector3(1, 2, 3); camera.lookAt(target); camera.updateMatrixWorld();
    const original = camera.position.clone();
    const quarter = animationCamera(camera, target, { width: 640, height: 480 }, ANIMATION_FRAMES / 4, 1);
    expect(quarter.position.distanceTo(new Vector3(-1, -7, 4))).toBeLessThan(1e-9);
    expect(quarter.position.distanceTo(target)).toBeCloseTo(camera.position.distanceTo(target));
    expect(quarter.zoom).toBe(2); expect(camera.position).toEqual(original);
    const center = target.clone().project(quarter); expect(center.x).toBeCloseTo(0); expect(center.y).toBeCloseTo(0);
    const full = animationCamera(camera, target, { width: 640, height: 480 }, ANIMATION_FRAMES, 1);
    expect(full.position.distanceTo(camera.position)).toBeLessThan(1e-9);
    const reverse = animationCamera(camera, target, { width: 640, height: 480 }, ANIMATION_FRAMES / 4, -1);
    expect(reverse.position.distanceTo(new Vector3(3, 11, 4))).toBeLessThan(1e-9);
  });
  // Real timer yields for 450 frames can exceed 5 seconds on Windows CI runners.
  it('encodes exactly 450 sequential frames over 15 seconds and releases each raw frame', async () => {
    const frames: HTMLCanvasElement[] = [];
    const render = vi.fn(async () => { const image = { width: 2, height: 2 } as HTMLCanvasElement; frames.push(image); return image; });
    const progress = vi.fn();
    const blob = await encodeAnimation({ width: 2, height: 2 }, render, new AbortController().signal, progress);
    expect(blob.type).toBe('video/mp4'); expect(blob.size).toBeGreaterThan(0);
    expect(render).toHaveBeenCalledTimes(450); expect(encoder.add).toHaveBeenCalledTimes(450);
    expect(encoder.add.mock.calls[0]).toEqual([0, 1 / ANIMATION_FPS]);
    expect(encoder.add.mock.calls[449]).toEqual([449 / ANIMATION_FPS, 1 / ANIMATION_FPS]);
    expect(progress).toHaveBeenLastCalledWith(450, 450); expect(frames.every(frame => frame.width === 0 && frame.height === 0)).toBe(true);
    expect(encoder.finalize).toHaveBeenCalledTimes(1); expect(encoder.cancel).not.toHaveBeenCalled(); expect(encoder.close).toHaveBeenCalledTimes(1);
  }, 30_000);
  it('applies custom FPS to frame count, timestamps and rotation, and passes the selected encoding quality', async () => {
    const render = vi.fn(async () => ({ width: 2, height: 2 } as HTMLCanvasElement)), progress = vi.fn();
    await encodeAnimation({ width: 2, height: 2 }, render, new AbortController().signal, progress, { fps: 2, quality: 'low' });
    expect(render).toHaveBeenCalledTimes(30); expect(encoder.add.mock.calls[29]).toEqual([14.5, .5]);
    expect(encoder.track).toHaveBeenCalledWith({ frameRate: 2 }); expect(progress).toHaveBeenLastCalledWith(30, 30);
    expect(encoder.quality).toHaveBeenCalledWith({ bitrate: 1_000_000 });
    const camera = new PerspectiveCamera(); camera.up.set(0, 0, 1); camera.position.set(10, 0, 4); camera.lookAt(0, 0, 0);
    const complete = animationCamera(camera, new Vector3(), { width: 640, height: 480 }, 30, 1, 2);
    expect(complete.position.distanceTo(camera.position)).toBeLessThan(1e-9);
  });
  it('offers increasingly higher bitrates for Low, Medium and High quality', () => {
    const size = { width: 1920, height: 1080 };
    const low = animationBitrate(size, 30, 'low'), medium = animationBitrate(size, 30, 'medium'), high = animationBitrate(size, 30, 'high');
    expect(low).toBeLessThan(medium); expect(medium).toBeLessThan(high);
    expect(animationBitrate(size, 60, 'high')).toBeGreaterThan(high);
  });
  it('encodes the presentation frame count instead of a fixed 15-second turn', async () => {
    const render = vi.fn(async (_index: number) => ({ width: 2, height: 2 } as HTMLCanvasElement)), progress = vi.fn();
    await encodeAnimation({ width: 2, height: 2 }, render, new AbortController().signal, progress, { fps: 2, quality: 'high' }, 7);
    expect(render.mock.calls.map(args => args[0])).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(encoder.add.mock.calls[6]).toEqual([3, .5]); expect(progress).toHaveBeenLastCalledWith(7, 7);
    expect(encoder.finalize).toHaveBeenCalledTimes(1);
  });
  it.each([0, 121, 1.5, NaN])('rejects invalid FPS %s before rendering', async fps => {
    const render = vi.fn();
    await expect(encodeAnimation({ width: 2, height: 2 }, render, new AbortController().signal, vi.fn(), { fps, quality: 'high' })).rejects.toThrow('FPS');
    expect(render).not.toHaveBeenCalled();
  });
  it('cancels rendering without finalizing or retaining raw frames', async () => {
    const controller = new AbortController(), frames: HTMLCanvasElement[] = [];
    const render = vi.fn(async index => {
      const frame = { width: 2, height: 2 } as HTMLCanvasElement; frames.push(frame);
      if (index === 2) controller.abort(); return frame;
    });
    await expect(encodeAnimation({ width: 2, height: 2 }, render, controller.signal, vi.fn())).rejects.toMatchObject({ name: 'AbortError' });
    expect(render).toHaveBeenCalledTimes(3); expect(encoder.add).toHaveBeenCalledTimes(2);
    expect(frames.every(frame => frame.width === 0 && frame.height === 0)).toBe(true);
    expect(encoder.cancel).toHaveBeenCalledTimes(1); expect(encoder.finalize).not.toHaveBeenCalled();
  });
  it('releases the encoder and frame when encoding fails', async () => {
    encoder.add.mockRejectedValueOnce(new Error('Encoder failed'));
    const frame = { width: 2, height: 2 } as HTMLCanvasElement;
    await expect(encodeAnimation({ width: 2, height: 2 }, async () => frame, new AbortController().signal, vi.fn())).rejects.toThrow('Encoder failed');
    expect(frame.width).toBe(0); expect(encoder.cancel).toHaveBeenCalledTimes(1);
  });
  it('reports unsupported encoders and resolutions before rendering', async () => {
    const render = vi.fn(); encoder.codec.mockResolvedValueOnce(null);
    await expect(encodeAnimation({ width: 8192, height: 8192 }, render, new AbortController().signal, vi.fn())).rejects.toThrow('smaller resolution');
    vi.stubGlobal('VideoEncoder', undefined);
    await expect(encodeAnimation({ width: 2, height: 2 }, render, new AbortController().signal, vi.fn())).rejects.toThrow('unavailable');
    expect(render).not.toHaveBeenCalled();
  });
});
