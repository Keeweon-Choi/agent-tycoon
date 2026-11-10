import { describe, expect, it } from 'vitest';

import type { BoardTask } from '../../../../core/src/messages.js';
import { MEMBER_MAIN_MAX, memberActions, type MemberFacts, memberTasks } from './memberActions.js';

const base: MemberFacts = { chat: true, work: false, looks: true, engine: null, canAct: true };
const every = (f: MemberFacts) => {
  const { main, more } = memberActions(f);
  return [...main, ...more];
};

describe('the member card: big buttons vs the ⋯ menu (FEAT-PARTY-V2)', () => {
  it('a plain session: chat on the card; looks and the stats window behind ⋯', () => {
    expect(memberActions(base)).toEqual({ main: ['chat'], more: ['looks', 'stats'] });
  });

  it('a stopped engine orchestrator: chat and start; dev, files, settings and delete behind ⋯', () => {
    const r = memberActions({ ...base, engine: { actions: ['start'], worker: false } });
    expect(r.main).toEqual(['chat', 'start']);
    expect(r.more).toEqual(['looks', 'stats', 'dev', 'files', 'edit', 'remove']);
  });

  it('a running background session: stop on the card, restart behind ⋯; a Worker adds promote', () => {
    const r = memberActions({ ...base, engine: { actions: ['stop', 'restart'], worker: true } });
    expect(r.main).toEqual(['chat', 'stop']);
    expect(r.more).toEqual(['looks', 'stats', 'dev', 'files', 'restart', 'promote', 'edit', 'remove']);
  });

  it('never more than three big buttons, and every action stays reachable', () => {
    const f: MemberFacts = { ...base, work: true, engine: { actions: ['stop', 'restart'], worker: true } };
    const { main, more } = memberActions(f);
    expect(main.length).toBeLessThanOrEqual(MEMBER_MAIN_MAX);
    expect(main).toEqual(['chat', 'stop', 'work']);
    expect(new Set([...main, ...more]).size).toBe(main.length + more.length); // none twice
    for (const a of ['looks', 'stats', 'dev', 'files', 'restart', 'promote', 'edit', 'remove'] as const)
      expect(every(f)).toContain(a);
  });

  it('a read-only client: no engine action at all, the views stay', () => {
    const r = memberActions({ ...base, canAct: false, engine: { actions: ['stop', 'restart'], worker: true } });
    expect(r.main).toEqual(['chat']);
    expect(r.more).toEqual(['looks', 'stats', 'dev', 'files']);
  });
});

describe("the member's issues", () => {
  const task = (id: string, status: BoardTask['status'], who: string, updatedAt: string) =>
    ({ id, status, title: id, updatedAt, owner: { kind: 'lead', name: who } }) as unknown as BoardTask;
  it("its own Tasks only, the open ones first (blocked, doing, review, todo), then the latest", () => {
    const tasks = [
      task('a', 'done', 'agty', '2026-11-06T10:00:00Z'),
      task('b', 'doing', 'agty', '2026-11-06T09:00:00Z'),
      task('c', 'blocked', 'agty', '2026-11-06T08:00:00Z'),
      task('d', 'doing', 'other', '2026-11-06T11:00:00Z'),
      task('e', 'doing', 'agty', '2026-11-06T11:00:00Z'),
    ];
    expect(memberTasks(tasks, 'agty', (x) => x.owner?.name ?? null).map((x) => x.id)).toEqual(['c', 'e', 'b', 'a']);
  });
});
