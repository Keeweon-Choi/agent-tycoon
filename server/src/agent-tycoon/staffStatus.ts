/**
 * `agty status` facts for orchestrators: the Claude weekly usage and the running Claude
 * sub-agents per project. Read-only views over what the daemon already tracks (the usage
 * source's last reading, the office's temporary staff); nothing here calls an API or blocks.
 */
import * as fs from 'fs';

import type { TempEmployee, UsageState } from '../../../core/src/messages.js';
import { CLAUDE_USAGE_STALE_MS } from '../constants.js';
import { claudeOwnUsage, claudeUsageFile } from './usage.js';

export interface ClaudeUsageFact {
  weekPct: number;
  resetsAt: string | null;
  fiveHourPct?: number;
}

export interface SubagentFacts {
  total: number;
  byProject: Record<string, number>;
}

/** The Claude weekly (and 5-hour, when reported) reading; null when the week is unknown. */
export function claudeUsageFact(
  usage: Pick<UsageState, 'providers'> | null | undefined,
): ClaudeUsageFact | null {
  const windows = usage?.providers.find((p) => p.id === 'claude')?.windows ?? [];
  const week = windows.find((w) => w.id === '7d');
  if (typeof week?.pct !== 'number') return null;
  const five = windows.find((w) => w.id === '5h');
  return {
    weekPct: Math.round(week.pct),
    resetsAt: week.resetAt,
    ...(typeof five?.pct === 'number' && { fiveHourPct: Math.round(five.pct) }),
  };
}

/** Running Claude sub-agents (Codex temporaries are not Claude's), counted per lead project. */
export function subagentFacts(staff: readonly TempEmployee[]): SubagentFacts {
  const byProject: Record<string, number> = {};
  let total = 0;
  for (const e of staff) {
    if (!e.working || !e.execution.startsWith('claude:')) continue;
    byProject[e.project] = (byProject[e.project] ?? 0) + 1;
    total++;
  }
  return { total, byProject };
}

/**
 * The status line's saved report (`usage-claude.json`), for when no viewer made UsageSource
 * read it. Used only while fresh (file mtime within CLAUDE_USAGE_STALE_MS) and while its reset
 * has not passed (claudeOwnUsage marks a passed reset as no figure).
 */
export function savedClaudeUsage(file: string, now = Date.now()): ClaudeUsageFact | null {
  try {
    if (now - fs.statSync(file).mtimeMs >= CLAUDE_USAGE_STALE_MS) return null;
  } catch {
    return null;
  }
  return claudeUsageFact({ providers: [claudeOwnUsage(file, now)] });
}

/** The two fields `agty status` adds to the daemon's status answer. */
export const staffFacts = (
  usage: Pick<UsageState, 'providers'> | null | undefined,
  staff: readonly TempEmployee[],
  home: string,
) => ({
  claudeUsage: claudeUsageFact(usage) ?? savedClaudeUsage(claudeUsageFile(home)),
  subagents: subagentFacts(staff),
});
