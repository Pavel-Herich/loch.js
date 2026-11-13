import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { Presentation } from '../src/presentation';
import { imageFilename } from '../src/save-image';
import { PresentationTimeline } from '../src/presentation-timeline';

beforeEach(() => { vi.stubGlobal('DOMParser', DOMParser); vi.stubGlobal('XMLSerializer', XMLSerializer); });
afterEach(() => vi.unstubAllGlobals());

describe('film caption and file names', () => {
  it('keeps a caption in the .lxa file and drops it when cleared', () => {
    const presentation = Presentation.create();
    presentation.caption = 'Jaskyna slobody 2026';
    const again = Presentation.parse(presentation.xml());
    expect(again.caption).toBe('Jaskyna slobody 2026');
    again.caption = '  ';
    expect(again.xml()).not.toContain('caption=');
  });
  it('names images and films after a GeoTIFF without its extension', () => {
    expect(imageFilename('dmr.tif')).toBe('dmr.png');
    expect(imageFilename('dmr.TIFF')).toBe('dmr.png');
    expect(imageFilename('dmr.zip').replace(/\.png$/, '.mp4')).toBe('dmr.mp4');
  });
  it('keeps labels in the .lxa with their views when views are added, moved or removed', () => {
    const presentation = Presentation.create(), camera = { facing: 0, tilt: 0, center: [0, 0, 0] as [number, number, number], distance: 10, focus: 50, perspective: true };
    for (let i = 0; i < 3; i++) presentation.add(camera, false, {});
    presentation.setLabels([{ text: 'Krakova hola', icon: 'peak', position: [-383000.5, -1201000.25, 1752], from: 1, to: 2 }]);
    const again = Presentation.parse(presentation.xml());
    expect(again.labels()).toEqual([{ text: 'Krakova hola', icon: 'peak', position: [-383000.5, -1201000.25, 1752], from: 1, to: 2, hide: true }]);
    again.add(camera, false, {}, 0); // a new view 1: the label moves to views 2–3
    expect(again.labels()[0]).toMatchObject({ from: 2, to: 3 });
    again.move(3, -1); // view 3 becomes 2: still 2–3
    expect(again.labels()[0]).toMatchObject({ from: 2, to: 3 });
    again.remove(0);
    expect(again.labels()[0]).toMatchObject({ from: 1, to: 2 });
    expect(again.views()).toHaveLength(3);
  });
  it('shows a label from the arrival at its first view until the camera reaches the view after its last, fading', () => {
    const view = (x: number) => ({ facing: 0, tilt: 0, center: [x, 0, 0] as [number, number, number], distance: 10, focus: 50, perspective: true,
      name: String(x), duration: 4, rotations: 0, rotationDuration: 15, walker: false, transition: false, scene: {} });
    const timeline = new PresentationTimeline([view(0), view(10), view(20)], false); // arrivals at 0, 4, 8 s
    const label = { from: 1, to: 1 };
    expect(timeline.labelAlpha(label, 2)).toBe(0);
    expect(timeline.labelAlpha(label, 3.75)).toBeCloseTo(.5);
    expect(timeline.labelAlpha(label, 4)).toBe(1);
    expect(timeline.labelAlpha(label, 6)).toBe(1); // on the way on to view 2
    expect(timeline.labelAlpha(label, 7.75)).toBeCloseTo(.5);
    expect(timeline.labelAlpha(label, 8)).toBe(0); // view 2 reached
    expect(timeline.labelAlpha({ from: 0, to: 2 }, 8)).toBe(1); // the last view: to the end
  });
});
