import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EngineAction } from '../../../core/src/messages.js';
import { authFetch, setStepUpPrompt } from './auth/authApi.js';
import {
  engineAsk,
  engineConfirm,
  engineGetSnapshot,
  engineHandleMessage,
  engineResetForTests,
} from './engineStore.js';

const proved = vi.hoisted(() => ({ ok: true }));
vi.mock('./auth/stepUp.js', () => ({ requestStepUp: async () => proved.ok }));

const reply = (status: number, body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

beforeEach(() => {
  proved.ok = true;
  engineResetForTests();
});
afterEach(() => {
  setStepUpPrompt(null);
  vi.unstubAllGlobals();
});

describe('S1: a dangerous action that answers "step-up required"', () => {
  it('authFetch runs the prompt and retries once', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => reply(403, { error: 'stepup' }))
      .mockImplementationOnce(() => reply(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const prompt = vi.fn(async () => true);
    setStepUpPrompt(prompt);
    expect(await authFetch('/api/auth/device-code', { method: 'POST' })).toEqual({ ok: true });
    expect(prompt).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a refused prompt changes nothing, and a second "stepup" is not retried again', async () => {
    const fetchMock = vi.fn(() => reply(403, { error: 'stepup' }));
    vi.stubGlobal('fetch', fetchMock);
    setStepUpPrompt(async () => false);
    await expect(
      authFetch('/api/auth/sessions/revoke-others', { method: 'POST' }),
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    setStepUpPrompt(async () => true);
    await expect(
      authFetch('/api/auth/sessions/revoke-others', { method: 'POST' }),
    ).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(3); // one retry, then the answer stands
  });

  it('an engine action is sent again once after the step-up', async () => {
    const out = vi.fn<(msg: EngineAction) => void>();
    engineAsk('start', 'alpha');
    engineConfirm(out, true);
    const first = out.mock.calls[0][0];
    engineHandleMessage({
      type: 'engineActionResult',
      requestId: first.requestId,
      action: 'start',
      name: 'alpha',
      ok: false,
      error: 'stepup',
    });
    await vi.waitFor(() => expect(out).toHaveBeenCalledTimes(2));
    const second = out.mock.calls[1][0];
    expect(second).toMatchObject({ action: 'start', name: 'alpha' });
    expect(second.requestId).not.toBe(first.requestId);
    // still busy until the real answer; a second "stepup" is final
    engineHandleMessage({
      type: 'engineActionResult',
      requestId: second.requestId,
      action: 'start',
      name: 'alpha',
      ok: false,
      error: 'stepup',
    });
    expect(out).toHaveBeenCalledTimes(2);
    expect(engineGetSnapshot().busy.alpha).toBeUndefined();
    expect(engineGetSnapshot().toast?.tone).toBe('error');
  });

  it('an engine action whose step-up fails is dropped with a message', async () => {
    proved.ok = false;
    const out = vi.fn<(msg: EngineAction) => void>();
    engineAsk('restart', 'alpha');
    engineConfirm(out, true);
    engineHandleMessage({
      type: 'engineActionResult',
      requestId: out.mock.calls[0][0].requestId,
      action: 'restart',
      name: 'alpha',
      ok: false,
      error: 'stepup',
    });
    await vi.waitFor(() => expect(engineGetSnapshot().busy.alpha).toBeUndefined());
    expect(out).toHaveBeenCalledOnce();
    expect(engineGetSnapshot().toast?.tone).toBe('error');
  });
});
