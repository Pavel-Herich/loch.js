import { parseLox } from './lox';
import { parseSurvex } from './survex';
import { parseCompass } from './compass';

export function modelFileFormat(filename: string): 'lox' | '3d' | 'plt' | undefined {
  const extension = filename.split('.').at(-1)?.toLowerCase();
  return extension === 'lox' || extension === '3d' || extension === 'plt' ? extension : undefined;
}
export function parseModelFile(buffer: ArrayBuffer, filename: string) {
  switch (modelFileFormat(filename)) {
    case 'lox': return parseLox(buffer);
    case '3d': return parseSurvex(buffer);
    case 'plt': return parseCompass(buffer);
    default: throw new Error('Unsupported file type. Open a .lox, .3d or .plt file.');
  }
}
