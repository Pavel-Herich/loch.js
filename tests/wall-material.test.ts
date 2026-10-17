import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { largeWallMaterial, LargeScene } from '../src/large-scene';
import { loadWallTexture, setTexturedWalls, wallMaterial } from '../src/wall-material';
import type { LargeModel } from '../src/large-lox';

function compile(material: THREE.Material, source = THREE.ShaderLib.standard) {
  const shader = { uniforms: THREE.UniformsUtils.clone(source.uniforms), vertexShader: source.vertexShader, fragmentShader: source.fragmentShader };
  material.onBeforeCompile(shader as Parameters<THREE.Material['onBeforeCompile']>[0], {} as THREE.WebGLRenderer);
  return shader;
}

describe('wall appearance', () => {
  it('shares the texture toggle across small meshes, large meshes, previews, and newly loaded materials', () => {
    const model: LargeModel = { min: [0, 0, 100], max: [1, 1, 110], origin: [0, 0, 105], minZ: 100, maxZ: 110, scraps: 1, triangles: 1, points: 3, shots: [] };
    const small = compile(wallMaterial(new THREE.MeshStandardMaterial({ vertexColors: true })));
    const large = largeWallMaterial(model), group = new THREE.Group(), scene = new LargeScene(group, large, model);
    scene.add({ positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), triangles: 1 });
    const points = group.children.find(child => child instanceof THREE.Points) as THREE.Points;
    const shaders = [small, compile(large), compile(points.material as THREE.Material, THREE.ShaderLib.points)];
    try {
      expect(shaders.every(shader => shader.uniforms.texturedWalls.value === false)).toBe(true);
      expect(shaders[1].uniforms.lowZ.value).toBe(-5);
      expect(shaders[1].uniforms.highZ.value).toBe(5);
      setTexturedWalls(true);
      expect(shaders.every(shader => shader.uniforms.texturedWalls.value === true)).toBe(true);
      const next = compile(largeWallMaterial(model));
      expect(next.uniforms.texturedWalls.value).toBe(true);
      expect(next.uniforms.rockMap).toBe(shaders[0].uniforms.rockMap);
      const mesh = group.children.find(child => child instanceof THREE.Mesh) as THREE.Mesh;
      expect(mesh.geometry.getAttribute('uv')).toBeUndefined();
      expect(mesh.geometry.getAttribute('normal')).toBeUndefined();
      setTexturedWalls(false);
      expect(shaders.every(shader => shader.uniforms.texturedWalls.value === false)).toBe(true);
      expect(next.uniforms.texturedWalls.value).toBe(false);
    } finally { setTexturedWalls(false); }
  });

  it('loads the texture once and reuses it with sRGB decoding and seamless repeat sampling', async () => {
    let complete: ((texture: THREE.Texture) => void) | undefined;
    const texture = new THREE.Texture();
    const loader = vi.spyOn(THREE.TextureLoader.prototype, 'load').mockImplementation((_url, onLoad) => {
      complete = onLoad; return texture;
    });
    try {
      const a = loadWallTexture(), b = loadWallTexture();
      expect(loader).toHaveBeenCalledTimes(1);
      complete!(texture);
      await Promise.all([a, b]);
      expect(compile(wallMaterial(new THREE.MeshStandardMaterial())).uniforms.rockMap.value).toBe(texture);
      expect(texture.colorSpace).toBe(THREE.SRGBColorSpace);
      expect(texture.wrapS).toBe(THREE.RepeatWrapping);
      expect(texture.wrapT).toBe(THREE.RepeatWrapping);
      await loadWallTexture();
      expect(loader).toHaveBeenCalledTimes(1);
    } finally { loader.mockRestore(); }
  });
});
