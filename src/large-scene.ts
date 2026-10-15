import * as THREE from 'three';
import type { GeometryBatch, LargeModel } from './large-lox';

function altitudeMaterial<T extends THREE.Material>(material: T, model: LargeModel): T {
  // Evaluate altitude color on the GPU instead of storing a color per vertex.
  material.onBeforeCompile = shader => {
    shader.uniforms.lowZ = { value: model.minZ - model.origin[2] };
    shader.uniforms.highZ = { value: model.maxZ - model.origin[2] };
    shader.vertexShader = 'varying float altitude;\n' + shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\naltitude = position.z;');
    shader.fragmentShader = 'varying float altitude;\nuniform float lowZ;\nuniform float highZ;\n' + shader.fragmentShader.replace('#include <color_fragment>', `
      float t = highZ == lowZ ? 0.5 : clamp((altitude - lowZ) / (highZ - lowZ), 0.0, 1.0);
      vec3 hue = clamp(abs(mod((1.0 - t) * 0.68 * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
      diffuseColor.rgb *= 0.54 + 0.82 * (hue - 0.5) * (1.0 - abs(2.0 * 0.54 - 1.0));
    `);
  };
  return material;
}

export function largeWallMaterial(model: LargeModel) {
  // Derivative normals light the triangle soup without a per-vertex normal buffer.
  return altitudeMaterial(new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, flatShading: true, roughness: .85, metalness: 0 }), model);
}

export function largeWallMesh(batch: GeometryBatch, material: THREE.Material) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(batch.positions, 3));
  if (batch.indices) geometry.setIndex(new THREE.BufferAttribute(batch.indices, 1));
  return new THREE.Mesh(geometry, material);
}

function previewPointMaterial(model: LargeModel) {
  const material = new THREE.ShaderMaterial({
    lights: true,
    uniforms: THREE.UniformsUtils.merge([THREE.ShaderLib.points.uniforms, THREE.UniformsLib.lights, { cullBackFaces: { value: false } }]),
    vertexShader: THREE.ShaderLib.points.vertexShader
      .replace('#include <common>', '#include <common>\n#include <lights_pars_begin>\nvarying vec3 pointLighting;\nvarying float pointFacing;')
      .replace('#include <project_vertex>', `#include <project_vertex>
        vec3 pointNormal = normalize(normalMatrix * normal);
        // Match double-sided walls by lighting the side facing the camera.
        vec3 viewDirection = isOrthographic ? vec3(0.0, 0.0, 1.0) : -mvPosition.xyz;
        pointFacing = dot(pointNormal, viewDirection);
        if (pointFacing < 0.0) pointNormal = -pointNormal;
        pointLighting = ambientLightColor;
        #if NUM_HEMI_LIGHTS > 0
        for (int i = 0; i < NUM_HEMI_LIGHTS; i++) {
          pointLighting += getHemisphereLightIrradiance(hemisphereLights[i], pointNormal);
        }
        #endif
        #if NUM_DIR_LIGHTS > 0
        for (int i = 0; i < NUM_DIR_LIGHTS; i++) {
          pointLighting += max(dot(pointNormal, directionalLights[i].direction), 0.0) * directionalLights[i].color;
        }
        #endif
        pointLighting *= RECIPROCAL_PI;
      `),
    fragmentShader: THREE.ShaderLib.points.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 pointLighting;\nvarying float pointFacing;\nuniform bool cullBackFaces;')
      .replace('#include <clipping_planes_fragment>', '#include <clipping_planes_fragment>\nif (cullBackFaces && pointFacing < 0.0) discard;')
      .replace('outgoingLight = diffuseColor.rgb;', 'outgoingLight = diffuseColor.rgb * pointLighting;'),
  });
  material.onBeforeRender = renderer => { material.uniforms.size.value = 1.5 * renderer.getPixelRatio(); };
  return altitudeMaterial(material, model);
}

export const LOD_TRIANGLE_BUDGET = 262_144;

export class LargeScene {
  private entries: { mesh: THREE.Mesh; points: THREE.Points; center: THREE.Vector3; radius: number; triangles: number; high: boolean }[] = [];
  private pointMaterial: THREE.ShaderMaterial;

  constructor(private group: THREE.Group, private material: THREE.Material, model: LargeModel) {
    this.pointMaterial = previewPointMaterial(model);
  }

  setCulling(enabled: boolean) {
    const side = enabled ? THREE.FrontSide : THREE.DoubleSide;
    if (this.material.side !== side) { this.material.side = side; this.material.needsUpdate = true; }
    this.pointMaterial.uniforms.cullBackFaces.value = enabled;
  }

  add(batch: GeometryBatch) {
    const mesh = largeWallMesh(batch, this.material);
    mesh.visible = false;
    // Only sampled faces need normals: at most 512 cross products per batch.
    const count = Math.min(batch.triangles, 512);
    const positions = new Float32Array(count * 3), normals = new Float32Array(count * 3);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), normal = new THREE.Vector3();
    for (let sample = 0; sample < count; sample++) {
      const triangle = Math.floor(sample * batch.triangles / count) * 3;
      const vertices = [0, 1, 2].map(offset => batch.indices ? batch.indices[triangle + offset] : triangle + offset);
      positions.set(batch.positions.subarray(vertices[sample % 3] * 3, vertices[sample % 3] * 3 + 3), sample * 3);
      a.fromArray(batch.positions, vertices[0] * 3);
      b.fromArray(batch.positions, vertices[1] * 3).sub(a);
      c.fromArray(batch.positions, vertices[2] * 3).sub(a);
      normal.crossVectors(b, c);
      if (normal.lengthSq() === 0) normal.set(0, 0, 1);
      normal.normalize().toArray(normals, sample * 3);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geometry.computeBoundingSphere();
    const sphere = geometry.boundingSphere!;
    const points = new THREE.Points(geometry, this.pointMaterial);
    this.group.add(mesh, points);
    this.entries.push({ mesh, points, center: sphere.center.clone(), radius: sphere.radius, triangles: batch.triangles, high: false });
  }

  update(camera: THREE.Camera, full: boolean) {
    const selected = new Set<THREE.Mesh>();
    if (!full) {
      const nearby = this.entries.map(entry => ({ entry, distance: camera.position.distanceTo(entry.center) }))
        .filter(({ entry, distance }) => distance < Math.max(20, entry.radius * 1.5))
        .sort((a, b) => a.distance - b.distance);
      let triangles = 0;
      for (const { entry } of nearby) {
        if (triangles + entry.triangles > LOD_TRIANGLE_BUDGET) continue;
        selected.add(entry.mesh); triangles += entry.triangles;
      }
    }
    for (const entry of this.entries) {
      const high = full || selected.has(entry.mesh);
      // Keep the source arrays, but release GPU buffers for distant batches.
      if (entry.high && !high) entry.mesh.geometry.dispose();
      entry.high = high;
      entry.mesh.visible = high;
      entry.points.visible = !high;
    }
  }

  get renderedTriangles() { return this.entries.reduce((sum, entry) => sum + (entry.high ? entry.triangles : 0), 0); }

  refinementBatches(camera: THREE.Camera) {
    for (const entry of this.entries) {
      entry.mesh.visible = false; entry.points.visible = false;
      if (entry.high) entry.mesh.geometry.dispose();
      entry.high = false;
    }
    return [...this.entries].sort((a, b) => camera.position.distanceToSquared(a.center) - camera.position.distanceToSquared(b.center))
      .map(entry => entry.mesh);
  }
}
