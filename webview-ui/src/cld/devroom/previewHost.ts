/** P4 S6: whether THIS screen is the PC whose localhost the dev servers listen on. */
import { loopbackUrl, scanDevUrl } from '../../../../core/src/cld/devUrl.js';
import { MOBILE_MEDIA_QUERY } from '../../constants.js';
import { t } from '../../i18n/index.js';

/**
 * The page is served from this machine: the daemon's own PC, or the desktop app beside it.
 * ponytail: the desktop app on a laptop that reaches a remote host through its SSH forward also
 * reads as loopback; its localhost is then not the host's. Tell them apart if that bites.
 */
export const onThisPc = (hostname: string = window.location.hostname): boolean =>
  ['localhost', '127.0.0.1', '[::1]'].includes(hostname);

/** The preview can open here: this PC and not the phone shell. */
export const canPreviewHere = (): boolean => onThisPc() && !window.matchMedia(MOBILE_MEDIA_QUERY).matches;

/** The address a box's text means: a loopback URL, or a pasted log line holding one; else why not. */
export function previewAddress(text: string, ownPort: string): { url: string } | { error: string } {
  const url = scanDevUrl(text) ?? loopbackUrl(text);
  if (!url) return { error: t('preview.refused') };
  // The office's own port under any loopback name (cookies and the token page are shared by name, not port).
  return new URL(url).port === ownPort ? { error: t('preview.self') } : { url };
}
