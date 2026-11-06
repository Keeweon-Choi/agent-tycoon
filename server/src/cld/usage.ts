import * as fs from 'fs';
import * as path from 'path';

import type {
  UsageLimitWindow,
  UsageProvider as UsageProviderState,
  UsageState,
} from '../../../core/src/messages.js';
import {
  CLAUDE_USAGE_REPORT_MAX_BYTES,
  CLAUDE_USAGE_STALE_MS,
  USAGE_EARLY_RESET_MIN_FUTURE_MS,
  USAGE_EARLY_RESET_MIN_NEXT_SHIFT_MS,
  USAGE_PROBE_MIN_GAP_MS,
  USAGE_PROBE_STDIN_HOLD_MS,
  USAGE_PROBE_TIMEOUT_MS,
  USAGE_REFRESH_MS,
} from '../constants.js';
import { configDirectory } from './configPath.js';
import { rateLimitsIn } from './engine/codex.js';
import { type SpawnFn, spawnJson, SpawnJsonError } from './spawnJson.js';
import { readText } from './tracking/tracker.js';
import { usageProbeDir } from './usageProbeFolder.js';

const str = (x: unknown): string | null => (typeof x === 'string' ? x : null);
const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const obj = (x: unknown): Record<string, unknown> | null =>
  typeof x === 'object' && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>) : null;

const providerNames: Record<string, string> = { claude: 'Claude', codex: 'Codex' };
const providerName = (id: string): string => providerNames[id] ?? id;

const provider = (id: string, name: string, windows: UsageLimitWindow[]): UsageProviderState => ({
  id,
  name,
  windows,
});

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
  // The sources document 0-100; anything else is junk, not a full window (>= 100 holds delegation back).
  if (p === null || p < 0 || p > 100) return null;
  if (at !== null && at * 1000 <= now) return { id, pct: null, resetAt: null, isReset: true };
  // A junk resets_at past Date's range (~8.64e12 s) would make toISOString throw: no reset time instead.
  const reset = at === null ? null : new Date(Math.round(at * 1000));
  return {
    id,
    pct: p,
    resetAt: reset && !Number.isNaN(reset.getTime()) ? reset.toISOString() : null,
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

/** Where cld/bin/cld-gui-statusline.js keeps the last `rate_limits` Claude Code handed it. */
export const claudeUsageFile = (home: string): string =>
  path.join(configDirectory(home), 'usage-claude.json');

/**
 * Claude's usage as Claude Code last reported it to the status line of a session we started
 * (https://code.claude.com/docs/en/statusline: `rate_limits.five_hour` / `seven_day`, each
 * `used_percentage` 0-100 and `resets_at` in epoch seconds; Pro, Max and Ultra only, after a
 * session's first response, only the windows the plan has), with `at` (the status line's `ts`),
 * when it came. A passed reset stays a reset marker until a fresh report; no file is no windows
 * (unknown). Never Claude Code's credentials (ADR-0016 decision 7).
 */
export function claudeOwnUsage(file: string, now = Date.now()): UsageProviderState {
  let raw: Record<string, unknown> | null = null;
  // A regular file only, never through a link, a FIFO or a device (they could hang the daemon), and small.
  const text = readText(file, true, CLAUDE_USAGE_REPORT_MAX_BYTES);
  try {
    if (typeof text === 'string') raw = obj(JSON.parse(text));
  } catch {
    // a broken file: unknown
  }
  const window = (id: string, key: string) => {
    const w = obj(raw?.[key]);
    return w ? slot(id, w.used_percentage, w.resets_at, now) : null;
  };
  const windows = [window('5h', 'five_hour'), window('7d', 'seven_day')].filter(
    (w): w is UsageLimitWindow => w !== null,
  );
  const at = Date.parse(str(raw?.ts) ?? '');
  return {
    ...provider('claude', providerName('claude'), windows),
    // A report time ahead of the clock is junk too: no age shown rather than "fresh" forever.
    ...(windows.length > 0 &&
      Number.isFinite(at) &&
      at <= now && { at: new Date(at).toISOString() }),
  };
}

type UsageModel = NonNullable<UsageProviderState['models']>[number];

/** Claude Code's own `/usage` report, as the probe last got it (raw: windows become slots when shown). */
export interface ClaudeUsageReport {
  /** When the probe got it (epoch ms). */
  at: number;
  windows: Array<{ id: string; pct: number; resetsAtSec: number | null }>;
  models: UsageModel[];
}

/** `/usage`'s report kinds that are a window we already show (the per-model weeks go to `models`). */
const REPORT_WINDOWS: Record<string, string> = { session: '5h', weekly_all: '7d' };

/**
 * The `usage_report` Claude Code attaches to the assistant message that answers `/usage` in
 * stream-json (https://code.claude.com/docs/en/agent-sdk/typescript, SDKUsageReport:
 * `rate_limits.limits[]` of `{kind, group, percent, resets_at (ISO), scope.model.display_name,
 * severity, is_active}`). `weekly_scoped` with a model is that model's week (e.g. Fable),
 * `weekly_all` the week, `session` the five hours; other kinds, a percent outside 0-100 or an
 * unreadable time are skipped. null when no line carries a report with a limits list (an API-key
 * login, an older CLI, or `limits: null` when the CLI's own fetch had not come back in time, about
 * one probe in two on 11-06): no reading, so the figures from the last good probe stay.
 */
export function claudeUsageReport(lines: unknown, now = Date.now()): ClaudeUsageReport | null {
  for (const line of Array.isArray(lines) ? lines : []) {
    const m = obj(line);
    const report = m?.type === 'assistant' ? obj(m.usage_report) : null;
    if (!report) continue;
    const limits = obj(report.rate_limits)?.limits;
    if (!Array.isArray(limits)) continue;
    const windows: ClaudeUsageReport['windows'] = [];
    const models: UsageModel[] = [];
    for (const raw of limits) {
      const limit = obj(raw);
      const pct = num(limit?.percent);
      if (!limit || pct === null || pct < 0 || pct > 100) continue;
      const resetMs = Date.parse(str(limit.resets_at) ?? '');
      const reset = Number.isFinite(resetMs) ? new Date(resetMs).toISOString() : null;
      const kind = str(limit.kind) ?? '';
      // Own keys only: a kind named "constructor" must not find Object.prototype's.
      const window = Object.hasOwn(REPORT_WINDOWS, kind) ? REPORT_WINDOWS[kind] : undefined;
      const model = str(obj(obj(limit.scope)?.model)?.display_name)
        ?.trim()
        .toLowerCase();
      if (window && !windows.some((w) => w.id === window))
        windows.push({ id: window, pct, resetsAtSec: reset ? resetMs / 1000 : null });
      else if (kind === 'weekly_scoped' && model && !models.some((x) => x.family === model))
        models.push({ family: model, pct, reset });
    }
    return { at: now, windows: windows.sort((a, b) => a.id.localeCompare(b.id)), models };
  }
  return null;
}

/** The arguments of the `/usage` probe: no model call, no transcript, no hooks, plugins or MCP. */
export const USAGE_PROBE_ARGS = [
  '-p',
  '/usage',
  '--output-format',
  'stream-json',
  '--verbose',
  '--no-session-persistence',
  '--safe-mode',
];

/** Run the user's own `claude` once for `/usage` in our empty probe folder; its stream-json lines. */
export function claudeUsageProbe(
  claude: string,
  env: NodeJS.ProcessEnv,
  home: string,
  spawnFn?: SpawnFn,
): Promise<unknown> {
  const cwd = usageProbeDir(home);
  fs.mkdirSync(cwd, { recursive: true });
  return spawnJson(claude, USAGE_PROBE_ARGS, {
    env,
    cwd,
    timeoutMs: USAGE_PROBE_TIMEOUT_MS,
    ndjson: true,
    // A closed stdin makes the CLI report limits: null (it answers before its background limits fetch
    // arrives). A CLI with the 3 s stdin grace proceeds by itself, one that reads stdin to EOF proceeds
    // when we end it: either way the fetch has had time.
    holdStdinMs: USAGE_PROBE_STDIN_HOLD_MS,
    spawnFn,
  });
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
 * Usage for the office's bar, viewer-gated: Claude from the status line's reports (re-read the
 * moment the status line rewrites its file, and on each refresh), Codex from its own session logs.
 * A provider nobody reports has no windows: shown as unknown, never guessed.
 */
export class UsageSource {
  usage: Usage | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private watcher: fs.FSWatcher | null = null;
  private viewing = false;
  private previous: Usage | null = null;
  private codex: UsageProviderState = provider('codex', providerName('codex'), []);
  private report: ClaudeUsageReport | null = null;
  private probing = false;
  private probedAt = Number.NEGATIVE_INFINITY;
  private probeWarned = false;

  constructor(
    readonly opts: {
      home: string;
      codexHome: string;
      /** Claude Code's `/usage` (claudeUsageProbe); none without an engine `claude`. */
      probe?: (() => Promise<unknown>) | null;
    },
    private readonly onChange: (usage: Usage) => void,
    private readonly onEarlyReset: (reset: EarlyUsageReset) => void = () => undefined,
  ) {}

  setViewing(on: boolean): void {
    if (on === this.viewing) return;
    this.viewing = on;
    if (on) {
      this.read();
      this.timer = setInterval(() => this.read(), USAGE_REFRESH_MS);
      this.watch();
      return;
    }
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.watcher?.close();
    this.watcher = null;
  }

  stop(): void {
    this.setViewing(false);
  }

  /** An explicit user action (the usage refresh): reads again and asks `/usage` past its gap. */
  async refreshNow(): Promise<void> {
    this.read(true);
  }

  /** Both sources now. Runs from a timer and a watch callback: nothing in it may take the daemon down. */
  private read(probeNow = false): void {
    try {
      const now = Date.now();
      this.codex = provider(
        'codex',
        providerName('codex'),
        codexOwnUsage(this.opts.codexHome, now),
      );
      this.publish(this.claude(now), now);
      this.probe(now, probeNow);
    } catch (err) {
      this.warnOnce(err);
    }
  }

  /**
   * Claude: the status line's windows or the `/usage` report's, whichever came later, and the
   * report's per-model weeks (the status line has none). A model week whose reset passed is dropped.
   */
  private claude(now: number): UsageProviderState {
    const line = claudeOwnUsage(claudeUsageFile(this.opts.home), now);
    const report = this.report;
    if (!report) return line;
    const lineAt = line.at ? Date.parse(line.at) : Number.NEGATIVE_INFINITY;
    // Window by window, the newer source: a report with only the week keeps the status line's five hours.
    const fromReport = report.windows
      .map((w) => slot(w.id, w.pct, w.resetsAtSec, now))
      .filter((w): w is UsageLimitWindow => w !== null);
    const [newer, older] =
      report.at > lineAt ? [fromReport, line.windows] : [line.windows, fromReport];
    const windows = [...newer, ...older.filter((o) => !newer.some((n) => n.id === o.id))].sort(
      (a, b) => a.id.localeCompare(b.id),
    );
    // A report this old is no longer a reading (the probe has failed for hours); a model week without a reset would stay forever.
    const models =
      now - report.at >= CLAUDE_USAGE_STALE_MS
        ? []
        : report.models.filter((m) => !m.reset || Date.parse(m.reset) > now);
    const at =
      report.at > lineAt && fromReport.length > 0 ? new Date(report.at).toISOString() : line.at;
    return {
      ...provider('claude', providerName('claude'), windows),
      ...(models.length > 0 && { models }),
      ...(at && { at }),
    };
  }

  /** `/usage` at most every USAGE_PROBE_MIN_GAP_MS while viewed (or on a click), one at a time. */
  private probe(now: number, force: boolean): void {
    const run = this.opts.probe;
    if (!run || this.probing || (!force && now - this.probedAt < USAGE_PROBE_MIN_GAP_MS)) return;
    this.probing = true;
    this.probedAt = now;
    let running: Promise<unknown>;
    try {
      running = run(); // a probe that throws before it returns a promise must not leave `probing` set
    } catch (err) {
      running = Promise.reject(err);
    }
    void running
      .then((lines) => {
        const report = claudeUsageReport(lines, Date.now());
        if (report) this.report = report;
        else this.warnProbe('no usage_report in its answer');
      })
      .catch((err: unknown) =>
        this.warnProbe(err instanceof SpawnJsonError && err.timedOut ? 'timed out' : 'failed'),
      )
      .finally(() => {
        this.probing = false;
        if (this.viewing) this.claudeReported();
      });
  }

  /** A fixed text only: the CLI's output can name paths and the account. */
  private warnProbe(kind: string): void {
    if (this.probeWarned) return;
    this.probeWarned = true;
    console.warn(`[Agent Tycoon] Claude /usage: ${kind}; the status line's figures stay`);
  }

  /** The status line rewrote its file (or `/usage` answered): Claude alone, sent only when it changed. */
  private claudeReported(): void {
    try {
      const now = Date.now();
      const claude = this.claude(now);
      const before = this.usage?.providers.find((p) => p.id === 'claude');
      if (JSON.stringify(before) !== JSON.stringify(claude)) this.publish(claude, now);
    } catch (err) {
      this.warnOnce(err);
    }
  }

  private warned = false;
  /** Only the error's name: a message could quote a path or the report. */
  private warnOnce(err: unknown): void {
    if (this.warned) return;
    this.warned = true;
    console.warn(
      `[Agent Tycoon] usage: a reading failed (${err instanceof Error ? err.name : 'error'}); keeping the last one`,
    );
  }

  private publish(claude: UsageProviderState, now: number): void {
    // ponytail: Claude and Codex by name; an agent added later (ACP) brings its own reading.
    const usage = { ts: new Date(now).toISOString(), providers: [claude, this.codex] };
    for (const reset of earlyResets(this.previous, usage, now)) this.onEarlyReset(reset);
    this.previous = usage;
    this.usage = usage;
    this.onChange(usage);
  }

  /**
   * The status line's folder, so a report shows as it lands (it writes a temp file and renames it).
   * fs.watch can miss on some platforms (lessons: Windows); the refresh timer re-reads it anyway.
   */
  private watch(): void {
    const file = claudeUsageFile(this.opts.home);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const watcher = fs.watch(path.dirname(file), (_event, name) => {
        if (name === path.basename(file) && this.viewing) this.claudeReported();
      });
      watcher.on('error', () => {
        watcher.close();
        if (this.watcher === watcher) this.watcher = null;
      });
      this.watcher = watcher;
    } catch {
      // no watch: the refresh timer still reads the file
    }
  }
}
