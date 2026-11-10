// ACP-1 through the engine and the messenger: an ACP Worker is added like any Worker (its Claude
// options refused), starts in its folder, takes the owner's message through session/prompt (never
// the Typist), waits while busy, shows its caps by name, stops. The mock ACP agent only.
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EngineAction, EngineActionKind } from '../../../../core/src/messages.js';
import { makeEngineHome, removeTestHome } from '../testHome.js';
import { AcpAgent } from './agents/acp/acp.js';
import { Engine } from './engine.js';
import { EngineEvents, eventsPath } from './events.js';
import { Messenger } from './messenger.js';
import { registryPath, saveRegistry } from './registry.js';

const MOCK = path.resolve(__dirname, '../../../../e2e/fixtures/mock-acp/mock-acp');
const FAST = { pollMs: 20, appearMs: 5_000, goneMs: 5_000, reviveGapMs: 50, safetyMs: 60_000, debounceMs: 50, watchMs: 0, renewPollMs: 20 };
const WAIT = { timeout: 8_000, interval: 25 };

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanup.reverse()) c();
  cleanup = [];
});

describe('ACP-1: an ACP Worker in the engine', () => {
  it('is added, started, messaged and stopped like any agent', async () => {
    const { home, claudePath } = makeEngineHome();
    const alpha = path.join(home, 'work', 'alpha');
    fs.mkdirSync(alpha, { recursive: true });
    saveRegistry(registryPath(home), [{ projectId: 'p_aaaaaaaaaa', name: 'alpha', folder: alpha, wantRunning: false }]);
    fs.writeFileSync(
      path.join(home, 'mock-acp.json'),
      JSON.stringify({ turns: [[{ say: 'first' }, { sleep: 300 }, { say: 'done' }], [{ say: 'second' }]] }),
    );
    const acp = new AcpAgent({
      preset: { id: 'mocky', name: 'Mocky', bins: ['mocky'], argv: ['--acp'], billing: 'unknown' },
      bin: MOCK,
      home,
      env: () => ({ PATH: process.env.PATH, HOME: home }),
      ask: () => Promise.resolve(null),
      log: () => undefined,
    });
    const e = new Engine({ claudePath, home, readOnly: false, systemdRun: null, log: () => undefined, timing: FAST, env: process.env, agents: [acp] });
    e.start();
    const typed: string[] = [];
    const m = new Messenger({
      home,
      engine: e,
      typist: { type: (_id, text) => (typed.push(text), Promise.resolve('typed')) },
      events: new EngineEvents(eventsPath(home)),
      timing: { tickMs: 20, retryMs: 50, ifIdleMs: 10 * 60_000, quietMs: 5_000 },
    });
    m.start();
    cleanup.push(() => {
      m.dispose();
      acp.dispose();
      e.dispose();
      removeTestHome(home);
    });
    let n = 0;
    const act = (action: EngineActionKind, name: string, fields: Partial<EngineAction> = {}) =>
      e.run({ type: 'engineAction', requestId: `r${++n}`, action, name, ...fields }, true, 'linux');

    expect(e.state().agentCaps?.mocky).toMatchObject({ name: 'Mocky', lifetime: 'session', approvalPolicy: ['ask'] });
    // Its own settings stay its own: no model, effort or Claude option.
    expect(await act('add', 'alpha-m', { role: 'worker', project: 'alpha', provider: 'mocky', model: 'x' })).toMatchObject({ ok: false });
    expect((await act('add', 'alpha-m', { role: 'worker', project: 'alpha', provider: 'mocky' })).ok).toBe(true);
    // Never a Lead.
    expect((await act('promote', 'alpha-m')).ok).toBe(false);
    expect((await act('start', 'alpha-m')).ok).toBe(true);
    await vi.waitFor(() => expect(e.state().projects.find((p) => p.name === 'alpha-m')?.live).toBe(true), WAIT);
    expect(e.isAcp('alpha-m')).toBe(true);
    expect(e.isAcp('alpha')).toBe(false);

    const sent = await m.send({ to: 'alpha-m', text: 'hello', ifIdle: false, from: null, source: 'gui:test' });
    expect(sent.ok).toBe(true);
    const sent2 = await m.send({ to: 'alpha-m', text: 'and then', ifIdle: false, from: null, source: 'gui:test' });
    expect(sent2.ok).toBe(true);
    const prompts = () =>
      fs.readFileSync(path.join(home, 'mock-acp.log'), 'utf8').split('\n').filter((l) => l.includes('"session/prompt"'));
    await vi.waitFor(() => expect(prompts()).toHaveLength(2), WAIT);
    // One at a time: the second went in only after the first turn's end.
    const lines = fs.readFileSync(path.join(home, 'mock-acp.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { at: number; got?: { method?: string } });
    const [p1, p2] = lines.filter((l) => l.got?.method === 'session/prompt');
    expect(p2!.at - p1!.at).toBeGreaterThanOrEqual(250);
    expect(prompts()[0]).toContain('hello');
    expect(typed).toEqual([]); // never typed into a terminal

    expect((await act('stop', 'alpha-m')).ok).toBe(true);
    await vi.waitFor(() => expect(e.state().projects.find((p) => p.name === 'alpha-m')?.live).toBeFalsy(), WAIT);
  }, 30_000);
});
