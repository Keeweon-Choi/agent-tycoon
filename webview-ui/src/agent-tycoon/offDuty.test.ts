import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OfficeOrchestrator } from '../../../core/src/messages.js';
import type { OfficeState } from '../office/engine/officeState.js';

const staff = vi.hoisted(() => ({ away: {} as Record<number, { x: number; y: number }> }));
vi.mock('./staff.js', () => ({ staffSnapshot: () => ({ away: staff.away }) }));

import { openStatDetail, statDetailId } from './ez/statDetail.js';
import { offDutyFacts, selectOrOpenInfo } from './offDuty.js';

const row = (over: Partial<OfficeOrchestrator> = {}): OfficeOrchestrator => ({
  name: 'alpha',
  dir: '/work/alpha',
  tab: 'orch-alpha',
  order: 1,
  state: 'off',
  busy: null,
  compactions: 0,
  alive: false,
  remoteControl: { on: false, url: null },
  agentId: 7,
  ...over,
});

afterEach(() => {
  staff.away = {};
  openStatDetail(null);
});

describe('selectOrOpenInfo (a card tap)', () => {
  const os = (selects: boolean) => ({ selectAndFollow: () => selects }) as unknown as OfficeState;

  it('selects a visible character and opens nothing', () => {
    expect(selectOrOpenInfo(os(true), 7)).toBe(true);
    expect(statDetailId()).toBeNull();
  });

  it('a character off duty (resting in the lounge) is followed, its menu opens, no stats view', () => {
    staff.away = { 7: { x: 1, y: 2 } };
    let followed = 0;
    const resting = { selectAndFollow: () => ++followed > 0 } as unknown as OfficeState;
    expect(selectOrOpenInfo(resting, 7)).toBe(false); // the caller does not go on to its terminal
    expect(followed).toBe(1);
    expect(statDetailId()).toBeNull();
  });

  it('one off duty whose character cannot be selected opens its stats view', () => {
    staff.away = { 7: { x: 1, y: 2 } };
    expect(selectOrOpenInfo(os(false), 7)).toBe(false);
    expect(statDetailId()).toBe(7);
  });

  it('a character that went home opens its stats view instead', () => {
    staff.away = { 7: { x: 1, y: 2 } };
    expect(selectOrOpenInfo(os(false), 7)).toBe(false);
    expect(statDetailId()).toBe(7);
  });

  it('a character that is merely absent (not home) opens nothing', () => {
    expect(selectOrOpenInfo(os(false), 9)).toBe(false);
    expect(statDetailId()).toBeNull();
  });
});

describe('offDutyFacts', () => {
  it('keeps only what the office holds', () => {
    expect(offDutyFacts(row({ dir: '', sessionId: null }), undefined, false)).toEqual({
      away: false,
      off: true,
      room: 'orch-alpha',
      folder: null,
      session: null,
      downNote: null,
      needsTrust: false,
    });
  });

  it('adds the engine project session and the reason it stays down', () => {
    const project = {
      name: 'alpha',
      folder: '/work/alpha',
      room: 'r',
      wantRunning: true,
      live: false,
      model: 'opus',
      effort: 'high',
      downNote: 'died 3 times',
      needsTrust: true,
    };
    expect(offDutyFacts(row({ sessionId: 'abcdef123456' }), project, true)).toMatchObject({
      away: true,
      session: 'abcdef12',
      downNote: 'died 3 times',
      needsTrust: true,
    });
  });
});
