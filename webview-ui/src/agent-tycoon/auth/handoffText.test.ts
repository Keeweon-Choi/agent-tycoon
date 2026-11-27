import './stepUp.js';

import { afterEach, expect, it, vi } from 'vitest';

import { t } from '../../i18n/index.js';
import { authFetch, handoffFailedText } from './authApi.js';

afterEach(() => vi.unstubAllGlobals());

/** The handoff-code route asks for a step-up; /api/auth/me then answers `me`. */
function stepUpRefused(me: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) =>
      path === '/api/auth/me'
        ? new Response(JSON.stringify(me), { status: 200 })
        : new Response(JSON.stringify({ error: 'stepup' }), { status: 403 }),
    ),
  );
}

const failure = (path: string) => authFetch(path, { method: 'POST' }).then(() => null, (err: unknown) => err);

it('S1.2: under passkeys-required, a QR phone with no passkey is told how to get the app in', async () => {
  stepUpRefused({ deviceId: 'd', passkeyRequired: true, keyStepUp: false, passkeyHere: false });
  expect(handoffFailedText(await failure('/api/auth/handoff-code'))).toBe(t('auth.handoff.stepUp'));
});

it('S1.2: a refusal that is no step-up keeps the server sentence', () => {
  expect(handoffFailedText(new Error('nope'))).toBe(t('auth.codeFailed', { error: 'nope' }));
});
