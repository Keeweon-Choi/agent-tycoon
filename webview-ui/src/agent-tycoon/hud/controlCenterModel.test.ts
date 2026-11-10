import { describe, expect, it } from 'vitest';

import type { UsageProvider } from '../../../../core/src/messages.js';
import { ccPart, ccPress, closest, foldedWindows, phoneFolded, tightest, usageAsOf, usageView } from './controlCenterModel.js';

const provider = (id: string, windows: UsageProvider['windows'], models?: UsageProvider['models']): UsageProvider => ({
  id,
  name: id.toUpperCase(),
  windows,
  models,
});
const w = (id: string, pct: number | null, isReset?: boolean) => ({ id, pct, resetAt: '2026-11-06T19:59:00Z', isReset });

describe('FEAT-HUD-CONTROL-CENTER: the provider-neutral usage view', () => {
  it('one row per agent, every window it reports (a model week too), what is left', () => {
    const view = usageView([
      provider('a', [w('7d', 78)], [{ family: 'fable', pct: 5, reset: null }]),
      provider('b', [w('5h', 0), w('7d', 17)]),
      provider('c', [w('daily', 15)]),
    ]);
    expect(view.map((a) => a.agent)).toEqual(['A', 'B', 'C']);
    expect(view[0].windows.map((x) => [x.id, x.leftPct])).toEqual([
      ['7d', 22],
      ['model:fable', 95],
    ]);
    expect(view[1].windows.map((x) => x.leftPct)).toEqual([100, 83]);
    // A window id no one taught the UI keeps its own name: a new agent needs no code.
    expect(view[2].windows[0]).toMatchObject({ id: 'daily', label: 'daily', leftPct: 85 });
  });

  it("a status-line report keeps its time; one older than a few minutes says its age, a fresh one says nothing", () => {
    const at = '2026-11-06T08:00:00.000Z';
    const [claude, codex] = usageView([{ ...provider('claude', [w('5h', 23.5), w('7d', 41.2)]), at }, provider('codex', [])]);
    expect(claude.windows.map((x) => [x.id, x.leftPct, x.resetAt])).toEqual([
      ['5h', 77, '2026-11-06T19:59:00Z'],
      ['7d', 59, '2026-11-06T19:59:00Z'],
    ]);
    expect(claude.reportedAt).toBe(at);
    expect(codex.reportedAt).toBeNull();
    const t0 = Date.parse(at);
    expect(usageAsOf(at, t0 + 60_000)).toBeNull();
    expect(usageAsOf(at, t0 + 12 * 60_000)).toMatch(/12/);
    expect(usageAsOf(null, t0 + 12 * 60_000)).toBeNull();
  });

  it('an agent without limits has no windows; an unknown or passed reading is null, never a full bar', () => {
    const [none, unknown] = usageView([provider('x', []), provider('y', [w('5h', null), w('7d', 40, true)])]);
    expect(none.windows).toEqual([]);
    expect(unknown.windows.map((x) => x.leftPct)).toEqual([null, null]);
    expect(tightest(none)).toBeUndefined();
    expect(tightest(unknown)).toBeUndefined();
  });

  it('folded shows the two agents closest to their limits, the tightest first, by their tightest window', () => {
    const view = usageView([
      provider('roomy', [w('5h', 10)]),
      provider('none', []),
      provider('tight', [w('5h', 20), w('7d', 91)]),
      provider('mid', [w('7d', 50)]),
    ]);
    expect(closest(view, 2).map((c) => [c.agent.id, c.window.id, c.window.leftPct])).toEqual([
      ['tight', '7d', 9],
      ['mid', '7d', 50],
    ]);
    expect(closest(usageView([provider('none', [])]), 2)).toEqual([]);
  });

  it('a plan with a 5-hour window shows it before the week, unless the week is nearly used up', () => {
    const [codex, spent, weekOnly] = usageView([
      provider('codex', [w('5h', 0), w('7d', 21)]),
      provider('spent', [w('5h', 0), w('7d', 95)]),
      provider('ultra', [w('7d', 7)]),
    ]);
    expect([tightest(codex)?.id, tightest(codex)?.leftPct]).toEqual(['5h', 100]);
    expect([tightest(spent)?.id, tightest(spent)?.leftPct]).toEqual(['7d', 5]);
    expect(tightest(weekOnly)?.id).toBe('7d');
  });
});

describe('FEAT-HUD-SUMMARY-STYLES: which windows a folded row shows', () => {
  it('a 5-hour plan shows the 5 hours and the week side by side, a week-only plan the week', () => {
    const [codex, spent, weekOnly, fiveOnly, none] = usageView([
      provider('codex', [w('7d', 21), w('5h', 0)]),
      provider('spent', [w('5h', 0), w('7d', 95)]),
      provider('ultra', [w('7d', 7)], [{ family: 'fable', pct: 5, reset: null }]),
      provider('five', [w('5h', 40)]),
      provider('none', []),
    ]);
    // Left to right: 5 hours, then the week, even when the week is nearly used up.
    expect(foldedWindows(codex).map((x) => [x.id, x.leftPct])).toEqual([['5h', 100], ['7d', 79]]);
    expect(foldedWindows(spent).map((x) => [x.id, x.leftPct])).toEqual([['5h', 100], ['7d', 5]]);
    expect(foldedWindows(weekOnly).map((x) => x.id)).toEqual(['7d']);
    expect(foldedWindows(fiveOnly).map((x) => x.id)).toEqual(['5h']);
    expect(foldedWindows(none)).toEqual([]);
  });

  it('an unknown window falls back to the tightest one; closest still orders by it', () => {
    const view = usageView([
      provider('stale', [w('5h', null), w('7d', 30)]),
      provider('both', [w('5h', 10), w('7d', 50)]),
    ]);
    expect(foldedWindows(view[0]).map((x) => x.id)).toEqual(['7d']);
    expect(closest(view, 2).map((c) => [c.agent.id, c.windows.map((x) => x.id)])).toEqual([
      ['stale', ['7d']],
      ['both', ['5h', '7d']],
    ]);
  });
});

describe('FEAT-HUD-SUMMARY-STYLES: the phone strip falls back until it fits', () => {
  const entries = closest(usageView([provider('a', [w('5h', 40), w('7d', 60)]), provider('b', [w('5h', 90), w('7d', 70)])]), 2);
  const shown = (level: number) => phoneFolded(entries, level).entries.map((e) => e.windows.map((x) => x.id));

  it('tries every plan two windows first, then logos only, then the tightest agent alone with two, then one each', () => {
    expect(shown(0)).toEqual([['5h', '7d'], ['5h', '7d']]);
    expect(phoneFolded(entries, 0).names).toBe(true);
    expect(shown(1)).toEqual([['5h', '7d'], ['5h', '7d']]);
    expect(phoneFolded(entries, 1).names).toBe(false);
    expect(entries[0].agent.id).toBe('b'); // the tighter one (10 % left in 5 hours) keeps both at level 2
    expect(shown(2)).toEqual([['5h', '7d'], ['5h']]);
    expect(phoneFolded(entries, 2).names).toBe(true);
    expect(shown(3)).toEqual([['5h'], ['5h']]);
  });
});

describe('FEAT-HUD-CONTROL-CENTER: each folded target opens its own part', () => {
  it('a target shows its part, the same target folds it, another switches', () => {
    expect(ccPress(null, 'usage')).toBe('usage');
    expect(ccPress('usage', 'usage')).toBeNull();
    expect(ccPress('usage', 'notices')).toBe('notices');
    expect(ccPress('notices', 'all')).toBe('all');
    expect(ccPress('all', 'all')).toBeNull();
  });

  it('the notification panel, opened from anywhere, wins over the control center own part', () => {
    expect(ccPart('usage', true)).toBe('notices');
    expect(ccPart('all', false)).toBe('all');
    expect(ccPart(null, false)).toBeNull();
  });
});
