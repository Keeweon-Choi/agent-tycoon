import { describe, expect, it } from 'vitest';

import type { OfficeOrchestrator } from '../../../core/src/messages.js';
import { DEVROOM_DONE_MS } from '../constants.js';
import { t } from '../i18n/index.js';
import { bucketOf } from './devroom/agentBoard.js';
import { describeActivity } from './ez/activity.js';
import { characterVisual } from './ez/visuals.js';
import { partyState } from './game/gameState.js';
import { leadState } from './messenger/messengerStore.js';
import { engineTurn, rowBusy, sharedActivity, turnInputs } from './turnState.js';
import { stateOf } from './workbench/workbenchState.js';

type Row = Pick<OfficeOrchestrator, 'provider' | 'state' | 'busy' | 'shellWait' | 'renewing'>;
const engineRow = (over: Partial<Row>): Row => ({ provider: 'engine', state: 'running', busy: false, ...over });

/** Thirty-one minutes without news: past the dev room's 끝남 window and the 야근 grace. */
const QUIET_MS = 31 * 60_000;

/** Every surface's word for one agent, from the functions those surfaces call. */
function surfaces(row: Row, office: { seen: boolean; turnEnded: boolean; openTool?: boolean; asks?: boolean }) {
  const turn = engineTurn(row);
  const status = sharedActivity({ turn, seen: office.seen, asks: !!office.asks, openTool: !!office.openTool, turnEnded: office.turnEnded });
  const lead = leadState(row, status);
  const activity = describeActivity({
    toolName: office.openTool ? 'Bash' : undefined,
    status: office.openTool ? 'Running: python train.py' : undefined,
    idle: !office.openTool,
    // What the office alone thought: its turn ended, so not busy.
    ...turnInputs(turn, false),
  });
  const visual = characterVisual(activity, row.state === 'off');
  return {
    party: partyState(undefined, status),
    messenger: lead,
    board: bucketOf(lead, QUIET_MS, DEVROOM_DONE_MS),
    ring: visual.ring,
    card: visual.text,
    workbench: stateOf(row as OfficeOrchestrator, undefined),
  };
}

describe('STATE-SYNC: every surface reads the engine for a session it runs', () => {
  it('a turn over with its job still running (shellWait) is at work everywhere, 31 min later too', () => {
    const s = surfaces(engineRow({ shellWait: true }), { seen: true, turnEnded: true });
    expect(s).toEqual({
      party: 'work',
      messenger: 'working',
      board: 'working',
      ring: 'working',
      card: t('activity.jobWait'),
      workbench: 'working',
    });
  });

  it('a turn the office never saw start (bound after a restart, a long quiet tool) is at work', () => {
    const s = surfaces(engineRow({ busy: true }), { seen: false, turnEnded: false });
    expect([s.party, s.messenger, s.board, s.ring, s.workbench]).toEqual(['work', 'working', 'working', 'working', 'working']);
    expect(s.card).toBe(t('activity.thinking'));
  });

  it('a renew under way is at work', () => {
    const s = surfaces(engineRow({ renewing: true }), { seen: true, turnEnded: true });
    expect([s.party, s.messenger, s.ring]).toEqual(['work', 'working', 'working']);
  });

  it('negative: the engine rests while the office still holds an active turn (no Stop): rest everywhere', () => {
    const s = surfaces(engineRow({ busy: false }), { seen: true, turnEnded: false });
    expect([s.party, s.messenger, s.board, s.ring, s.workbench]).toEqual(['rest', 'resting', 'idle', 'idle', 'resting']);
    expect(s.card).toBe(t('activity.resting'));
  });

  it('negative: an engine session that is off with a stale open tool is not at work', () => {
    const s = surfaces(engineRow({ state: 'off', busy: null }), { seen: true, turnEnded: false, openTool: true });
    expect([s.party, s.messenger, s.board, s.ring, s.workbench]).toEqual(['rest', 'off', 'idle', 'off', 'off']);
  });

  it('a person waited on comes first; a running tool is work even before the engine says busy', () => {
    expect(sharedActivity({ turn: 'job', seen: true, asks: true, openTool: false, turnEnded: true })).toBe('attention');
    expect(sharedActivity({ turn: 'over', seen: true, asks: false, openTool: true, turnEnded: false })).toBe('working');
  });

  it('a session the engine does not run keeps the office rule', () => {
    const claude: Row = { provider: 'claude', state: 'running', busy: true, shellWait: true };
    expect(engineTurn(claude)).toBeNull();
    expect(rowBusy(claude)).toBe(true);
    expect(sharedActivity({ turn: null, seen: false, asks: false, openTool: false, turnEnded: false })).toBeNull();
    expect(sharedActivity({ turn: null, seen: true, asks: false, openTool: false, turnEnded: true })).toBe('idle');
    expect(sharedActivity({ turn: null, seen: true, asks: false, openTool: false, turnEnded: false })).toBe('working');
    expect(engineTurn(engineRow({ busy: null }))).toBeNull(); // the engine does not know yet
  });
});
