import { describe, expect, it } from 'vitest';

import { DEVROOM_PALETTE_GROUP_MAX } from '../../constants.js';
import { t } from '../../i18n/index.js';
import {
  matchAt,
  nextWaiting,
  paletteChord,
  type PaletteInput,
  paletteItems,
  type PaletteKey,
  picksOnEnter,
} from './palette.js';

// D3's titles, escaped (no Hangul in tests): 결제 화면 문구 정리 and 장바구니 합계 계산 분리; typed: 결제.
const PAY = '\uacb0\uc81c \ud654\uba74 \ubb38\uad6c \uc815\ub9ac';
const CART = '\uc7a5\ubc14\uad6c\ub2c8 \ud569\uacc4 \uacc4\uc0b0 \ubd84\ub9ac';
const QUERY = '\uacb0\uc81c';

const space = (task: string, title: string, over: Partial<PaletteInput['spaces'][number]> = {}) => ({
  project: 'shop-web',
  task,
  title,
  chip: 'working' as const,
  conflicts: 0,
  who: `${task}-worker`,
  branch: `feat/${task}`,
  current: false,
  resting: false,
  ...over,
});

const input = (over: Partial<PaletteInput> = {}): PaletteInput => ({
  projects: ['shop-web'],
  trunks: { 'shop-web': 'main' },
  waiting: [
    { agent: 'api-worker', reason: 'question', since: 200, project: 'shop-web', task: 't2', title: CART },
    { agent: 'web-worker', reason: 'permission', since: 100, project: 'shop-web', task: 't1', title: CART },
  ],
  spaces: [space('t1', CART), space('t3', PAY, { chip: 'conflict', conflicts: 1 }), space('old', 'old', { resting: true })],
  agents: [
    { name: 'shop-web', project: 'shop-web', task: null, lead: true, branch: 'main' },
    { name: 'web-worker', project: 'shop-web', task: 't1', lead: false, branch: 'feat/t1' },
  ],
  canAct: true,
  ...over,
});

describe('paletteItems', () => {
  it('opened empty, the first line is the agent waiting longest', () => {
    const items = paletteItems(input(), '');
    expect(items[0]).toMatchObject({ group: 'waiting', action: { kind: 'pane', agent: 'web-worker', task: 't1' } });
    expect(items[1].action).toMatchObject({ agent: 'api-worker' });
  });

  it('lists the groups in order, a resting worktree and per-space actions only when typed for', () => {
    const items = paletteItems(input(), '');
    const groups = items.map((i) => i.group);
    expect(groups).toEqual([...groups].sort((a, b) => ['waiting', 'spaces', 'agents', 'actions'].indexOf(a) - ['waiting', 'spaces', 'agents', 'actions'].indexOf(b)));
    expect(items.some((i) => i.id === 's:shop-web:old')).toBe(false);
    expect(items.some((i) => i.action.kind === 'tab')).toBe(false);
    expect(items.some((i) => i.action.kind === 'newIssue')).toBe(true);
    expect(paletteItems(input(), 'old').some((i) => i.id === 's:shop-web:old')).toBe(true);
  });

  it('typing keeps the matching lines (Hangul and Latin, any case)', () => {
    const typed = paletteItems(input(), QUERY);
    expect(typed.find((i) => i.group === 'spaces')).toMatchObject({ label: PAY, chip: { chip: 'conflict', count: 1 } });
    expect(typed.filter((i) => i.group === 'actions').map((i) => i.action.kind)).toEqual(['tab', 'tab', 'tab', 'sync']);
    expect(typed.some((i) => i.label === CART && i.group === 'spaces')).toBe(false);
    expect(paletteItems(input(), 'WEB-WORKER').some((i) => i.group === 'agents' && i.label === 'web-worker')).toBe(true);
    expect(paletteItems(input(), 'feat/t3').some((i) => i.label === PAY)).toBe(true);
    expect(matchAt(PAY, QUERY)).toBe(0);
    expect(matchAt(PAY, '')).toBe(-1);
  });

  it('a session that may not write is offered no catch-up and no new issue', () => {
    const items = paletteItems(input({ canAct: false }), QUERY);
    expect(items.some((i) => i.action.kind === 'sync' || i.action.kind === 'newIssue')).toBe(false);
  });

  it('caps each group', () => {
    const many = Array.from({ length: DEVROOM_PALETTE_GROUP_MAX + 5 }, (_, n) => space(`t${n}`, `${PAY} ${n}`));
    expect(paletteItems(input({ spaces: many }), QUERY).filter((i) => i.group === 'spaces')).toHaveLength(DEVROOM_PALETTE_GROUP_MAX);
  });

  it('never lists an approve or deny action, with permissions waiting and whatever is typed', () => {
    // Only ways to go somewhere or open something: a new kind must be added here on purpose.
    const SAFE = new Set(['pane', 'space', 'tab', 'sync', 'cleanup', 'newIssue']);
    const answers = [t('permPrompt.allow'), t('permPrompt.deny')];
    for (const q of ['', QUERY, 'web', 'allow', 'deny', 'approve', ...answers]) {
      for (const item of paletteItems(input(), q)) {
        expect(SAFE.has(item.action.kind)).toBe(true);
        expect(item.label).not.toMatch(/\b(approve|deny|allow)\b/i);
        for (const word of answers) expect(item.label).not.toContain(word);
      }
    }
  });
});

const key = (over: Partial<PaletteKey>): PaletteKey => ({
  key: '',
  code: '',
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...over,
});

describe('keys', () => {
  it('Ctrl+K and ⌘K open the palette, also by the physical key under another layout', () => {
    expect(paletteChord(key({ key: 'k', code: 'KeyK', ctrlKey: true }), 6)).toBe('palette');
    expect(paletteChord(key({ key: 'k', code: 'KeyK', metaKey: true }), 6)).toBe('palette');
    expect(paletteChord(key({ key: 'x', code: 'KeyK', ctrlKey: true }), 6)).toBe('palette');
  });

  it('every other key goes on to the terminal', () => {
    for (const k of [
      key({ key: 'k', code: 'KeyK' }),
      key({ key: 'c', code: 'KeyC', ctrlKey: true }),
      key({ key: 'K', code: 'KeyK', ctrlKey: true, shiftKey: true }),
      key({ key: 'y', code: 'KeyY' }),
      key({ key: 'Enter', code: 'Enter' }),
      key({ key: '1', code: 'Digit1' }),
      key({ key: '7', code: 'Digit7', altKey: true }),
      key({ key: 'ArrowDown', code: 'ArrowDown' }),
      key({ key: 'ArrowUp', code: 'ArrowUp', altKey: true }),
    ]) {
      expect(paletteChord(k, 6)).toBeNull();
    }
  });

  it('Alt+1..6 is a pane, Alt+↓ the next waiting agent (Option on a Mac types ¡: the code counts)', () => {
    expect(paletteChord(key({ key: '¡', code: 'Digit1', altKey: true }), 6)).toEqual({ pane: 1 });
    expect(paletteChord(key({ key: '6', code: 'Digit6', altKey: true }), 6)).toEqual({ pane: 6 });
    expect(paletteChord(key({ key: 'ArrowDown', code: 'ArrowDown', altKey: true }), 6)).toBe('nextWaiting');
  });

  it('Enter picks, except while Hangul is composing', () => {
    expect(picksOnEnter({ key: 'Enter', isComposing: false, keyCode: 13 })).toBe(true);
    expect(picksOnEnter({ key: 'Enter', isComposing: true, keyCode: 13 })).toBe(false);
    expect(picksOnEnter({ key: 'Enter', isComposing: false, keyCode: 229 })).toBe(false);
    expect(picksOnEnter({ key: 'a', isComposing: false, keyCode: 65 })).toBe(false);
  });

  it('Alt+↓ goes round the waiting agents', () => {
    expect(nextWaiting([], null)).toBeNull();
    expect(nextWaiting(['a', 'b'], null)).toBe('a');
    expect(nextWaiting(['a', 'b'], 'a')).toBe('b');
    expect(nextWaiting(['a', 'b'], 'b')).toBe('a');
    expect(nextWaiting(['a', 'b'], 'zz')).toBe('a');
  });

  it('DV2: a picked script is a run line when typed for, only for a session that may act', () => {
    const runs = [{ project: 'shop-web', task: 'feat-t1', title: 'cart', script: 'test', role: 'test' as const }];
    const line = paletteItems(input({ runs }), 'feat-t1').find((i) => i.action.kind === 'run');
    expect(line?.action).toEqual({ kind: 'run', project: 'shop-web', task: 'feat-t1', script: 'test', role: 'test' });
    expect(paletteItems(input({ runs }), '').some((i) => i.action.kind === 'run')).toBe(false);
    expect(paletteItems(input({ runs, canAct: false }), 'feat-t1').some((i) => i.action.kind === 'run')).toBe(false);
  });
});
