import { afterEach, describe, expect, it, vi } from 'vitest';

import type { OfficeJob, OfficeOrchestrator } from '../../../core/src/messages.js';
import type { OfficeState } from '../office/engine/officeState.js';

const staff = vi.hoisted(() => ({ away: {} as Record<number, { x: number; y: number }> }));
vi.mock('./staff.js', () => ({ staffSnapshot: () => ({ away: staff.away }) }));

import { offDutyFacts, offDutyId, openOffDuty, recentJobs, selectOrOpenInfo } from './offDuty.js';

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
  openOffDuty(null);
});

describe('selectOrOpenInfo (a card tap)', () => {
  const os = (selects: boolean) => ({ selectAndFollow: () => selects }) as unknown as OfficeState;

  it('selects a visible character and opens nothing', () => {
    expect(selectOrOpenInfo(os(true), 7)).toBe(true);
    expect(offDutyId()).toBeNull();
  });

  it('a character that went home opens its sheet instead', () => {
    staff.away = { 7: { x: 1, y: 2 } };
    expect(selectOrOpenInfo(os(false), 7)).toBe(false);
    expect(offDutyId()).toBe(7);
  });

  it('a character that is merely absent (not home) opens nothing', () => {
    expect(selectOrOpenInfo(os(false), 9)).toBe(false);
    expect(offDutyId()).toBeNull();
  });
});

describe('offDutyFacts', () => {
  it('keeps only what the office holds', () => {
    expect(offDutyFacts(row({ dir: '', sessionId: null }), undefined, false)).toEqual({
      away: false,
      off: true,
      room: 'orch-alpha',
      folder: null,
      model: null,
      session: null,
      downNote: null,
      needsTrust: false,
    });
  });

  it('adds the engine project model, effort, session and the reason it stays down', () => {
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
      model: 'opus · high',
      session: 'abcdef12',
      downNote: 'died 3 times',
      needsTrust: true,
    });
  });
});

describe('recentJobs', () => {
  const job = (id: string, project: string, started: string): OfficeJob =>
    ({ id, project, started, label: id }) as OfficeJob;
  it('newest first, this project only, at most three', () => {
    const jobs = [
      job('a', 'alpha', '2026-10-24T01:00:00Z'),
      job('b', 'beta', '2026-10-24T05:00:00Z'),
      job('c', 'alpha', '2026-10-24T03:00:00Z'),
      job('d', 'alpha', '2026-10-24T02:00:00Z'),
      job('e', 'alpha', '2026-10-24T04:00:00Z'),
    ];
    expect(recentJobs(jobs, 'alpha').map((j) => j.id)).toEqual(['e', 'c', 'd']);
    expect(recentJobs(undefined, 'alpha')).toEqual([]);
  });
});
