import { afterEach, expect, it, vi } from 'vitest';

import { t } from '../../i18n/index.js';
import { stepUpFailedText } from './authApi.js';
import { requestStepUp } from './stepUp.js';

afterEach(() => vi.unstubAllGlobals());

const meIs = (me: Record<string, unknown>) =>
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(me), { status: 200 })));

it('passkeys required and none at this address: the refusal says so, not "could not verify"', async () => {
  meIs({ deviceId: 'd', passkeyRequired: true, keyStepUp: false, passkeyHere: false });
  expect(await requestStepUp()).toBe(false);
  expect(stepUpFailedText()).toBe(t('stepup.passkeyRequired'));
});

it('any other failed step-up keeps the plain sentence', async () => {
  meIs({ deviceId: null, passkeyRequired: false, keyStepUp: true, passkeyHere: false });
  expect(await requestStepUp()).toBe(false);
  expect(stepUpFailedText()).toBe(t('stepup.needed'));
});
