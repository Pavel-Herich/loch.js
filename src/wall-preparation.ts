import * as THREE from 'three';
import type { LargeScene } from './large-scene';
import type { ViewCamera } from './camera';

/** Yield between bounded CPU/GPU uploads; retain the normal full-detail draw. */
export class WallPreparation {
  phase = 'Preparing geometry';
  progress: number | null = 0;
  complete = false;
  private stage: 'geometry' | 'compile' | 'upload' | 'render' | 'gpu' | 'done' = 'geometry';
  private meshes: THREE.Mesh[];
  private objects: (THREE.Mesh | THREE.Points)[] = [];
  private next = 0;
  private compiling = false;
  private compiled = false;
  private compileError?: unknown;
  private uploadTarget = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: false });
  private fence?: WebGLSync;

  constructor(private renderer: THREE.WebGLRenderer, private scene: THREE.Scene, private camera: ViewCamera,
    private largeScene: LargeScene, private full: boolean) {
    this.meshes = largeScene.geometryBatches();
    largeScene.hide();
  }

  step() {
    if (this.compileError) throw this.compileError;
    const deadline = performance.now() + 8;
    if (this.stage === 'geometry') {
      while (this.next < this.meshes.length) {
        const geometry = this.meshes[this.next++].geometry;
        if (!geometry.boundingSphere) geometry.computeBoundingSphere();
        if (performance.now() >= deadline) break;
      }
      this.progress = this.meshes.length ? this.next / this.meshes.length : 1;
      if (this.next === this.meshes.length) {
        this.stage = 'compile'; this.phase = 'Compiling wall shaders'; this.progress = null;
      }
    } else if (this.stage === 'compile') {
      if (!this.compiling) {
        this.compiling = true;
        void this.renderer.compileAsync(this.scene, this.camera).then(() => { this.compiled = true; }, error => { this.compileError = error; });
      } else if (this.compiled) {
        this.objects = this.largeScene.uploadObjects(this.camera, this.full);
        this.next = 0; this.stage = 'upload'; this.phase = 'Uploading geometry'; this.progress = 0;
      }
    } else if (this.stage === 'upload') {
      while (this.next < this.objects.length) {
        this.upload(this.objects[this.next++]);
        if (performance.now() >= deadline) break;
      }
      this.progress = this.objects.length ? this.next / this.objects.length : 1;
      if (this.next === this.objects.length) {
        this.stage = 'render'; this.phase = 'Rendering walls'; this.progress = null;
      }
    } else if (this.stage === 'render') {
      this.largeScene.update(this.camera, this.full);
      this.renderer.render(this.scene, this.camera);
      const gl = this.renderer.getContext() as WebGL2RenderingContext;
      this.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0) ?? undefined;
      if (gl.isContextLost()) throw new Error('WebGL context lost while rendering walls.');
      if (this.fence) { gl.flush(); this.stage = 'gpu'; }
      else { gl.finish(); this.finish(); }
    } else if (this.stage === 'gpu') {
      const gl = this.renderer.getContext() as WebGL2RenderingContext;
      const result = gl.clientWaitSync(this.fence!, 0, 0);
      if (gl.isContextLost() || result === gl.WAIT_FAILED) throw new Error('Could not finish GPU wall rendering.');
      if (result === gl.ALREADY_SIGNALED || result === gl.CONDITION_SATISFIED) {
        gl.deleteSync(this.fence!); this.fence = undefined; this.finish();
      }
    }
  }

  private upload(object: THREE.Mesh | THREE.Points) {
    const target = this.renderer.getRenderTarget(), { start, count } = object.geometry.drawRange;
    const visible = object.visible, culled = object.frustumCulled;
    // Only this object is drawn: the surface, centreline and box would otherwise be drawn again
    // for every uploaded batch. Lights stay, so the wall shaders compiled for them are reused.
    const others = this.scene.children.filter(child => child.visible && !(child instanceof THREE.Light) && !contains(child, object));
    try {
      // Three.js uploads attributes before drawing. A zero-count draw uploads the
      // real buffers without processing triangles or changing the visible canvas.
      object.geometry.setDrawRange(0, 0); object.frustumCulled = false; object.visible = true;
      for (const other of others) other.visible = false;
      this.renderer.setRenderTarget(this.uploadTarget);
      this.renderer.render(this.scene, this.camera);
    } finally {
      object.geometry.setDrawRange(start, count); object.visible = visible; object.frustumCulled = culled;
      for (const other of others) other.visible = true;
      this.renderer.setRenderTarget(target);
    }
  }

  private finish() { this.stage = 'done'; this.progress = 1; this.complete = true; }

  dispose() {
    if (this.fence) { (this.renderer.getContext() as WebGL2RenderingContext).deleteSync(this.fence); this.fence = undefined; }
    this.uploadTarget.dispose();
  }
}

function contains(parent: THREE.Object3D, object: THREE.Object3D) {
  for (let node: THREE.Object3D | null = object; node; node = node.parent) if (node === parent) return true;
  return false;
}
