/**
 * The login page (T-0022): the only page a client without a session gets.
 * Static HTML from the server; /login/login.js (webview-ui/src/cld/login,
 * bundled by esbuild.js) only formats the code and adds the passkey and
 * approval buttons, so typing a code works without script.
 *
 * Its URLs are relative (T-0024): behind the direct connector the page lives
 * under `/<secret>/`, and a browser fetches the manifest without cookies, so
 * only a path under the secret reaches it there.
 */
import type { FastifyReply } from 'fastify';

import {
  fillText,
  koText,
  SERVER_TEXT,
  type ServerTextCode,
  textIn,
  type TextLang,
} from '../../../core/src/cld/serverText.js';

/** No inline script or style, no framing, nothing cached. */
const HEADERS = {
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; manifest-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'x-frame-options': 'DENY',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
};

export const LOGIN_ERRORS = {
  badCode: koText('login_bad_code'),
  tooMany: koText('login_too_many'),
  passkeyUnbound: koText('login_passkey_unbound'),
} as const;

/**
 * The page's language from the browser's Accept-Language: Korean when it asks for Korean first,
 * English otherwise. A client that sends none at all (not a browser) gets the page as it always was.
 */
export function pageLanguage(header: string | string[] | undefined): TextLang {
  const first = (Array.isArray(header) ? header[0] : header)?.split(',')[0]?.trim().toLowerCase();
  return first === undefined || first.startsWith('ko') ? 'ko' : 'en';
}

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );

export interface LoginPageOptions {
  error?: string;
  /** Default device label for the approval request (from the User-Agent). */
  label: string;
  /** This host has passkeys: offer the passkey button. */
  passkey?: boolean;
  /** --allow-approval-requests: offer the approval button. */
  approval?: boolean;
  /** T-0034: the script first tries a silent re-login with this browser's device key. */
  device?: boolean;
  /** I1: the language of the words in the page (the script that follows follows the browser). */
  lang?: TextLang;
}

export function loginPage({
  error = '',
  label,
  passkey,
  approval,
  device,
  lang = 'en',
}: LoginPageOptions): string {
  const w = (code: ServerTextCode) => SERVER_TEXT[code][lang];
  const app = w('app_name');
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="no-referrer">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="${escapeHtml(app)}">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" type="image/png" href="icons/icon-256.png?v=2">
<link rel="apple-touch-icon" href="icons/icon-256.png?v=2">
<title>${escapeHtml(fillText(w('login_title'), { app }))}</title>
<link rel="stylesheet" href="login/login.css">
<script type="module" src="login/login.js"></script>
</head>
<body>
<main class="login" data-label="${escapeHtml(label)}"${device ? ' data-device="1"' : ''}>
<h1>${escapeHtml(app)}</h1>
<form class="card" method="post" action="login">
<label for="code">${escapeHtml(w('login_code_label'))}</label>
<input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" placeholder="1234 5678" spellcheck="false" autocapitalize="off" required autofocus>
<p class="error" id="error" role="alert">${escapeHtml(textIn(lang, error))}</p>
<button type="submit" class="primary">${escapeHtml(w('login_submit'))}</button>
<p class="hint">${fillText(escapeHtml(w('login_hint')), { add: `<b>${escapeHtml(w('login_add_device'))}</b>`, cmd: '<code>cld-gui-login</code>' })}</p>
</form>
<div class="others">
${passkey ? `<button type="button" id="passkey" hidden>${escapeHtml(w('login_passkey'))}</button>\n` : ''}${approval ? `<button type="button" id="approval" class="small" hidden>${escapeHtml(w('login_approval'))}</button>\n` : ''}</div>
<section class="card" id="approval-panel" hidden></section>
</main>
</body>
</html>
`;
}

/**
 * A hop to the app from this origin (T-0034). A move starts on another
 * origin, so its whole navigation is cross-site: the SameSite=Strict cookie
 * set on it is kept but not sent on its redirect. A navigation this page
 * starts is same-site, so the cookie goes along.
 */
export function sendEnterPage(reply: FastifyReply): FastifyReply {
  return reply
    .code(200)
    .headers(HEADERS)
    .type('text/html; charset=utf-8')
    .send(
      '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta http-equiv="refresh" content="0;url=/">\n<title>cld-gui</title>\n</head>\n<body></body>\n</html>\n',
    );
}

export function sendLoginPage(
  reply: FastifyReply,
  status: number,
  options: LoginPageOptions,
): FastifyReply {
  return reply
    .code(status)
    .headers(HEADERS)
    .type('text/html; charset=utf-8')
    .send(loginPage(options));
}
