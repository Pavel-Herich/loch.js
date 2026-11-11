import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { imageCamera, renderImage } from '../src/render-image';
import { validImageSize } from '../src/image-size';
import { LargeScene } from '../src/large-scene';
afterEach(() => vi.unstubAllGlobals());
describe('image size and independent rendering', () => {
  it('rejects invalid, excessive and fractional pixel dimensions', () => {
    expect(validImageSize({ width: 1920, height: 1080 }, 8192)).toBe(true);
    expect(validImageSize({ width: 8192, height: 8192 }, 16384)).toBe(true);
    expect(validImageSize({ width: 16384, height: 8192 }, 16384)).toBe(true);
    expect(validImageSize({ width: 16384, height: 8193 }, 16384)).toBe(false);
    expect(validImageSize({ width: 16385, height: 1 }, 16384)).toBe(false);
    for (const size of [{ width: 0, height: 100 }, { width: NaN, height: 100 }, { width: 1.5, height: 100 },
      { width: 8193, height: 1 }]) expect(validImageSize(size, 8192)).toBe(false);
    expect(validImageSize({ width: 4096, height: 2048 }, 2048)).toBe(false);
  });
  it('cancels before allocating export resources when the signal is already aborted', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(renderImage({} as THREE.WebGLRenderer, new THREE.Scene(), new THREE.PerspectiveCamera(), { width: 1920, height: 1080 },
      undefined, undefined, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
  it.each([false, true])('clones projection for the chosen aspect without moving the live camera (orthographic %s)', ortho => {
    const source = ortho ? new THREE.OrthographicCamera(-4, 4, 3, -3, .01, 1000) : new THREE.PerspectiveCamera(45, 4 / 3, .01, 1000);
    source.position.set(5, 6, 7); source.lookAt(0, 0, 0); source.zoom = 2; source.updateProjectionMatrix();
    const original = source.projectionMatrix.clone(), copy = imageCamera(source, { width: 3000, height: 1000 });
    expect(copy).not.toBe(source); expect(copy.position).toEqual(source.position); expect(copy.quaternion.equals(source.quaternion)).toBe(true);
    expect(copy.zoom).toBe(2); expect(source.projectionMatrix).toEqual(original);
    if (copy instanceof THREE.OrthographicCamera) expect((copy.right - copy.left) / (copy.top - copy.bottom)).toBe(3);
    else expect(copy.aspect).toBe(3);
  });
  it.each([false, true])('renders at exact output dimensions, flips pixel rows and restores renderer/visibility (large %s)', large => {
    const previous = new THREE.WebGLRenderTarget(1, 1); let current: THREE.WebGLRenderTarget | null = previous;
    const context = { createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData: vi.fn() };
    const canvas = { width: 0, height: 0, getContext: () => context };
    vi.stubGlobal('document', { createElement: () => canvas });
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => { callback(); return 1; });
    const rendered: { width: number; height: number }[] = [];
    const renderer = { autoClear: false, outputColorSpace: THREE.SRGBColorSpace, capabilities: { maxSamples: 4 },
      getRenderTarget: () => current, setRenderTarget: (target: THREE.WebGLRenderTarget | null) => { current = target; },
      render: () => { rendered.push({ width: current!.width, height: current!.height }); },
      readRenderTargetPixels: (target: THREE.WebGLRenderTarget, _x: number, _y: number, w: number, h: number, pixels: Uint8Array) => {
        expect(target.texture.colorSpace).toBe(THREE.SRGBColorSpace); expect([w, h]).toEqual([2, 2]);
        pixels.set([1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 255, 10, 11, 12, 255]);
      } };
    const scene = new THREE.Scene(), group = new THREE.Group(); scene.add(group);
    const walls = new LargeScene(group, new THREE.MeshBasicMaterial(), { min: [-1, -1, 0], max: [1, 1, 0], origin: [0, 0, 0], minZ: 0, maxZ: 0, scraps: 1, triangles: 1, points: 3, shots: [] });
    walls.add({ positions: new Float32Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]), triangles: 1 });
    const visibility = group.children.map(child => child.visible);
    const camera = new THREE.PerspectiveCamera(45, 1, .1, 100); camera.position.z = 5; camera.updateMatrixWorld();
    return renderImage(renderer as unknown as THREE.WebGLRenderer, scene, camera, { width: 2, height: 2 }, large ? walls : undefined).then(result => {
      expect(result).toBe(canvas); expect([canvas.width, canvas.height]).toEqual([2, 2]);
      expect(rendered.every(size => size.width === 2 && size.height === 2)).toBe(true);
      expect(Array.from(context.putImageData.mock.calls[0][0].data)).toEqual([7, 8, 9, 255, 10, 11, 12, 255, 1, 2, 3, 255, 4, 5, 6, 255]);
      expect(current).toBe(previous); expect(renderer.autoClear).toBe(false); expect(group.children.map(child => child.visible)).toEqual(visibility);
    });
  });
});
