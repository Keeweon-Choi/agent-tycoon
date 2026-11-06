import { beforeEach, describe, expect, it } from 'vitest';

import { setLanguage, t } from '../i18n/index.js';
import {
  desktopTabs,
  foldedUsageText,
  percentTone,
  resetCountdown,
  stateLabel,
  timeAgo,
  usageWindowText,
  usageWindowTitle,
} from './format.js';

beforeEach(() => setLanguage('ko'));

const now = Date.parse('2026-10-21T10:00:00Z');
describe('formatters', () => {
  it('formats elapsed time and missing dates', () => {
    expect(timeAgo('2026-10-21T09:48:00Z', now)).toBe('12\ubd84 \uc804');
    expect(timeAgo('2026-10-20T08:00:00Z', now)).toBe('1\uc77c \uc804');
    expect(timeAgo(null, now)).toBe('\uae30\ub85d \uc5c6\uc74c');
  });
  it('formats limit countdowns', () => {
    expect(resetCountdown('2026-10-21T12:13:00Z', now)).toBe(
      '2\uc2dc\uac04 13\ubd84 \ub4a4 \ucd08\uae30\ud654',
    );
    expect(resetCountdown('2026-10-21T09:00:00Z', now)).toBe('\uace7 \ucd08\uae30\ud654');
    expect(resetCountdown('2026-10-21T10:00:30Z', now)).toBe('1\ubd84 \ub4a4 \ucd08\uae30\ud654');
    expect(resetCountdown('2026-10-23T11:05:00Z', now)).toBe(
      '2\uc77c 1\uc2dc\uac04 5\ubd84 \ub4a4 \ucd08\uae30\ud654',
    );
  });
  it('a window without a reset time reads as such', () => {
    expect(resetCountdown(null, now)).toBe(t('format.noReset'));
  });
  it('uses exact percentage thresholds', () => {
    expect(percentTone(69.9)).toBe('normal');
    expect(percentTone(70)).toBe('warn');
    expect(percentTone(85)).toBe('critical');
  });
  const win = (id: string, pct: number | null, extra = {}) => ({
    id,
    pct,
    resetAt: null,
    ...extra,
  });
  it("folds usage to each provider's reported windows only", () => {
    expect(
      foldedUsageText([
        { id: 'claude', name: 'Claude', windows: [win('7d', 3)] },
        { id: 'codex', name: 'Codex', windows: [win('5h', 77), win('7d', 19.4)] },
      ]),
    ).toBe('Claude 7d 3%   Codex 5h 77% · 7d 19%');
  });
  it('shows a made-up provider with its own window id, and a note for one that reported nothing', () => {
    expect(
      foldedUsageText([
        { id: 'acp', name: 'ACP', windows: [win('monthly', 12)] },
        { id: 'claude', name: 'Claude', windows: [] },
      ]),
    ).toBe(`ACP monthly 12%   Claude ${t('usage.none')}`);
  });
  it('adds the per-model weekly windows after the provider windows', () => {
    expect(
      foldedUsageText([
        {
          id: 'claude',
          name: 'Claude',
          windows: [win('5h', 1), win('7d', 66)],
          models: [{ family: 'fable', pct: 0, reset: null }],
        },
      ]),
    ).toBe('Claude 5h 1% · 7d 66% · F 7d 0%');
  });
  it('renders a passed reset as unknown, never a made-up percentage', () => {
    expect(usageWindowText(73, true)).toBe(t('usage.unknownShort'));
    expect(usageWindowText(73, true)).not.toContain('0%');
    expect(usageWindowText(73, true)).not.toContain('73%');
  });
  it('reads a window both ways round: used (as agty status) and left (as the gauge), then the reset', () => {
    const resetAt = new Date(2026, 10, 6, 20, 0).toISOString();
    expect(usageWindowTitle({ id: '7d', pct: 61, resetAt })).toBe(
      `${t('usage.usedLeft', { window: t('usage.win.7d'), used: 61, left: 39 })} · ${t('usage.resetAt', { time: '11-06 20:00' })}`,
    );
    expect(usageWindowTitle({ id: '5h', pct: 10, resetAt: null, isReset: true })).toBe(
      t('usage.resetPassed', { window: t('usage.win.5h') }),
    );
    expect(usageWindowTitle({ id: '5h', pct: null, resetAt: null })).toBe(
      t('usage.windowUnknown', { window: t('usage.win.5h') }),
    );
  });
  it('labels process and activity states in Korean', () => {
    expect(stateLabel('running', true)).toBe('\uc77c\ud558\ub294 \uc911');
    expect(stateLabel('running', false)).toBe('\uc26c\ub294 \uc911');
    expect(stateLabel('running', null)).toBe('\uc0c1\ud0dc \ud655\uc778 \uc911');
    expect(stateLabel('off')).toBe('\uaebc\uc9d0');
  });
});

it("UI-DASH: the dashboard's tab strip is the summary, projects and runs (HW is the lobby board's H/W screen); files is the folder icon's mode", () => {
  expect(desktopTabs.map((tab) => tab.id)).toEqual(['status', 'dev', 'runs']);
});
