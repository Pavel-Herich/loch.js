import { describe, expect, it } from 'vitest';
import { decodeSurveyText } from '../src/lox-title';

describe('decodeSurveyText', () => {
  it('drops stray control characters such as U+009D after ť', () => {
    const bytes = new TextEncoder().encode('Javorová priepasť\u009d V2\0rest');
    expect(decodeSurveyText(bytes)).toBe('Javorová priepasť V2');
    expect(decodeSurveyText(new TextEncoder().encode('Jelenia priepas\u009dť'))).toBe('Jelenia priepasť');
  });
});
