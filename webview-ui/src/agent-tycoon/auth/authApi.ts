import { startAuthentication, startRegistration } from '@simplewebauthn/browser';

import type { ApprovalNetwork } from '../../../../core/src/messages.js';
import { t } from '../../i18n/index.js';
import { serverText } from '../serverText.js';
import type { DeviceState } from './deviceKey.js';

/** S1: the step-up the person is asked for when a dangerous action answers `stepup`; set by stepUp.ts. */
let stepUpPrompt: (() => Promise<boolean>) | null = null;
export const setStepUpPrompt = (prompt: (() => Promise<boolean>) | null) => {
  stepUpPrompt = prompt;
};

/**
 * How the device-key step-up went. `required`: 패스키 필수 binds the key and no passkey is
 * here to tap. `noKey`: this session is no device with a key. `lostKey`: it is one, but
 * this browser does not hold its key (cleared, or another storage such as the Home-Screen
 * app). `rate`: too many tries for now. `failed`: anything else (or the passkey tap was not made).
 */
export type StepUpOutcome = 'ok' | 'required' | 'noKey' | 'lostKey' | 'rate' | 'failed';

/** Why the last step-up failed. */
let lastFailure: StepUpOutcome = 'failed';
export const noteStepUpFailure = (why: StepUpOutcome) => {
  lastFailure = why;
};

/** What a failed step-up tells the person, at the place they acted. */
export function stepUpText(why: StepUpOutcome): string {
  switch (why) {
    case 'required':
      return t('stepup.passkeyRequired');
    case 'lostKey':
      return t('stepup.lostKey');
    case 'rate':
      return t('stepup.rate');
    default:
      return t('stepup.needed');
  }
}

/** Why a dangerous action was not done, after a step-up that could not prove this device. */
export const stepUpFailedText = () => stepUpText(lastFailure);

/** The session-gated login API (/api/auth/*, T-0022). Same-origin fetches
 *  with the session cookie; an error carries the server's sentence when there is one.
 *  A 403 `stepup` runs the step-up prompt and retries once (S1), unless `noStepUp`. */
export async function authFetch<T>(
  path: string,
  init: {
    method?: string;
    body?: unknown;
    retried?: boolean;
    noStepUp?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? 'GET',
    credentials: 'same-origin',
    signal: init.signal,
    headers: init.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  const data: unknown = text ? safeJson(text) : null;
  if (!res.ok) {
    const error = (data as { error?: unknown } | null)?.error;
    if (res.status === 403 && error === STEPUP_REQUIRED && !init.retried && !init.noStepUp && stepUpPrompt) {
      if (await stepUpPrompt()) return authFetch<T>(path, { ...init, retried: true });
      // `stepUp`: why, so the page can offer the way out next to the note (lostKey: sign out, log in by code).
      throw Object.assign(new Error(stepUpFailedText()), { status: res.status, data, stepUp: lastFailure });
    }
    // status + body ride along: a 409 { error: 'cut', via } is a question, not a failure (S6).
    throw Object.assign(new Error(typeof error === 'string' ? serverText(data as { error: string }) : t('auth.requestFailed', { status: res.status })), { status: res.status, data });
  }
  return data as T;
}

/** The server's answer (403 { error }) to a dangerous action with no fresh step-up. */
export const STEPUP_REQUIRED = 'stepup';

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Register a passkey for this address (Face ID, Windows Hello…). */
export async function registerPasskey(): Promise<void> {
  const { ceremony, options } = await authFetch<{ ceremony: string; options: never }>(
    '/api/auth/passkeys/options',
    { method: 'POST' },
  );
  const response = await startRegistration({ optionsJSON: options });
  await authFetch('/api/auth/passkeys', { method: 'POST', body: { ceremony, response } });
}

/** A fresh assertion tied to this session, before weakening its login setting. */
export async function verifyPasskey(): Promise<void> {
  const { ceremony, options } = await authFetch<{ ceremony: string; options: never }>(
    '/api/auth/passkeys/verify/options',
    { method: 'POST' },
  );
  const response = await startAuthentication({ optionsJSON: options });
  await authFetch('/api/auth/passkeys/verify', { method: 'POST', body: { ceremony, response } });
}

/** A browser's own refusal (the user closed the passkey sheet) reads as a cancel. */
export function passkeyError(err: unknown): string {
  if (err instanceof Error && err.name === 'NotAllowedError') return t('auth.passkeyCancelled');
  return err instanceof Error ? err.message : String(err);
}

export interface Me extends DeviceState {
  method: string;
  label: string;
  /** Passkeys can be used at this address. */
  passkeys: boolean;
  /** One is registered for it already. */
  passkeyHere: boolean;
  /** This device has its own passkey at this address (turning 필수 on takes it). */
  ownPasskeyHere: boolean;
  approvals: boolean;
  /** This device's row in the device list (T-0034). */
  id: string;
  /** "패스키(생체 인증) 필수": no silent re-login by device key. */
  passkeyRequired: boolean;
  /** The device key may prove a step-up here: false once 필수 binds this device (it has its own passkey here). */
  keyStepUp: boolean;
  /** The canonical address, when this one isn't it: this device can move there. */
  moveTo: string | null;
  /** S3: a QR just logged this session in; it may ask for a code for the Home-Screen app. */
  handoff: boolean;
  /** O5: the host-verified outside address this keyed device moves to by itself, when this one isn't it. */
  autoMoveTo: string | null;
}

export function methodLabel(method: string): string {
  switch (method) {
    case 'link': return t('auth.method.link');
    case 'qr': return t('auth.method.qr');
    case 'short': return t('auth.method.short');
    case 'tailscale': return 'Tailscale';
    case 'approval': return t('auth.method.approval');
    case 'passkey': return t('auth.method.passkey');
    case 'device': return t('auth.method.device');
    case 'move': return t('auth.method.move');
    case 'handoff': return t('auth.method.handoff');
    default: return method;
  }
}

export function networkLabel(network: ApprovalNetwork): string {
  switch (network) {
    case 'funnel': return t('auth.network.funnel');
    case 'tailnet': return t('auth.network.tailnet');
    case 'lan': return t('auth.network.lan');
    case 'local': return t('auth.network.local');
  }
}

/** S3: Safari on an iPhone/iPad (not the installed Home-Screen app). */
export function isPhoneSafariTab(): boolean {
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  return ios && !isHomeScreenApp();
}

/** Opened as the installed (Home-Screen) app, not in a browser tab. */
export const isHomeScreenApp = () =>
  (navigator as Navigator & { standalone?: boolean }).standalone === true ||
  window.matchMedia('(display-mode: standalone)').matches;

/** "1234 5678" */
export const formatShortCode = (code: string) => `${code.slice(0, 4)} ${code.slice(4)}`;

/** m:ss */
export function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** "방금", "3분 전", "2시간 전", "4일 전" */
export function ago(at: number, now = Date.now()): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return t('auth.ago.justNow');
  if (minutes < 60) return t('auth.ago.minutes', { count: minutes });
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? t('auth.ago.hours', { count: hours }) : t('auth.ago.days', { count: Math.floor(hours / 24) });
}

/** Whole days until `at` (never below 0). */
export function daysLeft(at: number, now = Date.now()): number {
  return Math.max(0, Math.ceil((at - now) / 86_400_000));
}

/** A section of the security panel: its own box, so the headings read as separate parts. */
export const SECTION = 'flex flex-col gap-6 border-2 border-border p-8';
