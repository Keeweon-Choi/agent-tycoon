import { describe, expect, it } from 'vitest';

import type { SubColumn } from './devroomState.js';
import { rememberSubs } from './subagents.js';

const col = (agentId: number, parent: string, done = false): SubColumn => ({
  key: `${agentId}:${parent}`,
  n: 0,
  desc: parent,
  lines: [],
  agentId,
  parent,
  done,
});
const both = new Set([1, 2]);

describe('rememberSubs (DEVROOM-SUBVIEW)', () => {
  it('keeps the first-seen time, and remembers an ended one as done', () => {
    const a = rememberSubs([], [col(1, 'a'), col(1, 'b')], both, 100, 10);
    expect(a.map((r) => [r.key, r.running, r.since])).toEqual([
      ['1:a', true, 100],
      ['1:b', true, 100],
    ]);
    const b = rememberSubs(a, [col(1, 'b')], both, 200, 10);
    expect(b.map((r) => [r.key, r.running, r.since, r.endedAt])).toEqual([
      ['1:b', true, 100, null],
      ['1:a', false, 100, 200],
    ]);
    // Still gone later: its end time stays.
    expect(rememberSubs(b, [col(1, 'b')], both, 900, 10)[1].endedAt).toBe(200);
  });

  it('a spawn that came back is done even while its rows are still there', () => {
    const [r] = rememberSubs([], [col(1, 'a', true)], both, 50, 10);
    expect([r.running, r.endedAt]).toEqual([false, 50]);
  });

  it('another pick does not end the sub-agents it does not show', () => {
    const a = rememberSubs([], [col(1, 'a')], both, 100, 10);
    expect(rememberSubs(a, [], new Set([2]), 200, 10)[0].running).toBe(true);
  });

  it('keeps the newest finished ones only', () => {
    let rows = rememberSubs([], ['a', 'b', 'c'].map((p) => col(1, p)), both, 0, 2);
    rows = rememberSubs(rows, [col(1, 'b'), col(1, 'c')], both, 1, 2);
    rows = rememberSubs(rows, [col(1, 'c')], both, 2, 2);
    rows = rememberSubs(rows, [], both, 3, 2);
    expect(rows.map((r) => r.key).sort()).toEqual(['1:b', '1:c']);
  });
});
