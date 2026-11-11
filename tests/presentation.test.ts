import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { PerspectiveCamera, Vector3 } from 'three';
import { Presentation, type LxaView } from '../src/presentation';
import { PresentationTimeline, capturePresentationCamera, presentationCamera, transitionProgress } from '../src/presentation-timeline';
import { PresentationPlayer } from '../src/presentation-player';
import type { AnimationWakeLock } from '../src/screen-wake-lock';
const sample = readFileSync('tests/fixtures/presentation-sumienka.lxa', 'utf8');
beforeEach(() => { vi.stubGlobal('DOMParser', DOMParser); vi.stubGlobal('XMLSerializer', XMLSerializer); });
afterEach(() => vi.unstubAllGlobals());
function view(values: Partial<LxaView> = {}): LxaView {
  return { name: 'view', facing: 0, tilt: 20, center: [0, 0, 0], distance: 10, focus: 50, perspective: true,
    duration: 3, rotations: 0, rotationDuration: 15, walker: false, transition: false, scene: {}, ...values };
}

describe('compatible Loch animation XML', () => {
  it('reads the supplied 11-view sample and ignores legacy stop attributes without dropping them', () => {
    const animation = Presentation.parse(sample), views = animation.views();
    expect(views).toHaveLength(11); expect(animation.loop).toBe(true); expect(animation.sceneChanges).toBe(false);
    expect(views[0].center).toEqual([-4.7269, -.3884, .3016]); expect(views[3].walker).toBe(true);
    expect(views[3].rotationDuration).toBe(15); expect(views[3].transition).toBe(false);
    expect(animation.xml()).toContain('stop-duration="5"'); expect(animation.xml()).toContain('stop-view="true"');
  });
  it('retains unknown root, scene attributes and XML elements through update, editing and reordering', () => {
    const animation = Presentation.parse(sample.replace('<LochPresentation ', '<LochPresentation vendor-option="keep" ').replace('<CameraFacing>0.0000', '<Metadata key="unknown">A &amp; B</Metadata><CameraFacing>0.0000'));
    const original = animation.views()[3];
    animation.update(3, { ...original, distance: 2 }, false, { 'scene-vis-walls': 'false' });
    animation.edit(3, { ...original, name: 'Entrée & exit', duration: 4 }); animation.move(3, -1);
    const xml = animation.xml(), again = Presentation.parse(xml);
    expect(again.views()[2].name).toBe('Entrée & exit'); expect(again.views()[2].distance).toBe(2);
    for (const field of ['vendor-option="keep"', 'stop-duration="5"', 'stop-view="true"', 'scene-walls-opacity="0.5000"', '<Metadata key="unknown">A &amp; B</Metadata>']) expect(xml).toContain(field);
    expect(again.document.documentElement.getAttribute('transparency-sorting')).toBe('false');
  });
  it('preserves unsupported combinations of label flags when updating a view', () => {
    const animation = Presentation.parse(sample.replace('scene-label-comment="false"', 'scene-label-comment="true"').replace('scene-label-altitude="false"', 'scene-label-altitude="true"'));
    animation.update(0, animation.views()[0], false, { 'scene-label-comment': 'false', 'scene-label-altitude': 'false' });
    expect(animation.views()[0].scene['scene-label-comment']).toBe('true'); expect(animation.views()[0].scene['scene-label-altitude']).toBe('true');
  });
  it('adds, reorders and deletes views while retaining other XML nodes', () => {
    const animation = Presentation.create();
    animation.add(view(), false, {}); animation.add(view({ center: [1, 2, 3] }), true, {}, 0);
    expect(animation.count).toBe(2); expect(animation.move(1, -1)).toBe(0); expect(animation.views()[0].walker).toBe(true);
    animation.remove(0); expect(animation.views()[0].center).toEqual([0, 0, 0]);
    animation.loop = false; animation.sceneChanges = true;
    const again = Presentation.parse(animation.xml()); expect(again.loop).toBe(false); expect(again.sceneChanges).toBe(true);
  });
  it('rejects wrong files, entities and invalid camera numbers without interpreting unsupported fields', () => {
    for (const xml of ['<Other/>', '<!DOCTYPE x><LochPresentation/>', sample.replace('<CameraDistance>30.5843', '<CameraDistance>NaN')]) expect(() => Presentation.parse(xml)).toThrow();
  });
});

describe('Loch camera and timeline semantics', () => {
  it('matches the supplied sample duration and frame counts, with a closing loop transition', () => {
    const animation = Presentation.parse(sample), timeline = new PresentationTimeline(animation.views(), animation.loop);
    expect(timeline.duration).toBe(48); expect(timeline.frames(30).count).toBe(1440);
    expect(timeline.frames(30).time(1439)).toBeCloseTo(48 - 1 / 30);
    expect(timeline.sample(48).center).toEqual(timeline.sample(0).center);
    const once = new PresentationTimeline(animation.views(), false);
    expect(once.duration).toBe(45); expect(once.frames(30).count).toBe(1351); expect(once.frames(30).time(1350)).toBe(45);
    expect(once.sample(45).sceneIndex).toBe(10);
  });
  it('uses destination transition duration, shortest bearing and per-view signed rotations', () => {
    const timeline = new PresentationTimeline([view({ facing: 350, duration: 9, rotations: -1, rotationDuration: 2 }), view({ facing: 10, duration: 4 })], false);
    expect(timeline.duration).toBe(6); expect(timeline.sample(1).facing).toBeCloseTo(170);
    expect(timeline.sample(4).facing).toBeCloseTo(360);
    expect(timeline.sample(2).sceneIndex).toBe(0); expect(timeline.sample(6).sceneIndex).toBe(1);
  });
  it('implements the four Loch transition velocity combinations', () => {
    expect(transitionProgress(.25, false, false)).toBe(.15625);
    expect(transitionProgress(.25, true, false)).toBe(.296875);
    expect(transitionProgress(.25, false, true)).toBe(.109375);
    expect(transitionProgress(.25, true, true)).toBe(.25);
  });
  it('interpolates actual camera positions for walker transitions rather than orbit centres', () => {
    const a = view({ facing: 0 }), b = view({ facing: 90, walker: true, center: [5, 2, 1], distance: 2 });
    const timeline = new PresentationTimeline([a, b], false), clip = new PerspectiveCamera(45, 1, .01, 1000), origin = new Vector3();
    const from = presentationCamera(a, origin, 1, clip), to = presentationCamera(b, origin, 1, clip);
    const middle = presentationCamera(timeline.sample(1.5), origin, 1, clip);
    expect(middle.position.distanceTo(from.position.clone().lerp(to.position, .5))).toBeLessThan(1e-9);
    expect(timeline.sample(.001).walker).toBe(true);
  });
  it.each([true, false])('preserves world coordinates, lens and heading including poles (perspective %s)', perspective => {
    const origin = new Vector3(1000, 2000, 500), clip = new PerspectiveCamera(45, 1, .001, 10000);
    for (const tilt of [-90, 0, 90]) {
      const state = view({ facing: 130, tilt, center: [1010, 2010, 510], focus: 29, perspective });
      const camera = presentationCamera(state, origin, 16 / 9, clip), target = new Vector3(...state.center).sub(origin);
      const captured = capturePresentationCamera(camera, target, origin);
      expect(captured.facing).toBeCloseTo(130); expect(captured.tilt).toBeCloseTo(tilt); expect(captured.focus).toBeCloseTo(29);
      expect(captured.distance).toBeCloseTo(10); expect(captured.center).toEqual(state.center); expect(captured.perspective).toBe(perspective);
      expect(target.clone().project(camera).x).toBeCloseTo(0); expect(target.clone().project(camera).y).toBeCloseTo(0);
    }
  });
  it('follows Loch single-view rotation fallback and exports both endpoints only for non-looping multi-view animations', () => {
    const single = new PresentationTimeline([view({ rotations: 0 })], false);
    expect(single.duration).toBe(15); expect(single.frames(24).count).toBe(360); expect(single.sample(7.5).facing).toBe(180);
    const two = new PresentationTimeline([view(), view({ center: [1, 2, 3] })], false);
    const schedule = two.frames(2); expect(schedule.count).toBe(7); expect(two.sample(schedule.time(6)).center).toEqual([1, 2, 3]);
  });
  it('pauses elapsed playback during export/loading or hidden tabs, and stops at the final view', () => {
    const apply = vi.fn(), changed = vi.fn(), wake = { enabled: false };
    const player = new PresentationPlayer(apply, changed, wake as AnimationWakeLock);
    player.start(new PresentationTimeline([view(), view({ center: [1, 2, 3] })], false));
    player.update(0, false); player.update(1000, false); const first = apply.mock.calls.at(-1)![0];
    player.update(5000, true); player.update(10000, false); expect(apply.mock.calls.at(-1)![0]).toEqual(first);
    player.update(12000, false); expect(player.playing).toBe(false); expect(wake.enabled).toBe(false);
    expect(apply.mock.calls.at(-1)![0].sceneIndex).toBe(1); expect(changed.mock.calls).toEqual([[true], [false]]);
  });
});
