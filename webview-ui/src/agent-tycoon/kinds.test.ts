import { beforeEach, describe, expect, it } from 'vitest';

import type { CodexTasks, OfficeSnapshot } from '../../../core/src/messages.js';
import { setLanguage } from '../i18n/index.js';
import { statusIcon } from './ez/visuals.js';
import {
  activityElapsed,
  cardInfo,
  characterKind,
  characterName,
  elapsedText,
  KIND_ORDER,
  showsNameLabel,
} from './kinds.js';
import { virtualAgentId } from './officeStore.js';

const office = {
  type: 'officeSnapshot',
  tabs: [],
  orchestrators: [
    { name: 'alpha', dir: '/w/alpha', agentId: 1 },
    { name: 'beta', dir: '/w/beta', agentId: null },
    // A teammate's own session is listed beside the orchestrators too.
    { name: 'scout-session', dir: '/w/alpha', agentId: 5 },
  ],
} as unknown as OfficeSnapshot;
const tasks = {
  type: 'codexTasks',
  tasks: [{ id: 't1', project: 'alpha', agentId: null, state: 'running' }],
} as unknown as CodexTasks;
const codexId = virtualAgentId('codex:t1');
const kind = (ch: Parameters<typeof characterKind>[0]) => characterKind(ch, office, tasks);

beforeEach(() => setLanguage('ko'));

describe('characterKind', () => {
  it('reads orchestrators (real or virtual id) as orchestrators', () => {
    expect(kind({ id: 1 })).toBe('orchestrator');
    expect(kind({ id: virtualAgentId('orch:beta') })).toBe('orchestrator');
    expect(kind({ id: 2 })).toBe('visitor');
  });

  it('a negative-id Subtask is a sub-agent', () => {
    expect(kind({ id: -1, isSubagent: true })).toBe('subagent');
    expect(kind({ id: -7 })).toBe('subagent');
  });

  it('a named agent with a lead is a teammate, even with its own office row', () => {
    expect(kind({ id: 5, agentName: 'scout', leadAgentId: 1 })).toBe('teammate');
    expect(kind({ id: 6, agentName: 'scout' })).toBe('teammate');
    // A lead keeps its own kind.
    expect(kind({ id: 1, agentName: 'boss', isTeamLead: true })).toBe('orchestrator');
  });

  it('a synthetic Codex worker is codex', () => {
    expect(kind({ id: codexId })).toBe('codex');
  });

  it('anyone else is a lobby visitor', () => {
    expect(kind({ id: 9, directoryName: 'elsewhere' })).toBe('visitor');
    expect(characterKind({ id: 1 }, null, null)).toBe('visitor');
  });
});

describe('characterName', () => {
  const name = (ch: Parameters<typeof characterName>[0], label?: string) =>
    characterName(ch, office, tasks, label);
  it('uses the project name, codex project, team name, subtask or folder', () => {
    expect(name({ id: 1 })).toBe('alpha');
    expect(name({ id: 2, directoryName: 'folder' })).toBe('folder');
    expect(name({ id: codexId })).toBe('codex·alpha');
    expect(name({ id: 6, agentName: 'scout' })).toBe('scout');
    expect(name({ id: -1, isSubagent: true }, 'fix login')).toBe('fix login');
    expect(name({ id: -1, isSubagent: true })).toBe('\uc11c\ube0c\uc5d0\uc774\uc804\ud2b8');
    expect(name({ id: 9, directoryName: 'elsewhere' })).toBe('elsewhere');
  });
});

describe('label policy', () => {
  it('only orchestrators carry a name, unless \ud56d\uc0c1 \uc774\ub984 \ubcf4\uae30 is on', () => {
    expect(KIND_ORDER.filter((k) => showsNameLabel(k, false))).toEqual(['orchestrator']);
    expect(KIND_ORDER.every((k) => showsNameLabel(k, true))).toBe(true);
    expect(KIND_ORDER.filter((k) => !showsNameLabel(k, false, true))).toEqual(['subagent']);
    expect(KIND_ORDER.every((k) => showsNameLabel(k, true, true))).toBe(true);
  });

  it('the head icon follows the ring: zzz, "!", lock, the activity, nothing when off', () => {
    expect(statusIcon('idle')).toBe('zzz');
    expect(statusIcon('waiting')).toBe('alert');
    expect(statusIcon('permission')).toBe('lock');
    expect(statusIcon('working')).toBe('activity');
    expect(statusIcon('neutral')).toBe('activity');
    expect(statusIcon('off')).toBeNull();
  });
});

describe('cards', () => {
  it('groups by kind in KIND_ORDER and names each card', () => {
    expect(cardInfo({ id: 1 }, office, tasks)).toEqual({
      group: 0,
      groupLabel: '\uc624\ucf00\uc2a4\ud2b8\ub808\uc774\ud130',
      name: 'alpha',
    });
    expect(cardInfo({ id: -1, isSubagent: true }, office, tasks, 'fix').group).toBe(
      KIND_ORDER.indexOf('subagent'),
    );
    expect(cardInfo({ id: codexId }, office, tasks).groupLabel).toBe('Codex');
  });
});

describe('elapsed time', () => {
  it('restarts when the activity changes', () => {
    expect(activityElapsed(42, 'read', 1_000)).toBe(0);
    expect(activityElapsed(42, 'read', 181_000)).toBe(180_000);
    expect(activityElapsed(42, 'edit', 200_000)).toBe(0);
  });

  it('reads in minutes and hours', () => {
    expect(elapsedText(20_000)).toBe('\ubc29\uae08 \uc2dc\uc791');
    expect(elapsedText(180_000)).toBe('3\ubd84\uc9f8');
    expect(elapsedText(3_600_000)).toBe('1\uc2dc\uac04\uc9f8');
    expect(elapsedText(5_400_000)).toBe('1\uc2dc\uac04 30\ubd84\uc9f8');
  });
});
