import { describe, expect, it } from 'vitest';
import { DirectionalLight, OrthographicCamera, PerspectiveCamera, Vector3 } from 'three';
import { lightDirection, setLightDirection } from '../src/lighting';

describe('Z-up light direction', () => {
  it.each([PerspectiveCamera, OrthographicCamera])('follows camera position at zero offset and rotates offsets with the camera (%s)', CameraType => {
    const camera = new CameraType(), light = new DirectionalLight();
    camera.up.set(0, 0, 1);
    const target = new Vector3(15, -20, 35);
    for (const offset of [new Vector3(3, -4, 5), new Vector3(-5, 1, -2), new Vector3(0, -1e-6, 10)]) {
      camera.position.copy(target).add(offset); camera.lookAt(target);
      setLightDirection(light, 0, 0, camera, target);
      expect(light.position.distanceTo(camera.position)).toBeLessThan(1e-8);
      expect(light.target.position.distanceTo(target)).toBeLessThan(1e-8);
      setLightDirection(light, 90, 0, camera, target);
      const right = new Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
      expect(light.position.clone().sub(target).normalize().distanceTo(right)).toBeLessThan(1e-8);
      setLightDirection(light, 0, 90, camera, target);
      const up = new Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
      expect(light.position.clone().sub(target).normalize().distanceTo(up)).toBeLessThan(1e-8);
      setLightDirection(light, 27, 53);
      expect(light.position.distanceTo(lightDirection(27, 53))).toBeLessThan(1e-8);
      expect(light.target.position.length()).toBe(0);
    }
  });

  it.each([
    [0, 0, 0, 1, 0], [90, 0, 1, 0, 0], [180, 0, 0, -1, 0], [270, 0, -1, 0, 0], [360, 0, 0, 1, 0],
    [37, 90, 0, 0, 1], [230, -90, 0, 0, -1],
  ])('uses bearing %s° and clino %s° as the direction the light comes from', (bearing, clino, x, y, z) => {
    const direction = lightDirection(bearing, clino);
    expect(direction.x).toBeCloseTo(x, 10);
    expect(direction.y).toBeCloseTo(y, 10);
    expect(direction.z).toBeCloseTo(z, 10);
    expect(direction.length()).toBeCloseTo(1, 10);
  });
});
