import { describe, expect, it } from 'vitest';

import {
  agentTab,
  canSplitDown,
  canSplitRight,
  closePane,
  closeTab,
  emptyWorkspace,
  focusedKey,
  focusPane,
  leastRecentAttached,
  openTab,
  paneCount,
  paneOf,
  paneRects,
  phoneKey,
  restore,
  serialize,
  shellTab,
  showInPane,
  shownKeys,
  showTab,
  splitDown,
  splitRight,
  tabLabels,
  type Workspace,
} from './workspace.js';

const a = shellTab('aaaa', 'work');
const b = shellTab('bbbb', 'docs');
const c = agentTab('c0000001', 'beta', 7);
const d = agentTab('d0000002', 'gamma', 8);

const open = (...tabs: Parameters<typeof openTab>[1][]): Workspace =>
  tabs.reduce(openTab, emptyWorkspace());

describe('opening and showing', () => {
  it('a new tab shows in the focused pane; opening it again only focuses it', () => {
    let ws = open(a);
    expect(ws.tabs.map((t) => t.key)).toEqual(['shell:aaaa']);
    expect(focusedKey(ws)).toBe('shell:aaaa');
    ws = openTab(ws, b);
    // The second takes the pane; the first stays open, hidden.
    expect(ws.tabs).toHaveLength(2);
    expect(shownKeys(ws)).toEqual(['shell:bbbb']);
    ws = openTab(ws, { ...a, title: 'renamed' });
    expect(ws.tabs).toHaveLength(2);
    expect(ws.tabs[0].title).toBe('renamed');
    expect(focusedKey(ws)).toBe('shell:aaaa');
  });

  it('refuses a tab past the limit and leaves the workspace as it was', () => {
    let ws = emptyWorkspace();
    for (let i = 0; i < 16; i++) ws = openTab(ws, shellTab(`id${String(i)}`, 't'));
    expect(ws.tabs).toHaveLength(16);
    expect(openTab(ws, shellTab('extra', 't'))).toBe(ws);
  });

  it('showing a tab that another pane shows focuses that pane instead of copying it', () => {
    let ws = splitRight(open(a, b)); // a hidden, b left; the new pane takes a
    expect(ws.rows).toEqual([['shell:bbbb', 'shell:aaaa']]);
    ws = showTab(ws, 'shell:bbbb');
    expect(ws.focus).toEqual({ row: 0, col: 0 });
    expect(shownKeys(ws).sort()).toEqual(['shell:aaaa', 'shell:bbbb']);
  });

  it('moving a tab to a pane swaps with the pane that showed it', () => {
    let ws = splitRight(open(a, b));
    ws = showInPane(ws, 0, 0, 'shell:aaaa');
    expect(ws.rows).toEqual([['shell:aaaa', 'shell:bbbb']]);
    // Onto a pane showing nothing, from a pane: the source pane is left empty.
    ws = splitDown(ws);
    ws = showInPane(ws, 1, 0, 'shell:aaaa');
    expect(ws.rows).toEqual([[null, 'shell:bbbb'], ['shell:aaaa']]);
    // An unknown tab, or a pane that is not there, changes nothing.
    expect(showInPane(ws, 5, 5, 'shell:aaaa')).toBe(ws);
    expect(showInPane(ws, 0, 0, 'shell:zzzz')).toBe(ws);
    expect(showTab(ws, 'shell:zzzz')).toBe(ws);
  });
});

describe('splitting', () => {
  it('right, then down: at most 2x2, and the new pane shows a hidden tab if there is one', () => {
    let ws = open(a, b, c, d);
    expect(canSplitRight(ws) && canSplitDown(ws)).toBe(true);
    ws = splitRight(ws);
    expect(ws.rows).toEqual([['agent:d0000002', 'agent:c0000001']]);
    expect(ws.focus).toEqual({ row: 0, col: 1 });
    expect(canSplitRight(ws)).toBe(false);
    expect(splitRight(ws)).toBe(ws);
    ws = splitDown(ws);
    expect(ws.rows).toHaveLength(2);
    expect(ws.focus).toEqual({ row: 1, col: 0 });
    expect(canSplitDown(ws)).toBe(false);
    expect(splitDown(ws)).toBe(ws);
    ws = splitRight(ws);
    expect(paneCount(ws)).toBe(4);
    expect(ws.rows.every((r) => r.length <= 2)).toBe(true);
    // Four panes, four different tabs: nothing is shown twice.
    expect(new Set(shownKeys(ws)).size).toBe(shownKeys(ws).length);
  });

  it('a split with nothing hidden is an empty pane', () => {
    const ws = splitRight(open(a));
    expect(ws.rows).toEqual([['shell:aaaa', null]]);
  });
});

describe('tab names', () => {
  it('tabs with one title get numbers; a lone title stays as it is', () => {
    const ws = open(a, shellTab('cccc', 'work'), b, shellTab('dddd', 'work'));
    expect(tabLabels(ws)).toEqual({
      'shell:aaaa': 'work',
      'shell:cccc': 'work 2',
      'shell:bbbb': 'docs',
      'shell:dddd': 'work 3',
    });
  });
});

describe('where the panes sit', () => {
  it('rows share the height and the panes of a row share the width', () => {
    expect(paneRects(open(a))).toEqual([
      { row: 0, col: 0, key: 'shell:aaaa', left: 0, top: 0, width: 100, height: 100 },
    ]);
    const ws = splitRight(splitDown(open(a, b, c))); // [[x], [y, z]]
    expect(ws.rows.map((r) => r.length)).toEqual([1, 2]);
    expect(paneRects(ws).map(({ left, top, width, height }) => [left, top, width, height])).toEqual(
      [
        [0, 0, 100, 50],
        [0, 50, 50, 50],
        [50, 50, 50, 50],
      ],
    );
  });
});

describe('closing', () => {
  it('closing a pane keeps its tab open, hidden; the last pane stays', () => {
    let ws = splitRight(open(a, b)); // [b, a]
    ws = closePane(ws, 0, 1);
    expect(ws.rows).toEqual([['shell:bbbb']]);
    expect(ws.tabs).toHaveLength(2);
    expect(closePane(ws, 0, 0)).toBe(ws);
  });

  it('closing a tab only removes it from the workspace; its pane takes a hidden tab, or goes', () => {
    let ws = open(a, b);
    ws = closeTab(ws, 'shell:bbbb'); // shown: a hidden one takes the pane
    expect(ws.tabs.map((t) => t.key)).toEqual(['shell:aaaa']);
    expect(focusedKey(ws)).toBe('shell:aaaa');
    ws = splitRight(ws);
    ws = closeTab(ws, 'shell:aaaa'); // two panes, nothing hidden: one pane goes
    expect(ws.tabs).toEqual([]);
    expect(ws.rows).toHaveLength(1);
    expect(ws.rows[0]).toHaveLength(1);
    expect(focusedKey(ws)).toBeNull();
    expect(closeTab(ws, 'shell:aaaa')).toBe(ws);
  });

  it('a hidden tab closes without touching the panes', () => {
    const ws = open(a, b);
    const next = closeTab(ws, 'shell:aaaa');
    expect(next.rows).toEqual(ws.rows);
    expect(next.tabs.map((t) => t.key)).toEqual(['shell:bbbb']);
  });
});

describe('which agent tab to let go of', () => {
  it('the least recently focused one that holds an attach, never the one asking', () => {
    let ws = open(c, d, a);
    ws = showTab(ws, 'agent:c0000001');
    ws = showTab(ws, 'agent:d0000002');
    expect(leastRecentAttached(ws, ['agent:c0000001', 'agent:d0000002'], 'agent:e')).toBe(
      'agent:c0000001',
    );
    ws = focusPane(showTab(ws, 'agent:c0000001'), 0, 0);
    expect(leastRecentAttached(ws, ['agent:c0000001', 'agent:d0000002'], 'agent:e')).toBe(
      'agent:d0000002',
    );
    expect(leastRecentAttached(ws, ['agent:c0000001'], 'agent:c0000001')).toBeNull();
    expect(leastRecentAttached(ws, [], 'agent:c0000001')).toBeNull();
    expect(leastRecentAttached(ws, ['agent:gone'], 'agent:c0000001')).toBeNull();
  });
});

describe('the phone shows one pane', () => {
  it("the focused pane's tab, else the newest, else the first", () => {
    let ws = open(a, b);
    expect(phoneKey(ws)).toBe('shell:bbbb');
    ws = closePane(splitRight(ws), 0, 0);
    expect(phoneKey(ws)).toBe('shell:aaaa');
    expect(phoneKey(emptyWorkspace())).toBeNull();
  });
});

describe('what is kept on the device', () => {
  it('round-trips, with the arrangement and who is focused', () => {
    let ws = splitDown(splitRight(open(a, b, c)));
    ws = showTab(ws, 'shell:aaaa');
    const back = restore(serialize(ws));
    expect(back).toEqual(ws);
    expect(paneOf(back, 'shell:aaaa')).not.toBeNull();
  });

  it('a corrupt value gives an empty workspace', () => {
    for (const bad of [
      undefined,
      null,
      5,
      '',
      '{',
      'null',
      '[]',
      '{"v":2}',
      '{"v":1}',
      '{"v":1,"tabs":1,"rows":1}',
      {},
      { v: 1, tabs: {}, rows: [] },
    ])
      expect(restore(bad), JSON.stringify(bad)).toEqual(emptyWorkspace());
  });

  it('keeps the sound parts of a damaged one: no pane naming a missing tab, none twice, never past 2x2', () => {
    const ws = restore({
      v: 1,
      tabs: [a, { ...b, key: 'shell:wrong' }, { kind: 'shell' }, 7, c, a],
      rows: [
        ['shell:aaaa', 'shell:aaaa', 'agent:c0000001'],
        ['shell:gone', 5],
        ['agent:c0000001'],
        ['shell:aaaa'],
        'x',
      ],
      focus: { row: 9, col: 9 },
      recent: ['shell:aaaa', 'shell:aaaa', 'nope', 3],
    });
    expect(ws.tabs.map((t) => t.key)).toEqual(['shell:aaaa', 'agent:c0000001']);
    expect(ws.rows).toEqual([
      ['shell:aaaa', null],
      [null, null],
    ]);
    expect(ws.focus).toEqual({ row: 0, col: 0 });
    expect(ws.recent).toEqual(['shell:aaaa']);
  });

  it('a stored value cannot carry a long title or a hostile key through', () => {
    const ws = restore({
      v: 1,
      tabs: [
        { ...a, title: 'x'.repeat(1000) },
        { ...a, key: 'shell:other' },
      ],
      rows: [['shell:aaaa']],
    });
    expect(ws.tabs).toHaveLength(1);
    expect(ws.tabs[0].title.length).toBe(120);
  });
});
