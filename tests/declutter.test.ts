import { describe, expect, it } from 'vitest';
import { claimSymbol, resetSymbolSpace, symbolHidden } from '../src/declutter';

describe('declutter', () => {
  it('hides small symbols that would touch one already drawn', () => {
    resetSymbolSpace();
    const a = {}, b = {}, c = {};
    expect(claimSymbol(a, 100, 100, 4, .4)).toBe(true);
    expect(claimSymbol(b, 106, 100, 4, .4)).toBe(false);
    expect(claimSymbol(c, 109, 100, 4, .4)).toBe(true);
    expect(symbolHidden(b)).toBe(true); expect(symbolHidden(a)).toBe(false);
  });
  it('draws larger symbols even when they touch, and the next frame starts clear', () => {
    resetSymbolSpace();
    expect(claimSymbol({}, 0, 0, 6, .4)).toBe(true);
    expect(claimSymbol({}, 4, 0, 6, .9)).toBe(true);
    resetSymbolSpace();
    expect(claimSymbol({}, 4, 0, 6, .4)).toBe(true);
  });
});
