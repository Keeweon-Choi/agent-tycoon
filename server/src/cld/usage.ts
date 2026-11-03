import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import type {
  UsageLimitWindow,
  UsageProvider as UsageProviderState,
  UsageState,
} from '../../../core/src/messages.js';
import {
  CLAUDE_KEYCHAIN_SERVICE,
  CLAUDE_KEYCHAIN_TIMEOUT_MS,
  CLAUDE_USAGE_API_FILE,
  CLAUDE_USAGE_BACKOFF_MAX_MS,
  CLAUDE_USAGE_BETA,
  CLAUDE_USAGE_MIN_GAP_MS,
  CLAUDE_USAGE_STALE_MS,
  CLAUDE_USAGE_TIMEOUT_MS,
  CLAUDE_USAGE_URL,
  CLAUDE_USAGE_USER_AGENT,
  USAGE_EARLY_RESET_MIN_FUTURE_MS,
  USAGE_EARLY_RESET_MIN_NEXT_SHIFT_MS,
  USAGE_REFRESH_MS,
} from '../constants.js';
import { configDirectory } from './configPath.js';
import { rateLimitsIn } from './engine/codex.js';

const str = (x: unknown): string | null => (typeof x === 'string' ? x : null);
const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const obj = (x: unknown): Record<string, unknown> | null =>
  typeof x === 'object' && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>) : null;

const providerNames: Record<string, string> = { claude: 'Claude', codex: 'Codex' };
const providerName = (id: string): string => providerNames[id] ?? id;

function provider(
  id: string,
  name: string,
  windows: UsageLimitWindow[],
  models?: UsageProviderState['models'],
): UsageProviderState {
  return { id, name, windows, ...(models?.length ? { models } : {}) };
}

type Usage = Omit<UsageState, 'type'>;
export type UsageProvider = string;
export type UsagePeriod = '5h' | '7d';
export interface EarlyUsageReset {
  provider: UsageProvider;
  name: string;
  period: UsagePeriod;
}

/** One source-reported window: retain an elapsed reset as a marker, never as invented zero use. */
function slot(
  id: string,
  pct: unknown,
  resetsAtSec: unknown,
  now: number,
): UsageLimitWindow | null {
  const p = num(pct);
  const at = num(resetsAtSec);
  if (p === null) return null;
  if (at !== null && at * 1000 <= now) return { id, pct: null, resetAt: null, isReset: true };
  return {
    id,
    pct: p,
    resetAt: at === null ? null : new Date(Math.round(at * 1000)).toISOString(),
  };
}

export function earlyResets(previous: Usage | null, next: Usage, now: number): EarlyUsageReset[] {
  if (!previous) return [];
  const out: EarlyUsageReset[] = [];
  for (const after of next.providers) {
    const before = previous.providers.find((provider) => provider.id === after.id);
    if (!before) continue;
    for (const [period, minShift] of [
      ['5h', USAGE_EARLY_RESET_MIN_NEXT_SHIFT_MS.fiveHour],
      ['7d', USAGE_EARLY_RESET_MIN_NEXT_SHIFT_MS.sevenDay],
    ] as const) {
      const beforeWindow = before.windows.find((window) => window.id === period);
      const afterWindow = after.windows.find((window) => window.id === period);
      if (!beforeWindow || !afterWindow) continue;
      const beforeAt = beforeWindow.resetAt ? Date.parse(beforeWindow.resetAt) : Number.NaN;
      const afterAt = afterWindow.resetAt ? Date.parse(afterWindow.resetAt) : Number.NaN;
      if (
        typeof beforeWindow.pct === 'number' &&
        typeof afterWindow.pct === 'number' &&
        afterWindow.pct < beforeWindow.pct &&
        Number.isFinite(beforeAt) &&
        Number.isFinite(afterAt) &&
        beforeAt >= now + USAGE_EARLY_RESET_MIN_FUTURE_MS &&
        afterAt - beforeAt > minShift
      )
        out.push({ provider: after.id, name: after.name, period });
    }
  }
  return out;
}

type UsageModel = NonNullable<UsageProviderState['models']>[number];

/**
 * Claude's account usage as the endpoint answers it: `five_hour` / `seven_day`
 * (`utilization`, `resets_at` ISO) and the per-model weekly windows, from
 * `limits[]` (`kind: 'weekly_scoped'`, `percent`, `scope.model.display_name`,
 * e.g. Fable) or a flat `seven_day_<family>`. Only what it
 * reported (Ultra has no five_hour); null when it reported nothing we know.
 */
export function claudeApiUsage(data: unknown, now = Date.now()): UsageProviderState | null {
  const d = obj(data);
  if (!d) return null;
  const window = (id: string, key: string) => {
    const w = obj(d[key]);
    const at = Date.parse(str(w?.resets_at) ?? '');
    return w ? slot(id, w.utilization, Number.isFinite(at) ? at / 1000 : null, now) : null;
  };
  const windows = [window('5h', 'five_hour'), window('7d', 'seven_day')].filter(
    (w): w is UsageLimitWindow => w !== null,
  );
  const models: UsageModel[] = [];
  const model = (family: string, pct: unknown, reset: unknown) => {
    const p = num(pct);
    const r = str(reset);
    const at = Date.parse(r ?? '');
    if (p === null || models.some((m) => m.family === family)) return;
    if (Number.isFinite(at) && at <= now) return; // an elapsed week: no stale percent
    models.push({ family, pct: p, reset: Number.isFinite(at) ? r : null });
  };
  for (const raw of Array.isArray(d.limits) ? d.limits : []) {
    const limit = obj(raw);
    const name = str(obj(obj(limit?.scope)?.model)?.display_name);
    if (limit?.kind === 'weekly_scoped' && name)
      model(name.toLowerCase(), limit.percent, limit.resets_at);
  }
  // ponytail: any flat seven_day_<word> with a number is read as a model's week; a non-model one would show too.
  for (const [key, value] of Object.entries(d)) {
    const family = /^seven_day_([a-z]+)$/.exec(key)?.[1];
    const w = obj(value);
    if (family && w) model(family, w.utilization, w.resets_at);
  }
  return windows.length || models.length
    ? provider('claude', providerName('claude'), windows, models)
    : null;
}

/** Claude Code's credentials JSON (file or Keychain item) -> its OAuth access token, unless expired. */
export function oauthToken(text: string | null, now = Date.now()): string | null {
  if (!text) return null;
  try {
    const oauth = obj(obj(JSON.parse(text))?.claudeAiOauth);
    const token = str(oauth?.accessToken);
    const expires = num(oauth?.expiresAt);
    return token && (expires === null || expires > now) ? token : null;
  } catch {
    return null; // never rethrown: a parse error can quote the text
  }
}

/** The Keychain item's JSON, or null. */
export type ReadKeychain = () => Promise<string | null>;

/** macOS: Claude Code's Keychain item; a missing item, a denial or a dialog left open gives null. */
export const readMacKeychain: ReadKeychain = () =>
  new Promise((resolve) => {
    execFile(
      'security',
      ['find-generic-password', '-s', CLAUDE_KEYCHAIN_SERVICE, '-w'],
      { timeout: CLAUDE_KEYCHAIN_TIMEOUT_MS },
      (error, stdout) => resolve(error ? null : String(stdout).trim() || null),
    );
  });

/** The usage endpoint, or a loopback stand-in a test daemon names (never a remote one). */
export function claudeUsageUrl(env: NodeJS.ProcessEnv = process.env): string {
  const test = env.CLD_GUI_TEST_CLAUDE_USAGE_URL;
  try {
    if (test && new URL(test).protocol === 'http:' && new URL(test).hostname === '127.0.0.1')
      return test;
  } catch {
    // not a URL: the real endpoint
  }
  return CLAUDE_USAGE_URL;
}

interface Reply {
  status: number;
  body: unknown;
  /** The raw Retry-After header, when the server sent one. */
  retryAfter?: string | null;
}

/** Retry-After as milliseconds from `now`: delta-seconds or an HTTP date; null when absent or unreadable. */
export function retryAfterMs(header: string | null | undefined, now: number): number | null {
  const text = header?.trim();
  if (!text) return null;
  const ms = /^\d+$/.test(text) ? Number(text) * 1000 : Date.parse(text) - now;
  return Number.isFinite(ms) ? Math.max(0, ms) : null;
}

/** curl with everything (the token too) on stdin, so nothing shows in the process list. */
function curlUsage(url: string, token: string): Promise<Reply | null> {
  // The token goes inside a quoted config line: anything but token characters could add options.
  if (!/^[\w.~+/=-]+$/.test(token)) return Promise.resolve(null);
  const config = [
    `url = "${url}"`,
    `header = "Authorization: Bearer ${token}"`,
    `header = "anthropic-beta: ${CLAUDE_USAGE_BETA}"`,
    'header = "Accept: application/json"',
    `user-agent = "${CLAUDE_USAGE_USER_AGENT}"`,
    'silent',
    'write-out = "\\n%{http_code}"',
    '',
  ].join('\n');
  return new Promise((resolve) => {
    const child = execFile(
      'curl',
      ['-K', '-'],
      { timeout: CLAUDE_USAGE_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) return resolve(null);
        const cut = stdout.lastIndexOf('\n');
        const status = Number(stdout.slice(cut + 1));
        let body: unknown = null;
        try {
          body = JSON.parse(stdout.slice(0, cut));
        } catch {
          // a non-JSON body: no figures
        }
        resolve(Number.isInteger(status) ? { status, body } : null);
      },
    );
    child.on('error', () => resolve(null));
    child.stdin?.on('error', () => undefined); // curl missing: EPIPE
    child.stdin?.end(config);
  });
}

async function requestUsage(url: string, token: string): Promise<Reply> {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      'anthropic-beta': CLAUDE_USAGE_BETA,
      'User-Agent': CLAUDE_USAGE_USER_AGENT,
    },
    signal: AbortSignal.timeout(CLAUDE_USAGE_TIMEOUT_MS),
  });
  const body: unknown = await response.json().catch(() => null);
  // Some Linux Node builds get 403 for their TLS fingerprint where curl gets through (claude-dashboard's finding).
  if (response.status === 403) return (await curlUsage(url, token)) ?? { status: 403, body: null };
  return { status: response.status, body, retryAfter: response.headers.get('retry-after') };
}

/** Where cld/bin/cld-gui-statusline.js keeps Claude Code's own rate_limits. */
export const claudeUsageFile = (home: string): string =>
  path.join(configDirectory(home), 'usage-claude.json');

const claudeApiFile = (home: string): string =>
  path.join(configDirectory(home), CLAUDE_USAGE_API_FILE);

/**
 * Claude Code's own 5-hour and 7-day windows, as the status line of an engine
 * session last saw them (`used_percentage`, `resets_at` in epoch seconds), only
 * the windows it reported (an Ultra plan has no 5-hour one); empty when there is
 * no such file or nothing in it was source-reported. A passed
 * source reset remains visible as a reset marker until a fresh reading arrives.
 */
export function claudeOwnUsage(file: string, now = Date.now()): UsageLimitWindow[] {
  let raw: Record<string, { used_percentage?: unknown; resets_at?: unknown } | undefined>;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return [];
  }
  if (!raw || typeof raw !== 'object') return [];
  return [
    slot('5h', raw.five_hour?.used_percentage, raw.five_hour?.resets_at, now),
    slot('7d', raw.seven_day?.used_percentage, raw.seven_day?.resets_at, now),
  ].filter((window): window is UsageLimitWindow => window !== null);
}

/** Up to `n` newest `.jsonl` files under `dir` (Codex's sessions/YYYY/MM/DD/rollout-<time>-…). */
function newestLogs(dir: string, n: number): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => b.name.localeCompare(a.name))) {
      if (out.length >= n) return;
      if (e.isDirectory()) walk(path.join(d, e.name));
      else if (e.name.endsWith('.jsonl')) out.push(path.join(d, e.name));
    }
  };
  walk(dir);
  return out;
}

const TAIL_BYTES = 256 * 1024;
const DAY_MINUTES = 24 * 60;

const windowId = (minutes: number): string =>
  minutes % DAY_MINUTES === 0
    ? `${minutes / DAY_MINUTES}d`
    : minutes % 60 === 0
      ? `${minutes / 60}h`
      : `${minutes}m`;

/**
 * Codex's own windows from its newest session logs (`rate_limits` with
 * `primary`/`secondary`: `used_percent`, `window_minutes`, `resets_at` in epoch
 * seconds), the same records the engine's limit wait reads; empty when none.
 */
export function codexOwnUsage(codexHome: string, now = Date.now()): UsageLimitWindow[] {
  for (const file of newestLogs(path.join(codexHome, 'sessions'), 5)) {
    let text: string;
    try {
      const fd = fs.openSync(file, 'r');
      try {
        const size = fs.fstatSync(fd).size;
        const buf = Buffer.alloc(Math.min(size, TAIL_BYTES));
        fs.readSync(fd, buf, 0, buf.length, size - buf.length);
        text = buf.toString('utf-8');
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      continue;
    }
    const lines = text.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"rate_limits"')) continue;
      let rl: Record<string, unknown> | null = null;
      try {
        rl = rateLimitsIn(JSON.parse(lines[i]));
      } catch {
        continue; // the cut first line, or a broken one
      }
      if (!rl) continue;
      if (typeof rl.limit_id === 'string' && rl.limit_id !== 'codex') continue;
      const windows: UsageLimitWindow[] = [];
      for (const [key, fallback] of [
        ['primary', '5h'],
        ['secondary', '7d'],
      ] as const) {
        const x = rl[key] as Record<string, unknown> | undefined;
        if (!x || typeof x !== 'object') continue;
        const minutes = num(x.window_minutes);
        // Its length names it (300 min is 5h, 10080 is 7d), so a window a new plan adds shows by itself.
        const which = minutes === null ? fallback : minutes > 0 ? windowId(minutes) : null;
        if (!which) continue;
        const window = slot(which, x.used_percent, x.resets_at, now);
        if (window) windows.push(window);
      }
      return windows;
    }
  }
  return [];
}

/**
 * Usage for the office's bar, viewer-gated: Claude from its account usage
 * endpoint with Claude Code's own OAuth token (at most once per refresh
 * interval), else from its status-line data (engine sessions); Codex from its
 * own session logs. A provider nobody reports has no windows: shown as unknown, never guessed.
 */
export class UsageSource {
  usage: Usage | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private viewing = false;
  private refreshing: Promise<void> | null = null;
  private previous: Usage | null = null;
  /** No endpoint request before this (epoch ms): the refresh interval, or longer while backing off. */
  private nextRequestAt = 0;
  /** Failures in a row that call for backing off (429, 5xx, network); a success resets it. */
  private failures = 0;
  /** The last usable endpoint reading; shown while backing off until CLAUDE_USAGE_STALE_MS. */
  private good: { at: number; claude: UsageProviderState } | null = null;
  private keychainOff = false;
  private readonly warned = new Set<string>();

  constructor(
    readonly opts: {
      home: string;
      codexHome: string;
      /** $CLAUDE_CONFIG_DIR or ~/.claude: where Claude Code keeps `.credentials.json`. */
      claudeConfigDir: string;
      /** macOS: Claude Code's Keychain item, tried before the file; null elsewhere. */
      keychain?: ReadKeychain | null;
      usageUrl?: string;
    },
    private readonly onChange: (usage: Usage) => void,
    private readonly onEarlyReset: (reset: EarlyUsageReset) => void = () => undefined,
  ) {
    // A restart keeps the last endpoint reading (the per-model windows the status line never has);
    // a fresh one also holds off the first request, which would draw a 429 right after a deploy.
    try {
      const saved = JSON.parse(fs.readFileSync(claudeApiFile(opts.home), 'utf-8')) as {
        at?: unknown;
        claude?: UsageProviderState;
      };
      if (typeof saved.at === 'number' && saved.claude?.id === 'claude') {
        this.good = { at: saved.at, claude: saved.claude };
        const age = Date.now() - saved.at;
        if (age >= 0 && age < CLAUDE_USAGE_MIN_GAP_MS)
          this.nextRequestAt = saved.at + CLAUDE_USAGE_MIN_GAP_MS;
      }
    } catch {
      // no file or an unreadable one: the first request decides
    }
  }

  setViewing(on: boolean): void {
    if (on === this.viewing) return;
    this.viewing = on;
    if (on) {
      void this.refresh();
      this.timer = setInterval(() => void this.refresh(), USAGE_REFRESH_MS);
      return;
    }
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  stop(): void {
    this.setViewing(false);
  }

  /** An explicit user action may refresh without changing the viewing cadence. */
  async refreshNow(): Promise<void> {
    if (this.refreshing) await this.refreshing;
    await this.refresh();
  }

  private refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    const reading = this.read();
    this.refreshing = reading;
    void reading.finally(() => {
      if (this.refreshing === reading) this.refreshing = null;
    });
    return reading;
  }

  private async read(): Promise<void> {
    const now = Date.now();
    const live = await this.claudeLive(now);
    const claude =
      live ??
      provider(
        'claude',
        providerName('claude'),
        claudeOwnUsage(claudeUsageFile(this.opts.home), now),
      );
    const codex = provider('codex', providerName('codex'), codexOwnUsage(this.opts.codexHome, now));
    // ponytail: Claude and Codex by name; an agent added later (ACP) brings its own reading.
    const usage = { ts: new Date(now).toISOString(), providers: [claude, codex] };
    for (const reset of earlyResets(this.previous, usage, now)) this.onEarlyReset(reset);
    this.previous = usage;
    this.usage = usage;
    this.onChange(usage);
  }

  /**
   * The token, read fresh each time and held only for this call: the Keychain
   * (macOS) first, then `.credentials.json`. Never logged, stored or sent on.
   */
  private async claudeToken(now: number): Promise<string | null> {
    if (this.opts.keychain && !this.keychainOff) {
      const item = await this.opts.keychain();
      // ponytail: one failed Keychain read (or a dialog that timed out) stops them until restart, so no dialog repeats.
      if (item === null) this.keychainOff = true;
      const token = oauthToken(item, now);
      if (token) return token;
    }
    try {
      const file = path.join(this.opts.claudeConfigDir, '.credentials.json');
      return oauthToken(await fs.promises.readFile(file, 'utf-8'), now);
    } catch {
      return null;
    }
  }

  /** Claude's reading from the usage endpoint; null (the status-line file decides) when unavailable. */
  private async claudeLive(now: number): Promise<UsageProviderState | null> {
    if (now < this.nextRequestAt) return this.shown(now);
    // An expired or missing token makes no request: Claude Code refreshes it on its next turn.
    const token = await this.claudeToken(now);
    if (!token) {
      this.nextRequestAt = 0;
      this.good = null;
      return null;
    }
    this.nextRequestAt = now + CLAUDE_USAGE_MIN_GAP_MS;
    let backOff = false;
    let wait: number | null = null;
    try {
      const reply = await requestUsage(this.opts.usageUrl ?? CLAUDE_USAGE_URL, token);
      if (reply.status < 200 || reply.status >= 300) {
        this.warnOnce(`HTTP ${reply.status}`);
        backOff = reply.status === 429 || reply.status >= 500; // 401/403: no figures, no extra wait
        wait = retryAfterMs(reply.retryAfter, now);
        if (!backOff) this.good = null;
      } else {
        const claude = claudeApiUsage(reply.body, now);
        this.good = claude && { at: now, claude };
        if (this.good) this.keep(this.good);
        this.failures = 0;
        if (!claude) this.warnOnce('an answer without any known window');
      }
    } catch (err) {
      this.warnOnce(`request failed (${err instanceof Error ? err.name : 'error'})`);
      backOff = true;
    }
    if (backOff) {
      this.failures++;
      const own = USAGE_REFRESH_MS * 2 ** this.failures;
      this.nextRequestAt =
        now + Math.min(Math.max(wait ?? own, CLAUDE_USAGE_MIN_GAP_MS), CLAUDE_USAGE_BACKOFF_MAX_MS);
    }
    return this.shown(now);
  }

  /** Only the parsed state and its time, never the token or a header; atomic like the other config files. */
  private keep(good: { at: number; claude: UsageProviderState }): void {
    const file = claudeApiFile(this.opts.home);
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(good));
      fs.renameSync(tmp, file);
    } catch {
      // ponytail: a failed save only loses the reading across a restart
    }
  }

  /** The last good reading unless it is older than CLAUDE_USAGE_STALE_MS. */
  private shown(now: number): UsageProviderState | null {
    return this.good && now - this.good.at < CLAUDE_USAGE_STALE_MS ? this.good.claude : null;
  }

  /** Never with the token: only a status, an error's name or a fixed text. */
  private warnOnce(kind: string): void {
    if (this.warned.has(kind)) return;
    this.warned.add(kind);
    console.warn(
      `[Agent Tycoon] Claude usage endpoint: ${kind}; using the last or status-line reading`,
    );
  }
}
