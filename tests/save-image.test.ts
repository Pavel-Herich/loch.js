import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureImage, imageFilename, initializeSaveImage } from '../src/save-image';
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
class Button extends EventTarget { disabled = false; click() { this.dispatchEvent(new Event('click')); } }
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

describe('PNG image saving', () => {
  it('derives safe PNG filenames from supported model filenames', () => {
    expect(imageFilename('cave.lox')).toBe('cave.png'); expect(imageFilename('cave.3D')).toBe('cave.png');
    expect(imageFilename('cave.plt')).toBe('cave.png'); expect(imageFilename('Sample cave')).toBe('Sample cave.png');
    expect(imageFilename('a/b:c?')).toBe('a_b_c_.png'); expect(imageFilename('')).toBe('loch.png');
  });
  it.each([false, true])('copies WebGL pixels immediately and includes only visible labels (hidden %s)', hidden => {
    const drawImage = vi.fn(), blob = new Blob(['PNG'], { type: 'image/png' });
    const canvas = { width: 0, height: 0, getContext: () => ({ drawImage }), toBlob: vi.fn((done: (blob: Blob) => void) => done(blob)) };
    vi.stubGlobal('document', { createElement: () => canvas });
    const view = { width: 1600, height: 1200, clientWidth: 800, clientHeight: 600 } as HTMLCanvasElement;
    const labels = { width: 800, height: 600, hidden } as HTMLCanvasElement;
    const result = captureImage(view, labels, []);
    expect(drawImage.mock.calls[0]).toEqual([view, 0, 0]); expect(drawImage).toHaveBeenCalledTimes(hidden ? 1 : 2);
    if (!hidden) expect(drawImage.mock.calls[1]).toEqual([labels, 0, 0, 1600, 1200]);
    return result.then(value => { expect(value).toBe(blob); expect(canvas.width * canvas.height).toBe(0); });
  });
  it('opens the save picker during the click and writes a PNG once', async () => {
    const button = new Button(), write = vi.fn(), close = vi.fn(), abort = vi.fn();
    const picker = vi.fn(async () => ({ createWritable: async () => ({ write, close, abort }) }));
    vi.stubGlobal('window', { showSaveFilePicker: picker });
    const blob = new Blob(['PNG'], { type: 'image/png' }), capture = vi.fn(async () => blob), error = vi.fn();
    const state = initializeSaveImage(button as unknown as HTMLButtonElement, capture, () => 'test.lox', error);
    button.click(); expect(picker).toHaveBeenCalledTimes(1); expect(picker.mock.calls[0]).toEqual([{ suggestedName: 'test.png', types: [{ description: 'PNG image', accept: { 'image/png': ['.png'] } }] }]);
    button.click(); await settle();
    expect(write).toHaveBeenCalledExactlyOnceWith(blob); expect(close).toHaveBeenCalledTimes(1);
    expect(abort).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled(); expect(state.busy).toBe(false);
  });
  it('treats save cancellation as a normal action and recovers from a synchronous picker failure', async () => {
    const button = new Button(), error = vi.fn();
    const picker = vi.fn().mockRejectedValueOnce(new DOMException('Cancelled', 'AbortError')).mockImplementationOnce(() => { throw new Error('Picker failed'); });
    vi.stubGlobal('window', { showSaveFilePicker: picker });
    const state = initializeSaveImage(button as unknown as HTMLButtonElement, async () => new Blob(), () => 'cave', error);
    button.click(); await settle(); expect(error).not.toHaveBeenCalled(); expect(state.busy).toBe(false);
    button.disabled = false; button.click(); await settle(); expect(error).toHaveBeenCalledWith(expect.objectContaining({ message: 'Picker failed' })); expect(state.busy).toBe(false);
  });
  it('uses an MP4 filename and MIME type for animation saving', async () => {
    const button = new Button(), write = vi.fn(), error = vi.fn();
    const picker = vi.fn(async () => ({ createWritable: async () => ({ write, close: vi.fn(), abort: vi.fn() }) }));
    vi.stubGlobal('window', { showSaveFilePicker: picker });
    const blob = new Blob(['MP4'], { type: 'video/mp4' });
    initializeSaveImage(button as unknown as HTMLButtonElement, async () => blob, () => 'test.lox', error, undefined, () => 'mp4');
    button.click(); await settle();
    expect(picker.mock.calls[0]).toEqual([{ suggestedName: 'test.mp4', types: [{ description: 'MP4 animation', accept: { 'video/mp4': ['.mp4'] } }] }]);
    expect(write).toHaveBeenCalledWith(blob); expect(error).not.toHaveBeenCalled();
  });
  it('downloads PNG when the save picker is unavailable and releases its object URL', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { setTimeout });
    const link = { click: vi.fn(), remove: vi.fn(), download: '', href: '', hidden: false };
    vi.stubGlobal('document', { createElement: () => link, body: { append: vi.fn() } });
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test'); const revoke = vi.spyOn(URL, 'revokeObjectURL');
    const button = new Button(), error = vi.fn();
    initializeSaveImage(button as unknown as HTMLButtonElement, async () => new Blob(['PNG']), () => 'cave.lox', error);
    button.click(); await settle(); expect(link.download).toBe('cave.png'); expect(link.click).toHaveBeenCalledTimes(1); expect(link.remove).toHaveBeenCalledTimes(1);
    expect(revoke).not.toHaveBeenCalled(); vi.runAllTimers(); expect(revoke).toHaveBeenCalledWith('blob:test'); expect(error).not.toHaveBeenCalled();
  });
});
