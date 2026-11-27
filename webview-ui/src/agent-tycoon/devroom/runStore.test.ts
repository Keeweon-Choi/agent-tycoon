import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClientMessage, RunScriptsResult } from '../../../../core/src/messages.js';

const stepUp = vi.hoisted(() => ({ ok: true, gate: null as Promise<void> | null }));
vi.mock('../auth/stepUp.js', () => ({ requestStepUp: () => (stepUp.gate ?? Promise.resolve()).then(() => stepUp.ok) }));

const { bindRunWire, requestScripts, runGetSnapshot, runHandleMessage, runResetForTests } = await import('./runStore.js');

const sent: ClientMessage[] = [];
const toasts: string[] = [];
beforeEach(() => {
  runResetForTests();
  stepUp.gate = null;
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

describe('U1.8 run store: the socket drops while a run starts', () => {
  it('forgets the start and the script ask in flight, so the buttons work again after the reconnect', async () => {
    const { runConnectionLost, startKey, startRun } = await import('./runStore.js');
    requestScripts('shop', 'feat-t1');
    startRun('shop', 'feat-t1', 'dev', 'side');
    expect(runGetSnapshot().starting[startKey('shop', 'feat-t1', 'dev')]).toBe(true);
    runConnectionLost(); // the answers go to the old socket
    expect(runGetSnapshot().starting).toEqual({});
    expect(runGetSnapshot().scripts['shop\0feat-t1']).toBeUndefined();
    expect(runGetSnapshot().open['shop\0feat-t1']).toEqual({ side: 'dev' }); // what is open stays
    startRun('shop', 'feat-t1', 'dev', 'side');
    expect(sent.filter((m) => m.type === 'jobStart')).toHaveLength(2);
    const ask = sent[0] as Extract<ClientMessage, { type: 'runScripts' }>;
    runHandleMessage(answer(ask.requestId, {})); // a late answer to the old ask: not ours
    expect(runGetSnapshot().scripts['shop\0feat-t1']).toBeUndefined();
  });
});

describe('U1.8 run store: the reconnect', () => {
  it('asks again for the script lists that were loading when the socket dropped', async () => {
    const { runConnected, runConnectionLost } = await import('./runStore.js');
    requestScripts('shop', 'feat-t1');
    requestScripts('shop', 'feat-t2');
    runHandleMessage(answer((sent[1] as Extract<ClientMessage, { type: 'runScripts' }>).requestId, { task: 'feat-t2' }));
    runConnectionLost();
    runConnected();
    const again = sent.slice(2) as Extract<ClientMessage, { type: 'runScripts' }>[];
    expect(again.map((m) => m.task)).toEqual(['feat-t1']); // the answered one is not asked again
    expect(runGetSnapshot().scripts['shop\0feat-t1']).toBe('loading');
    runHandleMessage(answer(again[0].requestId, {}));
    expect(runGetSnapshot().scripts['shop\0feat-t1']).toMatchObject({ ok: true });
    runConnected(); // a second connected state asks nothing more
    expect(sent).toHaveLength(3);
  });
});

describe('U1.8 run store: a step-up in flight when the socket drops', () => {
  it('the start and the picks sent again on the new socket are waited for', async () => {
    const { runConnectionLost, startKey, startRun } = await import('./runStore.js');
    stepUp.ok = true;
    let open = () => {};
    stepUp.gate = new Promise((r) => (open = r));
    requestScripts('shop', 'feat-t1', [{ script: 'test', role: 'test' }]);
    startRun('shop', 'feat-t1', 'dev', 'side');
    const ask = sent[0] as Extract<ClientMessage, { type: 'runScripts' }>;
    const start = sent[1] as Extract<ClientMessage, { type: 'jobStart' }>;
    runHandleMessage(answer(ask.requestId, { ok: false, error: 'stepup' }));
    const result = { type: 'jobStartResult', requestId: start.requestId, project: 'shop', task: 'feat-t1', scriptId: 'dev' } as const;
    runHandleMessage({ ...result, ok: false, error: 'stepup' });
    runConnectionLost(); // the step-up is still being proven
    open();
    await flush();
    expect(sent.slice(2)).toEqual([ask, start]); // sent again on the new socket
    expect(runGetSnapshot().starting[startKey('shop', 'feat-t1', 'dev')]).toBe(true);
    runHandleMessage(answer(ask.requestId, { picks: [{ script: 'test', role: 'test' }] }));
    expect(runGetSnapshot().scripts['shop\0feat-t1']).toMatchObject({ ok: true, picks: [{ script: 'test' }] });
    runHandleMessage({ ...result, ok: false, error: 'boom' });
    expect(runGetSnapshot().starting).toEqual({});
    expect(toasts).toHaveLength(1);
  });
});
