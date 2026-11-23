import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { Presentation, type LxaView } from '../src/presentation';
import { PresentationTimeline } from '../src/presentation-timeline';

const view = (facing: number, extra: Partial<LxaView> = {}): LxaView => ({ facing, tilt: -20, center: [0, 0, 0], distance: 100, focus: 50, perspective: true,
  name: String(facing), duration: 2, rotations: 0, rotationDuration: 15, walker: false, transition: false, scene: {}, ...extra });

beforeEach(() => { vi.stubGlobal('DOMParser', DOMParser); vi.stubGlobal('XMLSerializer', XMLSerializer); });
afterEach(() => vi.unstubAllGlobals());

describe('holds (the picture standing still)', () => {
  it('stands still at a view for its hold, then travels on', () => {
    const timeline = new PresentationTimeline([view(0), view(90, { hold: 3 }), view(180)], false);
    expect(timeline.viewTimes).toEqual([0, 2, 7]);
    expect(timeline.duration).toBe(7);
    for (const time of [2, 3.5, 4.99]) expect(timeline.sample(time).facing).toBeCloseTo(90, 6);
    expect(timeline.sample(6).facing).toBeGreaterThan(90);
  });
  it('holds at the first view at the start and at the last view at the end', () => {
    const timeline = new PresentationTimeline([view(0, { hold: 1 }), view(90, { hold: 2 })], false);
    expect(timeline.duration).toBe(5);
    expect(timeline.sample(.5).facing).toBeCloseTo(0, 6);
    expect(timeline.sample(4).facing).toBeCloseTo(90, 6);
    expect(timeline.frames(10).count).toBe(51);
  });
  it('shows a label during a hold from its delay for its length', () => {
    const timeline = new PresentationTimeline([view(0), view(90, { hold: 6 }), view(180)], false);
    const label = { from: 1, to: 1, delay: 2, length: 3 };
    expect(timeline.labelAlpha(label, 3)).toBe(0);
    expect(timeline.labelAlpha(label, 3.75)).toBeCloseTo(.5, 6);
    expect(timeline.labelAlpha(label, 5)).toBe(1);
    expect(timeline.labelAlpha(label, 6.75)).toBeCloseTo(.5, 6);
    expect(timeline.labelAlpha(label, 7.5)).toBe(0);
    // Without a length: until the camera reaches the next view (through the hold).
    expect(timeline.labelAlpha({ from: 1, to: 1 }, 7.5)).toBe(1);
    expect(timeline.labelAlpha({ from: 1, to: 1 }, 10)).toBe(0);
  });
  it('keeps holds and label timing in the .lxa', () => {
    const presentation = Presentation.create();
    presentation.add(view(0), false, {}); presentation.add(view(90), false, {});
    presentation.edit(1, { name: 'stop', duration: 2, rotations: 0, rotationDuration: 15, walker: false, transition: false, hold: 4 });
    presentation.setLabels([{ text: 'Ďumbier', icon: 'peak', position: [1, 2, 3], from: 1, to: 1, delay: 1.5, length: 2 }]);
    const again = Presentation.parse(presentation.xml());
    expect(again.views()[1].hold).toBe(4);
    expect(again.labels()[0]).toMatchObject({ delay: 1.5, length: 2 });
    again.edit(1, { ...again.views()[1], hold: 0 });
    expect(again.xml()).not.toMatch(/hold=/);
  });
});
