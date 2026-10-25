import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { headingFromEvent } from '../src/heading';
import { headingScreenAngle } from '../src/location';
import { wgs84ToSJTSK } from '../src/geo';

describe('headingFromEvent', () => {
  it('uses the Safari compass heading plus declination and screen rotation', () => {
    expect(headingFromEvent({ alpha: 10, webkitCompassHeading: 90 }, 0, 5)).toBe(95);
    expect(headingFromEvent({ alpha: 10, webkitCompassHeading: 350 }, 90, 5)).toBe(85);
  });
  it('turns absolute alpha (counter-clockwise) into a clockwise heading', () => {
    expect(headingFromEvent({ alpha: 90, absolute: true }, 0, 0)).toBe(270);
  });
  it('ignores relative orientation without a compass', () => {
    expect(headingFromEvent({ alpha: 90, absolute: false }, 0, 0)).toBeUndefined();
    expect(headingFromEvent({ alpha: null, absolute: true }, 0, 0)).toBeUndefined();
  });
});

describe('headingScreenAngle', () => {
  const top = () => {
    const camera = new THREE.OrthographicCamera(-50, 50, 50, -50, .1, 1000);
    camera.up.set(0, 1, 0); camera.position.set(0, 0, 100); camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
    return camera;
  };
  it('points up for grid north in a north-up plan view', () => {
    expect(headingScreenAngle({ local: new THREE.Vector3(), trueNorth: 0 }, 0, top(), 400, 400)).toBeCloseTo(0);
    expect(headingScreenAngle({ local: new THREE.Vector3(), trueNorth: 0 }, 90, top(), 400, 400)).toBeCloseTo(90);
  });
  it('adds the meridian convergence', () => {
    expect(headingScreenAngle({ local: new THREE.Vector3(), trueNorth: 8 }, 0, top(), 400, 400)).toBeCloseTo(8);
  });
  it('S-JTSK true north in Liptov is turned several degrees clockwise from grid north', () => {
    const [e0, n0] = wgs84ToSJTSK(49.0, 19.6, 0), [e1, n1] = wgs84ToSJTSK(49.001, 19.6, 0);
    const convergence = Math.atan2(e1 - e0, n1 - n0) * 180 / Math.PI;
    expect(Math.abs(convergence)).toBeGreaterThan(3);
    expect(Math.abs(convergence)).toBeLessThan(12);
  });
});
