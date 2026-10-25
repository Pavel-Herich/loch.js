import { describe, expect, it } from 'vitest';
import { swipeStep } from '../src/layers-ui';

describe('swipeStep', () => {
  it('goes on with a swipe to the left and back with a swipe to the right', () => {
    expect(swipeStep(-80, 10)).toBe(1);
    expect(swipeStep(90, -5)).toBe(-1);
  });
  it('ignores short or mostly vertical moves (scrolling the table)', () => {
    expect(swipeStep(-30, 0)).toBe(0);
    expect(swipeStep(-60, 80)).toBe(0);
  });
});
