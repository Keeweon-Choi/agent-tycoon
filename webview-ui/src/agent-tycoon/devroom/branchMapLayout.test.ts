import { describe, expect, it } from 'vitest';

import type { OfficeJob, RepoMerge } from '../../../../core/src/messages.js';
import { DEVBRANCH_LOOPS_MAX, DEVBRANCH_TIPS_MAX } from '../../constants.js';
import { baseJobs, layoutMap, type MapLayout, mergedToday, orderTips, type Pt } from './branchMapLayout.js';

/** The branch view's width: the dev room maximized at 1280, the default window, and a 1024x700 screen. */
const WIDTHS = [1270, 1080, 1014];

type Seg = readonly [Pt, Pt];
const segs = (line: readonly Pt[]): Seg[] => line.slice(1).map((p, i) => [line[i], p] as const);

/** Proper crossing or touching of two segments (axis-aligned or not). */
function meet([a, b]: Seg, [c, d]: Seg): boolean {
  const o = (p: Pt, q: Pt, r: Pt) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]));
  const on = (p: Pt, q: Pt, r: Pt) =>
    Math.min(p[0], r[0]) <= q[0] && q[0] <= Math.max(p[0], r[0]) && Math.min(p[1], r[1]) <= q[1] && q[1] <= Math.max(p[1], r[1]);
  const [o1, o2, o3, o4] = [o(a, b, c), o(a, b, d), o(c, d, a), o(c, d, b)];
  if (o1 !== o2 && o3 !== o4) return true;
  return (o1 === 0 && on(a, c, b)) || (o2 === 0 && on(a, d, b)) || (o3 === 0 && on(c, a, d)) || (o4 === 0 && on(c, b, d));
}

type Box = { x: number; y: number; w: number; h: number };
const overlaps = (p: Box, q: Box) => p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h;
/** A segment passes through a box's inside (its end may touch the box's edge: the branch meets its card). */
function enters([a, b]: Seg, r: Box): boolean {
  const steps = 64;
  for (let i = 1; i < steps; i++) {
    const x = a[0] + ((b[0] - a[0]) * i) / steps;
    const y = a[1] + ((b[1] - a[1]) * i) / steps;
    if (x > r.x && x < r.x + r.w && y > r.y && y < r.y + r.h) return true;
  }
  return false;
}

function checkClean(m: MapLayout) {
  const cards: Box[] = [...m.tips, ...(m.box ? [m.box] : [])];
  const boxes: Box[] = [...cards, ...m.loops.map((l) => ({ x: l.x, y: l.y, w: l.w, h: 1 }))];
  for (let i = 0; i < cards.length; i++)
    for (let j = i + 1; j < cards.length; j++) expect(overlaps(cards[i], cards[j]), `cards ${i} ${j}`).toBe(false);
  if (m.box) for (const l of m.loops) expect(l.x + l.w).toBeLessThanOrEqual(m.box.x);
  expect(m.trunkEnd).toBeLessThanOrEqual(m.width);
  // Every line leaves the trunk (branches upward, loops downward): lifted off it by half a pixel, no two meet.
  const lift = (line: readonly Pt[], dy: number) => line.map(([x, y]) => [x, y === m.trunkY ? y + dy : y] as Pt);
  const lines = [...m.tips.map((t) => lift(t.line, -0.5)), ...m.loops.map((l) => lift(l.line, 0.5))];
  for (let i = 0; i < lines.length; i++)
    for (let j = i + 1; j < lines.length; j++)
      for (const s of segs(lines[i])) for (const u of segs(lines[j])) expect(meet(s, u), `lines ${i} ${j}`).toBe(false);
  for (const line of lines) for (const s of segs(line)) for (const b of boxes) expect(enters(s, b)).toBe(false);
  for (const t of m.tips) {
    expect(t.x + t.w).toBeLessThanOrEqual(m.width);
    expect(t.y).toBeGreaterThanOrEqual(0);
  }
  for (const l of m.loops) expect(l.x + l.w).toBeLessThanOrEqual(m.width);
}

describe('orderTips', () => {
  it('puts live agents first, then the most recently changed', () => {
    const { shown, folded } = orderTips([
      { key: 'old', live: false, last: 1 },
      { key: 'new', live: false, last: 9 },
      { key: 'live-old', live: true, last: 2 },
      { key: 'unknown', live: false, last: NaN },
    ]);
    expect(shown).toEqual(['live-old', 'new', 'old', 'unknown']);
    expect(folded).toBe(0);
  });

  it(`folds past ${DEVBRANCH_TIPS_MAX} into one count`, () => {
    const tips = Array.from({ length: 9 }, (_, i) => ({ key: `t${i}`, live: i === 8, last: i }));
    const { shown, folded } = orderTips(tips);
    expect(shown).toEqual(['t8', 't7', 't6', 't5', 't4', 't3']);
    expect(folded).toBe(3);
  });
});

describe('mergedToday', () => {
  const now = new Date(2026, 10, 27, 20, 0).getTime();
  const at = (h: number, day = 27) => new Date(2026, 10, day, h, 5).toISOString();
  const m = (over: Partial<RepoMerge>): RepoMerge => ({ ok: true, at: at(10), target: 'main', auto: false, kind: 'ff', branch: 'b', ...over });
  it("keeps today's merges into the base, oldest first", () => {
    const list = mergedToday(
      [
        m({ branch: 'a', at: at(9) }),
        m({ branch: 'b', at: at(15) }),
        m({ branch: 'yesterday', at: at(23, 26) }),
        m({ branch: 'refused', ok: false }),
        m({ branch: 'nothing', kind: 'already' }),
        m({ branch: 'other', target: 'dev' }),
      ],
      'main',
      now,
    );
    expect(list.map((x) => x.branch)).toEqual(['a', 'b']);
  });
});

describe('layoutMap', () => {
  it('the empty case: a trunk and its label only', () => {
    const m = layoutMap(800, [], 0, []);
    expect(m.tips).toEqual([]);
    expect(m.loops).toEqual([]);
    expect(m.trunkY).toBeGreaterThan(0);
    expect(m.height).toBeGreaterThan(m.trunkY);
  });

  for (const width of WIDTHS)
    for (const box of [false, true])
      for (const n of [1, 2, 3, 4, 5, 6])
        it(`${n} tips and ${n} loops at ${width}px${box ? ' with the base box' : ''}: no card overlaps, no line crosses a line or a card`, () => {
          const keys = Array.from({ length: n }, (_, i) => `k${i}`);
          const m = layoutMap(width, keys, 0, keys, box);
          expect(m.tips.map((t) => t.key)).toEqual(keys);
          expect(m.loops.length + m.loopsMore).toBe(n);
          expect(m.box !== null).toBe(box);
          checkClean(m);
        });

  for (const width of WIDTHS)
    it(`six tips, the +N tip, the base box and too many loops at ${width}px: the newest loops are drawn`, () => {
      const keys = Array.from({ length: 6 }, (_, i) => `k${i}`);
      const loops = Array.from({ length: 9 }, (_, i) => `m${i}`);
      const m = layoutMap(width, keys, 4, loops, true);
      expect(m.tips).toHaveLength(7);
      expect(m.tips[6].key).toBeNull();
      expect(m.folded).toBe(4);
      expect(m.loops.length).toBeLessThanOrEqual(DEVBRANCH_LOOPS_MAX);
      expect(m.loops.length + m.loopsMore).toBe(9);
      expect(m.loops.at(-1)?.key).toBe('m8');
      expect(m.moreX).toBeLessThan(m.loops[0].x);
      checkClean(m);
    });

  it('the first tip sits in the row nearest the trunk, at the left', () => {
    const m = layoutMap(724, ['a', 'b', 'c', 'd'], 0, []);
    const first = m.tips[0];
    expect(Math.max(...m.tips.map((t) => t.y))).toBe(first.y);
    expect(Math.min(...m.tips.map((t) => t.x))).toBe(first.x);
    expect(first.line[0][1]).toBe(m.trunkY);
  });
});

describe('the jobs on the base', () => {
  it('baseJobs keeps the running jobs of the project that no branch owns', () => {
    const job = (over: Partial<OfficeJob>): OfficeJob => ({ pid: 1, project: 'shop', cmd: 'npm test', started: '2026-11-27T10:00:00Z', ...over });
    const list = baseJobs(
      [
        job({ label: 'base' }),
        job({ label: 'trunk run', run: { task: '', script: 'test', role: 'test' } as OfficeJob['run'] }),
        job({ label: 'branch run', run: { task: 'feat-a', script: 'test', role: 'test' } as OfficeJob['run'] }),
        job({ label: 'ended', ended: '2026-11-27T10:05:00Z' }),
        job({ label: 'other', project: 'blog' }),
        job({ label: 'queued', started: null }),
      ],
      'shop',
      new Set(['feat-a']),
    );
    expect(list.map((j) => j.label)).toEqual(['base', 'trunk run']);
  });
});
