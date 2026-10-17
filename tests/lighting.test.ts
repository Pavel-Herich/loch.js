import { describe, expect, it } from 'vitest';
import { DirectionalLight, HemisphereLight, OrthographicCamera, PerspectiveCamera, Vector3 } from 'three';
import { createHeadlight, lightDirection, setLightDirection, setLightingMode, updateHeadlight } from '../src/lighting';

describe('headlight', () => {
  it('replaces directional/fill lighting only in headlight mode and restores their intensities', () => {
    const lights = { directional: new DirectionalLight(0xffffff, 2), fill: new HemisphereLight(0xffffff, 0x111111, 2.1), headlight: createHeadlight() };
    setLightingMode(lights, 'headlight');
    expect(lights.headlight.visible).toBe(true);
    expect(lights.directional.visible).toBe(false);
    expect(lights.fill.visible).toBe(false);
    expect(lights.headlight.penumbra).toBe(1);
    expect(lights.headlight.decay).toBe(0);
    for (const mode of ['static', 'follow'] as const) {
      setLightingMode(lights, mode);
      expect(lights.headlight.visible).toBe(false);
      expect(lights.directional.visible).toBe(true);
      expect(lights.fill.visible).toBe(true);
      expect(lights.directional.intensity).toBe(2);
      expect(lights.fill.intensity).toBe(2.1);
    }
  });

  it.each([new PerspectiveCamera(45, 1), new OrthographicCamera(-10, 10, 10, -10)])('tracks the camera and adapts its cone to projection and zoom (%s)', camera => {
    const light = createHeadlight(), target = new Vector3(10, 20, 30);
    camera.up.set(0, 0, 1); camera.position.set(40, -30, 60); camera.lookAt(target);
    const position = camera.position.clone(), orientation = camera.quaternion.clone();
    updateHeadlight(light, camera, target);
    expect(light.position.distanceTo(position)).toBeLessThan(1e-8);
    expect(light.target.position.clone().sub(light.position).distanceTo(camera.getWorldDirection(new Vector3()))).toBeLessThan(1e-8);
    const angle = light.angle;
    camera.zoom = 2; camera.updateProjectionMatrix(); updateHeadlight(light, camera, target);
    expect(light.angle).toBeLessThan(angle);
    expect(camera.position.distanceTo(position)).toBe(0);
    expect(camera.quaternion.angleTo(orientation)).toBeLessThan(1e-7);
    camera.position.add(new Vector3(1, 2, 3)); camera.rotateY(.3);
    updateHeadlight(light, camera, target);
    expect(light.position.distanceTo(camera.position)).toBeLessThan(1e-8);
    expect(light.target.position.clone().sub(light.position).distanceTo(camera.getWorldDirection(new Vector3()))).toBeLessThan(1e-8);
  });
});

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
