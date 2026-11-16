import { describe, expect, it } from 'vitest';
import { phoneView } from '../src/heading';

describe('phoneView', () => {
  it('looks straight down with the top of the phone as the bearing when it lies face up', () => {
    const view = phoneView(30, 0, 0);
    expect(view.tilt).toBeCloseTo(-90, 6); expect(view.bearing).toBeCloseTo(30, 6);
  });
  it('looks level where the back camera points when held upright', () => {
    const view = phoneView(120, 90 - 1e-6, 0);
    expect(view.tilt).toBeCloseTo(0, 4); expect(view.bearing).toBeCloseTo(120, 4);
  });
  it('tilts with the phone in between and keeps the bearing', () => {
    const view = phoneView(250, 40, 0);
    expect(view.tilt).toBeCloseTo(-50, 6); expect(view.bearing).toBeCloseTo(250, 6);
  });
  it('looks up when the phone leans back past upright', () => {
    expect(phoneView(0, 110, 0).tilt).toBeCloseTo(20, 6);
  });
  it('turns with the screen in landscape', () => {
    // Landscape, top of the screen (the phone's right side) east, phone lying flat.
    const view = phoneView(90, 0, 0, 90);
    expect(view.tilt).toBeCloseTo(-90, 6); expect(view.bearing).toBeCloseTo(90, 6);
    // Raised: the phone rolls about its long axis (gamma negative raises the right side).
    const raised = phoneView(90, 0, -60, 90);
    expect(raised.tilt).toBeCloseTo(-30, 6); expect(raised.bearing).toBeCloseTo(90, 6);
  });
});
