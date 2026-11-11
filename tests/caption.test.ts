import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { Presentation } from '../src/presentation';
import { imageFilename } from '../src/save-image';

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
});
