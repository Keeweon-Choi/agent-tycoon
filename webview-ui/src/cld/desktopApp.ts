/**
 * DESKTOP-ACTIONS: the Agent Tycoon desktop app (Tauri 2, WebView2 on Windows) shows this page with
 * its IPC bridge; a browser never has it. The app has no second window and no share sheet.
 */
import { APP_DOWNLOAD_EVENT } from '../constants.js';
import { t } from '../i18n/index.js';
import { cldOwnToast } from './officeStore.js';

export const isDesktopApp = (): boolean =>
  typeof window !== 'undefined' &&
  typeof (window as Window & { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__
    ?.invoke === 'function';

/** The app saves every download into the user's Downloads folder and says here how it ended. */
export function listenForAppDownloads(): () => void {
  const ended = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail as { name?: unknown; ok?: unknown } | null;
    if (!detail || typeof detail.ok !== 'boolean') return;
    const name = typeof detail.name === 'string' ? detail.name : '';
    cldOwnToast(
      t('desktopActions.downloadTitle'),
      detail.ok ? t('desktopActions.downloaded', { name }) : t('desktopActions.downloadFailed'),
      detail.ok ? 'ok' : 'error',
    );
  };
  window.addEventListener(APP_DOWNLOAD_EVENT, ended);
  return () => window.removeEventListener(APP_DOWNLOAD_EVENT, ended);
}
