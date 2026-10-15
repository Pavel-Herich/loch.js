import { describe, expect, it } from 'vitest';
import { exceptionMessage, formatLoadError } from '../src/errors';

describe('file-loading exception logs', () => {
  it('records read failures with the exact file size, phase, and DOMException', () => {
    const error = new DOMException('The requested file could not be read', 'NotReadableError');
    const text = formatLoadError(error, {
      phase: 'Reading file',
      file: { name: 'domica-10cm.lox', size: 2160000000, type: '', lastModified: 0 },
    });
    expect(text).toContain('Phase: Reading file');
    expect(text).toContain('File: domica-10cm.lox');
    expect(text).toContain('Size: 2160000000 bytes');
    expect(text).toContain('NotReadableError: The requested file could not be read');
    expect(text).toContain(`Code: ${error.code}`);
    if (error.stack) expect(text).toContain(error.stack);
  });

  it('preserves stack traces and causes for parsing errors', () => {
    const cause = new Error('Truncated record');
    const error = new Error('Cannot parse chunk', { cause });
    const text = formatLoadError(error, { phase: 'Parsing LOX', source: '/sample/demo.lox' });
    expect(text).toContain('Source: /sample/demo.lox');
    expect(text).toContain(error.stack);
    expect(text).toContain('Caused by:');
    expect(text).toContain(cause.stack);
  });

  it('handles non-Error exceptions and circular causes', () => {
    expect(exceptionMessage('Read failed')).toBe('Read failed');
    expect(formatLoadError(null, { phase: 'Reading file' })).toContain('null');
    const error = new Error('Circular') as Error & { cause: unknown };
    error.cause = error;
    expect(formatLoadError(error, { phase: 'Reading file' }).length).toBeLessThan(10000);
  });
});
