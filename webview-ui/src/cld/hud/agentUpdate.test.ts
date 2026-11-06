/**
 * AGENT-UPDATE: how long a 업데이트 result stays (a success one minute, a failure until the panel closes,
 * none when nobody looks) and the throttle of the newest-version ask. AGENT-LATEST: the version order.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { compareVersions } from '../../../../core/src/cld/versionCompare.js';
import type { AgentCliUpdateState } from '../../../../core/src/messages.js';
import { AGENT_LATEST_ASK_GAP_MS, AGENT_UPDATE_RESULT_MS } from '../../constants.js';
import { cliLatestOf } from '../engine.js';

const sent: unknown[] = [];
vi.mock('../../transport/index.js', () => ({ transport: { send: (m: unknown) => sent.push(m) } }));

const store = await import('./agentUpdate.js');
const done = (over: Partial<AgentCliUpdateState> = {}): AgentCliUpdateState => ({
  type: 'agentCliUpdateState',
  agent: 'codex',
  phase: 'done',
  ok: true,
  before: '0.156.1',
  after: '0.167.0',
  lines: [],
  ...over,
});
beforeEach(() => {
  vi.useFakeTimers();
  sent.length = 0;
  store.setUsagePanelOpen(true);
});
afterEach(() => {
  store.setUsagePanelOpen(false);
  vi.useRealTimers();
});

describe('compareVersions', () => {
  it('orders dotted numbers numerically', () => {
    expect(compareVersions('0.167.0', '0.156.1')).toBeGreaterThan(0);
    expect(compareVersions('0.156.1', '0.167.0')).toBeLessThan(0);
    expect(compareVersions('0.167.10', '0.167.9')).toBeGreaterThan(0);
    expect(compareVersions('2.1', '2.1.0')).toBe(0);
  });
  it('cliLatestOf reads the newest version the daemon found', () => {
    const state = { agentChoices: { codex: { version: '0.156.1', latest: '0.167.0', models: [], efforts: [] } } };
    expect(cliLatestOf(state, 'codex')).toBe('0.167.0');
    expect(cliLatestOf(state, 'claude')).toBeUndefined();
    expect(cliLatestOf(null, 'codex')).toBeUndefined();
  });
});

describe('the update result', () => {
  const view = (agent = 'codex') => store.peekAgentUpdate(agent);

  it('a success goes after a minute', () => {
    store.agentUpdateHandleMessage(done());
    expect(view()?.after).toBe('0.167.0');
    vi.advanceTimersByTime(AGENT_UPDATE_RESULT_MS - 1);
    expect(view()).toBeDefined();
    vi.advanceTimersByTime(1);
    expect(view()).toBeUndefined();
  });

  it('a failure stays until the panel closes', () => {
    store.agentUpdateHandleMessage(done({ ok: false, after: undefined, lines: ['npm error'] }));
    vi.advanceTimersByTime(AGENT_UPDATE_RESULT_MS * 10);
    expect(view()?.ok).toBe(false);
    store.setUsagePanelOpen(false);
    expect(view()).toBeUndefined();
  });

  it('a CLI that must be updated by hand stays like a failure', () => {
    store.agentUpdateHandleMessage(done({ ok: true, manual: true, command: 'npm i -g @openai/codex' }));
    vi.advanceTimersByTime(AGENT_UPDATE_RESULT_MS * 2);
    expect(view()?.command).toBe('npm i -g @openai/codex');
  });

  it('closing the panel ends a success early, but not a run in progress', () => {
    store.agentUpdateHandleMessage(done());
    store.agentUpdateHandleMessage({ type: 'agentCliUpdateState', agent: 'claude', phase: 'running' });
    store.setUsagePanelOpen(false);
    expect(view('codex')).toBeUndefined();
    expect(view('claude')?.phase).toBe('running');
    store.agentUpdateHandleMessage({ type: 'agentCliUpdateState', agent: 'claude', phase: 'done', ok: false, lines: [] });
    expect(view('claude')).toBeUndefined(); // it finished while nobody looked
  });

  it('a second run replaces the result and restarts the minute', () => {
    store.agentUpdateHandleMessage(done());
    vi.advanceTimersByTime(AGENT_UPDATE_RESULT_MS - 10);
    store.agentUpdateHandleMessage(done({ before: '0.167.0', after: '0.168.0' }));
    vi.advanceTimersByTime(AGENT_UPDATE_RESULT_MS - 10);
    expect(view()?.after).toBe('0.168.0');
    vi.advanceTimersByTime(10);
    expect(view()).toBeUndefined();
  });
});

describe('asking for the newest versions', () => {
  it('a plain ask always goes (the daemon caches), a forced one at most every 30 s', async () => {
    vi.useRealTimers();
    const forced = () => sent.filter((m) => (m as { refresh: boolean }).refresh);
    const ask = async (refresh: boolean, now: number) => {
      store.askAgentLatest(refresh, now);
      await new Promise((r) => setTimeout(r, 20)); // the send loads the transport on use
    };
    await ask(false, 1_000_000);
    await ask(true, 2_000_000);
    await ask(true, 2_000_000 + AGENT_LATEST_ASK_GAP_MS - 1);
    await ask(true, 2_000_000 + AGENT_LATEST_ASK_GAP_MS);
    expect(sent).toHaveLength(3);
    expect(forced()).toHaveLength(2);
    expect(sent[0]).toEqual({ type: 'agentCliLatest', refresh: false });
  });
});
