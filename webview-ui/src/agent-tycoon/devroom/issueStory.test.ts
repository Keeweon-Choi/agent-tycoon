import { describe, expect, it } from 'vitest';

import type { RepoMerge } from '../../../../core/src/messages.js';
import { openIssues, shortPath, statusMoves, story, type StoryFacts, todayMerges } from './issueStory.js';

const add = { at: '2026-11-27T10:00:00Z', by: 'shop', change: 'add' };
const toDoing = { at: '2026-11-27T10:05:00Z', by: 'shop', change: 'status todo → doing, assignee — → web-worker' };
const toReview = { at: '2026-11-27T10:40:00Z', by: 'web-worker', change: 'status doing → review' };
const back = { at: '2026-11-27T11:00:00Z', by: 'shop', change: 'note — → (set), status review → doing' };

const facts = (over: Partial<StoryFacts> = {}, task: Partial<StoryFacts['task']> = {}): StoryFacts => ({
  task: { status: 'todo', history: [add], ...task },
  wt: { ahead: 0, dirty: 0 },
  merged: false,
  agent: null,
  files: null,
  notes: 0,
  checked: false,
  ...over,
});

describe('statusMoves', () => {
  it('reads every `status a → b` of the history, also inside a line of several changes', () => {
    expect(statusMoves([add, toDoing, back])).toEqual([
      { at: toDoing.at, by: 'shop', from: 'todo', to: 'doing' },
      { at: back.at, by: 'shop', from: 'review', to: 'doing' },
    ]);
  });

  it('ignores a title or note that only mentions the word status', () => {
    expect(statusMoves([{ at: add.at, by: 'x', change: 'title fix status → done' }])).toEqual([]);
  });
});

describe('story', () => {
  it('a fresh issue with nothing stored: assign is current, every other step is a dim line', () => {
    const s = story(facts());
    expect(s.current).toBe('assign');
    expect(s.position).toBe(1);
    expect(s.state).toBe('assign');
    expect(s.since).toBeNull();
    expect(s.reached).toEqual({ assign: true, work: false, changes: false, check: false, merge: false, deploy: false });
    expect(s.has).toEqual({ assign: true, work: false, changes: false, check: false, merge: false, deploy: false });
    expect(s.returned).toBeNull();
    expect(s.round).toBe(1);
    expect(s.run).toBeNull();
  });

  it('work under way: work is current (step 2 of 6), its run live since its start, one open round', () => {
    const s = story(
      facts({ agent: 'web-worker', files: 2, wt: { ahead: 1, dirty: 0 } }, {
        status: 'doing',
        history: [add, toDoing],
        executions: [{ id: 'agent:a1', kind: 'agent', ref: 'a1', startedAt: toDoing.at }],
      }),
    );
    expect(s.current).toBe('work');
    expect(s.run).toEqual({ since: toDoing.at, live: true });
    expect(s.position).toBe(2);
    expect(s.state).toBe('work');
    expect(s.rounds).toEqual([{ start: toDoing.at }]);
    expect(s.since).toBe(toDoing.at);
    expect(s.has.changes).toBe(true);
    expect(s.reached.work && !s.reached.changes).toBe(true);
  });

  it('in review: check is current, the move into it recorded, tests reported count as data', () => {
    const s = story(
      facts({ agent: 'web-worker' }, {
        status: 'review',
        history: [add, toDoing, toReview],
        testsPassed: { value: true, source: 'reported', at: toReview.at },
      }),
    );
    expect(s.current).toBe('check');
    expect(s.position).toBe(4);
    expect(s.state).toBe('check');
    expect(s.has.check).toBe(true);
    expect(s.reviewMoves.map((m) => m.to)).toEqual(['review']);
    expect(s.returned).toBeNull();
  });

  it('sent back from review: work is current again, the return and its time are kept, second round', () => {
    const s = story(facts({ agent: 'web-worker', notes: 2 }, { status: 'doing', history: [add, toDoing, toReview, back] }));
    expect(s.current).toBe('work');
    expect(s.returned).toEqual({ at: back.at, by: 'shop', from: 'review', to: 'doing' });
    expect(s.round).toBe(2);
    expect(s.state).toBe('workAgain');
    // The first round is closed by the move to review, the second is under way since the return.
    expect(s.rounds).toEqual([{ start: toDoing.at, end: toReview.at }, { start: back.at }]);
    expect(s.has.check).toBe(true);
  });

  it('back in review after a return: no open return any more, the round count stays', () => {
    const again = { ...toReview, at: '2026-11-27T11:30:00Z' };
    const s = story(facts({}, { status: 'review', history: [add, toDoing, toReview, back, again] }));
    expect(s.returned).toBeNull();
    expect(s.round).toBe(2);
    expect(s.state).toBe('checkAgain');
  });

  it('merged: merge is current whatever the status says; deploy never has data', () => {
    const s = story(facts({ merged: true }, { status: 'review' }));
    expect(s.current).toBe('merge');
    expect(s.state).toBe('merged');
    expect(s.reached.deploy).toBe(false);
    expect(s.has.merge).toBe(true);
    expect(s.has.deploy).toBe(false);
  });

  it('an ended run is not live', () => {
    const s = story(
      facts({}, {
        status: 'doing',
        executions: [
          { id: 'job:j1', kind: 'job', ref: 'j1', startedAt: toDoing.at, endedAt: { value: toReview.at, source: 'observed', at: toReview.at } },
        ],
      }),
    );
    expect(s.run).toEqual({ since: toDoing.at, live: false });
    expect(s.has.work).toBe(true);
  });
});

describe('openIssues', () => {
  it('keeps the rows whose worktree names an issue that is not done', () => {
    const rows = [{ task: { status: 'doing' as const } }, { task: { status: 'done' as const } }, {}];
    expect(openIssues(rows)).toEqual([rows[0]]);
  });
});

describe('todayMerges', () => {
  const m = (at: string, ok = true): RepoMerge => ({ at, ok, target: 'main', auto: false, task: at });
  it('the successful merges of the local day, newest first', () => {
    const now = new Date(2026, 10, 27, 20, 0).getTime();
    const today1 = new Date(2026, 10, 27, 9, 0).toISOString();
    const today2 = new Date(2026, 10, 27, 19, 0).toISOString();
    const yesterday = new Date(2026, 10, 26, 23, 0).toISOString();
    expect(todayMerges([m(today1), m(yesterday), m(today2), m(today2, false)], now).map((x) => x.at)).toEqual([today2, today1]);
  });
});

describe('shortPath', () => {
  it('keeps short paths and folds the middle of long ones', () => {
    expect(shortPath('src/cart.ts')).toBe('src/cart.ts');
    expect(shortPath('server/src/agent-tycoon/engine/git/worktrees.ts')).toBe('server/…/git/worktrees.ts');
  });
});
