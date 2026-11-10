import { afterEach, describe, expect, it } from 'vitest';

import type { ClientMessage, WorkContent } from '../../../../core/src/messages.js';
import type { TempRow } from '../temps.js';
import {
  applyContent,
  closeWork,
  openWork,
  sameRef,
  viewMessage,
  WORK_ITEMS_MAX,
  workGetSnapshot,
  workHandleMessage,
  workResetForTests,
  type WorkSnapshot,
} from './workStore.js';

const item = (n: number, kind: 'user' | 'assistant' = 'assistant') => ({
  kind,
  text: `t${n}`,
  id: `${n}-x`,
  at: n,
});
const row = (over: Partial<TempRow> = {}): TempRow => ({
  id: -1,
  kind: 'subagent',
  leadId: 7,
  name: 'dig',
  task: '',
  model: null,
  modelId: null,
  phase: 'working',
  since: 0,
  work: { kind: 'subagent', agentId: 7, id: 'toolu_1' },
  ...over,
});
const content = (over: Partial<WorkContent> = {}): WorkContent => ({
  type: 'workContent',
  kind: 'subagent',
  agentId: 7,
  id: 'toolu_1',
  items: [],
  ...over,
});
const snap = (over: Partial<WorkSnapshot> = {}): WorkSnapshot => ({
  open: {
    ref: { kind: 'subagent', agentId: 7, id: 'toolu_1' },
    kind: 'subagent',
    name: 'dig',
    leadId: 7,
    model: null,
    modelId: null,
  },
  items: null,
  title: null,
  error: null,
  ...over,
});

afterEach(workResetForTests);

describe('applying workContent', () => {
  it('items replace, or follow with append, capped at the newest', () => {
    const a = applyContent(snap(), content({ items: [item(1), item(2)] }));
    expect(a.items?.map((i) => i.id)).toEqual(['1-x', '2-x']);
    const b = applyContent(a, content({ items: [item(3)], append: true }));
    expect(b.items?.map((i) => i.id)).toEqual(['1-x', '2-x', '3-x']);
    const c = applyContent(b, content({ items: [item(9)] }));
    expect(c.items?.map((i) => i.id)).toEqual(['9-x']);
    const many = Array.from({ length: WORK_ITEMS_MAX + 5 }, (_, i) => item(i));
    expect(applyContent(snap(), content({ items: many })).items).toHaveLength(WORK_ITEMS_MAX);
  });

  it('content for another view, or when none is open, is ignored', () => {
    const s = snap();
    expect(applyContent(s, content({ id: 'toolu_other', items: [item(1)] }))).toBe(s);
    expect(applyContent(s, content({ kind: 'teammate', items: [item(1)] }))).toBe(s);
    const closed = snap({ open: null });
    expect(applyContent(closed, content({ items: [item(1)] }))).toBe(closed);
  });

  it('a title replaces, an error shows and clears with the next good content', () => {
    const a = applyContent(snap(), content({ items: [item(1)], title: 'T' }));
    expect(a.title).toBe('T');
    const e = applyContent(snap(), content({ error: '\uae30\ub85d\uc744 \ucc3e\uc9c0 \ubabb\ud588\uc5b4\uc694' }));
    expect(e.error).toBe('\uae30\ub85d\uc744 \ucc3e\uc9c0 \ubabb\ud588\uc5b4\uc694');
    expect(applyContent(e, content({ items: [item(1)] })).error).toBeNull();
  });

  it('sameRef compares kind, lead and id', () => {
    expect(
      sameRef({ kind: 'subagent', agentId: 1, id: 'a' }, { kind: 'subagent', agentId: 1, id: 'a' }),
    ).toBe(true);
    expect(
      sameRef({ kind: 'subagent', agentId: 1, id: 'a' }, { kind: 'subagent', agentId: 1, id: 'b' }),
    ).toBe(false);
    expect(sameRef({ kind: 'teammate', agentId: 1 }, { kind: 'teammate', agentId: 2 })).toBe(false);
  });
});

describe('opening and closing', () => {
  it('open asks the server, close says so; another row closes the first', () => {
    const sent: ClientMessage[] = [];
    const send = (m: ClientMessage) => sent.push(m);
    expect(openWork(row(), send)).toBe(true);
    expect(sent).toEqual([
      { type: 'workView', kind: 'subagent', agentId: 7, id: 'toolu_1', on: true },
    ]);
    expect(openWork(row(), send)).toBe(true); // the same one: nothing more asked
    expect(sent).toHaveLength(1);
    openWork(row({ id: 12, kind: 'teammate', work: { kind: 'teammate', agentId: 12 } }), send);
    expect(sent.slice(1)).toEqual([
      { type: 'workView', kind: 'subagent', agentId: 7, id: 'toolu_1', on: false },
      { type: 'workView', kind: 'teammate', agentId: 12, on: true },
    ]);
    workHandleMessage(content({ kind: 'teammate', agentId: 12, id: undefined, items: [item(1)] }));
    expect(workGetSnapshot().items).toHaveLength(1);
    closeWork(send);
    expect(sent.at(-1)).toEqual({ type: 'workView', kind: 'teammate', agentId: 12, on: false });
    expect(workGetSnapshot().open).toBeNull();
    closeWork(send);
    expect(sent).toHaveLength(4);
  });

  it('a temp with nothing to read does not open', () => {
    const sent: ClientMessage[] = [];
    expect(openWork(row({ work: null }), (m) => sent.push(m))).toBe(false);
    expect(sent).toEqual([]);
    expect(workGetSnapshot().open).toBeNull();
  });

  it('the request carries only the fields the ref has', () => {
    expect(viewMessage({ kind: 'teammate', agentId: 3 }, true)).toEqual({
      type: 'workView',
      kind: 'teammate',
      agentId: 3,
      on: true,
    });
  });
});
