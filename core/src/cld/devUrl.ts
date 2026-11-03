/**
 * P4 S6 미리보기: which URLs the preview may load. One rule for the screen and the daemon: a dev
 * server on THIS machine (loopback), http or https, no credentials. Never a proxy, never anything
 * else: the iframe loads it directly and a different port is a different origin, so the page cannot
 * read the office's token. Pure, no runtime side effects.
 */
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];
/** The office page's CSP `frame-src`: the preview's iframe may load loopback pages and nothing else.
 *  CSP host sources have no IPv6 literal (Chrome logs `http://[::1]:*` as invalid and drops it), so
 *  `[::1]` is left out here: such a dev server still opens in its own window. */
export const FRAME_SRC_LOOPBACK = LOOPBACK.filter((h) => !h.startsWith('['))
  .flatMap((h) => [`http://${h}:*`, `https://${h}:*`])
  .join(' ');
const URL_AT = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?![\w.@-])(?::\d{1,5})?(?:\/[^\s"'<>]*)?/gi;
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
/** A `Network:` line (Vite, Next, CRA): the dev server is reachable from the LAN. */
const NETWORK = /Network:\s*(https?:\/\/\S+)/gi;

/** The normalised loopback URL `text` names (`localhost:5173`, `http://127.0.0.1:3000/x`), or null. */
export function loopbackUrl(text: string): string | null {
  const raw = text.trim();
  if (!raw || /[\s\u0000-\u001f]/.test(raw)) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
    const ok =
      (u.protocol === 'http:' || u.protocol === 'https:') &&
      LOOPBACK.includes(u.hostname) &&
      !u.username &&
      !u.password;
    return ok ? u.href : null;
  } catch {
    return null;
  }
}

/** The LAST loopback URL in a dev server's output (colours stripped), or null. */
export function scanDevUrl(output: string): string | null {
  const hits = output.replace(ANSI, '').match(URL_AT);
  return hits ? loopbackUrl(hits[hits.length - 1].replace(/[.,;)]+$/, '')) : null;
}

/** The output says the dev server listens on the network too (a `Network:` URL that is not loopback). */
export function devServerExposed(output: string): boolean {
  const clean = output.replace(ANSI, '');
  return [...clean.matchAll(NETWORK)].some((m) => loopbackUrl(m[1]) === null);
}
