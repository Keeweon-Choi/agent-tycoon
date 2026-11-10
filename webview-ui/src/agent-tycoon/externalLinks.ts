import { terminalLinkOpener } from '../terminal/terminalLinks.js';

/**
 * G2: inside an installed web app a link to another origin must never replace the app (there is
 * no address bar to come back with). The ONE place that decides: a link to this page's own origin
 * is left to the browser, another http(s) origin opens in a new window with no opener and no
 * Referer (the page URL carries the server token), anything else (javascript:, data:, file:,
 * custom schemes, unparsable) is refused. Opening reuses the terminal's safe opener.
 */
export type LinkAction = 'same' | 'open' | 'refuse';

export function linkAction(href: string, pageUrl: string): LinkAction {
  try {
    const url = new URL(href, pageUrl);
    // blob: carries its creator's origin, so a same-origin download link stays "same".
    if (url.origin === new URL(pageUrl).origin) return 'same';
    return url.protocol === 'http:' || url.protocol === 'https:' ? 'open' : 'refuse';
  } catch {
    return 'refuse';
  }
}

const openLink = terminalLinkOpener((url, target, features) => window.open(url, target, features));

/** Open `url` in the system browser (http and https only; anything else is ignored). */
export const openExternal = (url: string): void => openLink(null, url);

/** Browser runtime only: every anchor click goes through `linkAction`. */
export function installExternalLinks(): () => void {
  const onClick = (e: MouseEvent) => {
    const a = (e.target as Element | null)?.closest?.('a[href]');
    if (!a || e.defaultPrevented) return;
    const href = a.getAttribute('href') ?? '';
    const action = linkAction(href, window.location.href);
    if (action === 'same') return;
    e.preventDefault();
    if (action === 'open') openExternal(new URL(href, window.location.href).href);
  };
  document.addEventListener('click', onClick, true);
  return () => document.removeEventListener('click', onClick, true);
}
