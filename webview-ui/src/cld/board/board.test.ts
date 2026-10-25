import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { HwSample,OfficeSnapshot } from '../../../../core/src/messages.js';
import {
  BOARD_HISTORY_MS,
  BOARD_PAGE_MS,
  BOARD_PICK_HOLD_MS,
  BOARD_RECENT_MS,
} from '../../constants.js';
import { setLanguage } from '../../i18n/index.js';
import { cldGetSnapshot, cldHandleMessage, cldResetForTests } from '../officeStore.js';
import {
  donutArc,
  donutFrac,
  endWords,
  moreText,
  pctText,
  pickPage,
  projectRows,
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
    expect(r.page).toBe('projects');
    for (const [k, page] of (['hw', 'gpu', 'projects'] as const).entries()) {
      r = rotate(r, (k + 1) * BOARD_PAGE_MS, false);
      expect(r.page).toBe(page);
    }
    expect(BOARD_PAGE_MS).toBeGreaterThanOrEqual(15_000);
  });

  it('holds while the pointer is over the board, then gives the page its full time', () => {
    let r = rotate(startRotation(0), 30_000, true);
    expect(r.page).toBe('projects');
    r = rotate(r, 31_000, false);
    expect(r.page).toBe('projects');
    expect(rotate(r, 30_000 + BOARD_PAGE_MS, false).page).toBe('hw');
  });

  it('a tab picked by hand holds its page for a minute', () => {
    let r = pickPage('gpu', 0);
    r = rotate(r, BOARD_PICK_HOLD_MS - 1, false);
    expect(r.page).toBe('gpu');
    r = rotate(r, BOARD_PICK_HOLD_MS + BOARD_PAGE_MS, false);
    expect(r.page).toBe('projects');
  });
});

describe('the GPU line', () => {
  const t = { id: 'g-1', project: 'pofol', exclusive: false, ts: iso(125_000), ticket: 7 };

  it('ticket, VRAM and wait', () => {
    expect(ticketText(7)).toBe('#07');
    // eslint-disable-next-line pixel-agents/no-inline-colors -- a ticket number, not a colour
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

describe('the projects page', () => {
  afterEach(() => cldResetForTests());
  const orch = (name: string, order: number, busy: boolean | null = false) => ({
    name,
    dir: `/w/${name}`,
    tab: 'orch',
    order,
    state: 'running' as const,
    busy,
    remoteControl: { on: false, url: null },
    compactions: 0,
    alive: true,
    agentId: 100 + order,
  });
  const office = (n: number): OfficeSnapshot => ({
    type: 'officeSnapshot',
    readOnly: true,
    tabs: [{ name: 'orch', kind: 'orch', order: 0 }],
    orchestrators: Array.from({ length: n }, (_, k) => orch(`p${k}`, k)),
  });

  it('up to 8 rows, then "\uc678 N"', () => {
    cldHandleMessage(office(11));
    const { shown, more } = projectRows(cldGetSnapshot(), {}, NOW);
    expect(shown).toHaveLength(8);
    expect(more).toBe(3);
    expect(moreText(more)).toBe('\uc678 3');
    cldHandleMessage(office(8));
    expect(projectRows(cldGetSnapshot(), {}, NOW).more).toBe(0);
  });

  it('D3b: a project’s Workers are no project rows', () => {
    cldHandleMessage(office(3));
    expect(projectRows(cldGetSnapshot(), {}, NOW, 8, new Set(['p1'])).shown.map((r) => r.name).sort()).toEqual(['p0', 'p2']);
  });

  it('who needs the user first; context %, running jobs and Codex, the last notable event', () => {
    cldHandleMessage(office(3));
    const permission = [
      { toolId: 't', status: 'Bash', toolName: 'Bash', done: false, permissionWait: true },
    ];
    cldHandleMessage({
      type: 'agentContextUsage',
      id: 102,
      contextTokens: 50_000,
      maxContextTokens: 200_000,
    });
    cldHandleMessage({
      type: 'officeJobs',
      jobs: [
        { pid: 1, project: 'p2', cmd: 'x', label: '\ubc30\ud3ec' },
        { pid: 2, project: 'p2', cmd: 'y', ended: iso(1000) },
      ],
    });
    cldHandleMessage({
      type: 'codexTasks',
      tasks: [{ id: 'c', project: 'p2', state: 'running' }],
    });
    for (const [kind, summary, ago] of [
      ['job_end', '\ubc30\ud3ec\uac00 \ub05d\ub0ac\uc5b4\uc694', 180_000],
      ['turn_end', 'p2 \ud134 \ub05d', 60_000],
    ] as const)
      cldHandleMessage({ type: 'officeEvent', ts: iso(ago), kind, name: 'p2', summary });
    const { shown } = projectRows(cldGetSnapshot(), { 102: permission }, NOW);
    expect(shown[0]).toMatchObject({
      name: 'p2',
      ring: 'permission',
      context: 25,
      jobs: 1,
      codex: 1,
      work: '\ubc30\ud3ec · \uc2e4\ud589 \uc911 / Codex \uc791\uc5c5 · \uc2e4\ud589 \uc911',
      last: '3\ubd84 \uc804 · \ubc30\ud3ec\uac00 \ub05d\ub0ac\uc5b4\uc694',
    });
    expect(shown.slice(1).map((r) => r.name)).toEqual(['p0', 'p1']);
    expect(shown[1]).toMatchObject({ context: null, jobs: 0, codex: 0, last: null });
  });

  it('a job in the GPU queue and a Codex limit wait read as waits, not running (U-03)', () => {
    cldHandleMessage(office(3));
    cldHandleMessage({
      type: 'officeJobs',
      jobs: [{ pid: 1, project: 'p2', cmd: 'x', label: '\ud559\uc2b5', gpu: 'queued', started: null }],
    });
    cldHandleMessage({
      type: 'codexTasks',
      tasks: [{ id: 'c', project: 'p2', state: 'limit', title: '\uc791\uc5c5' }],
    });
    expect(projectRows(cldGetSnapshot(), {}, NOW).shown.find((r) => r.name === 'p2')?.work).toBe(
      '\ud559\uc2b5 · GPU \ub300\uae30 / \uc791\uc5c5 · \ud55c\ub3c4 \ub300\uae30',
    );
    cldHandleMessage({
      type: 'codexTasks',
      tasks: [{ id: 'c', project: 'p2', state: 'running', title: '\uc791\uc5c5', started: null }],
    });
    expect(projectRows(cldGetSnapshot(), {}, NOW).shown.find((r) => r.name === 'p2')?.work).toContain('\uc2e4\ud589 \ub300\uae30');
  });
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
