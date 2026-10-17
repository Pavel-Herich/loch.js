import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseLox } from '../src/lox';
import { READ_BYTES, streamLargeLox } from '../src/large-lox';
import { displayProjectTitle, SURVEY_TEXT_BYTES } from '../src/lox-title';

const demo = readFileSync('public/sample/demo.lox');
function survey(name: string, title: string) {
  const encoder = new TextEncoder(), n = encoder.encode(name + '\0'), t = encoder.encode(title + '\0');
  const data = new Uint8Array(40 + n.length + t.length), view = new DataView(data.buffer);
  [1, 24, 1, n.length + t.length, 1, 0, n.length, 0, n.length, t.length].forEach((v, i) => view.setUint32(i * 4, v, true));
  data.set(n, 40); data.set(t, 40 + n.length); return data;
}
function file(...parts: Uint8Array[]) {
  const bytes = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes.buffer;
}
async function large(data: ArrayBuffer) {
  return streamLargeLox(new Blob([data]), { progress() {}, async ready() {}, async batch() {} });
}

describe('project titles', () => {
  it('uses the first nonempty UTF-8 survey title after an empty root in both loaders', async () => {
    const data = file(demo, survey('survey', '  Jaskyňa Žľab — Cave  '), survey('child', 'Child title'));
    expect(parseLox(data).title).toBe('Jaskyňa Žľab — Cave');
    expect((await large(data)).title).toBe('Jaskyňa Žľab — Cave');
  });
  it('falls back to survey name or filename, with an absent or empty title', async () => {
    const data = file(demo, survey('  rabbit  ', ' '));
    expect(parseLox(data).title).toBe('rabbit'); expect((await large(data)).title).toBe('rabbit');
    const absent = file(demo);
    expect(parseLox(absent).title).toBeUndefined(); expect((await large(absent)).title).toBeUndefined();
    expect(displayProjectTitle(undefined, 'cave.LOX')).toBe('cave');
    expect(displayProjectTitle('  ', 'Sample cave')).toBe('Sample cave');
    expect(displayProjectTitle('Cave title', 'file.lox')).toBe('Cave title');
  });
  it('stops at the null terminator and preserves literal text for safe display', async () => {
    const data = file(demo, survey('name', '<img src=x>\0ignored text'));
    expect(parseLox(data).title).toBe('<img src=x>'); expect((await large(data)).title).toBe('<img src=x>');
  });
  it('rejects out-of-bounds survey text pointers in both loaders', async () => {
    const chunk = survey('name', 'title'); new DataView(chunk.buffer).setUint32(32, 0xffffffff, true);
    const data = file(chunk, demo);
    expect(() => parseLox(data)).toThrow('survey text pointer'); await expect(large(data)).rejects.toThrow('survey text pointer');
  });
  it('reads bounded text prefixes without pulling a large survey blob into memory', async () => {
    const header = new Uint8Array(40), view = new DataView(header.buffer), gap = READ_BYTES * 2;
    [1, 24, 1, gap, 0, 0, 0, 0, 0, gap].forEach((v, i) => view.setUint32(i * 4, v, true));
    const blob = new Blob([header, new TextEncoder().encode('A large project\0'), new Uint8Array(gap - 16), demo]);
    const reads: number[] = [];
    const model = await streamLargeLox({ size: blob.size, slice(start = 0, end = blob.size) {
      reads.push(end - start); return blob.slice(start, end);
    } }, { progress() {}, async ready() {}, async batch() {} });
    expect(model.title).toBe('A large project'); expect(reads).toContain(SURVEY_TEXT_BYTES);
    expect(Math.max(...reads)).toBeLessThanOrEqual(SURVEY_TEXT_BYTES);
  });
});
