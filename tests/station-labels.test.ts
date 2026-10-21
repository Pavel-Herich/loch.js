import { describe, expect, it, vi } from 'vitest';
import { OrthographicCamera, PerspectiveCamera, Vector3 } from 'three';
import { StationLabels } from '../src/station-labels';
import type { Station } from '../src/lox-stations';

function station(name: string, x = 0, comment?: string): Station {
  return { id: 1, surveyId: 0, name, comment, position: [x, 0, -10], flags: 0, survey: '', fullSurvey: '' };
}
function setup(stations: Station[]) {
  const context = { setTransform: vi.fn(), clearRect: vi.fn(), strokeText: vi.fn(), fillText: vi.fn(),
    measureText: vi.fn((text: string) => ({ width: text.length * 7 })) };
  const canvas = { hidden: true, width: 0, height: 0, getContext: () => context } as unknown as HTMLCanvasElement;
  const labels = new StationLabels(canvas);
  labels.setStations(stations); labels.setVisible(true);
  return { labels, context, canvas };
}

describe('bounded, non-overlapping station labels', () => {
  it.each(['perspective', 'orthographic'])('prioritizes commented stations and skips overlapping labels with a %s camera', type => {
    const { labels, context } = setup([station('ordinary'), station('priority', 0, 'Entrance'), station('separate', -3)]);
    const camera = type === 'perspective' ? new PerspectiveCamera(45, 4 / 3, .1, 100) : new OrthographicCamera(-8, 8, 6, -6, .1, 100);
    labels.draw(camera, 800, 600, new Vector3(), 'number', () => true);
    expect(context.fillText.mock.calls.map(call => call[0])).toEqual(['priority', 'separate']);
    context.fillText.mockClear();
    labels.draw(camera, 800, 600, new Vector3(), 'comments', () => true);
    expect(context.fillText.mock.calls.map(call => call[0])).toEqual(['Entrance']);
    context.fillText.mockClear(); camera.position.x = 100;
    labels.draw(camera, 800, 600, new Vector3(), 'number', () => true);
    expect(context.fillText).not.toHaveBeenCalled();
  });

  it('rejects labels whose full measured width overlaps an earlier label', () => {
    const { labels, context } = setup([station('A'.repeat(30), -1), station('B', 0)]);
    labels.draw(new PerspectiveCamera(45, 4 / 3, .1, 100), 800, 600, new Vector3(), 'number', () => true);
    expect(context.fillText).toHaveBeenCalledTimes(1);
  });

  it('handles 100,000 coincident stations without measuring or allocating a texture for every label', () => {
    const stations = Array.from({ length: 100_000 }, (_, i) => station(String(i)));
    stations.push(station('priority', 0, 'Entrance'));
    const { labels, context, canvas } = setup(stations);
    const camera = new PerspectiveCamera(45, 4 / 3, .1, 100);
    labels.draw(camera, 800, 600, new Vector3(), 'number', () => true);
    expect(context.fillText).toHaveBeenCalledExactlyOnceWith('priority', 405, 300);
    expect(context.measureText).toHaveBeenCalledTimes(1);
    labels.draw(camera, 800, 600, new Vector3(), 'number', () => true);
    expect(context.fillText).toHaveBeenCalledTimes(2);
    expect(canvas.width * canvas.height).toBeLessThanOrEqual(8_400_000);
    labels.clear(); expect(canvas.hidden).toBe(true); expect(canvas.width * canvas.height).toBe(0);
  });

  it('shortens long comments and excludes filtered and behind-camera stations', () => {
    const { labels, context } = setup([station('filtered', -3, 'filtered'),
      { ...station('behind', 0, 'behind'), position: [0, 0, 10] }, station('long', 0, 'Very long comment '.repeat(1000))]);
    labels.draw(new PerspectiveCamera(45, 4 / 3, .1, 100), 800, 600, new Vector3(), 'comments', s => s.name !== 'filtered');
    expect(context.fillText).toHaveBeenCalledTimes(1);
    const [text, x] = context.fillText.mock.calls[0] as unknown as [string, number];
    expect(text.endsWith('…')).toBe(true); expect(text.length * 7).toBeLessThanOrEqual(360);
    expect(x + text.length * 7).toBeLessThanOrEqual(800);
    expect(context.measureText.mock.calls.every(([text]) => text.length <= 257)).toBe(true);
  });

  it('caps the backing canvas on very large displays', () => {
    const { labels, canvas } = setup([]);
    vi.stubGlobal('devicePixelRatio', 3);
    try {
      labels.draw(new PerspectiveCamera(), 7680, 4320, new Vector3(), 'number', () => true);
      expect(canvas.width * canvas.height).toBeLessThan(8_400_000);
    } finally { vi.unstubAllGlobals(); }
  });
});
