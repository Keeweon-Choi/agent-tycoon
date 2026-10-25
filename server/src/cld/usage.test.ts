import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { UsageState } from '../../../core/src/messages.js';
import {
  USAGE_EARLY_RESET_MIN_FUTURE_MS,
  USAGE_EARLY_RESET_MIN_NEXT_SHIFT_MS,
  USAGE_REFRESH_MS,
} from '../constants.js';
import { REPO_ROOT } from './testHome.js';
import {
  claudeModelUsage,
  claudeOwnUsage,
  claudeUsageFile,
  codexOwnUsage,
  earlyResets,
  parseUsage,
  usageScript,
  UsageSource,
} from './usage.js';

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock('child_process', async (actual) => ({
  ...(await actual<typeof import('child_process')>()),
  execFile: execFileMock,
}));

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
  vi.useRealTimers();
  execFileMock.mockReset();
});

function tempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-usage-'));
  dirs.push(home);
  return home;
}

function writeScript(home: string, version: string, source: string): string {
  const file = path.join(
    home,
    '.claude',
    'plugins',
    'cache',
    'claude-dashboard',
    'claude-dashboard',
    version,
    'dist',
    'check-usage.js',
  );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, source);
  return file;
}

describe('parseUsage', () => {
  it('keeps the known claude-dashboard fields only', () => {
    expect(
      parseUsage(
        {
          claude: { fiveHourPercent: 42, sevenDayPercent: 16, fiveHourReset: 'a', extra: 1 },
          codex: { fiveHourPercent: 35, sevenDayPercent: 6, sevenDayReset: 'b' },
          secret: 'x',
        },
        't',
      ),
    ).toEqual({
      ts: 't',
      claude: { fiveHourPct: 42, sevenDayPct: 16, fiveHourReset: 'a', sevenDayReset: null },
      codex: { fiveHourPct: 35, sevenDayPct: 6, fiveHourReset: null, sevenDayReset: 'b' },
    });
  });
  it('an empty or odd payload gives null windows', () => {
    expect(parseUsage({}, 't')).toEqual({ ts: 't', claude: null, codex: null });
    expect(parseUsage(null, 't')).toEqual({ ts: 't', claude: null, codex: null });
    expect(parseUsage({ claude: [1] }, 't').claude).toBeNull();
  });
});

describe('usageScript', () => {
  it('selects the newest numeric plugin version and ignores other directories', () => {
    const home = tempHome();
    writeScript(home, '1.9.3', '');
    const newest = writeScript(home, '1.10.0', '');
    fs.mkdirSync(
      path.join(
        home,
        '.claude',
        'plugins',
        'cache',
        'claude-dashboard',
        'claude-dashboard',
        'current',
      ),
      { recursive: true },
    );
    expect(usageScript(home)).toBe(newest);
  });

  it('returns null when the plugin cache has no usable script', () => {
    expect(usageScript(tempHome())).toBeNull();
  });
});

const HOUR = 3600;
const nowSec = () => Math.floor(Date.now() / 1000);

describe("claudeModelUsage (USAGE-FABLE: the dashboard cache's per-model weekly windows)", () => {
  const NOW = Date.parse('2026-10-24T00:00:00Z');
  const FUTURE = '2026-10-30T11:00:00+00:00';
  const cache = (home: string, name: string, body: string, mtime = NOW / 1000): void => {
    const dir = path.join(home, '.cache', 'claude-dashboard');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), body);
    fs.utimesSync(path.join(dir, name), mtime, mtime);
  };
  const data = (extra: Record<string, unknown>) =>
    JSON.stringify({ data: { five_hour: { utilization: 3 }, ...extra } });

  it('takes every seven_day_<family> object with a numeric utilization', () => {
    const home = tempHome();
    cache(
      home,
      'cache-a.json',
      data({
        seven_day: { utilization: 9 },
        seven_day_fable: { utilization: 0, resets_at: FUTURE },
        seven_day_sonnet: null,
        seven_day_opus: { utilization: 41.5, resets_at: FUTURE },
        seven_day_odd: { utilization: 'x' },
      }),
    );
    expect(claudeModelUsage(home, NOW)).toEqual([
      { family: 'fable', pct: 0, reset: FUTURE },
      { family: 'opus', pct: 41.5, reset: FUTURE },
    ]);
  });

  it('reads the newest cache that has data.five_hour, skipping broken and unrelated ones', () => {
    const home = tempHome();
    cache(home, 'cache-old.json', data({ seven_day_fable: { utilization: 1 } }), NOW / 1000 - 99);
    cache(
      home,
      'cache-new.json',
      JSON.stringify({ data: { seven_day_fable: { utilization: 7 } } }),
    );
    expect(claudeModelUsage(home, NOW)).toEqual([{ family: 'fable', pct: 1, reset: null }]);
    cache(home, 'cache-broken.json', '{nope');
    cache(home, 'other.json', data({ seven_day_fable: { utilization: 5 } }));
    expect(claudeModelUsage(home, NOW)).toEqual([{ family: 'fable', pct: 1, reset: null }]);
  });

  it('gives nothing for null, missing, elapsed, malformed or no cache dir', () => {
    const home = tempHome();
    expect(claudeModelUsage(home, NOW)).toEqual([]);
    cache(home, 'cache-a.json', data({ seven_day_fable: null }));
    expect(claudeModelUsage(home, NOW)).toEqual([]);
    cache(home, 'cache-a.json', data({}));
    expect(claudeModelUsage(home, NOW)).toEqual([]);
    cache(
      home,
      'cache-a.json',
      data({ seven_day_fable: { utilization: 5, resets_at: '2026-10-01T00:00:00Z' } }),
    );
    expect(claudeModelUsage(home, NOW)).toEqual([]);
    cache(home, 'cache-a.json', 'null');
    expect(claudeModelUsage(home, NOW)).toEqual([]);
  });

  it('UsageSource puts them on the Claude entry (even with no other Claude data)', async () => {
    const home = tempHome();
    cache(
      home,
      'cache-a.json',
      data({ seven_day_fable: { utilization: 2, resets_at: '2999-01-01T00:00:00Z' } }),
    );
    const changes: Array<Omit<UsageState, 'type'>> = [];
    const source = new UsageSource(
      { home, codexHome: path.join(home, '.codex'), script: null },
      (u) => changes.push(u),
    );
    source.setViewing(true);
    await vi.waitFor(() => expect(changes).toHaveLength(1));
    source.stop();
    expect(changes[0].claude?.models).toEqual([
      { family: 'fable', pct: 2, reset: '2999-01-01T00:00:00Z' },
    ]);
    expect(changes[0].codex).toBeNull();
  });
});

describe('claudeOwnUsage (ENV-2: what the status line kept)', () => {
  it('maps Claude Code rate_limits; a passed reset is marked without a made-up percent; no file is null', () => {
    const home = tempHome();
    const file = claudeUsageFile(home);
    expect(claudeOwnUsage(file)).toBeNull();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const reset = nowSec() + HOUR;
    fs.writeFileSync(
      file,
      JSON.stringify({
        five_hour: { used_percentage: 23.5, resets_at: reset },
        seven_day: { used_percentage: 41.2, resets_at: nowSec() - 10 },
      }),
    );
    expect(claudeOwnUsage(file)).toEqual({
      fiveHourPct: 23.5,
      fiveHourReset: new Date(reset * 1000).toISOString(),
      fiveHourIsReset: null,
      sevenDayPct: null,
      sevenDayReset: null,
      sevenDayIsReset: true,
    });
    fs.writeFileSync(file, JSON.stringify({ five_hour: { used_percentage: 5, resets_at: 1 } }));
    expect(claudeOwnUsage(file)).toEqual({
      fiveHourPct: null,
      fiveHourReset: null,
      fiveHourIsReset: true,
      sevenDayPct: null,
      sevenDayReset: null,
      sevenDayIsReset: null,
    });
  });
});

describe('codexOwnUsage', () => {
  it("reads the newest log's rate_limits by window length; nothing to read is null", () => {
    const codex = tempHome();
    expect(codexOwnUsage(codex)).toBeNull();
    const day = (d: string) => path.join(codex, 'sessions', '2026', '10', d);
    fs.mkdirSync(day('22'), { recursive: true });
    fs.mkdirSync(day('23'), { recursive: true });
    const rl = (p: number) => ({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        rate_limits: {
          primary: { used_percent: p, window_minutes: 300, resets_at: nowSec() + HOUR },
          secondary: { used_percent: 27, window_minutes: 10080, resets_at: nowSec() + 50 * HOUR },
        },
      },
    });
    fs.writeFileSync(path.join(day('22'), 'rollout-a.jsonl'), `${JSON.stringify(rl(10))}\n`);
    // The newest file: its last rate_limits wins, a later line without one is skipped.
    fs.writeFileSync(
      path.join(day('23'), 'rollout-b.jsonl'),
      [JSON.stringify(rl(50)), JSON.stringify(rl(73)), '{"type":"other"}', ''].join('\n'),
    );
    expect(codexOwnUsage(codex)).toMatchObject({ fiveHourPct: 73, sevenDayPct: 27 });
  });

  it('keeps a passed Codex window as a reset marker, never as zero percent', () => {
    const codex = tempHome();
    const file = path.join(codex, 'sessions', '2026', '10', '24', 'rollout-a.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `${JSON.stringify({
        payload: {
          rate_limits: {
            primary: { used_percent: 73, window_minutes: 300, resets_at: nowSec() - 1 },
          },
        },
      })}\n`,
    );
    expect(codexOwnUsage(codex)).toEqual({
      fiveHourPct: null,
      fiveHourReset: null,
      fiveHourIsReset: true,
      sevenDayPct: null,
      sevenDayReset: null,
      sevenDayIsReset: null,
    });
  });

  it('ignores another Codex rate-limit bucket instead of replacing its own reading', () => {
    const codex = tempHome();
    const file = path.join(codex, 'sessions', '2026', '10', '24', 'rollout-a.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const rateLimits = (limitId: string, pct: number) => ({
      payload: {
        rate_limits: {
          limit_id: limitId,
          primary: { used_percent: pct, window_minutes: 300, resets_at: nowSec() + HOUR },
        },
      },
    });
    fs.writeFileSync(
      file,
      `${JSON.stringify(rateLimits('codex', 73))}\n${JSON.stringify(rateLimits('premium', 2))}\n`,
    );
    expect(codexOwnUsage(codex)).toMatchObject({ fiveHourPct: 73 });
  });
});

describe("cld-gui-statusline.js (the engine sessions' status line)", () => {
  const script = path.join(REPO_ROOT, 'cld/bin/cld-gui-statusline.js');
  const run = (home: string, input: unknown) =>
    spawnSync(process.execPath, [script], {
      input: JSON.stringify(input),
      encoding: 'utf-8',
      env: { HOME: home, PATH: process.env.PATH },
    });

  it("keeps rate_limits, prints the user's own status line, and never calls itself", () => {
    const home = tempHome();
    const project = path.join(home, 'proj');
    fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(home, '.claude'));
    fs.writeFileSync(
      path.join(home, '.claude', 'settings.json'),
      JSON.stringify({ statusLine: { type: 'command', command: 'echo user-wide' } }),
    );
    const reset = nowSec() + HOUR;
    const input = {
      workspace: { project_dir: project },
      rate_limits: { five_hour: { used_percentage: 12, resets_at: reset } },
    };
    const first = run(home, input);
    expect(first.status).toBe(0);
    expect(first.stdout.trim()).toBe('user-wide');
    expect(claudeOwnUsage(claudeUsageFile(home))?.fiveHourPct).toBe(12);

    // The project's own line wins; a run without rate_limits keeps the last numbers.
    fs.writeFileSync(
      path.join(project, '.claude', 'settings.json'),
      JSON.stringify({ statusLine: { command: 'cat >/dev/null; echo project-line' } }),
    );
    const second = run(home, { workspace: { project_dir: project } });
    expect(second.stdout.trim()).toBe('project-line');
    expect(claudeOwnUsage(claudeUsageFile(home))?.fiveHourPct).toBe(12);

    // A settings file that names us (copied from an engine session) is not chained.
    fs.writeFileSync(
      path.join(project, '.claude', 'settings.local.json'),
      JSON.stringify({ statusLine: { command: `node ${script}` } }),
    );
    const third = run(home, { workspace: { project_dir: project } });
    expect(third.status).toBe(0);
    expect(third.stdout).toBe('');
  });
});

describe('UsageSource', () => {
  const listen = (home: string, script: string | null) => {
    const changes: Array<Omit<UsageState, 'type'>> = [];
    const source = new UsageSource({ home, codexHome: path.join(home, '.codex'), script }, (u) =>
      changes.push(u),
    );
    return { source, changes };
  };

  it('with no plugin and no data it reports both providers unknown (null), only while viewed', async () => {
    const { source, changes } = listen(tempHome(), null);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(changes).toEqual([]);
    source.setViewing(true);
    await vi.waitFor(() => expect(changes).toHaveLength(1));
    expect(changes[0]).toMatchObject({ claude: null, codex: null });
    expect(execFileMock).not.toHaveBeenCalled();
    source.stop();
  });

  it('reports one early reset only when a future window drops and moves later', async () => {
    const home = tempHome();
    const file = claudeUsageFile(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const now = Date.now();
    const write = (pct: number, reset: number) =>
      fs.writeFileSync(
        file,
        JSON.stringify({
          five_hour: { used_percentage: pct, resets_at: Math.floor(reset / 1000) },
        }),
      );
    const resets: string[] = [];
    const source = new UsageSource(
      { home, codexHome: path.join(home, '.codex'), script: null },
      () => undefined,
      ({ provider, period }) => resets.push(`${provider}:${period}`),
    );
    write(73, now + 3 * HOUR * 1000);
    source.setViewing(true);
    await vi.waitFor(() => expect(source.usage?.claude?.fiveHourPct).toBe(73));

    // A lower reading with a later deadline is an early reset; an identical re-read is not.
    write(4, now + 6 * HOUR * 1000);
    source.setViewing(false);
    source.setViewing(true);
    await vi.waitFor(() => expect(resets).toEqual(['claude:fiveHour']));
    source.setViewing(false);
    source.setViewing(true);
    await vi.waitFor(() => expect(source.usage?.claude?.fiveHourPct).toBe(4));
    expect(resets).toEqual(['claude:fiveHour']);

    // Scheduled rollover (old deadline already elapsed), and a rise, remain quiet.
    source.stop();
    const quiet = new UsageSource(
      { home, codexHome: path.join(home, '.codex'), script: null },
      () => undefined,
      ({ provider, period }) => resets.push(`${provider}:${period}`),
    );
    write(73, now - HOUR * 1000);
    quiet.setViewing(true);
    await vi.waitFor(() => expect(quiet.usage?.claude?.fiveHourIsReset).toBe(true));
    write(2, now + HOUR * 1000);
    quiet.setViewing(false);
    quiet.setViewing(true);
    await vi.waitFor(() => expect(quiet.usage?.claude?.fiveHourPct).toBe(2));
    write(9, now + 2 * HOUR * 1000);
    quiet.setViewing(false);
    quiet.setViewing(true);
    await vi.waitFor(() => expect(quiet.usage?.claude?.fiveHourPct).toBe(9));
    expect(resets).toEqual(['claude:fiveHour']);
    quiet.stop();
  });

  it('refreshNow waits for an in-flight refresh, then reads fresh numbers once more', async () => {
    const home = tempHome();
    const script = writeScript(home, '9.9.9', '');
    const changes: Array<Omit<UsageState, 'type'>> = [];
    let calls = 0;
    let first: ((error: Error | null, stdout: string) => void) | undefined;
    execFileMock.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: Record<string, unknown>,
        callback: (error: Error | null, stdout: string) => void,
      ) => {
        calls++;
        if (calls === 1) first = callback;
        else
          queueMicrotask(() => callback(null, JSON.stringify({ codex: { fiveHourPercent: 12 } })));
      },
    );
    const source = new UsageSource(
      { home, codexHome: path.join(home, '.codex'), script },
      (usage) => changes.push(usage),
    );
    source.setViewing(true);
    await vi.waitFor(() => expect(first).toBeDefined());
    const checked = source.refreshNow();
    first!(null, JSON.stringify({ codex: { fiveHourPercent: 11 } }));
    await checked;
    expect(calls).toBe(2);
    expect(changes.at(-1)?.codex?.fiveHourPct).toBe(12);
    source.stop();
  });

  it("the plugin wins where it answers, Claude Code's own data fills the rest; a failure keeps the last answer", async () => {
    const home = tempHome();
    const file = claudeUsageFile(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ five_hour: { used_percentage: 9, resets_at: nowSec() + HOUR } }),
    );
    const script = writeScript(home, '9.9.9', '');
    let fail = false;
    execFileMock.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: Record<string, unknown>,
        callback: (error: Error | null, stdout: string) => void,
      ) => {
        queueMicrotask(() =>
          callback(
            fail ? new Error('check-usage failed') : null,
            JSON.stringify({ codex: { fiveHourPercent: 35, sevenDayPercent: 6 } }),
          ),
        );
      },
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { source, changes } = listen(home, script);
    source.setViewing(true);
    await vi.waitFor(() => expect(changes).toHaveLength(1));
    expect(changes[0].claude?.fiveHourPct).toBe(9); // own data: the plugin gave no Claude
    expect(changes[0].codex?.fiveHourPct).toBe(35);

    fail = true;
    source.setViewing(false);
    source.setViewing(true);
    await vi.waitFor(() => expect(changes).toHaveLength(2));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(changes[1].codex?.fiveHourPct).toBe(35);

    source.stop();
    vi.useFakeTimers();
    const stopped = listen(home, null).source;
    stopped.setViewing(true);
    expect(vi.getTimerCount()).toBe(1);
    stopped.stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(USAGE_REFRESH_MS);
    expect(changes).toHaveLength(2);
  });
});

describe('earlyResets', () => {
  const now = Date.parse('2026-10-24T00:00:00.000Z');
  const reading = (pct: number, resetAt: number) => ({
    ts: new Date(now).toISOString(),
    claude: { fiveHourPct: pct, fiveHourReset: new Date(resetAt).toISOString() },
    codex: null,
  });

  it('does not report the ordinary rollover whose old reset already passed', () => {
    const previous = reading(73, now - 1);
    const next = reading(2, now + 5 * HOUR * 1000);
    expect(earlyResets(previous, next, now)).toEqual([]);
  });

  it('reports the same drop when the old reset is still ahead', () => {
    const previous = reading(73, now + 4 * HOUR * 1000);
    const next = reading(2, now + 7 * HOUR * 1000);
    expect(earlyResets(previous, next, now)).toEqual([{ provider: 'claude', period: 'fiveHour' }]);
  });

  it('reports a weekly reset that came days early (10-24: 73 % → 0 % with five days left)', () => {
    const day = 24 * HOUR * 1000;
    const weekly = (pct: number, resetAt: number) => ({
      ts: new Date(now).toISOString(),
      claude: null,
      codex: { sevenDayPct: pct, sevenDayReset: new Date(resetAt).toISOString() },
    });
    for (const left of [1, 3.6, 5, 6])
      expect(earlyResets(weekly(73, now + left * day), weekly(0, now + 7 * day), now)).toEqual([
        { provider: 'codex', period: 'sevenDay' },
      ]);
  });

  it('ignores a reset too close to now or one that shifts by too little', () => {
    const later = now + 12 * HOUR * 1000;
    expect(
      earlyResets(reading(73, now + USAGE_EARLY_RESET_MIN_FUTURE_MS - 1), reading(2, later), now),
    ).toEqual([]);
    expect(
      earlyResets(
        reading(73, now + 4 * HOUR * 1000),
        reading(2, now + 4 * HOUR * 1000 + USAGE_EARLY_RESET_MIN_NEXT_SHIFT_MS.fiveHour),
        now,
      ),
    ).toEqual([]);
  });
});
