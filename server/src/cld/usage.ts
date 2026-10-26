import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import type { UsageState, UsageWindow } from '../../../core/src/messages.js';
import {
  USAGE_EARLY_RESET_MIN_FUTURE_MS,
  USAGE_EARLY_RESET_MIN_NEXT_SHIFT_MS,
  USAGE_REFRESH_MS,
} from '../constants.js';
import { configDirectory } from './configPath.js';
import { rateLimitsIn } from './engine/codex.js';

const VERSION = /^\d+(?:\.\d+)*$/;

function newer(a: string, b: string): boolean {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

const str = (x: unknown): string | null => (typeof x === 'string' ? x : null);
const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

function usageWindow(x: unknown): UsageWindow | null {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return null;
  const w = x as Record<string, unknown>;
  return {
    fiveHourPct: num(w.fiveHourPercent),
    sevenDayPct: num(w.sevenDayPercent),
    fiveHourReset: str(w.fiveHourReset),
    sevenDayReset: str(w.sevenDayReset),
  };
}

/** claude-dashboard's raw `--json` -> the known fields only. */
export function parseUsage(raw: unknown, ts: string): Omit<UsageState, 'type'> {
  const u = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  return { ts, claude: usageWindow(u.claude), codex: usageWindow(u.codex) };
}

/** The newest installed Claude Dashboard usage script, if its cache exists (an optional source). */
export function usageScript(home: string): string | null {
  const root = path.join(
    home,
    '.claude',
    'plugins',
    'cache',
    'claude-dashboard',
    'claude-dashboard',
  );
  let versions: string[];
  try {
    versions = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && VERSION.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return null;
  }
  const version = versions
    .filter((next) => fs.existsSync(path.join(root, next, 'dist', 'check-usage.js')))
    .reduce<string | null>((best, next) => (!best || newer(next, best) ? next : best), null);
  if (!version) return null;
  return path.join(root, version, 'dist', 'check-usage.js');
}

type Usage = Omit<UsageState, 'type'>;
export type UsageProvider = 'claude' | 'codex';
export type UsagePeriod = 'fiveHour' | 'sevenDay';
export interface EarlyUsageReset {
  provider: UsageProvider;
  period: UsagePeriod;
}

/** One source-reported window: retain an elapsed reset as a marker, never as invented zero use. */
function slot(
  pct: unknown,
  resetsAtSec: unknown,
  now: number,
): [number | null, string | null, boolean | null] {
  const p = num(pct);
  const at = num(resetsAtSec);
  if (p === null) return [null, null, null];
  if (at !== null && at * 1000 <= now) return [null, null, true];
  return [p, at === null ? null : new Date(at * 1000).toISOString(), null];
}

const known = (w: UsageWindow | null | undefined): w is UsageWindow =>
  !!w &&
  (typeof w.fiveHourPct === 'number' ||
    typeof w.sevenDayPct === 'number' ||
    w.fiveHourIsReset === true ||
    w.sevenDayIsReset === true);

export function earlyResets(previous: Usage | null, next: Usage, now: number): EarlyUsageReset[] {
  if (!previous) return [];
  const out: EarlyUsageReset[] = [];
  for (const provider of ['claude', 'codex'] as const) {
    const before = previous[provider];
    const after = next[provider];
    if (!before || !after) continue;
    for (const [period, pct, reset] of [
      ['fiveHour', 'fiveHourPct', 'fiveHourReset'],
      ['sevenDay', 'sevenDayPct', 'sevenDayReset'],
    ] as const) {
      const beforePct = before[pct];
      const afterPct = after[pct];
      const beforeReset = before[reset];
      const afterReset = after[reset];
      const beforeAt = beforeReset ? Date.parse(beforeReset) : Number.NaN;
      const afterAt = afterReset ? Date.parse(afterReset) : Number.NaN;
      if (
        typeof beforePct === 'number' &&
        typeof afterPct === 'number' &&
        afterPct < beforePct &&
        Number.isFinite(beforeAt) &&
        Number.isFinite(afterAt) &&
        beforeAt >= now + USAGE_EARLY_RESET_MIN_FUTURE_MS &&
        afterAt - beforeAt > USAGE_EARLY_RESET_MIN_NEXT_SHIFT_MS[period]
      )
        out.push({ provider, period });
    }
  }
  return out;
}

type UsageModel = NonNullable<UsageWindow['models']>[number];

/**
 * Per-model weekly windows from the newest claude-dashboard raw cache
 * (`~/.cache/claude-dashboard/cache-*.json`, `data.seven_day_<family>` with
 * `utilization` and `resets_at`): only those fields, never anything else in the
 * cache. A cache without `data.five_hour`, an unreadable one, an object without a
 * numeric utilization or a window whose reset has passed contributes nothing.
 */
export function claudeModelUsage(home: string, now = Date.now()): UsageModel[] {
  const dir = path.join(home, '.cache', 'claude-dashboard');
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => /^cache-.*\.json$/.test(n));
  } catch {
    return [];
  }
  const files = names
    .map((n) => {
      try {
        return { file: path.join(dir, n), mtime: fs.statSync(path.join(dir, n)).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((f): f is { file: string; mtime: number } => f !== null)
    .sort((a, b) => b.mtime - a.mtime);
  for (const { file } of files) {
    let data: Record<string, unknown>;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
      data = raw?.data;
      if (typeof data !== 'object' || data === null || !data.five_hour) continue;
    } catch {
      continue;
    }
    const out: UsageModel[] = [];
    for (const [key, w] of Object.entries(data)) {
      const family = /^seven_day_([a-z]+)$/.exec(key)?.[1];
      if (!family || typeof w !== 'object' || w === null) continue;
      const pct = num((w as Record<string, unknown>).utilization);
      if (pct === null) continue;
      const reset = str((w as Record<string, unknown>).resets_at);
      const at = reset === null ? Number.NaN : Date.parse(reset);
      if (Number.isFinite(at) && at <= now) continue;
      out.push({ family, pct, reset: Number.isFinite(at) ? reset : null });
    }
    return out; // ponytail: only the newest valid cache is read (one per account, newest wins)
  }
  return [];
}

/** Where cld/bin/cld-gui-statusline.js keeps Claude Code's own rate_limits. */
export const claudeUsageFile = (home: string): string =>
  path.join(configDirectory(home), 'usage-claude.json');

/**
 * Claude Code's own 5-hour and 7-day windows, as the status line of an engine
 * session last saw them (`used_percentage`, `resets_at` in epoch seconds); null
 * when there is no such file or nothing in it was source-reported. A passed
 * source reset remains visible as a reset marker until a fresh reading arrives.
 */
export function claudeOwnUsage(file: string, now = Date.now()): UsageWindow | null {
  let raw: Record<string, { used_percentage?: unknown; resets_at?: unknown } | undefined>;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const [fiveHourPct, fiveHourReset, fiveHourIsReset] = slot(
    raw.five_hour?.used_percentage,
    raw.five_hour?.resets_at,
    now,
  );
  const [sevenDayPct, sevenDayReset, sevenDayIsReset] = slot(
    raw.seven_day?.used_percentage,
    raw.seven_day?.resets_at,
    now,
  );
  const w = {
    fiveHourPct,
    fiveHourReset,
    fiveHourIsReset,
    sevenDayPct,
    sevenDayReset,
    sevenDayIsReset,
  };
  return known(w) ? w : null;
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

/**
 * Codex's own windows from its newest session logs (`rate_limits` with
 * `primary`/`secondary`: `used_percent`, `window_minutes`, `resets_at` in epoch
 * seconds), the same records the engine's limit wait reads; null when none.
 */
export function codexOwnUsage(codexHome: string, now = Date.now()): UsageWindow | null {
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
      const w: UsageWindow = {
        fiveHourPct: null,
        sevenDayPct: null,
        fiveHourReset: null,
        sevenDayReset: null,
        fiveHourIsReset: null,
        sevenDayIsReset: null,
      };
      for (const [key, fallback] of [
        ['primary', '5h'],
        ['secondary', '7d'],
      ] as const) {
        const x = rl[key] as Record<string, unknown> | undefined;
        if (!x || typeof x !== 'object') continue;
        const minutes = num(x.window_minutes);
        const which =
          minutes === 300 ? '5h' : minutes === 10080 ? '7d' : minutes === null ? fallback : null;
        const [pct, reset, isReset] = slot(x.used_percent, x.resets_at, now);
        if (which === '5h')
          [w.fiveHourPct, w.fiveHourReset, w.fiveHourIsReset] = [pct, reset, isReset];
        if (which === '7d')
          [w.sevenDayPct, w.sevenDayReset, w.sevenDayIsReset] = [pct, reset, isReset];
      }
      return known(w) ? w : null;
    }
  }
  return null;
}

/**
 * Usage for the office's bar, viewer-gated: Claude from its own status-line
 * data (engine sessions), Codex from its own session logs, and the Claude
 * Dashboard plugin when it happens to be installed (live, so it wins where it
 * answers). A provider nobody reports is null: shown as unknown, never guessed.
 */
export class UsageSource {
  usage: Usage | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private viewing = false;
  private refreshing: Promise<void> | null = null;
  private plugin: Usage | null = null;
  private previous: Usage | null = null;
  private readonly warned = new Set<string>();

  constructor(
    readonly opts: { home: string; codexHome: string; script: string | null },
    private readonly onChange: (usage: Usage) => void,
    private readonly onEarlyReset: (reset: EarlyUsageReset) => void = () => undefined,
  ) {}

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
    if (this.opts.script) await this.runPlugin(this.opts.script);
    const now = Date.now();
    const models = claudeModelUsage(this.opts.home, now);
    const pick = (live: UsageWindow | null | undefined, own: UsageWindow | null) =>
      known(live) ? live : own;
    let claude = pick(this.plugin?.claude, claudeOwnUsage(claudeUsageFile(this.opts.home), now));
    if (models.length) {
      claude = { ...(claude ?? { fiveHourPct: null, sevenDayPct: null }), models };
    }
    const usage = {
      ts: new Date(now).toISOString(),
      claude,
      codex: pick(this.plugin?.codex, codexOwnUsage(this.opts.codexHome, now)),
    };
    for (const reset of earlyResets(this.previous, usage, now)) this.onEarlyReset(reset);
    this.previous = usage;
    this.usage = usage;
    this.onChange(usage);
  }

  /** The plugin's answer; on failure the last one stands (warned once per message). */
  private async runPlugin(script: string): Promise<void> {
    try {
      const stdout = await new Promise<string>((resolve, reject) => {
        execFile(
          process.execPath,
          [script, '--json'],
          { timeout: 30_000, maxBuffer: 64 * 1024 },
          (error, output) => (error ? reject(error) : resolve(output)),
        );
      });
      this.plugin = parseUsage(JSON.parse(stdout), new Date().toISOString());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!this.warned.has(message)) {
        this.warned.add(message);
        console.warn(`[cld usage] ${message}`);
      }
    }
  }
}
