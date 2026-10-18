import type { Point } from './lox';
import { SurveyModel, surveyText, survexShotFlags } from './survey-model';
import type { LRUD } from './lrud';

/** Survex binary .3d versions 3–8; https://survex.com/docs/3dformat.htm */
export function parseSurvex(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer), view = new DataView(buffer), model = new SurveyModel();
  let offset = 0;
  const check = (length: number) => {
    if (!Number.isSafeInteger(length) || length < 0 || length > bytes.length - offset) throw new Error('Truncated or corrupt Survex .3d file');
  };
  const byte = () => { check(1); return bytes[offset++]; };
  const skip = (length: number) => { check(length); offset += length; };
  const uint = (width: 2 | 4) => { check(width); const value = width === 2 ? view.getUint16(offset, true) : view.getUint32(offset, true); offset += width; return value; };
  const line = () => {
    const end = bytes.indexOf(10, offset);
    if (end < 0) throw new Error('Truncated Survex .3d header');
    const result = surveyText(bytes.subarray(offset, end)); offset = end + 1; return result;
  };
  const point = (): Point => {
    check(12); const p: Point = [view.getInt32(offset, true) / 100, view.getInt32(offset + 4, true) / 100, view.getInt32(offset + 8, true) / 100];
    offset += 12; return p;
  };
  if (line() !== 'Survex 3D Image File') throw new Error('Not a Survex .3d file');
  const versionText = line(), version = /^v[3-8]$/.test(versionText) ? Number(versionText.slice(1)) : 0;
  if (!version) throw new Error(`Unsupported Survex .3d version: ${versionText} (supported: v3–v8)`);
  const metadata = line().split('\0'), title = metadata[0], separator = version === 8 ? metadata[2] || '.' : '.';
  line(); // File generation timestamp.
  if (version === 8) byte(); // File-wide flags (including extended elevation).
  let label: Uint8Array<ArrayBufferLike> = new Uint8Array(0), current: Point | undefined, style = -1, stopped = false;
  const stationPositions = new Map<string, Point>();
  let previousSection: { point: Point; dimensions: LRUD } | undefined, passage = 0;
  function append(remove: number, add: number) {
    if (remove > label.length) throw new Error('Invalid Survex label prefix');
    check(add);
    const next = new Uint8Array(label.length - remove + add);
    next.set(label.subarray(0, label.length - remove)); next.set(bytes.subarray(offset, offset + add), label.length - remove);
    offset += add; label = next;
  }
  function readLabel() {
    const packed = byte();
    if (version === 8) {
      const length = () => { const value = byte(); return value === 255 ? uint(4) : value; };
      if (packed) append(packed >> 4, packed & 15);
      else { const remove = length(), add = length(); append(remove, add); }
    } else {
      append(0, packed === 254 ? 254 + uint(2) : packed === 255 ? uint(4) : packed);
    }
  }
  function addLabel(code: number) {
    readLabel();
    const position = point(), parts = surveyText(label).split(separator), name = parts.pop() ?? '';
    stationPositions.set(surveyText(label), position);
    // Underground wins at entrances which belong to both surface and cave legs.
    const flags = (code & 1 && !(code & 2) ? 1 : 0) | (code & 4 ? 2 : 0) | (code & 16 ? 4 : 0);
    model.station(version === 8 && code & 0x60 ? '-' : name, position, parts, flags);
  }
  function crossSection(code: number) {
    readLabel(); const width = code < 0x32 ? 2 : 4;
    check(width * 4);
    const dimensions = Array.from({ length: 4 }, (_, i) => (width === 2
      ? view.getInt16(offset + i * width, true) : view.getInt32(offset + i * width, true)) / 100) as LRUD;
    offset += width * 4;
    const name = surveyText(label), position = stationPositions.get(name);
    if (!position) throw new Error(`Survex cross-section references an unknown station: ${name}`);
    if (previousSection) model.passage(previousSection.point, position, previousSection.dimensions, dimensions, `survex:${passage}`);
    previousSection = code & 1 ? undefined : { point: position, dimensions };
    if (code & 1) passage++;
  }
  while (offset < bytes.length && !stopped) {
    const code = byte();
    if (code === 15) { current = model.point(point()); continue; }
    if (version === 8) {
      if (code <= 4) { if (code === 0 && style === 0) stopped = true; else style = code; }
      else if (code === 0x10) { /* No date. */ }
      else if (code >= 0x11 && code <= 0x13) skip(code - 0x0f);
      else if (code === 0x1f) skip(20);
      else if (code >= 0x30 && code <= 0x33) crossSection(code);
      else if (code >= 0x80) addLabel(code);
      else if (code >= 0x40) {
        if (!(code & 0x20)) readLabel();
        const next = point();
        if (!current) throw new Error('Survex LINE without a preceding MOVE');
        model.shot(current, next, survexShotFlags(code)); current = next;
      } else throw new Error(`Invalid Survex .3d record: 0x${code.toString(16)}`);
    } else {
      if (code === 0) { if (!label.length) stopped = true; else label = new Uint8Array(0); }
      else if (code < 15) {
        let index = label.length - 18, levels = code;
        while (index >= 0) { if (label[index] === 46 && --levels === 0) break; index--; }
        if (index < 0) throw new Error('Invalid Survex label trim');
        label = label.subarray(0, index + 1);
      } else if (code < 0x20) {
        const remove = code - 15;
        if (remove >= label.length) throw new Error('Invalid Survex label trim');
        label = label.subarray(0, label.length - remove);
      } else if (code === 0x20 && version >= 4) skip(version < 7 ? 4 : 2);
      else if (code === 0x21 && version >= 4) skip(version < 7 ? 8 : 3);
      else if (code === 0x22 && version >= 6) skip(20);
      else if (code === 0x23 && version >= 7) skip(4);
      else if (code === 0x24 && version >= 7) { /* No date. */ }
      else if (code >= 0x30 && code <= 0x33 && version >= 5) crossSection(code);
      else if (code >= 0x40 && code <= 0x7f) addLabel(code);
      else if (code >= 0x80 && code <= 0xbf) {
        readLabel(); const next = point();
        if (!current) throw new Error('Survex LINE without a preceding MOVE');
        model.shot(current, next, survexShotFlags(code)); current = next;
      } else throw new Error(`Invalid Survex .3d record: 0x${code.toString(16)}`);
    }
  }
  if (!stopped) throw new Error('Truncated Survex .3d file: missing end marker');
  return model.finish(title);
}
