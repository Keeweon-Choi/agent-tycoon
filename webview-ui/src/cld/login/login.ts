/**
 * The login page's script (T-0022), bundled by esbuild.js to dist/login/login.js
 * and served without a session. Typing a code works without it; it keeps the
 * code in the "1234 5678" shape and adds the passkey button and the approval
 * request when the server offers them. First of all (T-0034) it tries a
 * silent re-login with this browser's device key.
 */
import { browserSupportsWebAuthn, startAuthentication } from '@simplewebauthn/browser';

import { OPEN_TARGET_KEY, parseNoticeUrl } from '../../../../core/src/cld/notices.js';
import { t } from '../../i18n/index.js';
import { loadDevice, proveDevice, signChallenge } from '../auth/deviceKey.js';
import { serverText } from '../serverText.js';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;

// T-0043: a notice's target (`/?open=…` from a push) survives the login: the
// app opens it once logged in, whichever way the login goes back to '/'.
try {
  if (parseNoticeUrl(location.search)) sessionStorage.setItem(OPEN_TARGET_KEY, location.search);
} catch {
  // No storage: the office opens without it.
}
const errorLine = $<HTMLParagraphElement>('error');

// ── Silent re-login with this browser's device key (T-0034) ──
if (document.querySelector<HTMLElement>('main')?.dataset.device === '1') void silentLogin();

/** No input: a key this browser holds signs the server's nonce. Any failure leaves the page as it is. */
async function silentLogin(): Promise<void> {
  const device = await loadDevice();
  if (!device) return;
  const status = el(
    'p',
    { class: 'hint', id: 'device-status', role: 'status' },
    t('login.reconnecting'),
  );
  document.querySelector('h1')?.after(status);
  try {
    if ((await proveDevice(device, '/login/device')).ok) return location.replace('/');
  } catch {
    // Offline: the normal login page.
  }
  status.remove();
}

function showError(text: string): void {
  if (errorLine) errorLine.textContent = text;
}

async function post<T>(url: string, body: unknown = {}): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(serverText(data, t('login.requestFailed', { status: res.status })));
  return data;
}

// ── The code ──
const input = $<HTMLInputElement>('code');
input?.addEventListener('input', () => {
  // Digits and spaces only: a pasted long code (letters) is left alone.
  if (!/^[\d\s]*$/.test(input.value)) return;
  const digits = input.value.replace(/\D/g, '').slice(0, 8);
  const shaped = digits.length > 4 ? `${digits.slice(0, 4)} ${digits.slice(4)}` : digits;
  if (shaped !== input.value) input.value = shaped;
});

// ── Passkey ──
const passkey = $<HTMLButtonElement>('passkey');
if (passkey && browserSupportsWebAuthn()) {
  passkey.hidden = false;
  passkey.addEventListener('click', async () => {
    passkey.disabled = true;
    showError('');
    try {
      const { ceremony, options } = await post<{ ceremony: string; options: never }>(
        '/login/passkey/options',
      );
      const response = await startAuthentication({ optionsJSON: options });
      // S5: a passkey tied to no device (made before devices were tracked) logs in
      // only together with this browser's registered device key.
      const stored = await loadDevice();
      const proof = stored ? await signChallenge(stored).catch(() => null) : null;
      await post('/login/passkey', {
        ceremony,
        response,
        ...(proof && 'nonce' in proof ? { device: proof } : {}),
      });
      location.replace('/');
    } catch (err) {
      showError(
        err instanceof Error && err.name !== 'NotAllowedError'
          ? err.message
          : t('login.passkeyCanceled'),
      );
      passkey.disabled = false;
    }
  });
}

// ── Approval request (only when the daemon allows it) ──
const approval = $<HTMLButtonElement>('approval');
const panel = $<HTMLElement>('approval-panel');
if (approval && panel) {
  approval.hidden = false;
  approval.addEventListener('click', () => {
    approval.hidden = true;
    askForm(panel);
  });
}

function askForm(box: HTMLElement): void {
  const label = document.querySelector<HTMLElement>('main')?.dataset.label ?? '';
  box.hidden = false;
  box.replaceChildren(
    el('label', { for: 'device-label' }, t('login.deviceName')),
    el('input', { id: 'device-label', class: 'label', maxlength: '40', value: label }),
    el('p', { class: 'hint' }, t('login.approvalHint')),
    el('button', { type: 'button', class: 'primary', id: 'approval-send' }, t('login.sendApproval')),
  );
  $<HTMLButtonElement>('approval-send')?.addEventListener('click', async () => {
    showError('');
    try {
      const name = $<HTMLInputElement>('device-label')?.value ?? label;
      const { secret, code, expiresIn } = await post<{
        secret: string;
        code: string;
        expiresIn: number;
      }>('/login/approval', { label: name });
      waiting(box, secret, code, expiresIn);
    } catch (err) {
      showError(err instanceof Error ? err.message : String(err));
    }
  });
}

/** Show the code and poll until a logged-in device answers. */
function waiting(box: HTMLElement, secret: string, code: string, expiresIn: number): void {
  const until = Date.now() + expiresIn * 1000;
  const status = el('p', { class: 'hint', 'aria-live': 'polite' }, '');
  box.replaceChildren(
    el('p', {}, t('login.enterCode')),
    el('p', { class: 'big-code', id: 'approval-code' }, `${code.slice(0, 3)} ${code.slice(3)}`),
    el('p', { class: 'warning' }, t('login.codeWarning')),
    status,
  );
  const tick = window.setInterval(async () => {
    const left = Math.max(0, Math.ceil((until - Date.now()) / 1000));
    status.textContent = t('login.waiting', { time: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` });
    try {
      const { state } = await post<{ state: string }>('/login/approval/poll', { secret });
      if (state === 'pending') return;
      window.clearInterval(tick);
      if (state === 'approved') location.replace('/');
      else again(box, state === 'refused' ? t('login.refused') : t('login.expired'));
    } catch (err) {
      window.clearInterval(tick);
      again(box, err instanceof Error ? err.message : String(err));
    }
  }, 2000);
}

function again(box: HTMLElement, why: string): void {
  box.replaceChildren(
    el('p', { class: 'error' }, why),
    el('button', { type: 'button', class: 'small', id: 'approval-again' }, t('login.tryAgain')),
  );
  $<HTMLButtonElement>('approval-again')?.addEventListener('click', () => askForm(box));
}

function el(tag: string, attrs: Record<string, string>, text?: string): HTMLElement {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  if (tag === 'input') (node as HTMLInputElement).value = attrs.value ?? '';
  if (text) node.textContent = text;
  return node;
}
