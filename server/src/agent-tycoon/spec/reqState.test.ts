// RQ1 (RQW §2.4): the three states from the four axes, table-driven: the table's five rows, a
// guess only, a changed text and a rejection. The function lives in core; the server and the
// 요구사항 tab both call it.
import { describe, expect, it } from 'vitest';

import { reqState, reqStateCounts } from '../../../../core/src/agent-tycoon/spec/reqState.js';
import type { ReqFacts, TraceState } from '../../../../core/src/agent-tycoon/spec/trace.js';

const facts = (f: Partial<ReqFacts>): ReqFacts => ({
  issues: [],
  commits: {},
  merged: {},
  runs: {},
  passed: {},
  reported: {},
  ...f,
});
const st = (f: Partial<ReqFacts>, more: Partial<TraceState> = {}): TraceState => ({
  acceptance: { current: 'none' },
  freshness: 'current',
  facts: facts(f),
  ...more,
});
const seenBoth = {
  commits: { confirmed: 1 },
  merged: { confirmed: 1 },
  runs: { written: 1 },
  passed: { written: 1 },
};

const rows: Array<[string, TraceState | undefined, string, boolean, string[]]> = [
  [
    '1 accepted on this text',
    st({}, { acceptance: { current: 'accepted' } }),
    'done',
    false,
    ['accepted'],
  ],
  [
    '2 merged and passed, seen through confirmed and written links',
    st(seenBoth),
    'done',
    false,
    ['seen'],
  ],
  [
    '3 rejected on this text',
    st(
      { issues: [{ id: 'T-1', status: 'doing', how: 'confirmed' }] },
      { acceptance: { current: 'rejected' } },
    ),
    'doing',
    false,
    ['rejected', 'issue', 'noRun'],
  ],
  [
    '3 before 2: rejected on this text wins over merged and passed, the why says both',
    st(seenBoth, { acceptance: { current: 'rejected' } }),
    'doing',
    false,
    ['rejected', 'commits', 'runs'],
  ],
  [
    '4 an issue in review',
    st({ issues: [{ id: 'T-1', status: 'review', how: 'confirmed' }] }),
    'doing',
    false,
    ['issue', 'noRun'],
  ],
  [
    '4 an issue done, nothing seen',
    st({ issues: [{ id: 'T-1', status: 'done', how: 'written' }] }),
    'doing',
    false,
    ['issue', 'noRun'],
  ],
  ['4 a commit, not merged', st({ commits: { written: 1 } }), 'doing', false, ['commits', 'noRun']],
  [
    '4 only an agent said its tests passed',
    st({ reported: { confirmed: 1 } }),
    'doing',
    false,
    ['noRun', 'reported'],
  ],
  ['5 nothing linked', st({}), 'todo', false, ['none']],
  [
    '5 issues still to do',
    st({
      issues: [
        { id: 'T-1', status: 'todo', how: 'confirmed' },
        { id: 'T-2', status: 'proposed', how: 'written' },
      ],
    }),
    'todo',
    false,
    ['todoIssues'],
  ],
  ['no state at all', undefined, 'todo', false, ['none']],
  [
    'guess only: a commit inferred through an issue to do',
    st({ issues: [{ id: 'T-1', status: 'todo', how: 'confirmed' }], commits: { guess: 1 } }),
    'doing',
    true,
    ['commits', 'noRun'],
  ],
  [
    'guess only never makes 확인됨',
    st({ commits: { guess: 2 }, merged: { guess: 2 }, runs: { guess: 1 }, passed: { guess: 1 } }),
    'doing',
    true,
    ['commits', 'runs'],
  ],
  [
    'a guess beside a fact is not dashed',
    st({ commits: { guess: 1, written: 1 } }),
    'doing',
    false,
    ['commits', 'noRun'],
  ],
  [
    'content changed: what was seen is about the old text',
    st(seenBoth, { freshness: 'review', linkReview: true }),
    'doing',
    false,
    ['commits', 'runs', 'changed'],
  ],
  [
    'content changed, accepted on the current text still wins',
    st(seenBoth, { freshness: 'review', acceptance: { current: 'accepted' } }),
    'done',
    false,
    ['accepted'],
  ],
];

describe('reqState (RQW §2.4)', () => {
  it.each(rows)('%s', (_name, s, status, guess, why) => {
    const v = reqState(s);
    expect(v.status).toBe(status);
    expect(v.guess).toBe(guess);
    expect(v.why.map((w) => w.k)).toEqual(why);
  });

  it('the reasons carry the numbers the sentence says; no percentage anywhere', () => {
    const v = reqState(
      st({
        issues: [{ id: 'T-117', status: 'review', how: 'written' }],
        commits: { confirmed: 2 },
        merged: { confirmed: 1 },
      }),
    );
    expect(v.why).toEqual([
      { k: 'issue', id: 'T-117', status: 'review', how: 'written' },
      { k: 'commits', n: 2, merged: 1, guess: false },
      { k: 'noRun' },
    ]);
    expect(JSON.stringify(v)).not.toMatch(/%|percent|ratio/);
    expect(reqState(st(seenBoth)).why).toEqual([{ k: 'seen', merged: 1, passed: 1 }]);
  });

  it('counts each state', () => {
    expect(reqStateCounts(['todo', 'done', 'todo', 'doing'])).toEqual({
      todo: 2,
      doing: 1,
      done: 1,
    });
  });
});
