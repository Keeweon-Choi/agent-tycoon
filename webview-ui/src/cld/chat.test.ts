import { beforeEach, expect, it } from 'vitest';

import type { BackgroundSession, OfficeOrchestrator, OfficeSnapshot } from '../../../core/src/messages.js';
import { setLanguage } from '../i18n/index.js';
import { chatOpenFor, chatTarget, noSendNote, readOnlyNote, requestChat } from './chat.js';
import { virtualAgentId } from './officeStore.js';
import {
  getWorkspace,
  reportVisibleTabs,
  resetWorkspaceForTests,
} from './terminal/workspaceStore.js';

const orch = (name: string, agentId: number | null, bg: BackgroundSession | null): OfficeOrchestrator => ({
  name,
  dir: '/w',
  tab: 'w',
  order: 1,
  state: 'running',
  busy: false,
  compactions: 0,
  alive: true,
  remoteControl: { on: false, url: null },
  agentId,
  bg,
});

beforeEach(() => setLanguage('ko'));

const office = (chat?: boolean): OfficeSnapshot => ({
  type: 'officeSnapshot',
  readOnly: true,
  chat,
  tabs: [],
  orchestrators: [
    orch('bg-one', 7, { id: 'a0000016', state: 'blocked' }),
    orch('tmux-one', 8, null),
    orch('no-character', null, null),
  ],
});

it('\ub300\ud654 only with chat on: a background session with its id (\ud130\ubbf8\ub110\ub85c \ubcf4\uae30), else read from the transcript', () => {
  expect(chatTarget(7, office())).toBeNull();
  expect(chatTarget(7, office(true))).toEqual({ kind: 'background', id: 'a0000016' });
  expect(chatTarget(8, office(true))).toEqual({ kind: 'interactive' });
  expect(chatTarget(virtualAgentId('orch:no-character'), office(true))).toEqual({
    kind: 'interactive',
  });
  expect(chatTarget(12345, office(true))).toBeNull(); // codex contractor, unknown
  expect(chatTarget(7, null)).toBeNull();
});

it('\ud130\ubbf8\ub110\ub85c \ubcf4\uae30 opens the session as one tab of the terminal workspace (not a second one on a second press)', () => {
  resetWorkspaceForTests();
  requestChat(7, 'a0000016');
  requestChat(7, 'a0000016');
  requestChat(5, 'a0000017'); // another session gets its own tab: nothing is replaced
  expect(getWorkspace().tabs.map((t) => [t.key, t.agentId])).toEqual([
    ['agent:a0000016', 7],
    ['agent:a0000017', 5],
  ]);
  // "In sight" is what a pane shows right now, not what is merely open.
  expect(chatOpenFor(7)).toBe(false);
  reportVisibleTabs(['agent:a0000016']);
  expect(chatOpenFor(7)).toBe(true);
  expect(chatOpenFor(5)).toBe(false);
  reportVisibleTabs([]);
  expect(chatOpenFor(7)).toBe(false);
});

it('the no-send note says why, and never blames another terminal for engine projects', () => {
  const state = office(true);
  const project: OfficeOrchestrator = { ...orch('proj', 10, null), provider: 'engine' };
  const withProject: OfficeSnapshot = { ...state, orchestrators: [...state.orchestrators, project] };
  expect(readOnlyNote(10, withProject)).toBe(`${noSendNote()} (\uc5d4\uc9c4\uc774 \uaebc\uc838 \uc788\uc5b4\uc694)`);
  // A plain Claude session, listed or not, is open in a terminal outside the engine.
  expect(readOnlyNote(8, state)).toBe(`${noSendNote()} (\uc5d4\uc9c4 \ubc16 \ud130\ubbf8\ub110\uc5d0\uc11c \uc5f4\ub824 \uc788\uc74c)`);
  expect(readOnlyNote(12345, state)).toBe(`${noSendNote()} (\uc5d4\uc9c4 \ubc16 \ud130\ubbf8\ub110\uc5d0\uc11c \uc5f4\ub824 \uc788\uc74c)`);
  expect(readOnlyNote(12345, null)).toBe(`${noSendNote()} (\uc5d4\uc9c4 \ubc16 \ud130\ubbf8\ub110\uc5d0\uc11c \uc5f4\ub824 \uc788\uc74c)`);
  for (const id of [7, 8, 10]) expect(readOnlyNote(id, withProject)).not.toContain('\ub2e4\ub978 \ud130\ubbf8\ub110');
});
