/** lxFileSurvey: id, name pointer, parent id, title pointer (24 bytes). */
export const SURVEY_TEXT_BYTES = 64 * 1024;
type TextReference = { offset: number; size: number };
export function surveyTextReferences(data: DataView, start: number, dataSize: number) {
  function reference(position: number): TextReference {
    const offset = data.getUint32(position, true), size = data.getUint32(position + 4, true);
    if (offset > dataSize || size > dataSize - offset) throw new Error('Invalid survey text pointer');
    return { offset, size };
  }
  return { name: reference(start + 4), title: reference(start + 16) };
}
export function decodeSurveyText(bytes: Uint8Array) {
  const prefix = bytes.subarray(0, SURVEY_TEXT_BYTES), end = prefix.indexOf(0);
  // Drop control characters, e.g. a stray U+009D left after "ť" by a cp1250 mix-up in the source data.
  return new TextDecoder().decode(end < 0 ? prefix : prefix.subarray(0, end)).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b\ufeff]/g, '').trim();
}
export function displayProjectTitle(title: string | undefined, filename: string) {
  return title?.trim() || filename.replace(/\.(?:lox|3d|plt)$/i, '');
}
