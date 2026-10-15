import * as THREE from 'three';
import type { LargeScene } from './large-scene';

/** Accumulate opaque batches into one color/depth buffer for a stationary camera. */
export class ProgressiveView {
  private target: THREE.WebGLRenderTarget;
  private copyScene = new THREE.Scene();
  private copyCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 2);
  private copyMesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private batches: THREE.Mesh[];
  private frustum = new THREE.Frustum();
  private next = 0;

  constructor(private renderer: THREE.WebGLRenderer, private scene: THREE.Scene,
    private camera: THREE.PerspectiveCamera, largeScene: LargeScene) {
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    // Multisample render targets can discard their color attachment on resolve,
    // so use a persistent single-sample target for accumulation across frames.
    this.target = new THREE.WebGLRenderTarget(size.x, size.y, { depthBuffer: true });
    this.copyCamera.position.z = 1;
    this.copyMesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({
      map: this.target.texture, depthTest: false, depthWrite: false, toneMapped: false,
    }));
    this.copyScene.add(this.copyMesh);
    this.batches = largeScene.refinementBatches(camera);
    camera.updateMatrixWorld();
    this.frustum.setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const target = renderer.getRenderTarget(), autoClear = renderer.autoClear;
    try {
      renderer.setRenderTarget(this.target);
      renderer.autoClear = true;
      // All large walls/points are hidden here; initialize background, lines,
      // bounding box and depth once, then retain them throughout refinement.
      renderer.render(scene, camera);
    } finally {
      renderer.setRenderTarget(target); renderer.autoClear = autoClear;
    }
  }

  get complete() { return this.next >= this.batches.length; }
  get progress() { return this.batches.length ? this.next / this.batches.length : 1; }

  step() {
    if (this.complete) return;
    const mesh = this.batches[this.next++];
    const renderer = this.renderer, target = renderer.getRenderTarget();
    const autoClear = renderer.autoClear, background = this.scene.background;
    try {
      if (mesh && this.frustum.intersectsObject(mesh)) {
        mesh.visible = true;
        renderer.setRenderTarget(this.target);
        renderer.autoClear = false;
        // A Color background forces a clear even when autoClear is false.
        this.scene.background = null;
        renderer.render(this.scene, this.camera);
      }
      renderer.setRenderTarget(target);
      renderer.autoClear = true;
      renderer.render(this.copyScene, this.copyCamera);
    } finally {
      if (mesh) { mesh.visible = false; mesh.geometry.dispose(); }
      this.scene.background = background;
      renderer.setRenderTarget(target); renderer.autoClear = autoClear;
    }
  }

  dispose() {
    this.target.dispose(); this.copyMesh.geometry.dispose(); this.copyMesh.material.dispose();
  }
}
