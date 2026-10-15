export type LoadContext = {
  phase: string;
  file?: Pick<File, 'name' | 'size' | 'type' | 'lastModified'>;
  source?: string;
};

export function exceptionMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error) return String(error.message);
  return String(error);
}

export function formatLoadError(error: unknown, context: LoadContext): string {
  const lines = ['loch.js file-loading exception', `Time: ${new Date().toISOString()}`, `Phase: ${context.phase}`];
  if (context.file) {
    const file = context.file;
    lines.push(`File: ${file.name}`, `Size: ${file.size} bytes`, `Type: ${file.type || '(unspecified)'}`);
    lines.push(`Last modified: ${new Date(file.lastModified).toISOString()}`);
  }
  if (context.source) lines.push(`Source: ${context.source}`);
  if (typeof navigator !== 'undefined') lines.push(`Browser: ${navigator.userAgent}`);
  const seen = new Set<unknown>();
  let current = error;
  while (!seen.has(current)) {
    seen.add(current);
    lines.push('');
    if (typeof current !== 'object' || current === null) { lines.push(String(current)); break; }
    const detail = current as { name?: unknown; message?: unknown; stack?: unknown; code?: unknown; cause?: unknown };
    lines.push(`${detail.name || 'Error'}: ${exceptionMessage(current)}`);
    if (detail.code !== undefined) lines.push(`Code: ${String(detail.code)}`);
    if (detail.stack) lines.push(String(detail.stack));
    if (detail.cause === undefined) break;
    lines.push('Caused by:');
    current = detail.cause;
  }
  return lines.join('\n');
}

let dialog: HTMLDialogElement | undefined;
let log: HTMLTextAreaElement;
let copy: HTMLButtonElement;

function openErrorLog(text: string) {
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'error-details';
    dialog.setAttribute('aria-labelledby', 'error-details-title');
    const title = document.createElement('h2');
    title.id = 'error-details-title'; title.textContent = 'File-loading exception log';
    log = document.createElement('textarea');
    log.readOnly = true; log.spellcheck = false; log.setAttribute('aria-label', 'Exception log');
    const actions = document.createElement('div'); actions.className = 'error-actions';
    copy = document.createElement('button'); copy.type = 'button'; copy.textContent = 'Copy log';
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(log.value); copy.textContent = 'Copied'; }
      catch { log.focus(); log.select(); copy.textContent = 'Select log and copy'; }
    });
    const close = document.createElement('button'); close.type = 'button'; close.textContent = 'Close';
    close.addEventListener('click', () => dialog!.close());
    actions.append(copy, close); dialog.append(title, log, actions); document.body.append(dialog);
  }
  log.value = text; copy.textContent = 'Copy log';
  if (!dialog.open) dialog.showModal();
}

export function showLoadError(status: HTMLElement, error: unknown, context: LoadContext) {
  const text = formatLoadError(error, context);
  status.textContent = `Cannot read ${context.file?.name || context.source || 'sample'}: ${exceptionMessage(error)} `;
  const more = document.createElement('a');
  more.href = '#error-details'; more.textContent = '[more...]';
  more.setAttribute('aria-label', 'Show exception log');
  more.addEventListener('click', event => { event.preventDefault(); openErrorLog(text); });
  status.append(more);
  console.error(text, error);
}
