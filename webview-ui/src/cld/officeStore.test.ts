import { beforeEach, describe, expect, it } from 'vitest';

import type { OfficeOrchestrator, OfficeSnapshot } from '../../../core/src/messages.js';
import { setLanguage } from '../i18n/index.js';
import { engineHandleMessage, engineResetForTests } from './engineStore.js';
import { describeActivity } from './ez/activity.js';
import { fatigueText } from './ez/fatigue.js';
import {
  actionToastDuration,
  cldConnectionLost,
  cldGetSnapshot,
  cldHandleMessage,
  cldResetForTests,
  cldToast,
  codexUsageCheckStarted,
  ezContext,
  fatigueFor,
  identityForAgent,
  panelAvailable,
} from './officeStore.js';

beforeEach(() => setLanguage('ko'));

it('keeps the default toast durations when no custom duration is supplied', () => {
  cldResetForTests();
  cldToast('name', 'text', 'ok');
  expect(actionToastDuration(cldGetSnapshot().toast!)).toBe(4_000);
  cldToast('name', 'text', 'error');
  expect(actionToastDuration(cldGetSnapshot().toast!)).toBe(8_000);
});

it('the \ud130\ubbf8\ub110 tab shows only when the host allows terminals (T-0052)', () => {
  cldResetForTests();
  expect(panelAvailable('terminal')).toBe(false);
  cldHandleMessage({ type: 'officeAccess', readOnly: false, terminal: true });
  expect(panelAvailable('terminal')).toBe(true);
  cldHandleMessage({ type: 'officeAccess', readOnly: false });
  expect(panelAvailable('terminal')).toBe(false);
});

it('a refused look is told in a toast, in the viewer language (CH-1)', () => {
  cldResetForTests();
  cldHandleMessage({ type: 'characterRefused', key: 'alpha', reason: 'full' });
  expect(cldGetSnapshot().toast).toMatchObject({ name: 'alpha', tone: 'error' });
  expect(cldGetSnapshot().toast?.text).toContain('500');
  setLanguage('en');
  cldHandleMessage({ type: 'characterRefused', key: 'alpha', reason: 'unknown' });
  expect(cldGetSnapshot().toast?.text).toBe(
    'That character was not found; its look was not changed.',
  );
});

it('keeps the newest 200 office events', () => {
  cldResetForTests();
  for (let i = 0; i < 205; i++) {
    cldHandleMessage({
      type: 'officeEvent',
      ts: new Date(i * 1000).toISOString(),
      kind: 'test',
      summary: String(i),
    });
  }
  expect(cldGetSnapshot().events).toHaveLength(200);
  expect(cldGetSnapshot().events[0].summary).toBe('204');
  expect(cldGetSnapshot().events[199].summary).toBe('5');
});

it('tracks a Codex usage check until its result arrives', () => {
  cldResetForTests();
  codexUsageCheckStarted();
  expect(cldGetSnapshot().codexUsageChecking).toBe(true);
  cldHandleMessage({ type: 'codexUsageCheckResult', ok: true });
  expect(cldGetSnapshot().codexUsageChecking).toBe(false);
});

it("a reconnect's replayed feed adds no event twice (T-0025)", () => {
  cldResetForTests();
  const feed = [0, 1, 2].map((i) => ({
    type: 'officeEvent' as const,
    ts: new Date(i * 1000).toISOString(),
    kind: 'test',
    summary: `e${i}`,
  }));
  for (const e of feed) cldHandleMessage(e);
  for (const e of feed) cldHandleMessage({ ...e }); // the resync sends the feed again
  cldHandleMessage({ ...feed[2], summary: 'same second, other news' });
  expect(cldGetSnapshot().events.map((e) => e.summary)).toEqual([
    'same second, other news',
    'e2',
    'e1',
    'e0',
  ]);
});

const orch = (over: Partial<OfficeOrchestrator> = {}): OfficeOrchestrator => ({
  name: 'alpha',
  dir: '/work/alpha',
  tab: 'room',
  order: 1,
  state: 'running',
  busy: false,
  remoteControl: { on: false, url: null },
  compactions: 0,
  alive: true,
  agentId: 5,
  ...over,
});
const state = (over: Partial<OfficeSnapshot> = {}): OfficeSnapshot => ({
  type: 'officeSnapshot',
  readOnly: true,
  tabs: [],
  orchestrators: [orch()],
  ...over,
});

describe('the EZ context', () => {
  beforeEach(cldResetForTests);

  it('carries the daemon-checked user rules, one object per change', () => {
    expect(ezContext()).toEqual({});
    const rules = {
      type: 'ezRules' as const,
      tools: [],
      commands: [{ program: ['make'], emoji: '🚀', text: '\ubc30\ud3ec\ud558\ub294 \uc911' }],
    };
    cldHandleMessage(rules);
    expect(ezContext().user).toBe(rules);
    expect(ezContext()).toBe(ezContext()); // memoized: one object per change, not per frame
    expect(describeActivity({ command: 'make deploy', toolName: 'Bash' }, ezContext()).text).toBe(
      '\ubc30\ud3ec\ud558\ub294 \uc911',
    );
    cldResetForTests();
    expect(ezContext()).toEqual({});
  });
});

describe('identities from data', () => {
  it('carries the provider busy flag (T-0045): true only for busy:true', () => {
    const idOf = (busy: boolean | null) =>
      identityForAgent(5, state({ orchestrators: [orch({ busy })] }), null);
    expect(idOf(true)?.busy).toBe(true);
    expect(idOf(false)?.busy).toBe(false);
    expect(idOf(null)?.busy).toBe(false);
  });

  it('the hand-over hint is the engine nudge only', () => {
    cldResetForTests();
    engineHandleMessage({
      type: 'engineState',
      projects: [
        {
          name: 'alpha',
          folder: '/w/a',
          room: 'a',
          wantRunning: true,
          live: true,
          compactionNudge: 2,
        },
      ],
    } as never);
    const office = state({ orchestrators: [orch({ compactions: 2, provider: 'engine' })] });
    cldHandleMessage(office);
    cldHandleMessage({
      type: 'agentContextUsage',
      id: 5,
      contextTokens: 170_000,
      maxContextTokens: 200_000,
    });
    expect(identityForAgent(5, office, null)?.handoff).toBe(true);
    expect(identityForAgent(5, office, null)?.engine).toBe(true);
    const plain = state({
      orchestrators: [orch({ name: 'plain', compactions: 2, provider: 'claude' })],
    });
    expect(identityForAgent(5, plain, null)?.handoff).toBe(false);
    engineResetForTests();
  });
});

describe('\ud53c\ub85c\ub3c4 per character (T-0026)', () => {
  beforeEach(cldResetForTests);
  const context = (id: number, tokens: number, max = 200_000) =>
    cldHandleMessage({
      type: 'agentContextUsage',
      id,
      contextTokens: tokens,
      maxContextTokens: max,
    });

  it('nothing before the first context report', () => {
    expect(fatigueFor(5)).toBeNull();
  });

  it('counts the context drops this screen saw', () => {
    context(7, 180_000);
    expect(fatigueFor(7)).toMatchObject({ value: 90, compactions: 0, yawn: true, rest: true });
    context(7, 20_000); // 90% -> 10%: a compaction, which does not add to the fatigue
    expect(fatigueFor(7)).toMatchObject({
      value: 10,
      compactions: 1,
      threshold: null,
      rest: false,
    });
    context(7, 170_000);
    context(7, 10_000);
    // No threshold without a provider that names one: "압축 2", no rest from the count.
    expect(fatigueFor(7)).toMatchObject({ value: 5, compactions: 2, threshold: null, rest: false });
    expect(fatigueText(fatigueFor(7)!)).toBe('\ud53c\ub85c\ub3c4 5% · \ud734\uc2dd 2');
  });

  it("a row's own count (the engine's) counts, beside the drops this screen saw", () => {
    cldHandleMessage(state({ orchestrators: [orch({ compactions: 2 })] }));
    context(5, 40_000);
    // An engine row carries the engine's count, the board's 컴팩션 N회 (10-22 18:26 the stat said
    // 1/2 beside a board's 2); no threshold unless the project has a nudge.
    expect(fatigueFor(5)).toMatchObject({
      value: 20,
      compactions: 2,
      threshold: null,
      rest: false,
    });
  });

  it('a Claude session (neutral 0) keeps its own drops', () => {
    cldHandleMessage(state({ orchestrators: [orch()] }));
    context(5, 180_000);
    context(5, 20_000);
    expect(fatigueFor(5)).toMatchObject({ value: 10, compactions: 1 });
  });

  it('M: an engine project its compactionNudge, a Claude session none; the renew is due once the context is full again', () => {
    const row = (extra: Partial<OfficeOrchestrator>) =>
      state({ orchestrators: [orch({ compactions: 1, ...extra })] });
    context(5, 100_000);
    cldHandleMessage(row({ provider: 'claude', compactions: 0 }));
    expect(fatigueText(fatigueFor(5)!)).toBe('\ud53c\ub85c\ub3c4 50% · \ud734\uc2dd 0');
    const project = (compactionNudge?: number) =>
      engineHandleMessage({
        type: 'engineState',
        projects: [
          {
            name: 'alpha',
            folder: '/w/a',
            room: 'a',
            wantRunning: true,
            live: true,
            compactionNudge,
          },
        ],
      } as never);
    cldHandleMessage(row({ provider: 'engine', compactions: 0 }));
    project(undefined);
    expect(fatigueText(fatigueFor(5)!)).toBe('\ud53c\ub85c\ub3c4 50% · \ud734\uc2dd 0');
    project(3);
    expect(fatigueText(fatigueFor(5)!)).toBe('\ud53c\ub85c\ub3c4 50% · \ud734\uc2dd 0/3');
    // 3 compactions reached: the renew is due at 85% fill (T-0116), not right after; no rest bubble (T-0047).
    cldHandleMessage(row({ provider: 'engine', compactions: 3 }));
    context(5, 40_000);
    expect(fatigueFor(5)).toMatchObject({ value: 20, compactions: 3, threshold: 3, renew: false });
    context(5, 170_000);
    expect(fatigueFor(5)).toMatchObject({ value: 85, compactions: 3, renew: true });
    engineResetForTests();
  });

  it('a new session (renew, /clear) starts the drop count over', () => {
    cldHandleMessage(state({ orchestrators: [orch({ sessionId: 's1' })] }));
    context(5, 180_000);
    context(5, 20_000);
    expect(fatigueFor(5)?.compactions).toBe(1);
    cldHandleMessage(state({ orchestrators: [orch({ sessionId: 's2' })] }));
    context(5, 10_000);
    expect(fatigueFor(5)).toMatchObject({ value: 5, compactions: 0 });
  });

  it("the user's ez-rules.json numbers apply", () => {
    cldHandleMessage({ type: 'ezRules', tools: [], commands: [], fatigue: { tired: 10 } });
    context(9, 30_000);
    expect(fatigueFor(9)).toMatchObject({ value: 15, tone: 'tired', sweat: true });
    expect(fatigueFor(9)?.rest).toBe(false);
  });
});

it('keeps the tracked items per project, drops a project that sends none, and forgets them with the socket (U-48)', () => {
  cldResetForTests();
  const item = { key: 'session:a', kind: 'session', title: 'a', status: 'doing', source: 'observed' } as const;
  cldHandleMessage({ type: 'trackedItems', project: 'p1', items: [item] });
  cldHandleMessage({ type: 'trackedItems', project: 'p2', items: [item] });
  expect(Object.keys(cldGetSnapshot().tracked)).toEqual(['p1', 'p2']);
  cldHandleMessage({ type: 'trackedItems', project: 'p1', items: [] });
  expect(Object.keys(cldGetSnapshot().tracked)).toEqual(['p2']);
  cldConnectionLost();
  expect(cldGetSnapshot().tracked).toEqual({});
});
