export function setStatusText(status: HTMLElement, text: string) {
  const message = document.createElement('span');
  message.className = 'status-message'; message.textContent = text;
  status.replaceChildren(message); status.title = text;
}

export function setStatusProgress(status: HTMLElement, fraction?: number | null) {
  status.classList.toggle('loading', fraction !== undefined);
  status.classList.toggle('indeterminate', fraction === null);
  status.style.setProperty('--progress', `${Math.max(0, Math.min(1, fraction ?? 0)) * 100}%`);
  status.setAttribute('aria-busy', String(fraction !== undefined));
}
