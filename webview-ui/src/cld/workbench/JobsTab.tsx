/**
 * The 프로젝트 tab's 이슈 (the task board) and the job cards (log viewer, stop, folds), which the
 * 현황판's own 실행 tab shows (panels/RunsPanel.tsx; owner 11-06 18:24: no 이슈 | 실행 toggle any
 * more). Both see what the surrounding CldScope lets them see: one project's items, every one, or
 * the ones with no project.
 */
import { useEffect, useState } from 'react';

import type { OfficeJob } from '../../../../core/src/messages.js';
import { Button } from '../../components/ui/Button.js';
import { t } from '../../i18n/index.js';
import { transport } from '../../transport/index.js';
import { Chevron } from '../Chevron.js';
import { JobRun } from '../game/JobRun.js';
import { jobRequest, useJobStore } from '../jobStore.js';
import { useCldStore } from '../officeStore.js';
import {
  foldText,
  gpuBadge,
  jobStatus,
  MAX_JOB_CARDS,
  planJobs,
  progressText,
  timesText,
} from '../panels/jobs.js';
import { serverLine } from '../serverText.js';
import { TaskBoardView } from '../taskboard/TaskBoard.js';

function useNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

export const section = 'pixel-panel p-12 min-w-0';
const muted = 'text-text-muted text-xs';
/** Tap targets big enough for a finger on touch screens. */
export const tapButton = 'border px-8 py-4 text-xs pointer-coarse:min-h-44 pointer-coarse:px-12';
/** A card a notice just opened (data-focused, notify/openTarget.ts). */
export const FOCUSED = 'data-[focused=true]:outline-2 data-[focused=true]:outline-accent';

function Empty() {
  return <p className="text-text-muted text-sm py-20 text-center">{t('panel.empty')}</p>;
}

const LOG_POLL_MS = 3_000;

/** Digest first; a masked raw log and process diagnostics stay one click away. */
function JobControls({ job, open, setOpen }: { job: OfficeJob; open: boolean; setOpen: (open: boolean) => void }) {
  const { officeSnapshot: officeState, officeReadOnly } = useCldStore();
  const { logs, stopping, errors } = useJobStore();
  const [raw, setRaw] = useState(false);
  const [details, setDetails] = useState(false);
  const [asking, setAsking] = useState(false);
  const ref = jobRef(job);
  const canStop = !!job.id && officeState?.readOnly === false && !officeReadOnly && !job.ended;
  const running = !job.ended;
  useEffect(() => {
    if (!open) return;
    const read = () => jobRequest((m) => transport.send(m), 'log', ref);
    read();
    if (!running) return;
    const timer = window.setInterval(read, LOG_POLL_MS);
    return () => window.clearInterval(timer);
  }, [open, running, ref]);
  if (officeReadOnly) return null;
  const log = logs[ref];
  return (
    <div className="mt-8 space-y-4">
      <div className="flex flex-wrap gap-8">
        <Button size="sm" aria-expanded={open} onClick={() => setOpen(!open)}>
          {t('panel.log')} {open ? '▲' : '▼'}
        </Button>
        {canStop && !asking && (
          <Button size="sm" disabled={!!stopping[ref]} onClick={() => setAsking(true)}>
            {stopping[ref] ? t('panel.stopping') : t('panel.stop')}
          </Button>
        )}
        {asking && (
          <span className="flex flex-wrap items-center gap-8 text-xs" role="alertdialog">
            {t('panel.stopQuestion')}
            <Button
              size="sm"
              className="text-red-400"
              onClick={() => {
                setAsking(false);
                jobRequest((m) => transport.send(m), 'stop', ref);
              }}
            >
              {t('panel.stop')}
            </Button>
            <Button size="sm" onClick={() => setAsking(false)}>
              {t('common.cancel')}
            </Button>
          </span>
        )}
      </div>
      {errors[ref] && <p className="text-xs text-red-400">{errors[ref]}</p>}
      {open && (
        <>
          <Button size="sm" onClick={() => setRaw(!raw)}>
            {raw ? t('panel.readableLog') : t('panel.rawLog')}
          </Button>
          {raw ? (
            <pre
              className="max-h-[240px] overflow-auto whitespace-pre-wrap break-all text-[11px] bg-black/30 border border-border p-8"
              data-testid="job-raw"
              data-selectable="always"
            >
              {log ? `${log.truncated ? '…\n' : ''}${log.text}` : t('panel.reading')}
            </pre>
          ) : (
            <div
              className="max-h-[240px] overflow-auto text-xs bg-black/30 border border-border p-8 space-y-4"
              data-testid="job-digest"
            >
              {!log && t('panel.reading')}
              {log?.digest?.steps.map((step, i) => (
                <p
                  key={`${i}-${step.name}`}
                  className={step.state === 'failed' ? 'text-red-400' : undefined}
                >
                  {step.state === 'done'
                    ? '✓'
                    : step.state === 'failed'
                      ? '✗'
                      : step.state === 'running'
                        ? '…'
                        : '·'}{' '}
                  {serverLine(step.name)}
                </p>
              ))}
              {log?.digest?.lines.map((line, i) => (
                <p key={i} className={`break-all ${line.error ? 'text-red-400' : muted}`}>
                  {line.text}
                </p>
              ))}
            </div>
          )}
          <p className={muted}>{t('panel.logHelp')}</p>
        </>
      )}
      <details
        className="text-xs"
        data-testid="job-details"
        onToggle={(e) => {
          const unfolded = e.currentTarget.open;
          setDetails(unfolded);
          if (unfolded && !log) jobRequest((m) => transport.send(m), 'log', ref);
        }}
      >
        <summary className="cursor-pointer">{t('panel.details')}</summary>
        {/* Rendered only while unfolded: the command stays off the page until asked for. */}
        {details && (
          <div className="mt-4 space-y-2 break-all text-text-muted">
            <p>
              {t('panel.command')} {job.cmd}
            </p>
            <p>PID {job.pid}</p>
            <p>
              {t('panel.exitCode')} {job.exit ?? t('panel.none')}
            </p>
            <p>
              {t('panel.log')} {log?.path ?? t('panel.reading')}
            </p>
          </div>
        )}
      </details>
    </div>
  );
}

const statusClass = {
  gpuWait: 'text-yellow-300',
  running: 'text-text-muted',
  done: 'text-text',
  failed: 'text-red-400',
  stopped: 'text-text-muted',
  timeout: 'text-red-400',
};

/** A job's key for a notice (T-0043): the engine's id, or `pid:<n>` (office's events' `ref`). */
const jobRef = (job: OfficeJob) => job.id ?? `pid:${job.pid}`;

/** `walk`: the list's top card; only its runner walks (GAME-UI-1, 06: less noise with many jobs). */
function JobCard({ job, now, walk = false }: { job: OfficeJob; now: number; walk?: boolean }) {
  const status = jobStatus(job, now);
  const progress = progressText(job, now);
  const [logOpen, setLogOpen] = useState(false);
  const { officeReadOnly } = useCldStore();
  const line = job.label ?? t('panel.job');
  return (
    // data-job-ref: a job-end notice opens this card (T-0043, notify/openTarget.ts).
    <li
      className={`${section} ${FOCUSED}`}
      data-testid="job-card"
      data-job-kind={status.kind}
      data-job-ref={jobRef(job)}
    >
      <strong className="block text-sm break-words" data-testid="job-what">
        {line}
      </strong>
      <p className={`${muted} truncate mt-4`}>
        {job.project ?? t('jobs.outsideProject')}
        {job.id && <span className="text-accent-text"> · {t('status.engineBadge')}</span>}
        {gpuBadge(job) && (
          <span className="text-yellow-300" data-testid="job-gpu">
            {' '}
            · {gpuBadge(job)}
          </span>
        )}
      </p>
      <p className={`text-xs mt-4 ${statusClass[status.kind]}`} data-testid="job-status">
        {status.text}
      </p>
      <p className={`${muted} mt-2`} data-testid="job-times">
        {timesText(job.created ?? job.started, job.started, now)}
      </p>
      {/* GAME-UI-1 (06): the run; the log's own words under it. */}
      <JobRun job={job} kind={status.kind} walk={walk} onLog={officeReadOnly ? undefined : () => setLogOpen(true)} />
      {progress && (
        <p className={`${muted} mt-4`} data-testid="job-progress">
          {progress}
        </p>
      )}
      <JobControls job={job} open={logOpen} setOpen={setLogOpen} />
    </li>
  );
}

function JobList({ jobs, now }: { jobs: OfficeJob[]; now: number }) {
  const cards = jobs.slice(0, MAX_JOB_CARDS);
  return (
    <>
      {cards.map((job) => (
        <JobCard key={job.id ?? `office:${job.pid}`} job={job} now={now} />
      ))}
      {jobs.length > cards.length && (
        <li className={muted} data-testid="jobs-more">
          {t('temp.more', { count: jobs.length - cards.length })}
        </li>
      )}
    </>
  );
}

export function JobsPanel() {
  const { officeJobs } = useCldStore();
  const now = useNow();
  const [open, setOpen] = useState<Set<string>>(new Set());
  if (!officeJobs?.jobs.length) return <Empty />;
  const plan = planJobs(officeJobs.jobs, now);
  return (
    <ul className="space-y-8" data-testid="jobs-panel">
      {plan.cards.map((job, i) => (
        <JobCard key={job.id ?? `office:${job.pid}`} job={job} now={now} walk={i === 0} />
      ))}
      {plan.more > 0 && (
        <li className={muted} data-testid="jobs-more">
          {t('temp.more', { count: plan.more })}
        </li>
      )}
      {plan.folds.map((fold) => {
        const shown = open.has(fold.project);
        return (
          <li key={fold.project} className="space-y-8" data-testid="job-fold">
            <button
              type="button"
              data-job-refs={fold.jobs.map(jobRef).join(' ')}
              className={`${section} w-full text-left text-xs flex items-center gap-6 ${tapButton}`}
              aria-expanded={shown}
              onClick={() =>
                setOpen((prev) => {
                  const next = new Set(prev);
                  if (!next.delete(fold.project)) next.add(fold.project);
                  return next;
                })
              }
            >
              <Chevron open={shown} />
              <span>{foldText(fold)}</span>
            </button>
            {shown && (
              <ul className="space-y-8">
                <JobList jobs={fold.jobs} now={now} />
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** DEV-BOARD: the 이슈 tab's board. */
export function JobsTab() {
  const now = useNow();
  return (
    <div className="space-y-8 min-w-0">
      <TaskBoardView now={now} />
    </div>
  );
}
