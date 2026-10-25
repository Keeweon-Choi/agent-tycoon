/**
 * T-0041: temps in words. A lead's card carries "+N" for its temps; tapping it
 * opens the list (name, model, state, elapsed, what it does), and a row goes
 * to that character; its 작업 보기 button opens the read-only work view (T-0056). The 현황판's orchestrator row shows the same summary:
 * at most five temp rows then "외 N", finished Codex tasks folded into one
 * line, and the live work counted by state: "⏳ 작업 중 3 · ⌛ GPU 대기 1" (U-04;
 * from the records alone, never a progress figure), each job under it in EZ text only, never a command.
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import type { CodexTask, OfficeJob } from '../../../core/src/messages.js';
import { Button } from '../components/ui/Button.js';
import { Modal } from '../components/ui/Modal.js';
import { MODEL_BADGE_COLORS, MODEL_BADGE_TEXT, TEMP_ROWS_MAX } from '../constants.js';
import { t } from '../i18n/index.js';
import { transport } from '../transport/index.js';
import { elapsedDuration } from './kinds.js';
import { jobLineLabel } from './messenger/toolLine.js';
import { MODEL_BADGES, type ModelBadge as Badge, modelVersion, rankModelLabel } from './modelBadges.js';
import { presenceOf, presenceWord } from './officeHours.js';
import { ezContext, useCldStore } from './officeStore.js';
import { codexKind, codexStatus, jobStatus, workCounts, workLines } from './panels/jobs.js';
import { staffFocus, useStaff } from './staff.js';
import {
  capRows,
  codexFold,
  codexTaskLine,
  isFinishedCodex,
  type TempPhase,
  type TempRow,
} from './temps.js';
import { openWork } from './work/workStore.js';

/** Over the card bars and panels, like the other cld dialogs. */
const LIST_Z_INDEX = 60;

const phaseWord = (phase: TempPhase): string => t(`temp.phase.${phase}`);
const codexWord = (state: CodexTask['state']): string =>
  state === 'done' ? t('temp.codex.done') : state === 'failed' ? t('temp.codex.failed') : t('temp.codex.stopped');

/** The clock for "N분", a tick a minute (Date.now is not for render). */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/** The small model badge (a letter on the model's colour); its name in the tooltip. */
export function ModelBadge({ badge, modelId }: { badge: Badge; modelId?: string | null }) {
  return (
    <span
      className="shrink-0 px-2 text-[9px] font-bold leading-tight"
      style={{ background: MODEL_BADGE_COLORS[badge], color: MODEL_BADGE_TEXT }}
      title={modelVersion(modelId) ?? MODEL_BADGES[badge].name}
      data-testid="model-badge"
      data-model={badge}
    >
      {MODEL_BADGES[badge].letter}
    </span>
  );
}

/** The readable rank/model tag used at a character's feet and in details. */
export function TempRank({
  level,
  badge,
  modelId,
}: {
  level?: number;
  badge: Badge | null;
  modelId?: string | null;
}) {
  return (
    <span
      className="bg-bg border border-border px-4 text-xs leading-tight whitespace-nowrap"
      data-testid="temp-rank"
    >
      {rankModelLabel(level, badge, modelId)}
    </span>
  );
}

/** The project's live work counted by state (the button); each job and Codex task in the list (hover or tap). */
function JobSummary({ jobs, tasks, now }: { jobs: OfficeJob[]; tasks: CodexTask[]; now: number }) {
  const [open, setOpen] = useState(false);
  const ctx = ezContext();
  const each = [
    ...jobs.map((job) => {
      // What it is (its own description, else the command in EZ words; never the command), and its state; no percent: it is not a count.
      return `${jobLineLabel(job, ctx)} · ${jobStatus(job, now).text}`;
    }),
    ...tasks.map((task) => `⌘ ${codexTaskLine(task)} · ${codexStatus(task, now)}`),
  ];
  return (
    <div>
      <button
        type="button"
        className="text-left w-full truncate pointer-coarse:min-h-44"
        title={each.join('\n')}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        data-testid="job-summary"
      >
        {workLines(workCounts(jobs, tasks)).join(' · ')}
      </button>
      {open && (
        <ul className="pl-12 space-y-2 text-text-muted" data-testid="job-list">
          {each.map((line, i) => (
            <li key={i} className="truncate">
              {line}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Finished Codex tasks in one line, opened on a tap. */
function CodexFold({ tasks }: { tasks: CodexTask[] }) {
  const [open, setOpen] = useState(false);
  const text = codexFold(tasks);
  if (!text) return null;
  return (
    <div>
      <button
        type="button"
        className="text-left w-full truncate pointer-coarse:min-h-44"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        data-testid="codex-fold"
      >
        ⌘ {text}
      </button>
      {open && (
        <ul className="pl-12 space-y-2 text-text-muted">
          {tasks.map((task) => (
            <li key={task.id} className="truncate">
              {codexTaskLine(task)} · {codexWord(task.state)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One temp: name and model, what it does, its state and how long it has been here. */
function TempLine({ row, now, onPick }: { row: TempRow; now: number; onPick?: () => void }) {
  return (
    <li className="flex items-center gap-8 min-w-0">
      <button
        type="button"
        className="flex-1 text-left px-4 py-2 hover:bg-btn-hover pointer-coarse:min-h-44 min-w-0"
        onClick={() => {
          staffFocus(row.id);
          onPick?.();
        }}
        data-testid="temp-row"
        data-agent-id={row.id}
        data-phase={row.phase}
      >
        {/* UI-CONSISTENCY: one line per field; what does not fit ends in an ellipsis (the whole text is the tooltip). */}
        <span className="flex items-center gap-4 min-w-0">
          {row.model && <ModelBadge badge={row.model} modelId={row.modelId} />}
          <strong className="truncate min-w-0 shrink-0 max-w-[45%]" title={row.name}>
            {row.name}
          </strong>
          {row.task && (
            <span className="min-w-0 flex-1 truncate text-text-muted" title={row.task} data-testid="temp-task">
              · {row.task}
            </span>
          )}
        </span>
        <span className="block truncate text-text-muted">
          {phaseWord(row.phase)} · {elapsedDuration(now - row.since)}
        </span>
      </button>
      {row.work && (
        // T-0056: a row goes to the character; this button opens what it is doing.
        <Button
          size="sm"
          className="shrink-0"
          data-testid="work-open"
          data-agent-id={row.id}
          onClick={() => {
            openWork(row, (m) => transport.send(m));
            onPick?.();
          }}
        >
          {t('temp.workOpen')}
        </Button>
      )}
    </li>
  );
}

/**
 * A lead's temps and noise, summarised. `rows`: its temps; `project`: the
 * orchestrator's project (its Codex tasks and jobs), or null.
 */
export function TempSummary({
  rows,
  project,
  outsourced = false,
  onPick,
}: {
  rows: TempRow[];
  project: string | null;
  /** 외주: Codex tasks no orchestrator owns. */
  outsourced?: boolean;
  onPick?: () => void;
}) {
  const { codexTasks, officeJobs, officeSnapshot } = useCldStore();
  const [all, setAll] = useState(false);
  const owners = new Set(officeSnapshot?.orchestrators.map((o) => o.name));
  const finished = (codexTasks?.tasks ?? []).filter(
    (t) =>
      isFinishedCodex(t.state) && (outsourced ? !owners.has(t.project) : t.project === project),
  );
  const jobs = project
    ? (officeJobs?.jobs ?? []).filter((job) => job.project === project && !job.ended)
    : [];
  const live = project
    ? (codexTasks?.tasks ?? []).filter(
        (task) => task.project === project && ['queued', 'running', 'limit'].includes(codexKind(task)),
      )
    : [];
  const { shown, more } = capRows(rows, all ? rows.length : TEMP_ROWS_MAX);
  const now = useNow();
  if (!rows.length && !finished.length && !jobs.length && !live.length) return null;
  return (
    <div className="space-y-4 text-xs min-w-0" data-testid="temp-summary">
      {rows.length > 0 && (
        <ul className="space-y-2">
          {shown.map((row) => (
            <TempLine key={row.id} row={row} now={now} onPick={onPick} />
          ))}
          {more > 0 && (
            <li>
              <button
                type="button"
                className="px-4 text-text-muted underline"
                onClick={() => setAll(true)}
              >
                {t('temp.more', { count: more })}
              </button>
            </li>
          )}
        </ul>
      )}
      <CodexFold tasks={finished} />
      {jobs.length + live.length > 0 && <JobSummary jobs={jobs} tasks={live} now={now} />}
    </div>
  );
}

/** "+N" under a lead's card name: its temps, in a list on a tap. */
export function TempChip({
  rows,
  title,
  project,
  outsourced,
}: {
  rows: TempRow[];
  title: string;
  project: string | null;
  outsourced?: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (!rows.length) return null;
  return (
    <>
      <button
        type="button"
        className="block w-full text-center text-[10px] leading-tight text-accent-text border border-border bg-bg pointer-events-auto"
        title={t('temp.viewTeam', { count: rows.length })}
        aria-haspopup="dialog"
        data-testid="temp-chip"
        onClick={(e) => {
          e.stopPropagation(); // not the card's select
          setOpen(true);
        }}
      >
        +{rows.length}
      </button>
      {open &&
        // Portalled out of the card bar (the phone's sliding track would be
        // its fixed box); React events still bubble to the card, so they stop here.
        createPortal(
          <div onClick={(e) => e.stopPropagation()} onTouchStart={(e) => e.stopPropagation()}>
            <Modal
              isOpen
              onClose={() => setOpen(false)}
              title={t('temp.teamTitle', { title, count: rows.length })}
              zIndex={LIST_Z_INDEX}
              className="w-[min(480px,100%)]"
            >
              <div className="px-10 pb-8" data-testid="temp-list">
                <TempSummary
                  rows={rows}
                  project={project}
                  outsourced={outsourced}
                  onPick={() => setOpen(false)}
                />
              </div>
            </Modal>
          </div>,
          document.body,
        )}
    </>
  );
}

/** 퇴근 on a card or a 현황판 row whose orchestrator went home; 야근 for one on overtime. */
export function DutyMark({ id }: { id: number }) {
  const duty = presenceOf(useStaff(), id);
  if (!duty) return null;
  const word = presenceWord(duty);
  return (
    <span
      className="shrink-0 border border-border px-4 text-[10px] leading-tight text-text-muted"
      data-testid="duty-mark"
    >
      {word}
    </span>
  );
}
