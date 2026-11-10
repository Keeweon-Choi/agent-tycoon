/**
 * DESKTOP-ACTIONS: the Agent Tycoon desktop app (Tauri 2, WebView2 on Windows) shows this page with
 * its IPC bridge; a browser never has it. The app has no second window and no share sheet.
 */
import { APP_DOWNLOAD_EVENT, TOGGLE_FULLSCREEN_COMMAND } from '../constants.js';
import { t } from '../i18n/index.js';
import { agtyOwnToast } from './officeStore.js';

export const isDesktopApp = (): boolean =>
  typeof window !== 'undefined' &&
  typeof (window as Window & { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__
    ?.invoke === 'function';

/** The app's own F11 command. An app older than 11-04 refuses it for an office reached by address
 *  (office-keys allowed only localhost): the settings button then says so instead of doing nothing. */
export function toggleAppFullscreen(): void {
  const bridge = (window as Window & { __TAURI_INTERNALS__?: { invoke?: (cmd: string) => Promise<unknown> } })
    .__TAURI_INTERNALS__;
  bridge?.invoke?.(TOGGLE_FULLSCREEN_COMMAND).catch((e: unknown) => {
    console.warn('[Webview] toggle_fullscreen', e);
    agtyOwnToast(t('windowMode.title'), t('windowMode.refused'), 'error');
  });
}

/** The page cannot ask the window (no is_fullscreen permission): a page as big as the screen is full screen.
 *  ponytail: a borderless window the size of the screen reads as full screen too; ask the app if that matters. */
export const pageFillsScreen = (): boolean =>
  window.innerWidth >= window.screen.width && window.innerHeight >= window.screen.height;

/** The app saves every download into the user's Downloads folder and says here how it ended. */
export function listenForAppDownloads(): () => void {
  const ended = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail as { name?: unknown; ok?: unknown } | null;
    if (!detail || typeof detail.ok !== 'boolean') return;
    const name = typeof detail.name === 'string' ? detail.name : '';
    agtyOwnToast(
      t('desktopActions.downloadTitle'),
      detail.ok ? t('desktopActions.downloaded', { name }) : t('desktopActions.downloadFailed'),
      detail.ok ? 'ok' : 'error',
    );
  };
  window.addEventListener(APP_DOWNLOAD_EVENT, ended);
  return () => window.removeEventListener(APP_DOWNLOAD_EVENT, ended);
}
