/**
 * T-0029: the 현황판 tree's rules. Grouping by room, a row's ring and words,
 * a collapsed room's counts and worst badge, the filter, the per-device open
 * state (also with storage blocked), and 프로젝트 현황's statusView link.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OfficeOrchestrator, OfficeSnapshot, StatusView } from '../../../../core/src/messages.js';
import { setLanguage } from '../../i18n/index.js';
import type { ToolActivity } from '../../office/types.js';
import { PLAIN_CONTEXT } from '../ez/activity.js';
import type { RingState } from '../ez/visuals.js';
import {
  groupRooms,
  isOpen,
  parseTree,
  passesFilter,
  reloadStatusTree,
  roomSummary,
  rowLook,
  rowState,
  setAllOpen,
  setTreeFilter,
  STATUS_TREE_KEY,
  statusTree,
  toggleNode,
  watchProjectStatus,
} from './statusTree.js';

beforeEach(() => setLanguage('ko'));

const orch = (name: string, over: Partial<OfficeOrchestrator> = {}): OfficeOrchestrator => ({
  name,
  dir: `/work/${name}`,
  tab: 'room',
  order: 1,
  state: 'running',
  busy: false,
  remoteControl: { on: false, url: null },
  compactions: 0,
  alive: true,
  agentId: null,
  ...over,
});

const office = (orchestrators: OfficeOrchestrator[]): OfficeSnapshot => ({
  type: 'officeSnapshot',
  readOnly: true,
  tabs: [
    { name: 'orch-beta', kind: 'orch', order: 2 },
    { name: 'orch-alpha', kind: 'orch', order: 1 },
    { name: '\uad00\ub9ac\uc2e4', kind: 'ops', order: 3 },
    { name: 'empty', kind: 'orch', order: 4 },
  ],
  orchestrators,
});

const tool = (toolName: string, over: Partial<ToolActivity> = {}): ToolActivity => ({
  toolId: toolName,
  status: `${toolName} something`,
  toolName,
  done: false,
  ...over,
});

describe('groupRooms', () => {
  it('rooms in tab order, rows in their order, \uae30\ud0c0 for rows of no tab, empty rooms left out', () => {
    const rooms = groupRooms(
      office([
        orch('b2', { tab: 'orch-beta', order: 2 }),
        orch('lost', { tab: 'gone-room' }),
        orch('a1', { tab: 'orch-alpha', order: 1 }),
        orch('b1', { tab: 'orch-beta', order: 1 }),
        orch('j', { tab: '\uad00\ub9ac\uc2e4' }),
      ]),
    );
    expect(rooms.map((r) => [r.name, r.rows.map((o) => o.name)])).toEqual([
      ['orch-alpha', ['a1']],
      ['orch-beta', ['b1', 'b2']],
      ['\uad00\ub9ac\uc2e4', ['j']],
      ['\uae30\ud0c0', ['lost']],
    ]);
  });

  it('a room called \uae30\ud0c0 stays its own room', () => {
    const state = office([orch('x', { tab: '\uae30\ud0c0' }), orch('y', { tab: 'nowhere' })]);
    state.tabs = [{ name: '\uae30\ud0c0', kind: 'orch', order: 1 }];
    expect(groupRooms(state).map((r) => [r.name, r.rows.map((o) => o.name)])).toEqual([
      ['\uae30\ud0c0', ['x']],
      ['\uae30\ud0c0', ['y']],
    ]);
  });
});

describe('D3b: the board lists projects', () => {
  it('leaves Workers out (they show under their project in the workbench and the messenger)', () => {
    const state = office([orch('alpha', { tab: 'orch-alpha' }), orch('alpha-a', { tab: 'orch-alpha' }), orch('beta', { tab: 'orch-beta' })]);
    expect(groupRooms(state, new Set(['alpha-a'])).map((r) => [r.name, r.rows.map((o) => o.name)])).toEqual([
      ['orch-alpha', ['alpha']],
      ['orch-beta', ['beta']],
    ]);
  });
});

describe('rowLook', () => {
  it('reads a row like its office character', () => {
    const look = (o: OfficeOrchestrator, tools?: ToolActivity[]) => rowLook(o, tools, PLAIN_CONTEXT);
    expect(look(orch('a', { busy: true }), [tool('Read')])).toEqual({
      ring: 'working',
      ez: '📖 \uc790\ub8cc \uc77d\ub294 \uc911',
      raw: 'Read something',
    });
    expect(look(orch('a'), [tool('Bash', { permissionWait: true })]).ring).toBe('permission');
    expect(look(orch('a'), [tool('AskUserQuestion')]).ring).toBe('waiting');
    // A done tool still names the last thing done; none at all and not busy is idle.
    expect(look(orch('a'), [tool('Read', { done: true })]).ring).toBe('working');
    expect(look(orch('a'))).toEqual({ ring: 'idle', ez: '☕ \uc26c\ub294 \uc911', raw: '\ub3c4\uad6c \uc0ac\uc6a9 \uc5c6\uc74c' });
    expect(look(orch('a', { busy: true }))).toEqual({
      ring: 'working',
      ez: '🤔 \uc0dd\uac01 \uc911',
      raw: '\ub3c4\uad6c \uc0ac\uc6a9 \uc5c6\uc74c',
    });
    expect(look(orch('a', { state: 'off', busy: null }))).toEqual({
      ring: 'off',
      ez: '💤 \uaebc\uc838 \uc788\uc74c',
      raw: '\uaebc\uc9d0',
    });
    expect(look(orch('a', { state: 'off', busy: null }), [tool('Read')]).raw).toBe('\uaebc\uc9d0');
  });
});

describe('rowLook: the tool call\'s own description', () => {
  const bash = { status: 'Running: cd /x && npm te\u2026' };
  it('replaces the phrase words when present, keeps the EZ words when absent', () => {
    const o = orch('a', { busy: true });
    const plain = rowLook(o, [tool('Bash', bash)], PLAIN_CONTEXT);
    const worded = rowLook(o, [tool('Bash', { ...bash, desc: 'Run the tests' })], PLAIN_CONTEXT);
    expect(worded.ez).toBe(`${plain.ez.split(' ')[0]} Run the tests`);
    expect(plain.ez).not.toContain('Run the tests');
    expect(worded.ring).toBe(plain.ring);
  });
});

describe('room summary and filter', () => {
  const rings: RingState[] = ['working', 'neutral', 'waiting', 'permission', 'idle', 'off', 'off'];

  it('counts working (an unnamed activity too), waiting (a permission too) and off', () => {
    expect(roomSummary(rings)).toEqual({ working: 2, waiting: 2, off: 2, worst: 'permission' });
  });

  it('the worst badge: permission, then a question, then work, then rest, then off', () => {
    const worst = (r: RingState[]) => roomSummary(r).worst;
    expect(worst(['off', 'waiting', 'working'])).toBe('waiting');
    expect(worst(['idle', 'working', 'off'])).toBe('working');
    expect(worst(['off', 'idle'])).toBe('idle');
    expect(worst(['off', 'off'])).toBe('off');
    expect(roomSummary(['idle', 'idle'])).toEqual({
      working: 0,
      waiting: 0,
      off: 0,
      worst: 'idle',
    });
  });

  it('each chip keeps its own rows; \uc804\uccb4 keeps all', () => {
    const kept = (filter: Parameters<typeof passesFilter>[0]) =>
      rings.filter((ring) => passesFilter(filter, ring));
    expect(kept('all')).toEqual(rings);
    expect(kept('working')).toEqual(['working', 'neutral']);
    expect(kept('waiting')).toEqual(['waiting', 'permission']);
    expect(kept('off')).toEqual(['off', 'off']);
    expect(rings.map(rowState)).toEqual([
      'working',
      'working',
      'waiting',
      'waiting',
      'idle',
      'off',
      'off',
    ]);
  });
});

describe('open state, per device', () => {
  const memory = () => {
    const data = new Map<string, string>();
    return {
      data,
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    };
  };
  afterEach(() => {
    vi.unstubAllGlobals();
    reloadStatusTree();
  });

  it('starts with rooms open and orchestrators closed', () => {
    vi.stubGlobal('localStorage', memory());
    reloadStatusTree();
    expect(isOpen(statusTree(), 'room', 'orch-alpha')).toBe(true);
    expect(isOpen(statusTree(), 'orch', 'alpha')).toBe(false);
    expect(statusTree().filter).toBe('all');
  });

  it('remembers toggles, \ubaa8\ub450 \ud3bc\uce58\uae30 / \ubaa8\ub450 \uc811\uae30 and the filter across a reload', () => {
    const store = memory();
    vi.stubGlobal('localStorage', store);
    reloadStatusTree();
    toggleNode('orch', 'alpha');
    toggleNode('room', 'orch-beta');
    setTreeFilter('waiting');
    reloadStatusTree(); // the page loads again
    let tree = statusTree();
    expect([isOpen(tree, 'orch', 'alpha'), isOpen(tree, 'room', 'orch-beta')]).toEqual([
      true,
      false,
    ]);
    expect(tree.filter).toBe('waiting');
    toggleNode('orch', 'alpha'); // back to the default: nothing kept for it
    expect(JSON.parse(store.data.get(STATUS_TREE_KEY)!).open).toEqual({ 'room:orch-beta': false });

    setAllOpen(true);
    reloadStatusTree();
    tree = statusTree();
    // Every room and orchestrator, also ones that appear later.
    expect([isOpen(tree, 'room', 'orch-beta'), isOpen(tree, 'orch', 'new-one')]).toEqual([
      true,
      true,
    ]);
    toggleNode('orch', 'gamma');
    setAllOpen(false);
    tree = statusTree();
    expect([isOpen(tree, 'room', 'orch-alpha'), isOpen(tree, 'orch', 'gamma')]).toEqual([
      false,
      false,
    ]);
    expect(tree.filter).toBe('waiting');
  });

  it('junk in storage reads as the defaults', () => {
    for (const raw of ['{', '[]', '"x"', '{"rooms":"yes","open":[1],"filter":"later"}'])
      expect(parseTree(raw)).toEqual({ rooms: true, orchs: false, open: {}, filter: 'all' });
    expect(parseTree('{"orchs":true,"open":{"orch:a":false,"orch:b":"no"}}')).toEqual({
      rooms: true,
      orchs: true,
      open: { 'orch:a': false },
      filter: 'all',
    });
  });

  it('blocked storage: the tree still opens and closes, nothing throws', () => {
    const blocked = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
    };
    vi.stubGlobal('localStorage', blocked);
    expect(() => reloadStatusTree()).not.toThrow();
    expect(() => toggleNode('orch', 'alpha')).not.toThrow();
    expect(isOpen(statusTree(), 'orch', 'alpha')).toBe(true);
    reloadStatusTree();
    expect(isOpen(statusTree(), 'orch', 'alpha')).toBe(false);
  });
});

describe('\ud504\ub85c\uc81d\ud2b8 \ud604\ud669 and statusView', () => {
  /** React's effect rule for one dependency: the previous cleanup runs before
   *  the next effect and on unmount (ProjectStatus's useEffect). */
  const mounted = (effect: (open: boolean) => (() => void) | undefined, open: boolean) => {
    let cleanup = effect(open);
    return {
      set(next: boolean) {
        cleanup?.();
        cleanup = effect(next);
      },
      unmount() {
        cleanup?.();
        cleanup = undefined;
      },
    };
  };

  it('opening the section turns statusView on, collapsing turns it off', () => {
    const sent: StatusView[] = [];
    const section = mounted(
      (open) => (open ? watchProjectStatus('alpha', (msg) => sent.push(msg)) : undefined),
      false,
    );
    expect(sent).toEqual([]);
    section.set(true);
    expect(sent).toEqual([{ type: 'statusView', name: 'alpha', on: true }]);
    section.set(false);
    expect(sent).toEqual([
      { type: 'statusView', name: 'alpha', on: true },
      { type: 'statusView', name: 'alpha', on: false },
    ]);
    // Open again, then folded away with its orchestrator: off once more.
    section.set(true);
    section.unmount();
    expect(sent.map((m) => m.on)).toEqual([true, false, true, false]);
  });
});
