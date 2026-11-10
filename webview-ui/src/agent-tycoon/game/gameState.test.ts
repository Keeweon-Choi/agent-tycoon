// GAME-UI-1 G3: the party states, the job run's honest fill and the HUD figures.
import { beforeAll, describe, expect, it } from 'vitest';

import { koText } from '../../../../core/src/agent-tycoon/serverText.js';
import type { OfficeJob } from '../../../../core/src/messages.js';
import { setLanguage } from '../../i18n/index.js';
import { contextLeft, contextTone, gaugeTone, gaugeWindows, heatLook, isDaytime, litCells, partyState, runFill, stopCells, usageLeft, windowLeft } from './gameState.js';

beforeAll(() => setLanguage('ko'));

describe('party', () => {
  it('a wait wins over the activity; the activity says working; anything else rests', () => {
    expect(partyState('question', 'working')).toBe('ask');
    expect(partyState('permission', 'idle')).toBe('lock');
    expect(partyState(undefined, 'working')).toBe('work');
    expect(partyState(undefined, 'attention')).toBe('rest');
    expect(partyState(undefined, null)).toBe('rest');
  });
  it('context left is the rest of the fill; 20% and under is amber; unknown stays unknown', () => {
    expect(contextLeft(26)).toBe(74);
    expect(contextLeft(null)).toBeNull();
    expect(contextLeft(120)).toBe(0);
    expect([contextTone(20), contextTone(21), contextTone(null)]).toEqual(['warn', undefined, undefined]);
  });
});

describe('job run', () => {
  const job = (progress: OfficeJob['progress'], more: Partial<OfficeJob> = {}): OfficeJob => ({ pid: 1, project: 'alpha', cmd: 'x', progress, ...more });
  it('fills from a tqdm bar or the median of the last runs, never from anything else', () => {
    expect(runFill(job({ pct: 45, label: null, rate: '5it/s', eta: '01:41' }))).toEqual({ pct: 45, source: 'tqdm' });
    expect(runFill(job({ pct: 70, label: koText('progress_last', { last: '6m', left: '2m' }), rate: null, eta: null }))).toEqual({ pct: 70, source: 'median' });
    expect(runFill(job({ pct: 0, label: koText('progress_first_run'), indeterminate: true }))).toBeNull();
    expect(runFill(job({ pct: 50, label: koText('progress_steps', { done: 1, total: 2 }) }))).toBeNull();
    expect(runFill(job(null))).toBeNull();
    expect(runFill(job({ pct: 45 }, { ended: '2026-11-03T00:00:00Z' }))).toBeNull();
    expect(runFill(job({ pct: 45 }, { gpu: 'queued' }))).toBeNull();
  });
  it('lights only the cells reached', () => {
    expect([litCells(45, 30), litCells(100, 30), litCells(-5, 30), litCells(99.9, 30)]).toEqual([13, 30, 0, 29]);
  });
  it('a failed job fills to where it stopped and marks that cell; no basis marks nothing', () => {
    expect(stopCells(job(null, { ended: 'x', exit: 1, stopPct: 45 }), 30)).toEqual({ lit: 13, mark: 13 });
    expect(stopCells(job(null, { ended: 'x', exit: 1, stopPct: 0 }), 30)).toEqual({ lit: 0, mark: 0 });
    expect(stopCells(job(null, { ended: 'x', exit: 1, stopPct: 100 }), 30)).toEqual({ lit: 30, mark: 29 });
    expect(stopCells(job(null, { ended: 'x', exit: 1, stopPct: null }), 30)).toEqual({ lit: 0, mark: undefined });
    expect(stopCells(job(null, { ended: 'x', exit: 1 }), 30)).toEqual({ lit: 0, mark: undefined });
  });
});

describe('HUD', () => {
  it('the gauge draws the 5-hour window as cells; a plan without one (Claude Ultra) gets its week instead', () => {
    const [five, week] = [{ id: '5h' }, { id: '7d' }];
    expect(gaugeWindows([five, week], false)).toEqual({ main: five, rest: [week] });
    expect(gaugeWindows([week, five], true)).toEqual({ main: five, rest: [] });
    expect(gaugeWindows([week], false)).toEqual({ main: week, rest: [] });
    expect(gaugeWindows([week], true)).toEqual({ main: week, rest: [] });
    expect(gaugeWindows([], false)).toEqual({ main: undefined, rest: [] });
  });
  it('shows what is left, amber at 10 and under, dimmed at 0', () => {
    expect([usageLeft(38), usageLeft(100), usageLeft(null)]).toEqual([62, 0, null]);
    // A passed reset is unknown, not a full bar (MOBILE-QUEST: Codex showed "reset" with every cell lit).
    expect(windowLeft({ pct: 40, isReset: true })).toBeNull();
    expect(windowLeft({ pct: 61 })).toBe(39);
    expect([gaugeTone(0), gaugeTone(6), gaugeTone(11), gaugeTone(null)]).toEqual(['zero', 'warn', undefined, undefined]);
  });
  it('heat: 85 warm, 95 danger (format.tempTone), at least one cell', () => {
    expect(heatLook(62)).toEqual({ lit: 5, tone: undefined, word: null });
    expect(heatLook(88)).toEqual({ lit: 8, tone: 'warn', word: 'hot' });
    expect(heatLook(96)).toEqual({ lit: 9, tone: 'bad', word: 'danger' });
    expect(heatLook(20).lit).toBe(1);
  });
  it('the sun from 6, the moon from 18', () => {
    expect([isDaytime(5), isDaytime(6), isDaytime(17), isDaytime(18), isDaytime(22)]).toEqual([false, true, true, false, false]);
  });
});
