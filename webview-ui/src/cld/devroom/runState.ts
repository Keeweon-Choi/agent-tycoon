/**
 * DV2 개발실 실행 row, its pure rules: which engine job is a worktree's run of a script (the
 * daemon marks them, OfficeJob.run), what its chip says, how many runs are going, the dev server's
 * address in a log and the failed lines sent to an agent. runStore.ts asks the daemon, RunRow.tsx draws.
 */
import { scanDevUrl } from '../../../../core/src/cld/devUrl.js';
import type { OfficeJob, RunRole } from '../../../../core/src/messages.js';
import { DEVROOM_RUN_TAIL_LINES } from '../../constants.js';
import { t } from '../../i18n/index.js';
import { timeAgo } from '../format.js';

/** `HH:MM` of a job's time, in this screen's clock. */
export const clock = (iso: string | null | undefined): string => {
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? new Date(ms).toTimeString().slice(0, 5) : '';
};

/** The newest job that is worktree `task`'s run of `script` ('' task = the project's own folder). */
export function latestRun(jobs: readonly OfficeJob[], project: string, task: string, script: string): OfficeJob | undefined {
  let best: OfficeJob | undefined;
  for (const j of jobs)
    if (j.id && j.project === project && j.run?.task === task && j.run.script === script && (!best || (j.created ?? '') >= (best.created ?? ''))) best = j;
  return best;
}

/** The newest run of the script picked as 테스트 in this worktree. */
export const latestTest = (jobs: readonly OfficeJob[], project: string, task: string): OfficeJob | undefined =>
  jobs
    .filter((j) => j.id && j.project === project && j.run?.task === task && j.run.role === 'test')
    .sort((a, b) => (a.created ?? '').localeCompare(b.created ?? ''))
    .at(-1);

export type RunTone = 'none' | 'running' | 'failed' | 'ok' | 'stopped';

export function runTone(job: OfficeJob | undefined): RunTone {
  if (!job) return 'none';
  if (!job.ended) return 'running';
  if (job.stopped) return 'stopped';
  return job.exit === 0 ? 'ok' : 'failed';
}

/** The chip's words: `실행 중 · localhost:5174`, `실패 · 종료 코드 1 · 18:12`, `성공 · 방금`, `아직 안 돌림`. */
export function runText(job: OfficeJob | undefined, url: string | null, now = Date.now()): string {
  const tone = runTone(job);
  if (!job || tone === 'none') return t('devroom.run.never');
  if (tone === 'running')
    return url ? t('devroom.run.runningAt', { url: shortUrl(url) }) : t('devroom.run.runningSince', { time: clock(job.started ?? job.created) });
  if (tone === 'stopped') return t('devroom.run.stopped', { time: clock(job.ended) });
  if (tone === 'ok') return t('devroom.run.ok', { ago: timeAgo(job.ended, now) });
  return job.exit === null || job.exit === undefined
    ? t('devroom.run.gone', { time: clock(job.ended) })
    : t('devroom.run.failed', { code: job.exit, time: clock(job.ended) });
}

/** `localhost:5174`, not `http://localhost:5174/`. */
export const shortUrl = (url: string): string => url.replace(/^https?:\/\//, '').replace(/\/$/, '');

/** The dev server's address in a run's log: the last loopback URL only (anything else is never offered). */
export const devUrlOf = (log: string | undefined): string | null => (log ? scanDevUrl(log) : null);

/** Runs going now, everywhere (the footer's `실행 N개`). */
export const liveRuns = (jobs: readonly OfficeJob[]): number => jobs.filter((j) => j.run && !j.ended).length;

/** A log's last lines (trailing blank ones dropped). */
export function tailLines(text: string, n = DEVROOM_RUN_TAIL_LINES): string {
  const lines = text.replace(/\s+$/, '').split('\n');
  return lines.slice(-n).join('\n');
}

/** What `<agent>에게 보내기` sends: which run failed, where, and its last lines. */
export const failMessage = (label: string, cmd: string, job: OfficeJob, log: string): string =>
  t('devroom.run.sendText', { label, cmd, code: job.exit ?? '?', time: clock(job.ended), lines: tailLines(log) });

/** A role's name on screen; `other` shows the script's own key. */
export const roleLabel = (role: RunRole, script: string): string => (role === 'other' ? script : t(`devroom.run.role.${role}`));

/** The run order of the row: 개발 서버, 테스트, 타입 검사, then the others. */
export const ROLE_ORDER: readonly RunRole[] = ['dev', 'test', 'typecheck', 'other'];
