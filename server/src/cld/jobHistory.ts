/** Last five successful durations for an exact visible job name. */
import * as fs from 'fs';
import * as path from 'path';

import { koText } from '../../../core/src/cld/serverText.js';
import type { JobProgress } from '../../../core/src/messages.js';
import { writeAtomic } from './engine/messenger.js';
import { digestJobLog } from './jobDigest.js';

type History = Record<string, number[]>;
const fileOf = (home: string) => path.join(home, '.config/cld-gui/job-history.json');
function read(home: string): History {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(fileOf(home), 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as History) : {};
  } catch {
    return {};
  }
}
export function historyMedian(home: string, name: string): number | null {
  const numbers = read(home)[name];
  if (!Array.isArray(numbers)) return null;
  const sorted = numbers.filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
}
export function rememberDuration(home: string, name: string, ms: number): void {
  if (!Number.isFinite(ms) || ms <= 0) return;
  const file = fileOf(home);
  const history = read(home);
  history[name] = [...(Array.isArray(history[name]) ? history[name] : []), ms].slice(-5);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeAtomic(file, `${JSON.stringify(history)}\n`);
}

/** A running job's bar without tqdm: the log's known steps, else elapsed vs the last runs' median
 *  (capped at 95 % until it ends), else an indeterminate first run. */
export function estimateProgress(
  home: string,
  name: string,
  cmd: string,
  tail: string,
  elapsedMs: number,
): JobProgress {
  const steps = digestJobLog(cmd, tail).steps;
  const base = { rate: null, eta: null };
  if (steps.length) {
    const done = steps.filter((s) => s.state === 'done').length;
    return {
      ...base,
      label: koText('progress_steps', { done, total: steps.length }),
      pct: Math.min(95, Math.round((done / steps.length) * 100)),
    };
  }
  const last = historyMedian(home, name);
  if (!last) return { ...base, label: koText('progress_first_run'), pct: 0, indeterminate: true };
  const minutes = (ms: number) => koText('minutes_n', { n: Math.max(1, Math.round(ms / 60_000)) });
  const elapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  return {
    ...base,
    label: koText('progress_last', { last: minutes(last), left: minutes(Math.max(0, last - elapsed)) }),
    pct: Math.min(95, Math.round((elapsed / last) * 100)),
  };
}
