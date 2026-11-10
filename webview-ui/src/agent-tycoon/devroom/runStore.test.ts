import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClientMessage, RunScriptsResult } from '../../../../core/src/messages.js';

const stepUp = vi.hoisted(() => ({ ok: true }));
vi.mock('../auth/stepUp.js', () => ({ requestStepUp: () => Promise.resolve(stepUp.ok) }));

const { bindRunWire, requestScripts, runGetSnapshot, runHandleMessage, runResetForTests } = await import('./runStore.js');

const sent: ClientMessage[] = [];
const toasts: string[] = [];
beforeEach(() => {
  runResetForTests();
  sent.length = 0;
  toasts.length = 0;
  bindRunWire({ send: (m) => sent.push(m), connected: () => true, toast: (text) => toasts.push(text) });
});
const answer = (requestId: string, o: Partial<RunScriptsResult>): RunScriptsResult => ({
  type: 'runScriptsResult',
  requestId,
  project: 'shop',
  task: 'feat-t1',
  ok: true,
  scripts: [],
  picks: [],
  ...o,
});
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('DV2 run store: saving picks from a remote session', () => {
  it('a stepup refusal asks for the step-up once and sends the same picks again', async () => {
    stepUp.ok = true;
    requestScripts('shop', 'feat-t1', [{ script: 'test', role: 'test' }]);
    const first = sent[0] as Extract<ClientMessage, { type: 'runScripts' }>;
    runHandleMessage(answer(first.requestId, { ok: false, error: 'stepup' }));
    await flush();
    expect(sent).toEqual([first, first]);
    runHandleMessage(answer(first.requestId, { picks: [{ script: 'test', role: 'test' }] }));
    expect(runGetSnapshot().scripts['shop\0feat-t1']).toMatchObject({ ok: true, picks: [{ script: 'test' }] });
  });

  it('a failed step-up saves nothing and says so', async () => {
    stepUp.ok = false;
    requestScripts('shop', 'feat-t1', [{ script: 'test', role: 'test' }]);
    const first = sent[0] as Extract<ClientMessage, { type: 'runScripts' }>;
    runHandleMessage(answer(first.requestId, { ok: false, error: 'stepup' }));
    await flush();
    expect(sent).toHaveLength(1);
    expect(toasts).toHaveLength(1);
    expect(runGetSnapshot().scripts['shop\0feat-t1']).toBe('loading');
  });
});
