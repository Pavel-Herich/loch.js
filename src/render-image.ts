import * as THREE from 'three';
import type { ViewCamera } from './camera';
import { resizeCamera } from './camera';
import type { LargeScene } from './large-scene';
import { ProgressiveView } from './progressive-view';
import type { ImageSize } from './image-size';

export function imageCamera(camera: ViewCamera, size: ImageSize) {
  const copy = camera.clone(); resizeCamera(copy, size.width / size.height); copy.updateMatrixWorld(); return copy;
}

/** Render into an independent framebuffer; never resize or change the live view. */
export async function renderImage(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: ViewCamera,
  size: ImageSize, largeScene?: LargeScene, surface?: THREE.Group, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const previous = renderer.getRenderTarget(), autoClear = renderer.autoClear;
  const parents = new Set(largeScene?.geometryBatches().map(mesh => mesh.parent));
  const visibility = [...parents].flatMap(parent => parent?.children ?? []).map(object => [object, object.visible] as const);
  let view: ProgressiveView | undefined, target: THREE.WebGLRenderTarget | undefined;
  try {
    if (largeScene) {
      view = new ProgressiveView(renderer, scene, camera, largeScene, surface, new THREE.Vector2(size.width, size.height));
      while (!view.complete) { signal?.throwIfAborted(); view.step(false); await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); }
      target = view.imageTarget;
    } else {
      target = new THREE.WebGLRenderTarget(size.width, size.height, { samples: size.width * size.height <= 8 * 1024 * 1024 ? Math.min(4, renderer.capabilities.maxSamples) : 0 });
      target.texture.colorSpace = renderer.outputColorSpace;
      renderer.setRenderTarget(target); renderer.autoClear = true; renderer.render(scene, camera);
    }
    signal?.throwIfAborted();
    const pixels = new Uint8Array(size.width * size.height * 4);
    renderer.readRenderTargetPixels(target, 0, 0, size.width, size.height, pixels);
    const canvas = document.createElement('canvas'); canvas.width = size.width; canvas.height = size.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not create image canvas');
    const image = context.createImageData(size.width, size.height), stride = size.width * 4;
    for (let row = 0; row < size.height; row++) image.data.set(pixels.subarray(row * stride, (row + 1) * stride), (size.height - row - 1) * stride);
    context.putImageData(image, 0, 0); return canvas;
  } finally {
    renderer.setRenderTarget(previous); renderer.autoClear = autoClear;
    if (view) view.dispose(); else target?.dispose();
    for (const [object, visible] of visibility ?? []) object.visible = visible;
  }
}
