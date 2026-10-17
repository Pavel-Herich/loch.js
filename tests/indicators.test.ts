import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { viewOrientation, viewScale, formatScaleDistance } from '../src/indicators';
import type { ViewCamera } from '../src/camera';

function orient(camera: ViewCamera, bearing: number, tilt: number) {
  const b = THREE.MathUtils.degToRad(bearing), t = THREE.MathUtils.degToRad(tilt);
  const direction = new THREE.Vector3(Math.sin(b) * Math.cos(t), Math.cos(b) * Math.cos(t), Math.sin(t));
  const right = new THREE.Vector3(Math.cos(b), -Math.sin(b), 0);
  const back = direction.negate(), up = new THREE.Vector3().crossVectors(back, right);
  camera.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, back));
}

describe('view indicators', () => {
  it.each([[0, 0], [90, 0], [180, 0], [270, 0], [38, -45], [128, 25], [215, -90], [315, 90]])(
    'reports heading and tilt, including vertical views (%s°, %s°)', (bearing, tilt) => {
      const camera = new THREE.PerspectiveCamera(); orient(camera, bearing, tilt);
      const result = viewOrientation(camera);
      expect(result.bearing).toBeCloseTo(bearing); expect(result.tilt).toBeCloseTo(tilt);
    });

  it.each(['perspective', 'orthographic'])('matches the scale ruler to projected world distances (%s)', projection => {
    const height = 600, width = 900;
    const camera = projection === 'perspective' ? new THREE.PerspectiveCamera(45, width / height, .1, 1000)
      : new THREE.OrthographicCamera(-30, 30, 20, -20, .1, 1000);
    camera.up.set(0, 0, 1); camera.position.set(80, -120, 70);
    const target = new THREE.Vector3(10, 15, 20); camera.lookAt(target);
    for (const zoom of [.5, 1, 3]) {
      camera.zoom = zoom; camera.updateProjectionMatrix(); camera.updateMatrixWorld();
      const ruler = viewScale(camera, target, height)!;
      const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
      const a = target.clone().project(camera), b = target.clone().addScaledVector(right, ruler.distance).project(camera);
      expect((b.x - a.x) * width / 2).toBeCloseTo(ruler.pixels);
      expect(ruler.pixels).toBeGreaterThan(40); expect(ruler.pixels).toBeLessThanOrEqual(140);
      const mantissa = ruler.distance / 10 ** Math.floor(Math.log10(ruler.distance));
      expect([1, 2, 5]).toContain(mantissa);
    }
  });

  it('preserves orthographic scale when moving the camera and updates it when the viewport grows', () => {
    const camera = new THREE.OrthographicCamera(-30, 30, 20, -20, .1, 1000); camera.position.z = 10;
    const target = new THREE.Vector3(), first = viewScale(camera, target, 600)!;
    camera.position.z = 100;
    expect(viewScale(camera, target, 600)).toEqual(first);
    const taller = viewScale(camera, target, 1200)!;
    expect(taller.distance / taller.pixels).toBeCloseTo(first.distance / first.pixels / 2);
  });

  it('does not show a ruler for zero-sized views or an invalid perspective target', () => {
    const camera = new THREE.PerspectiveCamera(); camera.position.z = 10;
    expect(viewScale(camera, new THREE.Vector3(), 0)).toBeNull();
    expect(viewScale(camera, camera.position, 600)).toBeNull();
    expect(viewScale(camera, new THREE.Vector3(0, 0, 20), 600)).toBeNull();
  });

  it.each([[.001, '1 mm'], [.02, '2 cm'], [5, '5 m'], [2000, '2 km']] as const)('formats metric scale distances (%s)', (distance, text) => {
    expect(formatScaleDistance(distance)).toBe(text);
  });
});
