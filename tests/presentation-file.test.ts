import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DOMParser } from '@xmldom/xmldom';
import { readPresentationXml } from '../src/presentation-file';

const xml = readFileSync('tests/fixtures/presentation-sumienka.lxa', 'utf8');
beforeEach(() => vi.stubGlobal('DOMParser', DOMParser));
afterEach(() => vi.unstubAllGlobals());

describe('animation file identification', () => {
  it.each(['tour.lxa', 'tour.xml', 'tour.lox', 'tour.txt', 'tour'])('identifies the XML root independently of filename (%s)', async filename => {
    expect(await readPresentationXml(new File([xml], filename))).toBe(xml);
  });
  it('accepts BOMs, declarations, comments, attributes and empty presentations', async () => {
    const source = '\ufeff<?xml version="1.0"?>\n<!-- Animation -->\n<LochPresentation loop-animation="false"/>';
    expect(await readPresentationXml(new Blob([source]))).toContain('<LochPresentation');
  });
  it('does not mistake XML names inside comments or child elements for the root', async () => {
    for (const source of ['<!-- <LochPresentation/> --><Other/>', '<Other><LochPresentation/></Other>']) {
      await expect(readPresentationXml(new Blob([source]))).rejects.toThrow('Expected a LochPresentation');
    }
  });
  it('does not classify binary or plain text by its extension or embedded XML strings', async () => {
    for (const source of [new Uint8Array([1, 0, 0, 0, 255, 0]), 'Not XML <LochPresentation/>']) {
      expect(await readPresentationXml(new File([source], 'misnamed.lxa'))).toBeUndefined();
    }
  });
  it('reads only a small prefix of a multi-gigabyte binary file', async () => {
    const slice = vi.fn(() => new Blob([new Uint8Array(512)])), text = vi.fn();
    const large = { size: 2322386032, slice, text } as unknown as Blob;
    expect(await readPresentationXml(large)).toBeUndefined();
    expect(slice).toHaveBeenCalledExactlyOnceWith(0, 512); expect(text).not.toHaveBeenCalled();
  });
  it('rejects oversized XML and entity declarations before parsing', async () => {
    const text = vi.fn(), large = { size: 2322386032, slice: () => new Blob(['<LochPresentation>']), text } as unknown as Blob;
    await expect(readPresentationXml(large)).rejects.toThrow('size limit'); expect(text).not.toHaveBeenCalled();
    await expect(readPresentationXml(new Blob(['<!DOCTYPE LochPresentation><LochPresentation/>']))).rejects.toThrow('unsupported animation XML');
  });
});
