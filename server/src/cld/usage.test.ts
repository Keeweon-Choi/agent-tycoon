import { spawnSync } from 'child_process';
import * as fs from 'fs';
import { createRequire, syncBuiltinESMExports } from 'module';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { UsageLimitWindow, UsageState } from '../../../core/src/messages.js';
import {
  CLAUDE_USAGE_REPORT_MAX_BYTES,
  CLAUDE_USAGE_STALE_MS,
  USAGE_EARLY_RESET_MIN_FUTURE_MS,
  USAGE_EARLY_RESET_MIN_NEXT_SHIFT_MS,
  USAGE_PROBE_MIN_GAP_MS,
  USAGE_PROBE_STDIN_HOLD_MS,
  USAGE_PROBE_TIMEOUT_MS,
} from '../constants.js';
import { fakeUsage, makeEngineHome, REPO_ROOT } from './testHome.js';
import {
  claudeOwnUsage,
  claudeUsageFile,
  claudeUsageProbe,
  claudeUsageReport,
  codexOwnUsage,
  earlyResets,
  UsageSource,
} from './usage.js';
import { usageProbeDir } from './usageProbeFolder.js';

let dirs: string[] = [];
const restore: Array<() => void> = [];
afterEach(() => {
  for (const undo of restore.splice(0)) undo();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function tempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-usage-'));
  dirs.push(home);
  return home;
}

const providerOf = (usage: Omit<UsageState, 'type'> | null | undefined, id: string) =>
  usage?.providers.find((provider) => provider.id === id);
const windowOf = (windows: ReadonlyArray<UsageLimitWindow> | undefined, id: string) =>
  windows?.find((window) => window.id === id);

const HOUR = 3600;
const nowSec = () => Math.floor(Date.now() / 1000);

describe('claudeOwnUsage (ENV-2: what the status line kept)', () => {
  it('maps Claude Code rate_limits with the report time; a passed reset is marked without a made-up percent; no file is unknown', () => {
    const home = tempHome();
    const file = claudeUsageFile(home);
    expect(claudeOwnUsage(file)).toEqual({ id: 'claude', name: 'Claude', windows: [] });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const reset = nowSec() + HOUR;
    fs.writeFileSync(
      file,
      JSON.stringify({
        ts: '2026-11-06T08:00:00.000Z',
        five_hour: { used_percentage: 23.5, resets_at: reset },
        seven_day: { used_percentage: 41.2, resets_at: nowSec() - 10 },
      }),
    );
    expect(claudeOwnUsage(file)).toEqual({
      id: 'claude',
      name: 'Claude',
      windows: [
        { id: '5h', pct: 23.5, resetAt: new Date(reset * 1000).toISOString() },
        { id: '7d', pct: null, resetAt: null, isReset: true },
      ],
      at: '2026-11-06T08:00:00.000Z',
    });
    fs.writeFileSync(file, JSON.stringify({ five_hour: { used_percentage: 5, resets_at: 1 } }));
    expect(claudeOwnUsage(file).windows).toEqual([
      { id: '5h', pct: null, resetAt: null, isReset: true },
    ]);
    fs.writeFileSync(file, '{broken');
    expect(claudeOwnUsage(file).windows).toEqual([]);
  });
});

describe('a junk report never takes the daemon down', () => {
  it('a resets_at past Date range keeps the figure without a reset time (it used to throw RangeError)', () => {
    const home = tempHome();
    const file = claudeUsageFile(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ seven_day: { used_percentage: 40, resets_at: 1e13 } }));
    expect(claudeOwnUsage(file).windows).toEqual([{ id: '7d', pct: 40, resetAt: null }]);
  });

  it('a reading that throws (here the listener) is caught and warned once, in setViewing and refreshNow', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const source = new UsageSource(options(tempHome()), () => {
      throw new RangeError('boom');
    });
    expect(() => source.setViewing(true)).not.toThrow();
    await expect(source.refreshNow()).resolves.toBeUndefined();
    source.stop();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('RangeError');
  });
});

describe('out-of-range figures are not believed', () => {
  it('a percent outside 0-100 is no figure (never a full window that holds delegation); a report time ahead of now is dropped', () => {
    const home = tempHome();
    const file = claudeUsageFile(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const reset = nowSec() + HOUR;
    fs.writeFileSync(
      file,
      JSON.stringify({
        ts: new Date(Date.now() + 3_600_000).toISOString(),
        five_hour: { used_percentage: 250, resets_at: reset },
        seven_day: { used_percentage: -3, resets_at: reset },
      }),
    );
    expect(claudeOwnUsage(file)).toEqual({ id: 'claude', name: 'Claude', windows: [] });
    fs.writeFileSync(
      file,
      JSON.stringify({
        ts: new Date(Date.now() + 3_600_000).toISOString(),
        seven_day: { used_percentage: 100, resets_at: reset },
      }),
    );
    expect(claudeOwnUsage(file)).toEqual({
      id: 'claude',
      name: 'Claude',
      windows: [{ id: '7d', pct: 100, resetAt: new Date(reset * 1000).toISOString() }],
    });
  });
});

describe('the report path holds only a small regular file', () => {
  const report = JSON.stringify({ seven_day: { used_percentage: 40, resets_at: nowSec() + HOUR } });

  it('a symlink at the report path is not followed', () => {
    const home = tempHome();
    const file = claudeUsageFile(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const elsewhere = path.join(home, 'elsewhere.json');
    fs.writeFileSync(elsewhere, report);
    fs.symlinkSync(elsewhere, file);
    expect(claudeOwnUsage(file).windows).toEqual([]);
  });

  it('a file over the size cap is not read', () => {
    const home = tempHome();
    const file = claudeUsageFile(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      report.replace('{', `{"pad":"${'x'.repeat(CLAUDE_USAGE_REPORT_MAX_BYTES)}",`),
    );
    expect(claudeOwnUsage(file).windows).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')(
    'a FIFO at the report path returns at once instead of blocking',
    () => {
      const home = tempHome();
      const file = claudeUsageFile(home);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      expect(spawnSync('mkfifo', [file]).status).toBe(0);
      expect(claudeOwnUsage(file).windows).toEqual([]);
    },
  );
});

describe('codexOwnUsage', () => {
  it("reads the newest log's rate_limits by window length; nothing to read is null", () => {
    const codex = tempHome();
    expect(codexOwnUsage(codex)).toEqual([]);
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
    expect(codexOwnUsage(codex)).toMatchObject([
      { id: '5h', pct: 73 },
      { id: '7d', pct: 27 },
    ]);
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
    expect(codexOwnUsage(codex)).toEqual([{ id: '5h', pct: null, resetAt: null, isReset: true }]);
  });

  it('names a window by its length, so one a new plan adds shows by itself', () => {
    const codex = tempHome();
    const file = path.join(codex, 'sessions', '2026', '10', '24', 'rollout-a.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const at = nowSec() + HOUR;
    fs.writeFileSync(
      file,
      `${JSON.stringify({
        payload: {
          rate_limits: {
            primary: { used_percent: 0, window_minutes: 1440, resets_at: at },
            secondary: { used_percent: 4, window_minutes: 10080, resets_at: at },
          },
        },
      })}\n`,
    );
    expect(codexOwnUsage(codex)).toMatchObject([
      { id: '1d', pct: 0 },
      { id: '7d', pct: 4 },
    ]);
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
    expect(codexOwnUsage(codex)).toMatchObject([{ id: '5h', pct: 73 }]);
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
    expect(windowOf(claudeOwnUsage(claudeUsageFile(home)).windows, '5h')?.pct).toBe(12);

    // The project's own line wins; a run without rate_limits keeps the last numbers.
    fs.writeFileSync(
      path.join(project, '.claude', 'settings.json'),
      JSON.stringify({ statusLine: { command: 'cat >/dev/null; echo project-line' } }),
    );
    const second = run(home, { workspace: { project_dir: project } });
    expect(second.stdout.trim()).toBe('project-line');
    expect(windowOf(claudeOwnUsage(claudeUsageFile(home)).windows, '5h')?.pct).toBe(12);

    // A plan with no 5-hour limit sends only seven_day: the 5h window is gone, not "unknown".
    run(home, {
      workspace: { project_dir: project },
      rate_limits: { seven_day: { used_percentage: 3, resets_at: reset } },
    });
    expect(claudeOwnUsage(claudeUsageFile(home)).windows.map((w) => w.id)).toEqual(['7d']);

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

const options = (home: string): UsageSource['opts'] => ({
  home,
  codexHome: path.join(home, '.codex'),
});

describe('UsageSource', () => {
  const listen = (home: string) => {
    const changes: Array<Omit<UsageState, 'type'>> = [];
    const source = new UsageSource(options(home), (u) => changes.push(u));
    return { source, changes };
  };
  const script = path.join(REPO_ROOT, 'cld/bin/cld-gui-statusline.js');

  it('with no data reports both providers without windows, only while viewed, with no timer once stopped', async () => {
    const { source, changes } = listen(tempHome());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(changes).toEqual([]);
    source.setViewing(true);
    await vi.waitFor(() => expect(changes).toHaveLength(1));
    expect(changes[0].providers).toEqual([
      { id: 'claude', name: 'Claude', windows: [] },
      { id: 'codex', name: 'Codex', windows: [] },
    ]);
    source.stop();
    vi.useFakeTimers();
    const timed = listen(tempHome()).source;
    timed.setViewing(true);
    expect(vi.getTimerCount()).toBe(1);
    timed.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a status-line payload becomes the usage the UI reads the moment it lands (windows, percent, reset, report time)', async () => {
    const home = tempHome();
    const { source, changes } = listen(home);
    source.setViewing(true);
    await vi.waitFor(() => expect(changes).toHaveLength(1));
    // The JSON Claude Code hands a status line (code.claude.com/docs/en/statusline), trimmed to a fixture.
    const reset5h = nowSec() + 2 * HOUR;
    const reset7d = nowSec() + 60 * HOUR;
    const payload = {
      session_id: 'fixture-session',
      transcript_path: path.join(home, 'transcript.jsonl'),
      workspace: { current_dir: home, project_dir: home },
      model: { id: 'claude-opus-5-5', display_name: 'Opus' },
      rate_limits: {
        five_hour: { used_percentage: 23.5, resets_at: reset5h },
        seven_day: { used_percentage: 41.2, resets_at: reset7d },
      },
    };
    const before = Date.now();
    const run = spawnSync(process.execPath, [script], {
      input: JSON.stringify(payload),
      encoding: 'utf-8',
      env: { HOME: home, PATH: process.env.PATH },
    });
    expect(run.status).toBe(0);
    // No refresh tick (2 min) in between: the file watch brings it.
    await vi.waitFor(() => expect(providerOf(source.usage, 'claude')?.windows).toHaveLength(2), {
      timeout: 3000,
    });
    const claude = providerOf(source.usage, 'claude');
    expect(claude?.windows).toEqual([
      { id: '5h', pct: 23.5, resetAt: new Date(reset5h * 1000).toISOString() },
      { id: '7d', pct: 41.2, resetAt: new Date(reset7d * 1000).toISOString() },
    ]);
    expect(Date.parse(claude?.at ?? '')).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(claude?.at ?? '')).toBeLessThanOrEqual(Date.now());
    // Codex is untouched by a Claude report, and nothing is sent once nobody views.
    expect(providerOf(source.usage, 'codex')).toEqual({ id: 'codex', name: 'Codex', windows: [] });
    source.stop();
    const sent = changes.length;
    spawnSync(process.execPath, [script], {
      input: JSON.stringify(payload),
      env: { HOME: home, PATH: process.env.PATH },
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(changes).toHaveLength(sent);
  });

  it('never opens Claude Code credentials nor calls an account usage endpoint (ADR-0016 decision 7)', async () => {
    const home = tempHome();
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const creds = path.join(home, '.claude', '.credentials.json');
    const oauth = { accessToken: 'sk-ant-oat01-FIXTURE', expiresAt: Date.now() + 86_400_000 };
    fs.writeFileSync(creds, JSON.stringify({ claudeAiOauth: oauth }));
    const read = fs.promises.readFile;
    const opened: string[] = [];
    const note = (file: unknown) => opened.push(String(file));
    // The ESM namespace cannot be spied on: patch Node's own fs object and sync the namespace to it.
    const nodeFs = createRequire(__filename)('fs') as typeof fs;
    const readSync = nodeFs.readFileSync;
    nodeFs.readFileSync = ((...args: unknown[]) => {
      note(args[0]);
      return (readSync as (...a: unknown[]) => never)(...args);
    }) as typeof fs.readFileSync;
    syncBuiltinESMExports();
    restore.push(() => {
      nodeFs.readFileSync = readSync;
      syncBuiltinESMExports();
    });
    vi.spyOn(fs.promises, 'readFile').mockImplementation((...args: unknown[]) => {
      note(args[0]);
      return (read as (...a: unknown[]) => never)(...args);
    });
    // Rejected, so even old code under this test never reaches the network.
    const fetched = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('no network in tests'));
    // Every option an older UsageSource took for that read, so the same test catches it there too.
    const opts = { ...options(home), claudeConfigDir: path.join(home, '.claude'), keychain: null };
    const changes: unknown[] = [];
    const source = new UsageSource(opts, (u) => changes.push(u));
    source.setViewing(true);
    await vi.waitFor(() => expect(changes.length).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 50));
    source.stop();
    expect(opened.filter((f) => f.includes('credentials'))).toEqual([]);
    expect(fetched).not.toHaveBeenCalled();
    // And in the source: no credential path, Keychain item, OAuth endpoint or HTTP client.
    const code = fs.readFileSync(path.join(REPO_ROOT, 'server/src/cld/usage.ts'), 'utf-8');
    expect(code).not.toMatch(
      /credentials\.json|claudeAiOauth|Keychain|find-generic-password|oauth\/usage|fetch\(|curl/,
    );
  });

  it('a Claude plan with only a 7-day window shows one window; Codex with both shows two', async () => {
    const home = tempHome();
    fs.mkdirSync(path.dirname(claudeUsageFile(home)), { recursive: true });
    fs.writeFileSync(
      claudeUsageFile(home),
      JSON.stringify({ seven_day: { used_percentage: 3, resets_at: nowSec() + HOUR } }),
    );
    const day = path.join(home, '.codex', 'sessions', '2026', '10', '23');
    fs.mkdirSync(day, { recursive: true });
    const limit = (minutes: number, used: number) => ({
      used_percent: used,
      window_minutes: minutes,
      resets_at: nowSec() + HOUR,
    });
    fs.writeFileSync(
      path.join(day, 'rollout-a.jsonl'),
      `${JSON.stringify({
        payload: {
          type: 'token_count',
          rate_limits: { primary: limit(300, 77), secondary: limit(10080, 19) },
        },
      })}\n`,
    );
    const { source, changes } = listen(home);
    source.setViewing(true);
    await vi.waitFor(() => expect(changes).toHaveLength(1));
    source.stop();
    const ids = (id: string) => providerOf(changes[0], id)?.windows.map((w) => w.id);
    expect(ids('claude')).toEqual(['7d']);
    expect(ids('codex')).toEqual(['5h', '7d']);
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
      options(home),
      () => undefined,
      ({ provider, period }) => resets.push(`${provider}:${period}`),
    );
    write(73, now + 3 * HOUR * 1000);
    source.setViewing(true);
    await vi.waitFor(() =>
      expect(windowOf(providerOf(source.usage, 'claude')?.windows, '5h')?.pct).toBe(73),
    );

    // A lower reading with a later deadline is an early reset; an identical re-read is not.
    write(4, now + 6 * HOUR * 1000);
    source.setViewing(false);
    source.setViewing(true);
    await vi.waitFor(() => expect(resets).toEqual(['claude:5h']));
    source.setViewing(false);
    source.setViewing(true);
    await vi.waitFor(() =>
      expect(windowOf(providerOf(source.usage, 'claude')?.windows, '5h')?.pct).toBe(4),
    );
    expect(resets).toEqual(['claude:5h']);

    // Scheduled rollover (old deadline already elapsed), and a rise, remain quiet.
    source.stop();
    const quiet = new UsageSource(
      options(home),
      () => undefined,
      ({ provider, period }) => resets.push(`${provider}:${period}`),
    );
    write(73, now - HOUR * 1000);
    quiet.setViewing(true);
    await vi.waitFor(() =>
      expect(windowOf(providerOf(quiet.usage, 'claude')?.windows, '5h')?.isReset).toBe(true),
    );
    write(2, now + HOUR * 1000);
    quiet.setViewing(false);
    quiet.setViewing(true);
    await vi.waitFor(() =>
      expect(windowOf(providerOf(quiet.usage, 'claude')?.windows, '5h')?.pct).toBe(2),
    );
    write(9, now + 2 * HOUR * 1000);
    quiet.setViewing(false);
    quiet.setViewing(true);
    await vi.waitFor(() =>
      expect(windowOf(providerOf(quiet.usage, 'claude')?.windows, '5h')?.pct).toBe(9),
    );
    expect(resets).toEqual(['claude:5h']);
    quiet.stop();
  });
});

describe('earlyResets', () => {
  const now = Date.parse('2026-10-24T00:00:00.000Z');
  const reading = (pct: number, resetAt: number) => ({
    ts: new Date(now).toISOString(),
    providers: [
      {
        id: 'claude',
        name: 'Claude',
        windows: [{ id: '5h', pct, resetAt: new Date(resetAt).toISOString() }],
      },
    ],
  });

  it('does not report the ordinary rollover whose old reset already passed', () => {
    const previous = reading(73, now - 1);
    const next = reading(2, now + 5 * HOUR * 1000);
    expect(earlyResets(previous, next, now)).toEqual([]);
  });

  it('reports the same drop when the old reset is still ahead', () => {
    const previous = reading(73, now + 4 * HOUR * 1000);
    const next = reading(2, now + 7 * HOUR * 1000);
    expect(earlyResets(previous, next, now)).toEqual([
      { provider: 'claude', name: 'Claude', period: '5h' },
    ]);
  });

  it('reports a weekly reset that came days early (10-24: 73 % → 0 % with five days left)', () => {
    const day = 24 * HOUR * 1000;
    const weekly = (pct: number, resetAt: number) => ({
      ts: new Date(now).toISOString(),
      providers: [
        {
          id: 'codex',
          name: 'Codex',
          windows: [{ id: '7d', pct, resetAt: new Date(resetAt).toISOString() }],
        },
      ],
    });
    for (const left of [1, 3.6, 5, 6])
      expect(earlyResets(weekly(73, now + left * day), weekly(0, now + 7 * day), now)).toEqual([
        { provider: 'codex', name: 'Codex', period: '7d' },
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

/**
 * Claude Code's `/usage` answer in stream-json, trimmed (fixtures/claude-usage-stream.jsonl): the
 * values the orchestrator saw on 2.1.319 (weekly_all 82, Fable weekly_scoped 5) in the documented
 * SDKUsageReport shape, plus entries a parser must skip (a surface scope, an unknown kind, a junk
 * percent) and a cut last line.
 */
const STREAM = path.join(__dirname, 'fixtures', 'claude-usage-stream.jsonl');
const streamLines = (shiftMs = 0) =>
  fs
    .readFileSync(STREAM, 'utf-8')
    .split('\n')
    .flatMap((line) => {
      try {
        return [
          JSON.parse(
            line.replace(/"(2026-11-06T[^"]+)"/g, (_m, t: string) =>
              JSON.stringify(new Date(Date.parse(t) + shiftMs).toISOString()),
            ),
          ),
        ];
      } catch {
        return [];
      }
    });
const FIXTURE_NOW = Date.parse('2026-11-06T09:30:00Z');

describe('claudeUsageReport (Claude Code /usage, stream-json)', () => {
  it('maps the week, the five hours and each model week; skips other scopes, unknown kinds and junk', () => {
    expect(claudeUsageReport(streamLines(), FIXTURE_NOW)).toEqual({
      at: FIXTURE_NOW,
      windows: [
        { id: '5h', pct: 12, resetsAtSec: Date.parse('2026-11-06T13:00:00Z') / 1000 },
        { id: '7d', pct: 82, resetsAtSec: Date.parse('2026-11-06T10:59:59.900Z') / 1000 },
      ],
      models: [{ family: 'fable', pct: 5, reset: '2026-11-06T10:59:59.900Z' }],
    });
  });

  it('no report (an API-key login, an older CLI, not stream-json at all) is null', () => {
    expect(claudeUsageReport([{ type: 'result', total_cost_usd: 0 }])).toBeNull();
    expect(claudeUsageReport({ usage_report: {} })).toBeNull();
    expect(
      claudeUsageReport([{ type: 'assistant', usage_report: { rate_limits: null } }]),
    ).toBeNull();
  });

  it('a report whose limits are not in yet (limits: null) is no reading, not empty figures', () => {
    // The real shape when the CLI's own limits fetch has not come back (11-06, Claude Code 2.1.319).
    const late = {
      type: 'assistant',
      usage_report: { rate_limits: { limits: null, extra_usage: { is_enabled: false } } },
    };
    expect(claudeUsageReport([late])).toBeNull();
    // An empty list is a reading: the account has no limits to show.
    expect(
      claudeUsageReport([{ type: 'assistant', usage_report: { rate_limits: { limits: [] } } }])
        ?.models,
    ).toEqual([]);
  });
});

describe('UsageSource with the /usage probe', () => {
  const DAY = 86_400_000;
  /** The fixture moved so its resets are a day ahead of now. */
  const future = () => streamLines(Date.now() - FIXTURE_NOW + DAY);

  it('brings the model week back; the fresher of status line and /usage gives the windows', async () => {
    const home = tempHome();
    const probe = vi.fn(() => Promise.resolve<unknown>(future()));
    const source = new UsageSource({ ...options(home), probe }, () => undefined);
    // An older status-line report: /usage, newer, wins the windows.
    const file = claudeUsageFile(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const old = new Date(Date.now() - 60_000).toISOString();
    fs.writeFileSync(
      file,
      JSON.stringify({ ts: old, seven_day: { used_percentage: 70, resets_at: nowSec() + HOUR } }),
    );
    source.setViewing(true);
    await vi.waitFor(() => expect(providerOf(source.usage, 'claude')?.models).toBeDefined());
    let claude = providerOf(source.usage, 'claude');
    expect(claude?.models).toEqual([{ family: 'fable', pct: 5, reset: expect.any(String) }]);
    expect(claude?.windows.map((w) => [w.id, w.pct])).toEqual([
      ['5h', 12],
      ['7d', 82],
    ]);
    expect(Date.parse(claude?.at ?? '')).toBeGreaterThan(Date.parse(old));
    // A status-line report after it (week only): its week wins, the report's five hours stay, the model week stays.
    fs.writeFileSync(
      file,
      JSON.stringify({
        ts: new Date(Date.now() + 1).toISOString(),
        seven_day: { used_percentage: 83, resets_at: nowSec() + HOUR },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    await source.refreshNow();
    claude = providerOf(source.usage, 'claude');
    expect(claude?.windows.map((w) => [w.id, w.pct])).toEqual([
      ['5h', 12],
      ['7d', 83],
    ]);
    expect(claude?.models?.[0]).toMatchObject({ family: 'fable', pct: 5 });
    source.stop();
  });

  it('runs only while viewed, at most once per gap, again on an explicit refresh, never two at once', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    const home = tempHome();
    let release: (v: unknown) => void = () => undefined;
    const probe = vi.fn(() => new Promise<unknown>((resolve) => (release = resolve)));
    const source = new UsageSource({ ...options(home), probe }, () => undefined);
    expect(probe).not.toHaveBeenCalled();
    source.setViewing(true);
    expect(probe).toHaveBeenCalledTimes(1);
    await source.refreshNow(); // still running: no second run
    expect(probe).toHaveBeenCalledTimes(1);
    release(future());
    await vi.waitFor(() => expect(providerOf(source.usage, 'claude')?.models).toBeDefined());
    source.setViewing(false);
    source.setViewing(true); // a viewer coming back inside the gap
    vi.advanceTimersByTime(USAGE_PROBE_MIN_GAP_MS - 1000);
    expect(probe).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2 * 60_000); // the next refresh tick past the gap
    expect(probe).toHaveBeenCalledTimes(2);
    release([]);
    await vi.waitFor(() => expect(source['probing']).toBe(false));
    await source.refreshNow(); // the click: past any gap
    expect(probe).toHaveBeenCalledTimes(3);
    release([]);
    source.stop();
    vi.advanceTimersByTime(USAGE_PROBE_MIN_GAP_MS * 3);
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it("a failing or empty probe keeps the status line's figures and warns once without its output", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const home = tempHome();
    const file = claudeUsageFile(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ seven_day: { used_percentage: 30, resets_at: nowSec() + HOUR } }),
    );
    const probe = vi.fn(() => Promise.reject(new Error('/home/u/secret path in stderr')));
    const source = new UsageSource({ ...options(home), probe }, () => undefined);
    source.setViewing(true);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    await source.refreshNow();
    await new Promise((resolve) => setTimeout(resolve, 10));
    source.stop();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).not.toContain('secret');
    expect(providerOf(source.usage, 'claude')?.windows.map((w) => w.pct)).toEqual([30]);
  });

  it("claudeUsageProbe runs the user's claude in our empty folder without session, hooks or model call", async () => {
    const { home, claudePath } = makeEngineHome();
    dirs.push(home);
    await fakeUsage(home, { fable: 9 }, { fiveHour: 0, sevenDay: 0 });
    const lines = await claudeUsageProbe(claudePath, { HOME: home, PATH: process.env.PATH }, home);
    expect(claudeUsageReport(lines)?.models).toEqual([
      { family: 'fable', pct: 9, reset: expect.any(String) },
    ]);
    const [call] = fs
      .readFileSync(path.join(home, 'fake-claude-usage.log'), 'utf-8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { argv: string[]; cwd: string });
    expect(call.argv).toEqual([
      '-p',
      '/usage',
      '--output-format',
      'stream-json',
      '--verbose',
      '--no-session-persistence',
      '--safe-mode',
    ]);
    expect(fs.realpathSync(call.cwd)).toBe(fs.realpathSync(usageProbeDir(home)));
    expect(fs.readdirSync(usageProbeDir(home))).toEqual([]);
  });

  it("claudeUsageProbe holds the child's stdin open, then ends it, well before the timeout", async () => {
    const { home, claudePath } = makeEngineHome();
    dirs.push(home);
    await fakeUsage(home, { fable: 9 }, { fiveHour: 0, sevenDay: 0 });
    fs.writeFileSync(path.join(home, 'fake-usage-stdin'), '');
    await claudeUsageProbe(claudePath, { HOME: home, PATH: process.env.PATH }, home);
    const seen = JSON.parse(fs.readFileSync(path.join(home, 'fake-usage-stdin.log'), 'utf-8')) as {
      openAt1s: boolean;
      eofMs: number;
    };
    expect(seen.openAt1s).toBe(true);
    expect(seen.eofMs).toBeGreaterThanOrEqual(USAGE_PROBE_STDIN_HOLD_MS - 500);
    expect(seen.eofMs).toBeLessThan(USAGE_PROBE_TIMEOUT_MS / 2);
  }, 15_000);

  it('a report kind named like an Object.prototype member is skipped, not a window; the daemon stays up', async () => {
    const limit = (kind: string, percent: number) => ({
      kind,
      percent,
      resets_at: new Date(Date.now() + DAY).toISOString(),
    });
    const lines = [
      {
        type: 'assistant',
        usage_report: {
          rate_limits: {
            limits: [
              limit('session', 12),
              limit('constructor', 7),
              limit('toString', 8),
              limit('__proto__', 9),
            ],
          },
        },
      },
    ];
    expect(claudeUsageReport(lines)?.windows.map((w) => w.id)).toEqual(['5h']);
    // A throw while reading the answer is caught too (a bad figure must not become an unhandled rejection).
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    restore.push(() => process.off('unhandledRejection', unhandled));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const source = new UsageSource(
      { ...options(tempHome()), probe: () => Promise.resolve<unknown>(lines) },
      () => undefined,
    );
    source.setViewing(true);
    await vi.waitFor(() =>
      expect(providerOf(source.usage, 'claude')?.windows.map((w) => w.id)).toEqual(['5h']),
    );
    vi.spyOn(Array.prototype, 'sort').mockImplementationOnce(() => {
      throw new Error('boom');
    });
    source['probedAt'] = 0;
    source['probe'](Date.now(), true);
    await vi.waitFor(() => expect(source['probing']).toBe(false));
    await new Promise((resolve) => setTimeout(resolve, 10));
    source.stop();
    expect(unhandled).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it('a probe that throws before it returns (unwritable folder) does not leave probing set', async () => {
    const { home, claudePath } = makeEngineHome();
    dirs.push(home);
    fs.writeFileSync(usageProbeDir(home), 'a file where the folder should be');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const probe = () => claudeUsageProbe(claudePath, { HOME: home }, home);
    expect(probe).toThrow();
    const source = new UsageSource({ ...options(home), probe }, () => undefined);
    source.setViewing(true);
    await vi.waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(source['probing']).toBe(false));
    source.stop();
  });

  it("a report with only the week keeps the status line's five hours", async () => {
    const home = tempHome();
    const file = claudeUsageFile(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const old = new Date(Date.now() - 60_000).toISOString();
    fs.writeFileSync(
      file,
      JSON.stringify({
        ts: old,
        five_hour: { used_percentage: 20, resets_at: nowSec() + HOUR },
        seven_day: { used_percentage: 70, resets_at: nowSec() + 10 * HOUR },
      }),
    );
    const source = new UsageSource(options(home), () => undefined);
    source['report'] = {
      at: Date.now(),
      windows: [{ id: '7d', pct: 82, resetsAtSec: nowSec() + 10 * HOUR }],
      models: [],
    };
    const claude = source['claude'](Date.now());
    expect(claude.windows.map((w) => [w.id, w.pct])).toEqual([
      ['5h', 20],
      ['7d', 82],
    ]);
  });

  it('a report older than the status line stale limit drops its model weeks, even one without a reset', () => {
    const source = new UsageSource(options(tempHome()), () => undefined);
    const models = [{ family: 'fable', pct: 5, reset: null }];
    source['report'] = { at: Date.now() - 1000, windows: [], models };
    expect(source['claude'](Date.now()).models).toEqual(models);
    source['report'] = { at: Date.now() - CLAUDE_USAGE_STALE_MS - 1000, windows: [], models };
    expect(source['claude'](Date.now()).models).toBeUndefined();
  });
});
