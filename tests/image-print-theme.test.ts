import { describe, expect, it } from 'vitest';
import { BufferGeometry, Color, Group, LineBasicMaterial, LineSegments, Mesh, MeshBasicMaterial, Points, PointsMaterial, Scene } from 'three';
import { applyImageBackground, applyImagePrintTheme, setSceneBackground } from '../src/image-print-theme';

describe('white-background export colours', () => {
  it('toggles the on-screen view between pure black and white without changing altitude colours', () => {
    const scene = new Scene(); scene.background = new Color(0x000000);
    const centreline = new Group(), points = new PointsMaterial({ color: 0xffffff }), lines = new LineBasicMaterial({ vertexColors: true });
    centreline.add(new Points(new BufferGeometry(), points), new LineSegments(new BufferGeometry(), lines));
    setSceneBackground(scene, centreline, true, true);
    expect(scene.background.getHex()).toBe(0xffffff); expect(points.color.getHex()).toBe(0x162531); expect(lines.color.getHex()).toBe(0x162531);
    setSceneBackground(scene, centreline, true, false);
    expect(lines.color.getHex()).toBe(0xffffff); expect(points.color.getHex()).toBe(0x162531);
    setSceneBackground(scene, centreline, false, false);
    expect(scene.background.getHex()).toBe(0x000000); expect(points.color.getHex()).toBe(0xffffff);
  });
  it('exports without white background exactly as the view looks (its own dark background and colours)', () => {
    const scene = new Scene(), background = new Color(0x09131c); scene.background = background;
    const centreline = new Group(), points = new PointsMaterial({ color: 0xffffff });
    centreline.add(new Points(new BufferGeometry(), points));
    const restore = applyImageBackground(scene, centreline, true, false);
    expect(scene.background).toBe(background); expect(background.getHex()).toBe(0x09131c); expect(points.color.getHex()).toBe(0xffffff);
    restore();
    expect(scene.background).toBe(background);
  });
  it.each([false, true])('keeps cave colours, darkens print annotations and restores shared materials (default centreline %s)', defaultCentreline => {
    const scene = new Scene(), background = new Color('#09131c'); scene.background = background;
    const centreline = new Group(), points = new PointsMaterial({ color: 0xffffff });
    const lines = new LineBasicMaterial({ color: 0xffffff, vertexColors: true });
    const walls = new MeshBasicMaterial({ color: 0x44aabb });
    scene.add(centreline, new Mesh(new BufferGeometry(), walls));
    centreline.add(new Points(new BufferGeometry(), points), new LineSegments(new BufferGeometry(), lines), new LineSegments(new BufferGeometry(), lines));
    const restore = applyImagePrintTheme(scene, centreline, defaultCentreline);
    expect((scene.background as Color).getHex()).toBe(0xffffff);
    expect(points.color.getHex()).toBe(0x162531); expect(lines.color.getHex()).toBe(defaultCentreline ? 0x162531 : 0xffffff);
    expect(walls.color.getHex()).toBe(0x44aabb); expect(lines.vertexColors).toBe(true);
    restore();
    expect(scene.background).toBe(background); expect(points.color.getHex()).toBe(0xffffff); expect(lines.color.getHex()).toBe(0xffffff);
    expect(walls.color.getHex()).toBe(0x44aabb);
  });
});
