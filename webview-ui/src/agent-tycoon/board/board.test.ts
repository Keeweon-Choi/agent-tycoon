import { beforeEach, describe, expect, it } from 'vitest';

import type { HwSample } from '../../../../core/src/messages.js';
import {
  BOARD_HISTORY_MS,
  BOARD_PAGE_MS,
  BOARD_PICK_HOLD_MS,
  BOARD_RECENT_MS,
} from '../../constants.js';
import { setLanguage } from '../../i18n/index.js';
import {
  donutArc,
  donutFrac,
  endWords,
  inQuad,
  moreText,
  pctText,
  pickPage,
  recentEnds,
  rotate,
  startRotation,
  tickerItems,
  ticketLine,
  ticketText,
  vramText,
} from './board.js';
import { type HwPoint, lineSegments, recordHw, Ring } from './hwHistory.js';

const NOW = Date.parse('2026-10-22T03:00:00Z');
beforeEach(() => setLanguage('ko'));
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

describe('the ring buffer', () => {
  it('keeps the newest `cap` values, oldest first', () => {
    const r = new Ring<number>(3);
    expect(r.toArray()).toEqual([]);
    expect(r.last()).toBeUndefined();
    for (const x of [1, 2]) r.push(x);
    expect(r.toArray()).toEqual([1, 2]);
    for (const x of [3, 4, 5]) r.push(x);
    expect(r.toArray()).toEqual([3, 4, 5]);
    expect(r.last()).toBe(5);
    r.push(6);
    expect(r.toArray()).toEqual([4, 5, 6]);
  });

  it('records a sample once (a resent snapshot does not count twice)', () => {
    const r = new Ring<HwPoint>(10);
    const hw = (ts: string, cpuUtil: number) =>
      ({ type: 'hwSample', ts, stale: false, disks: [], warnings: [], cpuUtil }) as HwSample;
    recordHw(hw(iso(4000), 0.1), r);
    recordHw(hw(iso(2000), 0.5), r);
    recordHw(hw(iso(2000), 0.5), r);
    recordHw(hw(iso(3000), 0.9), r); // older than the last: ignored
    recordHw({ ...hw('', 0.2), ts: null }, r);
    expect(r.toArray().map((p) => p.cpu)).toEqual([0.1, 0.5]);
    expect(r.toArray()[0].gpu).toBeNull();
  });
});

describe('the line graph', () => {
  const pts = (vals: Array<[number, number | null]>): HwPoint[] =>
    vals.map(([ago, v]) => ({ t: NOW - ago, cpu: v, gpu: null }));

  it('maps the last 60 s to the width, the newest at the right edge', () => {
    const [seg] = lineSegments(
      pts([
        [60_000, 0],
        [30_000, 0.5],
        [0, 1],
      ]),
      'cpu',
      120,
      100,
    );
    expect(seg).toEqual([
      [0, 100],
      [60, 50],
      [120, 0],
    ]);
  });

  it('breaks at a missing value, drops what is older than 60 s and clamps', () => {
    const segs = lineSegments(
      pts([
        [BOARD_HISTORY_MS + 2000, 0.3],
        [40_000, 1.5],
        [20_000, null],
        [0, -1],
      ]),
      'cpu',
      60,
      10,
    );
    expect(segs).toEqual([[[20, 0]], [[60, 10]]]);
    expect(lineSegments(pts([[0, 0.4]]), 'gpu', 10, 10)).toEqual([]);
  });
});

describe('the donuts', () => {
  it('0, 100 % and beyond, and nothing to draw without a total', () => {
    expect(donutFrac(0, 8)).toBe(0);
    expect(donutFrac(8, 8)).toBe(1);
    expect(donutFrac(9, 8)).toBe(1);
    expect(donutFrac(-1, 8)).toBe(0);
    expect(donutFrac(4, 8)).toBe(0.5);
    expect(donutFrac(4, 0)).toBeNull();
    expect(donutFrac(null, 8)).toBeNull();
    expect(donutFrac(4, undefined)).toBeNull();
  });

  it('arcs clockwise from 12 o’clock: empty at 0, the whole ring at 1', () => {
    const zero = donutArc(0);
    expect(zero.end - zero.start).toBe(0);
    const full = donutArc(1);
    expect(full.start).toBeCloseTo(-Math.PI / 2);
    expect(full.end - full.start).toBeCloseTo(2 * Math.PI);
    expect(donutArc(0.25).end).toBeCloseTo(0);
  });

  it('a sliver never reads as 0 or 100 %', () => {
    expect(pctText(0)).toBe('0%');
    expect(pctText(0.004)).toBe('<1%');
    expect(pctText(0.37)).toBe('37%');
    expect(pctText(0.996)).toBe('>99%');
    expect(pctText(1)).toBe('100%');
  });
});

describe('page rotation', () => {
  it('turns every BOARD_PAGE_MS, round and round', () => {
    let r = startRotation(0);
    r = rotate(r, BOARD_PAGE_MS - 1, false);
    expect(r.page).toBe('summary');
    for (const [k, page] of (['hw', 'gpu', 'summary'] as const).entries()) {
      r = rotate(r, (k + 1) * BOARD_PAGE_MS, false);
      expect(r.page).toBe(page);
    }
    expect(BOARD_PAGE_MS).toBeGreaterThanOrEqual(15_000);
  });

  it('holds while the pointer is over the board, then gives the page its full time', () => {
    let r = rotate(startRotation(0), 30_000, true);
    expect(r.page).toBe('summary');
    r = rotate(r, 31_000, false);
    expect(r.page).toBe('summary');
    expect(rotate(r, 30_000 + BOARD_PAGE_MS, false).page).toBe('hw');
  });

  it('a tab picked by hand holds its page for a minute', () => {
    let r = pickPage('gpu', 0);
    r = rotate(r, BOARD_PICK_HOLD_MS - 1, false);
    expect(r.page).toBe('gpu');
    r = rotate(r, BOARD_PICK_HOLD_MS + BOARD_PAGE_MS, false);
    expect(r.page).toBe('summary');
  });
});

describe('the GPU line', () => {
  const t = { id: 'g-1', project: 'pearl', exclusive: false, ts: iso(125_000), ticket: 7 };

  it('ticket, VRAM and wait', () => {
    expect(ticketText(7)).toBe('#07');
    // eslint-disable-next-line agent-tycoon/no-inline-colors -- a ticket number, not a colour
    expect(ticketText(123)).toBe('#123');
    expect(vramText(2)).toBe('2 GiB');
    expect(vramText(1.25)).toBe('1.3 GiB');
    expect(vramText(null)).toBe('VRAM ?');
    expect(ticketLine({ ...t, vramGib: 2 }, NOW)).toBe('#07 · 2 GiB · 2\ubd84');
  });

  it('gpu_cancel reasons and releases in words', () => {
    expect(endWords({ kind: 'cancel', reason: 'cancel' })).toBe('\ucde8\uc18c');
    expect(endWords({ kind: 'cancel', reason: 'wait' })).toBe('\uc2dc\uac04 \ucd08\uacfc');
    expect(endWords({ kind: 'cancel', reason: 'stop' })).toBe('\uba48\ucda4');
    expect(endWords({ kind: 'cancel', reason: 'dead' })).toBe('\ube44\uc815\uc0c1 \uc885\ub8cc');
    expect(endWords({ kind: 'cancel', reason: null })).toBe('\ucde8\uc18c');
    expect(endWords({ kind: 'release', exit: 0 })).toBe('\ub05d\ub0a8(\uc131\uacf5)');
    expect(endWords({ kind: 'release', exit: 1 })).toBe('\uc2e4\ud328');
    expect(endWords({ kind: 'release', reason: 'dead' })).toBe('\ube44\uc815\uc0c1 \uc885\ub8cc');
  });

  it('recent endings fade out, newest first, and leave', () => {
    const end = (id: string, ago: number) => ({
      id,
      project: 'p',
      kind: 'cancel' as const,
      ts: iso(ago),
    });
    const ends = recentEnds(
      [end('old', BOARD_RECENT_MS + 1), end('mid', BOARD_RECENT_MS / 2), end('new', 0)],
      NOW,
    );
    expect(ends.map((e) => e.end.id)).toEqual(['new', 'mid']);
    expect(ends[0].fade).toBe(1);
    expect(ends[1].fade).toBeCloseTo(0.5);
  });
});

describe('"\uc678 N"', () => {
  it('what did not fit', () => expect(moreText(3)).toBe('\uc678 3'));
});

describe('the ticker', () => {
  it('the latest notable news, newest first, without the chatter', () => {
    const ev = (kind: string, summary: string, msAgo: number) => ({
      type: 'officeEvent' as const,
      ts: iso(msAgo),
      kind,
      summary,
    });
    const items = tickerItems(
      [
        ev('turn_end', 'a \ud134 \ub05d', 0),
        ev('job_end', '\ubc30\ud3ec\uac00 \ub05d\ub0ac\uc5b4\uc694', 120_000),
        ev('send', 'a → b \uba54\uc2dc\uc9c0', 130_000),
        ev('gpu_lease', 'GPU \ucc28\ub840 \uc634: p', 600_000),
      ],
      NOW,
      2,
    );
    expect(items).toEqual(['2\ubd84 \uc804 \ubc30\ud3ec\uac00 \ub05d\ub0ac\uc5b4\uc694', '10\ubd84 \uc804 GPU \ucc28\ub840 \uc634: p']);
  });
});

describe('the board as a tap target', () => {
  it('a flat rectangle: inside, outside, the far edges excluded', () => {
    const q = { x: 10, y: 20, ux: 100, uy: 0, vx: 0, vy: 30 };
    expect(inQuad({ x: 10, y: 20 }, q)).toBe(true);
    expect(inQuad({ x: 109, y: 49 }, q)).toBe(true);
    expect(inQuad({ x: 110, y: 30 }, q)).toBe(false);
    expect(inQuad({ x: 50, y: 19 }, q)).toBe(false);
  });

  it("the isometric wall's slanted face: the sheared box, not its bounding box", () => {
    // Top edge going down-right at the wall's 2:1, sides straight down.
    const q = { x: 0, y: 0, ux: 100, uy: 50, vx: 0, vy: 40 };
    expect(inQuad({ x: 50, y: 45 }, q)).toBe(true); // middle of the face
    expect(inQuad({ x: 90, y: 10 }, q)).toBe(false); // in the bounding box, above the face
    expect(inQuad({ x: 10, y: 80 }, q)).toBe(false); // in the bounding box, below the face
    expect(inQuad({ x: 5, y: 5 }, { ...q, ux: 0, uy: 0 })).toBe(false); // degenerate
  });
});
