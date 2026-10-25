/**
 * The 작업 panel's rules (T-0047), pure: how a job reads (tense, elapsed time),
 * and which jobs show as cards, which fold, and which are cut.
 */
import { matchKorean } from '../../../../core/src/cld/serverText.js';
import { jobOutcome } from '../../../../core/src/cld/work.js';
import type { CodexTask, OfficeJob } from '../../../../core/src/messages.js';
import { t } from '../../i18n/index.js';
import { resetCountdown, timeAgo } from '../format.js';
import { serverLine } from '../serverText.js';

/** Ended jobs older than this fold into one line per project. */
export const FOLD_AFTER_MS = 60 * 60_000;
/** At most this many cards per panel (and per expanded fold); the rest is "외 N". */
export const MAX_JOB_CARDS = 20;

const time = (value: string | null | undefined): number | null => {
  const t = value ? Date.parse(value) : NaN;
  return Number.isFinite(t) ? t : null;
};

/** "45초", "12분", "2시간 5분": whole units, never negative. */
export function spanText(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return t('jobs.seconds', { count: Math.floor(Math.max(0, ms) / 1000) });
  if (minutes < 60) return t('jobs.minutes', { count: minutes });
  const m = minutes % 60;
  return [t('jobs.hours', { count: Math.floor(minutes / 60) }), m && t('jobs.minutes', { count: m })].filter(Boolean).join(' ');
}

export type JobKind = 'gpuWait' | 'running' | 'done' | 'failed' | 'stopped' | 'timeout';

export interface JobStatus {
  kind: JobKind;
  /** Outcome and elapsed time, without process diagnostics. */
  text: string;
}

/** A job whose command has not run yet: it holds a place in the GPU queue (U-03). */
const waitsForGpu = (job: OfficeJob): boolean => !job.ended && job.gpu === 'queued';

/** "GPU 대기 · 10분째": a wait word and how long since `from` (ms), or the bare word. */
const waitText = (word: string, from: number | null, now: number): string =>
  from === null ? word : t('jobs.waitFor', { word, duration: spanText(now - from) });

/** "생성 10분 전 · 시작 2분 전": created and really started, apart (U-03). Before the start it says so. */
export function timesText(
  created: string | null | undefined,
  started: string | null | undefined,
  now: number,
): string {
  return t('jobs.times', {
    created: timeAgo(created, now),
    started: started ? t('jobs.startedAt', { time: timeAgo(started, now) }) : t('jobs.notStarted'),
  });
}

export function jobStatus(job: OfficeJob, now: number): JobStatus {
  // `started` is the real start (null while a GPU job waits); older daemons sent only the creation time.
  const created = time(job.created) ?? time(job.started);
  const start = time(job.started);
  if (waitsForGpu(job)) {
    return { kind: 'gpuWait', text: waitText(t('jobs.gpuWait'), created, now) };
  }
  if (!job.ended) {
    return {
      kind: 'running',
      text: start === null ? t('jobs.running') : t('jobs.runningFor', { duration: spanText(now - start) }),
    };
  }
  const end = time(job.ended);
  const began = start ?? created;
  const took = began !== null && end !== null ? t('jobs.took', { duration: spanText(end - began) }) : '';
  const outcome = jobOutcome(job.exit, true, job.stopped === true);
  const kind: JobKind =
    outcome === '\ub05d\ub0a8(\uc131\uacf5)'
      ? 'done'
      : outcome === '\uc2dc\uac04 \ucd08\uacfc'
        ? 'timeout'
        : outcome === '\uba48\ucda4(\uc0ac\uc6a9\uc790\uac00 \uba48\ucda4)'
          ? 'stopped'
          : 'failed';
  const label = kind === 'done' ? t('jobs.outcome.done') : kind === 'timeout' ? t('jobs.outcome.timeout') : kind === 'stopped' ? t('jobs.outcome.stopped') : outcome === '\ud55c\ub3c4 \ub300\uae30' ? t('jobs.outcome.limit') : t('jobs.outcome.failed');
  return { kind, text: `${label}${took}` };
}

/** A GPU job's reservation while it runs (T-0021). Waiting for its turn is its status (`gpuWait`), not a badge. */
export function gpuBadge(job: OfficeJob): string | null {
  return job.ended || job.gpu !== 'leased' ? null : t('jobs.gpuReserved');
}

/** A progress line only for what the log really said: no tqdm, no bar, no zeros. */
export function progressText(job: OfficeJob, now = Date.now()): string | null {
  // Nothing runs while the job waits for the GPU: a bar would be made up (F-15).
  const p = job.ended || waitsForGpu(job) ? null : job.progress;
  if (!p) return null;
  if (p.indeterminate)
    return t('jobs.progressFor', { label: p.label ? serverLine(p.label) : t('jobs.firstRun'), duration: spanText(now - (time(job.started) ?? now)) });
  const said = p.label ? matchKorean(p.label)?.code : undefined;
  if (said === 'progress_last' && p.label) return serverLine(p.label);
  if (said === 'progress_steps' && p.label) return `${serverLine(p.label)} · ${Math.round(p.pct)}%`;
  return [`${Math.round(p.pct)}%`, p.rate, p.eta ? t('jobs.eta', { eta: p.eta }) : null]
    .filter(Boolean)
    .join(' · ');
}

// ── Codex tasks and the count of work (U-03, U-04) ───────────

export type CodexKind = 'queued' | 'limit' | 'running' | 'done' | 'failed' | 'stopped';

/** What a Codex task is doing now. `queued`: asked for, its worker has not started Codex (no start time). */
export function codexKind(task: CodexTask): CodexKind {
  if (task.state === 'limit') return 'limit';
  if (task.state === 'running') return task.ended ? 'done' : task.started === null ? 'queued' : 'running';
  return task.state === 'done' || task.state === 'stopped' ? task.state : 'failed';
}

/** The task's state in words, with what the record knows: "실행 대기 · 10분째", "한도 대기 · 1시간 뒤 초기화". */
export function codexStatus(task: CodexTask, now: number): string {
  const kind = codexKind(task);
  if (kind === 'queued') return waitText(t('jobs.queued'), time(task.created), now);
  if (kind === 'limit')
    return task.resetAt
      ? `${t('jobs.outcome.limit')} · ${resetCountdown(task.resetAt, now)}`
      : t('jobs.outcome.limit');
  if (kind === 'running')
    return t('jobs.runningFor', { duration: spanText(now - (time(task.started) ?? now)) });
  return t(`jobs.outcome.${kind}`);
}

/** The state word of a Codex task, for a header or a board cell. */
export function codexWord(task: CodexTask): string {
  const kind = codexKind(task);
  return t(kind === 'running' ? 'jobs.running' : kind === 'queued' ? 'jobs.queued' : `jobs.outcome.${kind}`);
}

/** The state word of a live job: waiting in the GPU queue is not running. */
export const jobWord = (job: OfficeJob): string => t(waitsForGpu(job) ? 'jobs.gpuWait' : 'jobs.running');

export interface WorkCounts {
  running: number;
  queued: number;
  gpuWait: number;
  limit: number;
}

/** How much work is in each live state, from the records alone: a start, an end or a lease
 *  changes it the moment the record does. No progress figure is read (F-15). */
export function workCounts(jobs: readonly OfficeJob[], tasks: readonly CodexTask[]): WorkCounts {
  const n: WorkCounts = { running: 0, queued: 0, gpuWait: 0, limit: 0 };
  for (const job of jobs) if (!job.ended) n[waitsForGpu(job) ? 'gpuWait' : 'running']++;
  for (const task of tasks) {
    const kind = codexKind(task);
    if (kind === 'running' || kind === 'queued' || kind === 'limit') n[kind]++;
  }
  return n;
}

/** "⏳ 작업 중 3", then each wait that has anyone in it; nothing when no work is live. */
export function workLines(n: WorkCounts): string[] {
  if (n.running + n.queued + n.gpuWait + n.limit === 0) return [];
  return [
    t('jobs.summary.running', { count: n.running }),
    ...(['queued', 'gpuWait', 'limit'] as const)
      .filter((k) => n[k] > 0)
      .map((k) => t(`jobs.summary.${k}`, { count: n[k] })),
  ];
}

export interface JobFold {
  project: string;
  jobs: OfficeJob[];
  failed: number;
}

export const foldText = ({ project, jobs, failed }: JobFold): string =>
  `${t('jobs.fold', { project, count: jobs.length })}${failed ? t('jobs.failedCount', { count: failed }) : ''}`;

export interface JobPlan {
  cards: OfficeJob[];
  /** "외 N": cards cut by the cap. */
  more: number;
  folds: JobFold[];
}

const stamp = (j: OfficeJob) => time(j.ended) ?? time(j.started) ?? time(j.created) ?? 0;

/** Running first, newest first; ended within the hour as cards; older ended folded per project. */
export function planJobs(jobs: OfficeJob[], now: number): JobPlan {
  const running = jobs
    .filter((j) => !j.ended)
    .sort((a, b) => (time(b.started) ?? time(b.created) ?? 0) - (time(a.started) ?? time(a.created) ?? 0));
  const ended = jobs.filter((j) => j.ended).sort((a, b) => stamp(b) - stamp(a));
  const old = (j: OfficeJob) => {
    const end = time(j.ended);
    return end !== null && now - end > FOLD_AFTER_MS;
  };
  const cards = [...running, ...ended.filter((j) => !old(j))];
  const folds = new Map<string, OfficeJob[]>();
  for (const j of ended.filter(old)) {
    const key = j.project || t('jobs.outsideProject');
    folds.set(key, [...(folds.get(key) ?? []), j]);
  }
  return {
    cards: cards.slice(0, MAX_JOB_CARDS),
    more: Math.max(0, cards.length - MAX_JOB_CARDS),
    folds: [...folds].map(([project, list]) => ({
      project,
      jobs: list,
      failed: list.filter((j) => j.exit != null && j.exit > 0).length,
    })),
  };
}
