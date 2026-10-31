import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { UsageLimitWindow, UsageState } from '../../../core/src/messages.js';
import {
  CLAUDE_USAGE_BETA,
  USAGE_EARLY_RESET_MIN_FUTURE_MS,
  USAGE_EARLY_RESET_MIN_NEXT_SHIFT_MS,
} from '../constants.js';
import { REPO_ROOT } from './testHome.js';
import {
  claudeOwnUsage,
  claudeUsageFile,
  claudeUsageUrl,
  codexOwnUsage,
  earlyResets,
  type ReadKeychain,
  UsageSource,
} from './usage.js';

let dirs: string[] = [];
afterEach(() => {
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
  it('maps Claude Code rate_limits; a passed reset is marked without a made-up percent; no file is null', () => {
    const home = tempHome();
    const file = claudeUsageFile(home);
    expect(claudeOwnUsage(file)).toEqual([]);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const reset = nowSec() + HOUR;
    fs.writeFileSync(
      file,
      JSON.stringify({
        five_hour: { used_percentage: 23.5, resets_at: reset },
        seven_day: { used_percentage: 41.2, resets_at: nowSec() - 10 },
      }),
    );
    expect(claudeOwnUsage(file)).toEqual([
      { id: '5h', pct: 23.5, resetAt: new Date(reset * 1000).toISOString() },
      { id: '7d', pct: null, resetAt: null, isReset: true },
    ]);
    fs.writeFileSync(file, JSON.stringify({ five_hour: { used_percentage: 5, resets_at: 1 } }));
    expect(claudeOwnUsage(file)).toEqual([{ id: '5h', pct: null, resetAt: null, isReset: true }]);
  });
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
    expect(windowOf(claudeOwnUsage(claudeUsageFile(home)), '5h')?.pct).toBe(12);

    // The project's own line wins; a run without rate_limits keeps the last numbers.
    fs.writeFileSync(
      path.join(project, '.claude', 'settings.json'),
      JSON.stringify({ statusLine: { command: 'cat >/dev/null; echo project-line' } }),
    );
    const second = run(home, { workspace: { project_dir: project } });
    expect(second.stdout.trim()).toBe('project-line');
    expect(windowOf(claudeOwnUsage(claudeUsageFile(home)), '5h')?.pct).toBe(12);

    // A plan with no 5-hour limit sends only seven_day: the 5h window is gone, not "unknown".
    run(home, {
      workspace: { project_dir: project },
      rate_limits: { seven_day: { used_percentage: 3, resets_at: reset } },
    });
    expect(claudeOwnUsage(claudeUsageFile(home)).map((w) => w.id)).toEqual(['7d']);

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

const TOKEN = 'sk-ant-oat01-FAKE-usage-test-token-0123456789';
const options = (home: string, extra: Partial<UsageSource['opts']> = {}): UsageSource['opts'] => ({
  home,
  codexHome: path.join(home, '.codex'),
  claudeConfigDir: path.join(home, '.claude'),
  ...extra,
});
const writeCreds = (home: string, expiresAt: number, accessToken = TOKEN) => {
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude', '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken, refreshToken: 'r', expiresAt } }),
  );
};
const writeStatusLine = (home: string, fiveHour: number) => {
  fs.mkdirSync(path.dirname(claudeUsageFile(home)), { recursive: true });
  fs.writeFileSync(
    claudeUsageFile(home),
    JSON.stringify({ five_hour: { used_percentage: fiveHour, resets_at: nowSec() + HOUR } }),
  );
};
/** Everything the daemon printed during the test, as one string. */
const printed = () => {
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation(() => undefined),
  );
  return () => JSON.stringify(spies.map((spy) => spy.mock.calls));
};

let servers: http.Server[] = [];
afterEach(() => {
  for (const server of servers) server.close();
  servers = [];
});
type Answer = { status: number; body: unknown };
/** A stand-in for the usage endpoint on loopback, recording each request's headers. */
async function fakeEndpoint(answer: (n: number) => Answer | Promise<Answer>) {
  const seen: http.IncomingHttpHeaders[] = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers);
    void Promise.resolve(answer(seen.length)).then(({ status, body }) =>
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body)),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}/api/oauth/usage`, seen };
}

describe('UsageSource', () => {
  const listen = (home: string, extra: Partial<UsageSource['opts']> = {}) => {
    const changes: Array<Omit<UsageState, 'type'>> = [];
    const source = new UsageSource(options(home, extra), (u) => changes.push(u));
    return { source, changes };
  };
  const view = async (source: UsageSource, changes: unknown[], n: number) => {
    source.setViewing(false);
    source.setViewing(true);
    await vi.waitFor(() => expect(changes).toHaveLength(n));
  };
  const week = new Date(Math.round(Date.now() / 1000) * 1000 + 5 * 86_400_000).toISOString();
  const ultra = {
    five_hour: null,
    seven_day: { utilization: 16, resets_at: week },
    seven_day_sonnet: null,
    limits: [
      { kind: 'weekly_all', group: 'weekly', percent: 16, resets_at: week, scope: null },
      {
        kind: 'weekly_scoped',
        group: 'weekly',
        percent: 18,
        resets_at: week,
        scope: { model: { id: null, display_name: 'Fable' }, surface: null },
      },
    ],
  };

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

  it("maps the endpoint's answer (Ultra: 7d and Fable, no 5h), only while viewed, once per interval, never leaking the token", async () => {
    const home = tempHome();
    writeCreds(home, Date.now() + HOUR * 1000);
    writeStatusLine(home, 9); // the endpoint wins over it
    const output = printed();
    const api = await fakeEndpoint(() => ({ status: 200, body: ultra }));
    const { source, changes } = listen(home, { usageUrl: api.url });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(api.seen).toHaveLength(0); // nobody viewing: no request
    source.setViewing(true);
    await vi.waitFor(() => expect(changes).toHaveLength(1));
    const claude = providerOf(changes[0], 'claude');
    expect(claude?.windows).toEqual([{ id: '7d', pct: 16, resetAt: week }]);
    expect(claude?.models).toEqual([{ family: 'fable', pct: 18, reset: week }]);
    expect(api.seen[0].authorization).toBe(`Bearer ${TOKEN}`);
    expect(api.seen[0]['anthropic-beta']).toBe(CLAUDE_USAGE_BETA);
    // A reconnect inside the interval reuses the reading instead of asking again.
    await view(source, changes, 2);
    expect(api.seen).toHaveLength(1);
    expect(providerOf(changes[1], 'claude')?.models).toEqual(claude?.models);
    source.stop();
    expect(JSON.stringify(changes)).not.toContain(TOKEN);
    expect(output()).not.toContain(TOKEN);
  });

  it('an expired token makes no request; a 401 falls back to the status-line file with one warning and no token', async () => {
    const home = tempHome();
    writeStatusLine(home, 9);
    writeCreds(home, Date.now() - 1000);
    const output = printed();
    const api = await fakeEndpoint(() => ({ status: 401, body: { error: 'nope' } }));
    const expired = listen(home, { usageUrl: api.url });
    expired.source.setViewing(true);
    await vi.waitFor(() => expect(expired.changes).toHaveLength(1));
    expired.source.stop();
    expect(api.seen).toHaveLength(0);
    expect(windowOf(providerOf(expired.changes[0], 'claude')?.windows, '5h')?.pct).toBe(9);

    writeCreds(home, Date.now() + HOUR * 1000);
    const refused = listen(home, { usageUrl: api.url });
    refused.source.setViewing(true);
    await vi.waitFor(() => expect(refused.changes).toHaveLength(1));
    refused.source.stop();
    expect(api.seen).toHaveLength(1);
    expect(windowOf(providerOf(refused.changes[0], 'claude')?.windows, '5h')?.pct).toBe(9);
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(output()).toContain('HTTP 401');
    expect(output()).not.toContain(TOKEN);
  });

  it('a 403 (the TLS fingerprint some Node builds get) is asked once more through curl', async () => {
    const home = tempHome();
    writeCreds(home, Date.now() + HOUR * 1000);
    const api = await fakeEndpoint((n) =>
      n === 1
        ? { status: 403, body: {} }
        : {
            status: 200,
            body: {
              five_hour: { utilization: 42, resets_at: week },
              seven_day: { utilization: 16 },
            },
          },
    );
    const { source, changes } = listen(home, { usageUrl: api.url });
    source.setViewing(true);
    await vi.waitFor(() => expect(changes).toHaveLength(1));
    source.stop();
    expect(api.seen).toHaveLength(2);
    expect(api.seen[1].authorization).toBe(`Bearer ${TOKEN}`);
    expect(api.seen[1]['anthropic-beta']).toBe(CLAUDE_USAGE_BETA);
    expect(providerOf(changes[0], 'claude')?.windows).toEqual([
      { id: '5h', pct: 42, resetAt: week },
      { id: '7d', pct: 16, resetAt: null },
    ]);
  });

  it('macOS: the Keychain item comes first; a failed read falls back to the file and is not tried again', async () => {
    const home = tempHome();
    const api = await fakeEndpoint(() => ({ status: 200, body: ultra }));
    const item = JSON.stringify({
      claudeAiOauth: { accessToken: 'keychain-token', expiresAt: Date.now() + HOUR * 1000 },
    });
    const fromKeychain = listen(home, { usageUrl: api.url, keychain: async () => item });
    fromKeychain.source.setViewing(true);
    await vi.waitFor(() => expect(fromKeychain.changes).toHaveLength(1));
    fromKeychain.source.stop();
    expect(api.seen[0].authorization).toBe('Bearer keychain-token');

    let reads = 0;
    const broken: ReadKeychain = async () => {
      reads++;
      return null;
    };
    const { source, changes } = listen(home, { usageUrl: api.url, keychain: broken });
    source.setViewing(true);
    await vi.waitFor(() => expect(changes).toHaveLength(1));
    expect(api.seen).toHaveLength(1); // no Keychain item, no file: no request
    writeCreds(home, Date.now() + HOUR * 1000);
    await view(source, changes, 2);
    source.stop();
    expect(reads).toBe(1);
    expect(api.seen).toHaveLength(2);
    expect(api.seen[1].authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('refreshNow waits for an in-flight refresh, then reads once more (the endpoint still once)', async () => {
    const home = tempHome();
    writeCreds(home, Date.now() + HOUR * 1000);
    let release = () => undefined as void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const api = await fakeEndpoint(async () => {
      await held;
      return { status: 200, body: ultra };
    });
    const { source, changes } = listen(home, { usageUrl: api.url });
    source.setViewing(true);
    await vi.waitFor(() => expect(api.seen).toHaveLength(1));
    const checked = source.refreshNow();
    release();
    await checked;
    source.stop();
    expect(changes).toHaveLength(2);
    expect(api.seen).toHaveLength(1);
    expect(windowOf(providerOf(changes[1], 'claude')?.windows, '7d')?.pct).toBe(16);
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

it('claudeUsageUrl: a test daemon may point it at 127.0.0.1 only', () => {
  expect(claudeUsageUrl({})).toBe('https://api.anthropic.com/api/oauth/usage');
  const local = 'http://127.0.0.1:9/api/oauth/usage';
  expect(claudeUsageUrl({ CLD_GUI_TEST_CLAUDE_USAGE_URL: local })).toBe(local);
  for (const other of ['https://example.com/u', 'http://10.0.0.1/u', 'nonsense'])
    expect(claudeUsageUrl({ CLD_GUI_TEST_CLAUDE_USAGE_URL: other })).not.toBe(other);
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
