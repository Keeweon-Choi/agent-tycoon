/**
 * The office's rooms and a row's look: grouping by room, a row's ring and words; A5: the 현황판's
 * filter, per device (also with storage blocked).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OfficeOrchestrator, OfficeSnapshot } from '../../../../core/src/messages.js';
import { setLanguage } from '../../i18n/index.js';
import type { ToolActivity } from '../../office/types.js';
import { PLAIN_CONTEXT } from '../ez/activity.js';
import type { RingState } from '../ez/visuals.js';
import {
  BOARD_FILTER_KEY,
  boardFilter,
  groupRooms,
  parseFilter,
  reloadBoardFilter,
  rowLook,
  rowState,
  setRoomFilter,
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

describe('rowState', () => {
  it('a permission and a question both wait; an unnamed activity is still work', () => {
    const rings: RingState[] = ['working', 'neutral', 'waiting', 'permission', 'idle', 'off'];
    expect(rings.map(rowState)).toEqual(['working', 'working', 'waiting', 'waiting', 'idle', 'off']);
  });
});

describe('A5: the board filter, per device', () => {
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
    reloadBoardFilter();
  });

  it('starts on every room; remembers the picked room across a reload; the all row clears it', () => {
    const store = memory();
    vi.stubGlobal('localStorage', store);
    reloadBoardFilter();
    expect(boardFilter()).toEqual({ room: null });
    setRoomFilter('orch-beta');
    reloadBoardFilter(); // the page loads again
    expect(boardFilter()).toEqual({ room: 'orch-beta' });
    expect(JSON.parse(store.data.get(BOARD_FILTER_KEY)!)).toEqual({ room: 'orch-beta' });
    setRoomFilter(null);
    reloadBoardFilter();
    expect(boardFilter()).toEqual({ room: null });
  });

  it('junk in storage reads as the defaults; an old stored state box list is ignored', () => {
    for (const raw of ['{', '[]', '"x"', '{"hidden":"todo","room":3}']) expect(parseFilter(raw)).toEqual({ room: null });
    expect(parseFilter('{"hidden":["doing"],"room":"a"}')).toEqual({ room: 'a' });
  });

  it('blocked storage: the filter still changes, nothing throws', () => {
    const blocked = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('SecurityError');
      },
    };
    vi.stubGlobal('localStorage', blocked);
    expect(() => reloadBoardFilter()).not.toThrow();
    expect(() => setRoomFilter('a')).not.toThrow();
    expect(boardFilter().room).toBe('a');
  });
});
