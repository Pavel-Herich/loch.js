import * as THREE from 'three';
import type { LargeModel } from './large-lox';

type AltitudeRange = Pick<LargeModel, 'minZ' | 'maxZ' | 'origin'>;
const placeholder = new THREE.DataTexture(new Uint8Array([145, 139, 126, 255]), 1, 1);
placeholder.colorSpace = THREE.SRGBColorSpace; placeholder.needsUpdate = true;
const texturedWalls = { value: false };
const rockMap = { value: placeholder as THREE.Texture };
let textureLoading: Promise<void> | undefined;

export function setTexturedWalls(enabled: boolean) { texturedWalls.value = enabled; }

export function loadWallTexture() {
  return textureLoading ??= new Promise<void>((resolve, reject) => {
    new THREE.TextureLoader().load(new URL('./assets/limestone.webp', import.meta.url).href, texture => {
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
      texture.anisotropy = 4;
      rockMap.value = texture;
      resolve();
    }, undefined, () => {
      textureLoading = undefined;
      reject(new Error('Could not load the limestone wall texture.'));
    });
  });
}

/** Model-space triplanar mapping needs no UVs or additional full-mesh attributes. */
export function wallMaterial<T extends THREE.Material>(material: T, model?: AltitudeRange, points = false): T {
  material.customProgramCacheKey = () => `wall-surface-v1:${Boolean(model)}:${points}`;
  material.onBeforeCompile = shader => {
    shader.uniforms.texturedWalls = texturedWalls;
    shader.uniforms.rockMap = rockMap;
    shader.uniforms.lowZ = { value: model ? model.minZ - model.origin[2] : 0 };
    shader.uniforms.highZ = { value: model ? model.maxZ - model.origin[2] : 0 };
    shader.vertexShader = `varying vec3 wallPosition;\n${points ? 'varying vec3 wallSampleNormal;\n' : ''}`
      + shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
        wallPosition = position;
        ${points ? 'wallSampleNormal = normal;' : ''}
      `);
    shader.fragmentShader = `
      varying vec3 wallPosition;
      ${points ? 'varying vec3 wallSampleNormal;' : ''}
      uniform bool texturedWalls;
      uniform sampler2D rockMap;
      uniform float lowZ;
      uniform float highZ;
      vec3 wallRockColor(vec3 position, vec3 surfaceNormal) {
        vec3 weights = pow(abs(normalize(surfaceNormal)), vec3(4.0));
        weights /= max(weights.x + weights.y + weights.z, 0.00001);
        // One tile per metre, consistent across scraps, LOD batches, and views.
        return texture2D(rockMap, position.yz).rgb * weights.x
          + texture2D(rockMap, position.xz).rgb * weights.y
          + texture2D(rockMap, position.xy).rgb * weights.z;
      }
    ` + shader.fragmentShader.replace('#include <color_fragment>', `
      float wallHeight = 0.0;
      if (texturedWalls) {
        vec3 surfaceNormal = ${points ? 'wallSampleNormal' : 'cross(dFdx(wallPosition), dFdy(wallPosition))'};
        vec3 rock = wallRockColor(wallPosition, surfaceNormal);
        diffuseColor.rgb = rock;
        wallHeight = dot(rock, vec3(0.2126, 0.7152, 0.0722)) * 0.003;
      } else {
        #include <color_fragment>
        ${model ? `
          float t = highZ == lowZ ? 0.5 : clamp((wallPosition.z - lowZ) / (highZ - lowZ), 0.0, 1.0);
          vec3 hue = clamp(abs(mod((1.0 - t) * 0.68 * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0);
          diffuseColor.rgb *= 0.54 + 0.82 * (hue - 0.5) * (1.0 - abs(2.0 * 0.54 - 1.0));
        ` : ''}
      }
    `);
    if (!points) shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>', `
      #include <normal_fragment_maps>
      if (texturedWalls) {
        // Subtle relief from the stone detail, evaluated on the GPU only.
        vec3 dx = dFdx(-vViewPosition), dy = dFdy(-vViewPosition);
        vec3 r1 = cross(dy, normal), r2 = cross(normal, dx);
        float determinant = dot(dx, r1) * faceDirection;
        vec3 gradient = sign(determinant) * (dFdx(wallHeight) * r1 + dFdy(wallHeight) * r2);
        normal = normalize(max(abs(determinant), 0.0000000001) * normal - gradient);
      }
    `);
  };
  return material;
}
