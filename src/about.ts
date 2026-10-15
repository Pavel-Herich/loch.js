import { buildInfo } from './build-info';

export function initializeAbout() {
  const dialog = document.querySelector<HTMLDialogElement>('#about-dialog')!;
  document.querySelector('#app-version')!.textContent = buildInfo.version;
  document.querySelector('#build-commit')!.textContent = buildInfo.commit;
  const date = document.querySelector<HTMLTimeElement>('#build-date')!;
  date.dateTime = buildInfo.builtAt;
  date.textContent = new Date(buildInfo.builtAt).toUTCString();
  document.querySelector('#about-button')!.addEventListener('click', () => {
    if (!dialog.open) dialog.showModal();
  });
}
