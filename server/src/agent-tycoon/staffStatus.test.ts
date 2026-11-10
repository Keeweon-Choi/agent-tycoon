import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import type { TempEmployee } from '../../../core/src/messages.js';
import { claudeUsageFact, savedClaudeUsage, subagentFacts } from './staffStatus.js';

const emp = (execution: string, project: string, working = true): TempEmployee => ({
  execution,
  employeeId: execution,
  nameId: 'n',
  project,
  working,
});
const win = (id: string, pct: number | null, resetAt: string | null = null) => ({
  id,
  pct,
  resetAt,
});

describe('claudeUsageFact', () => {
  it('reads the week and the 5-hour value when the daemon has one', () => {
    const providers = [
      {
        id: 'claude',
        name: 'Claude',
        windows: [win('5h', 12.4), win('7d', 83.6, '2026-11-05T01:00:00.000Z')],
      },
    ];
    expect(claudeUsageFact({ providers })).toEqual({
      weekPct: 84,
      resetsAt: '2026-11-05T01:00:00.000Z',
      fiveHourPct: 12,
    });
  });
  it('leaves the 5-hour value out when there is none', () => {
    const providers = [{ id: 'claude', name: 'Claude', windows: [win('7d', 40, null)] }];
    expect(claudeUsageFact({ providers })).toEqual({ weekPct: 40, resetsAt: null });
  });
  it('is null when nothing is known (no reading, no Claude, week reset marker)', () => {
    expect(claudeUsageFact(null)).toBeNull();
    expect(
      claudeUsageFact({ providers: [{ id: 'codex', name: 'Codex', windows: [win('7d', 5)] }] }),
    ).toBeNull();
    expect(
      claudeUsageFact({
        providers: [{ id: 'claude', name: 'Claude', windows: [win('7d', null)] }],
      }),
    ).toBeNull();
  });
});

describe('subagentFacts', () => {
  it('counts running Claude sub-agents per project, not finished or Codex ones', () => {
    const staff = [
      emp('claude:a', 'agent-tycoon'),
      emp('claude:b', 'agent-tycoon'),
      emp('claude:c', 'agent-tycoon'),
      emp('claude:d', 'iris'),
      emp('claude:e', 'iris', false),
      emp('codex:1', 'iris'),
    ];
    expect(subagentFacts(staff)).toEqual({ total: 4, byProject: { 'agent-tycoon': 3, iris: 1 } });
  });
  it('is zero with none', () => {
    expect(subagentFacts([])).toEqual({ total: 0, byProject: {} });
  });
});

describe('savedClaudeUsage', () => {
  const NOW = Date.UTC(2026, 10, 1, 12);
  const sec = (ms: number) => Math.floor(ms / 1000);
  /** A saved reading whose file was last written `ageMs` ago. */
  function saved(ageMs: number, weekResetMs: number): string {
    const file = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'staff-status-')),
      'usage-claude.json',
    );
    fs.writeFileSync(
      file,
      JSON.stringify({
        five_hour: { used_percentage: 9, resets_at: sec(NOW + 3_600_000) },
        seven_day: { used_percentage: 15, resets_at: sec(weekResetMs) },
      }),
    );
    fs.utimesSync(file, (NOW - ageMs) / 1000, (NOW - ageMs) / 1000);
    return file;
  }
  it('uses a fresh file', () => {
    const reset = NOW + 86_400_000;
    expect(savedClaudeUsage(saved(60_000, reset), NOW)).toEqual({
      weekPct: 15,
      resetsAt: new Date(sec(reset) * 1000).toISOString(),
      fiveHourPct: 9,
    });
  });
  it('ignores a file older than 6 hours', () => {
    expect(savedClaudeUsage(saved(6 * 3_600_000 + 1000, NOW + 86_400_000), NOW)).toBeNull();
  });
  it('ignores a file whose reset has passed', () => {
    expect(savedClaudeUsage(saved(60_000, NOW - 1000), NOW)).toBeNull();
  });
});
