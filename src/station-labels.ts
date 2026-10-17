import * as THREE from 'three';
import { STATION_SURFACE, stationLabel, type Station, type StationLabel } from './lox-stations';

const ATLAS_SIZE = 1024;
const TEXT_SCALE = 2;
const ROW_HEIGHT = 36;

/** Batched screen-sized text quads sharing the model's depth buffer. */
export class StationLabels {
  private meshes: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>[] = [];
  constructor(private group: THREE.Group, private createCanvas = () => document.createElement('canvas')) {}

  rebuild(stations: Station[], mode: StationLabel, origin: THREE.Vector3) {
    this.clear();
    let canvas: HTMLCanvasElement | undefined, context: CanvasRenderingContext2D | null = null;
    let x = 0, y = 0;
    let positions: number[] = [], offsets: number[] = [], uvs: number[] = [], indices: number[] = [];
    const flush = () => {
      if (!canvas || !positions.length) return;
      const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
      texture.generateMipmaps = false; texture.minFilter = THREE.LinearFilter;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.setAttribute('pixelOffset', new THREE.Float32BufferAttribute(offsets, 2));
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2)); geometry.setIndex(indices);
      const material = new THREE.ShaderMaterial({
        uniforms: { atlas: { value: texture }, viewport: { value: new THREE.Vector2(1, 1) }, orthographic: { value: false } },
        depthTest: true, depthWrite: true, toneMapped: false,
        vertexShader: `attribute vec2 pixelOffset;
          uniform vec2 viewport;
          uniform bool orthographic;
          varying vec2 labelUV;
          void main() {
            labelUV = uv;
            vec4 viewPosition = modelViewMatrix * vec4(position, 1.0);
            // Move along the viewing ray, preserving the station's screen anchor.
            if (orthographic) viewPosition.z *= 0.9;
            else viewPosition.xyz *= 0.9;
            gl_Position = projectionMatrix * viewPosition;
            gl_Position.xy += pixelOffset * 2.0 / viewport * gl_Position.w;
          }`,
        fragmentShader: `uniform sampler2D atlas;
          varying vec2 labelUV;
          void main() {
            vec4 text = texture2D(atlas, labelUV);
            if (text.a < 0.2) discard;
            gl_FragColor = vec4(text.rgb, 1.0);
            #include <colorspace_fragment>
          }`,
      });
      // Opaque text pixels also preserve label depth across progressive wall batches.
      const mesh = new THREE.Mesh(geometry, material); mesh.name = 'Station labels'; mesh.frustumCulled = false;
      this.group.add(mesh); this.meshes.push(mesh);
    };
    const startPage = () => {
      canvas = this.createCanvas(); canvas.width = ATLAS_SIZE; canvas.height = ATLAS_SIZE;
      context = canvas.getContext('2d');
      if (!context) throw new Error('Could not create station label texture.');
      context.font = '24px system-ui, sans-serif'; context.textBaseline = 'middle';
      context.lineWidth = 6; context.strokeStyle = '#09131c'; context.lineJoin = 'round';
      x = 0; y = 0; positions = []; offsets = []; uvs = []; indices = [];
    };
    for (const station of stations) {
      const text = stationLabel(station, mode);
      if (!text) continue;
      if (!context) startPage();
      const width = Math.min(ATLAS_SIZE, Math.ceil(context!.measureText(text).width) + 12);
      if (x + width > ATLAS_SIZE) { x = 0; y += ROW_HEIGHT; }
      if (y + ROW_HEIGHT > ATLAS_SIZE) { flush(); startPage(); }
      context!.fillStyle = station.flags & STATION_SURFACE ? '#808080' : '#ffffff';
      context!.strokeText(text, x + 6, y + ROW_HEIGHT / 2, width - 12);
      context!.fillText(text, x + 6, y + ROW_HEIGHT / 2, width - 12);
      const first = positions.length / 3;
      const point = station.position.map((value, axis) => value - origin.getComponent(axis));
      for (const [u, v] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
        positions.push(...point);
        offsets.push(2 + u * width / TEXT_SCALE, (0.5 - v) * ROW_HEIGHT / TEXT_SCALE);
        uvs.push((x + u * width) / ATLAS_SIZE, 1 - (y + v * ROW_HEIGHT) / ATLAS_SIZE);
      }
      indices.push(first, first + 3, first + 2, first, first + 2, first + 1);
      x += width;
    }
    flush();
  }

  setVisible(visible: boolean) { for (const mesh of this.meshes) mesh.visible = visible; }
  update(camera: THREE.Camera, width: number, height: number) {
    for (const { material } of this.meshes) {
      material.uniforms.viewport.value.set(width, height);
      material.uniforms.orthographic.value = Boolean((camera as THREE.OrthographicCamera).isOrthographicCamera);
    }
  }
  clear() {
    for (const mesh of this.meshes) {
      this.group.remove(mesh); mesh.geometry.dispose();
      (mesh.material.uniforms.atlas.value as THREE.Texture).dispose(); mesh.material.dispose();
    }
    this.meshes = [];
  }
}
