/**
 * Trusted-device shells (T-0052, --allow-terminal): the HTTP side. A shell
 * opens only for a registered device (device key or passkey) that proved
 * itself in the last 120 s (the step-up); attaching to one needs the same.
 */
import { PASSKEY_PRIME_REFRESH_MS, PASSKEY_PRIMED_FRESH_MS } from '../../constants.js';
import {
  authFetch,
  type Me,
  type PasskeyVerifyOptions,
  passkeyVerifyOptions,
  type StepUpOutcome,
  verifyPasskey,
} from '../auth/authApi.js';
import { deviceKeySettled, idbStore, type KeyStore, loadDevice, proveDevice } from '../auth/deviceKey.js';

export interface ShellRow {
  id: string;
  /** The device-list row that opened it. */
  deviceId: string;
  label: string;
  cwd: string;
  openedAt: number;
}

export interface ShellList {
  shells: ShellRow[];
  /** This session is a registered device: it may open shells. */
  canOpen: boolean;
  /** This session's row: its own shells are the ones it can attach to. */
  device: string;
}

/** What the server's refusal codes mean to the user. */
const REFUSED: Record<string, TranslationKey> = {
  rate: 'shell.rate',
  origin: 'shell.origin',
  host: 'shell.host',
  session: 'shell.session',
  device: 'shell.device',
  proof: 'shell.proof',
  cap: 'shell.cap',
};

const say = (err: unknown) => {
  const text = err instanceof Error ? err.message : String(err);
  return new Error(REFUSED[text] ? t(REFUSED[text]) : serverLine(text));
};

export const listShells = () => authFetch<ShellList>('/api/shell');

export async function openShell(cwd: string): Promise<ShellRow> {
  try {
    return await authFetch<ShellRow>('/api/shell', { method: 'POST', body: { cwd } });
  } catch (err) {
    throw say(err);
  }
}

export const closeShell = (id: string) =>
  authFetch(`/api/shell/${encodeURIComponent(id)}`, { method: 'DELETE' });

export const shellSocketPath = (id: string) => `/agty/shell/${encodeURIComponent(id)}`;

/**
 * The automatic step-up: this browser's device key signs a fresh challenge.
 * Anything but `ok` says why it can't (see StepUpOutcome); then only a passkey
 * (a tap, `passkeyStepUp`) proves the device, or the page says what to do.
 */
export async function deviceStepUp(
  me: Pick<Me, 'keyStepUp' | 'deviceId'>,
  store: KeyStore = idbStore,
): Promise<StepUpOutcome> {
  // A `me` read before AuthLayer linked or registered this browser's key names no device (10-28:
  // the terminal's read at load after a code login refused every shell): read it again once that ended.
  if (me.keyStepUp && !me.deviceId)
    me = await deviceKeySettled().then(() => authFetch<Me>('/api/auth/me'));
  if (!me.keyStepUp) return 'required';
  if (!me.deviceId) return 'noKey';
  const stored = await loadDevice(store);
  if (stored?.id !== me.deviceId) return 'lostKey';
  const res = await proveDevice(stored, '/api/auth/stepup/device');
  if (res.ok) {
    lastProofAt = Date.now();
    return 'ok';
  }
  // 403: the server's key for this device is not the one here.
  return res.status === 429 ? 'rate' : res.status === 403 ? 'lostKey' : 'failed';
}

/**
 * Face ID / Windows Hello: must run from the user's own tap (WebKit). iOS Safari refuses
 * navigator.credentials.get once an await stands between the tap and it, and the options
 * fetch was one (T-142: the terminal's Face ID button did nothing). So a page showing a
 * Face ID button primes the options first and the tap goes straight to Face ID; without
 * fresh ones it still fetches them (fine on a desktop) and primes again after a failure.
 */
export async function passkeyStepUp(): Promise<void> {
  const ready = primed && Date.now() - primed.at < PASSKEY_PRIMED_FRESH_MS ? primed.options : undefined;
  primed = null; // a ceremony answers once
  try {
    await verifyPasskey(ready);
  } catch (err) {
    primeVisible();
    throw err;
  }
  lastProofAt = Date.now();
  if (primers > 0) primeVisible(); // a tap within the next minute has options in hand too
}

let primed: { options: PasskeyVerifyOptions; at: number } | null = null;
const fetchPrimed = () =>
  passkeyVerifyOptions().then(
    (options) => {
      primed = { options, at: Date.now() };
    },
    () => undefined, // no passkey here: the tap says so
  );

/**
 * While a Face ID button is on screen: keep fresh options ready for its tap. Returns the stop.
 * The server keeps only 4 open ceremonies per session and every tab of a browser shares the
 * session, so a page primes once for all its callers (the terminal overlay and the step-up
 * prompt together), never while hidden, and once more when it is shown again.
 */
export function primePasskeyStepUp(): () => void {
  if (primers++ === 0) {
    primeVisible();
    primeTimer = setInterval(primeVisible, PASSKEY_PRIME_REFRESH_MS);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', primeVisible);
  }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    if (--primers > 0) return;
    clearInterval(primeTimer);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', primeVisible);
  };
}
let primers = 0;
let primeTimer: ReturnType<typeof setInterval> | undefined;
const primeVisible = () => {
  if (typeof document === 'undefined' || !document.hidden) void fetchPrimed();
};

/** When this page last proved the device (the server keeps a proof for 120 s). */
let lastProofAt = 0;
const PROOF_REUSE_MS = 90_000;

/**
 * A terminal socket's step-up (TerminalPane `prepare`): reuse a proof less
 * than 90 s old, else the device key signs a fresh one by itself. False: only
 * a passkey tap can (the pane asks for it). Throws while the daemon is not
 * answering, which the socket retries -- the daemon restarting forgets every
 * proof, so every shell reconnect after a deploy comes through here.
 */
export function ensureShellProof(force: boolean): Promise<boolean> {
  if (!force && Date.now() - lastProofAt < PROOF_REUSE_MS) return Promise.resolve(true);
  // Every pane reconnecting at once shares one proof (one nonce, not one per pane).
  proofInflight ??= authFetch<Me>('/api/auth/me')
    .then(async (me) => (await deviceStepUp(me)) === 'ok')
    .finally(() => {
      proofInflight = null;
    });
  return proofInflight;
}
let proofInflight: Promise<boolean> | null = null;

/**
 * S5.1: an agent's terminal socket (TerminalPane `prepare`). The server asks a step-up only of a
 * remote session (this PC's browser needs none), so it connects without one and proves the
 * device once the server refused it ('proof').
 */
export const ensureAgentTerminalProof = (force: boolean): Promise<boolean> =>
  force ? ensureShellProof(true) : Promise.resolve(true);
import { t, type TranslationKey } from '../../i18n/index.js';
import { serverLine } from '../serverText.js';
