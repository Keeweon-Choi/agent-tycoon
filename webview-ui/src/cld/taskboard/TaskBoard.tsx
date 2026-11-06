/**
 * 작업 탭의 '업무' (DEV-BOARD): 지금 하는 일, then the board by status. One
 * single-column list on every screen (the 현황판 window and the phone page are
 * both narrow), nothing wider than its box. Cards open in place: note, links,
 * history, the linked runs, and (privileged screens) a status/owner/priority/
 * note editor. D6: the assignee on the card, children under their parent, and
 * in the detail the facts and Executions, each with its source (관측 / 보고 /
 * 추정). The board also has an MVP summary, calculated from reported tasks.
 * GAME-UI-1 G2 (cockpit 09, the 퀘스트 게시판): each card is a pinned request: id and priority
 * stars, the title, its requirement chip and evidence lights (QuestReq, lazy), the assignee's
 * face; a done Task carries a 완료 stamp (dropped once when it turns done while shown). Wide
 * boards lay the status groups out as columns (quest.css). FEAT-BOARD-LESS: no stars (the P0 chip
 * says the priority once); on columns a card is dragged to another status like Jira (the editor's
 * status select stays, for the keyboard and the phone), and a card linked to an agent or a work
 * space opens the 개발실 on it.
 */
import './quest.css';

import { type DragEvent, lazy, type RefObject, Suspense, useContext, useEffect, useMemo, useRef, useState } from 'react';

import type {
  BoardExecution,
  BoardFactSource,
  BoardTask,
  BoardTaskOwner,
  BoardTaskOwnerKind,
  BoardTaskStatus,
  TaskEditFields,
  TrackedItem,
} from '../../../../core/src/messages.js';
import { Button } from '../../components/ui/Button.js';
import { QUEST_COLS_MIN_PX, QUEST_SIDE_MIN_PX } from '../../constants.js';
import { t, type TranslationKey } from '../../i18n/index.js';
import { transport } from '../../transport/index.js';
import { openDevRoom } from '../devroom/devroomStore.js';
import { Face } from '../devroom/WorktreeRail.js';
import { timeAgo } from '../format.js';
import { DataText, type IconName, PixelIcon, Stamp } from '../game/parts.js';
import { hudGetSnapshot, minimizeWindow } from '../hud/hudStore.js';
import { useCldStore } from '../officeStore.js';
import { codexStatus, jobStatus } from '../panels/jobs.js';
import { worktreeOfTask } from '../repo/repoText.js';
import { serverLine } from '../serverText.js';
import { TaskWorktreeChip, TaskWorktreeDetail } from '../workbench/TaskWorktree.js';
import { TaskWorktreeScope } from '../workbench/taskWorktreeScope.js';
import {
  assigneeOf,
  type BoardFilter,
  type BoardItem,
  boardItems,
  docDrift,
  dropEdit,
  filterChoices,
  filterItems,
  type Goal,
  goalProgress,
  GOALS,
  groupItems,
  nestItems,
  newlyDone,
  NO_FILTER,
  nowStrip,
  type ObservedRun,
  OTHER_GOAL,
  stampDate,
  STATUS_ORDER,
  statusesOf,
  toggleGoalFilter,
  trackedCount,
  withMoves,
} from './taskBoardState.js';

// SPT-P3-ISSUES: the spec part (요구사항 filter, a Task's requirements) is a lazy chunk.
const ReqFilter = lazy(() => import('../spec/TaskReqs.js').then((m) => ({ default: m.ReqFilter })));
const TaskReqs = lazy(() => import('../spec/TaskReqs.js').then((m) => ({ default: m.TaskReqs })));
const QuestReq = lazy(() => import('../spec/QuestReq.js').then((m) => ({ default: m.QuestReq })));

const OWNER_KINDS: BoardTaskOwnerKind[] = ['lead', 'worker', 'subagent', 'codex', 'user', 'unassigned'];
const PRIORITIES = ['P0', 'P1', 'P2', 'later'];
const section = 'pixel-panel p-12 min-w-0';
const STATUS_ICON = { doing: 'gear', review: 'lens', blocked: 'stop', proposed: 'flag', todo: 'board', done: 'check' } as const satisfies Record<BoardTaskStatus, string>;

const muted = 'text-text-muted text-xs';
const chip = 'quest-pill text-xs';
const control = 'ui-input px-6 py-2 text-xs min-w-0 max-w-full';
const button = 'ui-raise bg-btn-bg border-ui border-border rounded-ui-card hover:border-border-hi px-8 py-4 text-xs pointer-coarse:min-h-44 cursor-pointer';
/** A status pill's tone (quest.css .quest-pill[data-tone]). */
const STATUS_PILL = { doing: 'busy', review: 'review', blocked: 'bad', proposed: 'accent', todo: 'muted', done: 'ok' } as const satisfies Record<BoardTaskStatus, string>;
const PRIORITY_PILL: Record<string, string> = { P0: 'bad', P1: 'warn', P2: 'muted', later: 'muted' };
/** The status groups in the order the columns run. */
const COLUMN_ORDER: BoardTaskStatus[] = ['todo', 'proposed', 'doing', 'review', 'blocked', 'done'];

function StatusPill({ status }: { status: BoardTaskStatus }) {
  return (
    <span className="quest-pill text-xs" data-tone={STATUS_PILL[status]} data-testid="quest-status">
      {status === 'done' && <PixelIcon name="check" size={12} />}
      {t(`tasks.status.${status}`)}
    </span>
  );
}

/** The board's width class: a list, status columns, or columns plus a detail side panel (quest.css [data-layout]). */
function useLayout(ref: RefObject<HTMLElement | null>): 'list' | 'cols' | 'side' {
  const [layout, setLayout] = useState<'list' | 'cols' | 'side'>('list');
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width;
      setLayout(w >= QUEST_SIDE_MIN_PX ? 'side' : w >= QUEST_COLS_MIN_PX ? 'cols' : 'list');
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return layout;
}
const STATUS_TONE: Record<BoardTaskStatus, string> = {
  doing: 'text-accent-text',
  review: 'text-yellow-300',
  blocked: 'text-red-400',
  proposed: 'text-accent-text',
  todo: 'text-text',
  done: 'text-text-muted',
};
const GOAL_LABELS: Record<Goal, TranslationKey> = {
  Security: 'tasks.goal.security',
  'Core Orchestration': 'tasks.goal.coreOrchestration',
  'Collaboration & Workbench': 'tasks.goal.collaborationWorkbench',
  'Desktop & Installer': 'tasks.goal.desktopInstaller',
  'UX & Onboarding': 'tasks.goal.uxOnboarding',
  'Release Candidate': 'tasks.goal.releaseCandidate',
  'Public Release': 'tasks.goal.publicRelease',
};

function goalText(goal: string): string {
  return GOALS.includes(goal as Goal) ? t(GOAL_LABELS[goal as Goal]) : goal;
}

const MVP_PROGRESS_OPEN_KEY = 'cld.task-board.mvp-progress-open';

function savedMvpProgressOpen(): boolean {
  try {
    return localStorage.getItem(MVP_PROGRESS_OPEN_KEY) !== 'closed';
  } catch {
    return true;
  }
}

function saveMvpProgressOpen(open: boolean): void {
  try {
    localStorage.setItem(MVP_PROGRESS_OPEN_KEY, open ? 'open' : 'closed');
  } catch {
    // A locked-down browser keeps the current visit's setting only.
  }
}

function ownerText(o: BoardTaskOwner | null): string {
  if (!o || (o.kind === 'unassigned' && !o.name)) return t('tasks.owner.unassigned');
  return o.name ? `${o.name} · ${t(`tasks.owner.${o.kind}`)}` : t(`tasks.owner.${o.kind}`);
}

/** A run's state in the engine's words, with the times it has. */
function runText(r: ObservedRun, now: number): string {
  if (r.job) return jobStatus(r.job, now).text;
  return r.codex ? codexStatus(r.codex, now) : t('jobs.outcome.failed');
}

function RunBadge({ run, now }: { run: ObservedRun; now: number }) {
  return (
    <span className="text-xs" data-testid="task-run" data-run-ref={run.id}>
      <span className={`${chip} text-accent-text`}>{t('tasks.source.observed')}</span>{' '}
      {run.kind === 'codex' ? 'Codex' : t('panel.job')} · {runText(run, now)}
    </span>
  );
}

/** U-48: where a tracked line comes from, in the three words of D6 (관측 / 보고 / 추정). */
function TrackedSource({ source }: { source: TrackedItem['source'] }) {
  const hint = source === 'observed' || source === 'reported' || source === 'inferred' ? source : null;
  return (
    <span
      className={`${chip} ${source === 'observed' ? 'text-accent-text' : 'text-text-muted'}`}
      title={hint ? t(`tasks.tracked.${hint}Hint`) : undefined}
      data-testid="tracked-source"
      data-source={source}
    >
      {t(`tasks.source.${source}`)}
    </span>
  );
}

const trackedStatusText = (status: TrackedItem['status']) =>
  status === 'unknown' ? t('tasks.tracked.unknown') : t(`tasks.status.${status}`);
const trackedTone = (status: TrackedItem['status']) =>
  status === 'unknown' || status === 'cancelled' ? 'text-text-muted' : STATUS_TONE[status];

/** U-48 2a: where a document line was seen, relative to its project folder. */
const docRef = (line: TrackedItem) => (line.path ? (line.line ? `${line.path}:${line.line}` : line.path) : line.ref);

function DocChips({ item }: { item: TrackedItem }) {
  return (
    <>
      {item.gone && (
        <span className={`${chip} text-text-muted`} title={t('tasks.tracked.goneHint')} data-testid="tracked-gone">
          {t('tasks.tracked.gone')}
        </span>
      )}
      {item.duplicate && (
        <span className={`${chip} text-yellow-300`} title={t('tasks.tracked.duplicateHint')} data-testid="tracked-duplicate">
          {t('tasks.tracked.duplicate')}
        </span>
      )}
    </>
  );
}

/** U-48: one line of an agent's own list (read-only): its status word, where the word comes from, and where it was seen. */
function TrackedLine({
  line,
  now,
  indent = false,
  testId = 'tracked-line',
  drift = false,
}: {
  line: TrackedItem;
  now: number;
  indent?: boolean;
  testId?: string;
  drift?: boolean;
}) {
  if (line.unreadable)
    return (
      <li className={muted} data-testid="tracked-unreadable">
        {t('tasks.tracked.unreadable')}
      </li>
    );
  const status = trackedTone(line.status);
  const ref = docRef(line);
  const where = [
    line.reporter && t('tasks.tracked.reporter', { name: line.reporter }),
    ref && t('tasks.tracked.from', { ref }),
    line.rawStatus && t('tasks.tracked.raw', { raw: line.rawStatus }),
    line.changedAt && timeAgo(line.changedAt, now),
  ].filter(Boolean);
  return (
    <li
      className={`min-w-0 text-xs ${indent ? 'ml-12' : ''}`}
      data-testid={testId}
      data-tracked-key={line.key}
      {...(drift && { 'data-drift': true })}
      data-tracked-status={line.status}
      data-tracked-source={line.source}
      {...(line.gone && { 'data-tracked-gone': true })}
    >
      <span className="flex flex-wrap gap-4 items-baseline min-w-0">
        <span className={`${chip} ${status}`} data-testid="tracked-status">
          {trackedStatusText(line.status)}
        </span>
        <TrackedSource source={line.source} />
        {line.taskId && line.kind === 'doc' && <span className="text-text-muted">{line.taskId}</span>}
        <span className={`break-words min-w-0 ${line.gone ? 'line-through' : ''}`} data-testid="tracked-title">
          {line.title}
        </span>
        <DocChips item={line} />
      </span>
      {where.length > 0 && <span className="block text-text-muted break-words">{where.join(' · ')}</span>}
    </li>
  );
}

/** A document's lines: a heading with lines under it is a group label, its lines indented. */
function LineList({ lines, now }: { lines: TrackedItem[]; now: number }) {
  const parents = new Set(lines.map((l) => l.parentKey));
  const heads = new Set(lines.filter((l) => parents.has(l.key)).map((l) => l.key));
  return lines.map((line) =>
    heads.has(line.key) ? (
      <li key={line.key} className="text-text-muted text-xs list-none break-words" data-testid="tracked-heading">
        {line.title}
      </li>
    ) : (
      <TrackedLine key={line.key} line={line} now={now} indent={!!line.parentKey && heads.has(line.parentKey)} />
    ),
  );
}

function TrackedLines({ item, now }: { item: BoardItem; now: number }) {
  const all = item.trackedChildren ?? [];
  const agent = item.source === 'tracked' ? all : all.filter((l) => l.kind !== 'doc');
  const docLines = item.source === 'tracked' ? [] : all.filter((l) => l.kind === 'doc');
  const docs = item.trackedDocs ?? [];
  const mentions = item.trackedMentions ?? [];
  if (!agent.length && !item.trackedMore && !docs.length && !docLines.length && !mentions.length) return null;
  return (
    <>
      {(agent.length > 0 || !!item.trackedMore) && (
        <ul className="mt-8 ml-12 space-y-4" data-testid="tracked-lines">
          {item.source !== 'tracked' && (
            <li className="text-text-muted text-xs list-none">{t('tasks.tracked.agentTasks')}</li>
          )}
          <LineList lines={agent} now={now} />
          {!!item.trackedMore && (
            <li className={muted} data-testid="tracked-more">
              {t('tasks.tracked.more', { count: item.trackedMore })}
            </li>
          )}
        </ul>
      )}
      {(docs.length > 0 || docLines.length > 0) && (
        <ul className="mt-8 ml-12 space-y-4" data-testid="tracked-doc-lines">
          <li className="text-text-muted text-xs list-none">{t('tasks.tracked.docSources')}</li>
          {item.trackedDrift && item.task && (
            <li className="text-xs flex flex-wrap gap-4 items-baseline" data-testid="tracked-task-line">
              <span className={`${chip} ${STATUS_TONE[item.task.status]}`}>{t(`tasks.status.${item.task.status}`)}</span>
              <TrackedSource source="reported" />
              <span>{t('tasks.tracked.taskLine')}</span>
            </li>
          )}
          {docs.map((d) => (
            <TrackedLine key={d.key} line={d} now={now} testId="tracked-doc-source" drift={!!item.task && docDrift(item.task, d)} />
          ))}
          <LineList lines={docLines} now={now} />
        </ul>
      )}
      {mentions.length > 0 && (
        <p
          className={`${muted} mt-4 ml-12`}
          title={[...new Set(mentions.map((m) => m.path))].join(', ')}
          data-testid="tracked-mentions"
        >
          {t('tasks.tracked.mentions', { count: mentions.length })}
        </p>
      )}
    </>
  );
}

function SourceBadge({ item }: { item: BoardItem }) {
  if (item.tracked) return <TrackedSource source={item.tracked.source} />;
  return (
    <span
      className={`${chip} ${item.source === 'observed' ? 'text-accent-text' : 'text-text-muted'}`}
      title={t(item.source === 'observed' ? 'tasks.source.observedHint' : 'tasks.source.reportedHint')}
      data-testid="task-source"
    >
      {t(item.source === 'observed' ? 'tasks.source.observed' : 'tasks.source.reported')}
    </span>
  );
}

/** D6: where a fact comes from, as a small chip. */
function FactSource({ source }: { source: BoardFactSource }) {
  return (
    <span
      className={`${chip} ${source === 'observed' ? 'text-accent-text' : 'text-text-muted'}`}
      data-testid="fact-source"
      data-source={source}
    >
      {t(`tasks.source.${source}`)}
    </span>
  );
}

const yesNo = (v: boolean) => t(v ? 'tasks.yes' : 'tasks.no');

/** D6: the task's facts, each with its source; only the ones someone recorded. */
function TaskFacts({ task, now }: { task: BoardTask; now: number }) {
  type FactKey = 'status' | 'reportedDone' | 'commits' | 'filesChanged' | 'testsRan' | 'testsPassed';
  const rows: Array<[FactKey, string, BoardFactSource, string | null]> = [
    ['status', t(`tasks.status.${task.status}`), task.statusSource ?? 'unknown', null],
  ];
  const add = (key: FactKey, f: { value: boolean | number; source: BoardFactSource; at: string } | undefined) => {
    if (f) rows.push([key, typeof f.value === 'boolean' ? yesNo(f.value) : String(f.value), f.source, f.at]);
  };
  add('reportedDone', task.reportedDone);
  add('commits', task.commits);
  add('filesChanged', task.filesChanged);
  add('testsRan', task.testsRan);
  add('testsPassed', task.testsPassed);
  return (
    <div data-testid="task-facts">
      <h4 className="quest-h">{t('tasks.facts')}</h4>
      {rows.map(([key, value, source, at]) => (
        <p key={key} className="quest-fact" data-fact={key}>
          {t(`tasks.fact.${key}`, { value })} <FactSource source={source} />
          {at && <span className="text-text-muted"> · {timeAgo(at, now)}</span>}
        </p>
      ))}
    </div>
  );
}

/** D6: one Execution with what the daemon recorded (and how it knows). */
function ExecutionRow({ e, now }: { e: BoardExecution; now: number }) {
  return (
    <p className="flex flex-wrap gap-4 items-center" data-testid="task-execution" data-execution={e.id}>
      <span>{e.kind === 'codex' ? 'Codex' : e.kind === 'job' ? t('panel.job') : e.kind}</span>
      <span className="text-text-muted break-all">{e.ref}</span>
      {e.startedAt && <span className="text-text-muted">{t('tasks.exec.started', { time: timeAgo(e.startedAt, now) })}</span>}
      {e.endedAt ? (
        <span>
          {t('tasks.exec.ended', { time: timeAgo(e.endedAt.value, now) })} <FactSource source={e.endedAt.source} />
        </span>
      ) : (
        <span className="text-text-muted">{t('tasks.exec.open')}</span>
      )}
      {e.exit && (
        <span>
          {t('tasks.exec.exit', { code: e.exit.value })} <FactSource source={e.exit.source} />
        </span>
      )}
      {e.commits && (
        <span>
          {t('tasks.exec.commits', { count: e.commits.value })} <FactSource source={e.commits.source} />
        </span>
      )}
      {e.limit && (
        <span>
          {t('tasks.exec.limit')} <FactSource source={e.limit.source} />
        </span>
      )}
    </p>
  );
}

function NowStrip({ items, now }: { items: BoardItem[]; now: number }) {
  const rows = nowStrip(items);
  return (
    <section className="quest-now" aria-label={t('tasks.now')} data-testid="task-now">
      <strong className="quest-h">{t('tasks.now')}</strong>
      {rows.length === 0 && <p className={`${muted} mt-4`}>{t('tasks.nowEmpty')}</p>}
      <ul className="quest-now-rows">
        {rows.map((row) => (
          <li key={row.key} className="min-w-0 ui-card quest-now-row" data-testid="task-now-row">
            <div className="flex flex-wrap items-center gap-4 text-sm">
              <strong className="break-words min-w-0">{row.owner?.name || t('tasks.owner.unassigned')}</strong>
              {row.owner?.name && <span className={chip}>{t(`tasks.owner.${row.owner.kind}`)}</span>}
            </div>
            <ul className="mt-2 space-y-2">
              {row.items.map((i) => (
                <li key={i.key} className="text-xs min-w-0 break-words" data-task-id={i.id}>
                  <span className="text-text-muted">{i.id}</span> {i.title}
                  <span className="text-text-muted">
                    {i.since && ` · ${t('tasks.since', { time: timeAgo(i.since, now) })}`}
                    {i.task?.branch && ` · ${t('tasks.branch', { branch: i.task.branch })}`}
                  </span>
                  {i.source === 'reported' &&
                    i.runs.map((r) => (
                      <span key={r.id}>
                        {' '}
                        <RunBadge run={r} now={now} />
                      </span>
                    ))}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}

function send(id: string | undefined, fields: TaskEditFields) {
  transport.send({ type: 'taskEdit', ...(id && { id }), fields });
}

function TaskEditor({ item }: { item: BoardItem }) {
  const task = item.task!;
  const [status, setStatus] = useState<BoardTaskStatus>(task.status);
  const [priority, setPriority] = useState(task.priority ?? '');
  const [kind, setKind] = useState<BoardTaskOwnerKind>(task.owner?.kind ?? 'unassigned');
  const [name, setName] = useState(task.owner?.name ?? '');
  const [note, setNote] = useState(task.note ?? '');
  const save = () => {
    const fields: TaskEditFields = {};
    if (status !== task.status) fields.status = status;
    if (priority !== (task.priority ?? '')) fields.priority = priority;
    if (kind !== (task.owner?.kind ?? 'unassigned') || name.trim() !== (task.owner?.name ?? ''))
      fields.owner = { kind, name: name.trim() };
    if (note !== (task.note ?? '')) fields.note = note;
    if (Object.keys(fields).length) send(task.id, fields);
  };
  return (
    <div className="quest-editor" data-testid="task-editor">
      <label className="flex flex-col gap-2 text-xs">
        {t('tasks.statusLabel')}
        <select
          aria-label={t('tasks.statusLabel')}
          className={control}
          value={status}
          onChange={(e) => setStatus(e.target.value as BoardTaskStatus)}
        >
          {STATUS_ORDER.map((s) => (
            <option key={s} value={s}>
              {t(`tasks.status.${s}`)}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-2 text-xs">
        {t('tasks.priority')}
        <select aria-label={t('tasks.priority')} className={control} value={priority} onChange={(e) => setPriority(e.target.value)}>
          <option value="">{t('tasks.priorityNone')}</option>
          {PRIORITIES.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-2 text-xs">
        {t('tasks.filter.owner')}
        <select
          aria-label={t('tasks.filter.owner')}
          className={control}
          value={kind}
          onChange={(e) => setKind(e.target.value as BoardTaskOwnerKind)}
        >
          {OWNER_KINDS.map((k) => (
            <option key={k} value={k}>
              {t(`tasks.owner.${k}`)}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-2 text-xs min-w-0 flex-1">
        {t('tasks.ownerName')}
        <input aria-label={t('tasks.ownerName')} className={control} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="flex flex-col gap-2 text-xs w-full">
        {t('tasks.note')}
        <textarea aria-label={t('tasks.note')} className={`${control} w-full`} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
      </label>
      <Button size="sm" variant="accent" onClick={save}>
        {t('tasks.save')}
      </Button>
    </div>
  );
}

function TaskDetail({ item, now, readOnly }: { item: BoardItem; now: number; readOnly: boolean }) {
  const task = item.task;
  const links = task?.links ?? [];
  return (
    <div className="quest-detail text-xs min-w-0 break-words" data-testid="task-detail">
      {task?.detail && <p className="whitespace-pre-wrap">{task.detail}</p>}
      {task?.note && (
        <p className="whitespace-pre-wrap">
          <span className="text-text-muted">{t('tasks.note')} · </span>
          {task.note}
        </p>
      )}
      {!task && item.tracked && <p className={muted}>{t('tasks.tracked.readOnly')}</p>}
      {item.tracked?.kind === 'doc' && item.project && !readOnly && (
        <button
          type="button"
          className={button}
          data-testid="tracked-hide"
          onClick={() => transport.send({ type: 'trackingSettings', project: item.project!, hide: item.key })}
        >
          {t('tasks.tracked.hide')}
        </button>
      )}
      {!task && !item.tracked && <p className={muted}>{t('tasks.noDetail')}</p>}
      {task && <TaskFacts task={task} now={now} />}
      {task && <TaskWorktreeDetail task={task} />}
      {task && (
        <Suspense fallback={null}>
          <TaskReqs project={task.project} taskId={task.id} readOnly={readOnly} />
        </Suspense>
      )}
      {task?.executions && task.executions.length > 0 && (
        <div>
          <h4 className="quest-h">{t('tasks.executions')}</h4>
          {task.executions.map((e) => (
            <ExecutionRow key={e.id} e={e} now={now} />
          ))}
        </div>
      )}
      {task?.goal && <p className={muted}>{t('tasks.filter.goal')} · {task.goal}</p>}
      {(item.runs.length > 0 || item.missing.length > 0) && (
        <div>
          <h4 className="quest-h">{t('tasks.runs')}</h4>
          {item.runs.map((r) => (
            <p key={r.id}>
              <RunBadge run={r} now={now} /> <span className="text-text-muted">{r.id}</span>
              {r.branch && <span className="text-text-muted"> · {t('tasks.branch', { branch: r.branch })}</span>}
            </p>
          ))}
          {item.missing.map((id) => (
            <p key={id} className={muted}>
              {t('tasks.notSeen', { id })}
            </p>
          ))}
        </div>
      )}
      {links.some((l) => l.kind === 'url') && (
        <div>
          <h4 className="quest-h">{t('tasks.links')}</h4>
          {links
            .filter((l) => l.kind === 'url')
            .map((l) => (
              <p key={l.ref} className="break-all">
                {/^https?:\/\//.test(l.ref) ? (
                  <a href={l.ref} target="_blank" rel="noreferrer noopener" className="underline">
                    {l.ref}
                  </a>
                ) : (
                  l.ref
                )}
              </p>
            ))}
        </div>
      )}
      {task && task.history.length > 0 && (
        <details>
          <summary className="quest-h cursor-pointer">{t('tasks.history')} ({task.history.length})</summary>
          <ul className="mt-4 space-y-2" data-testid="task-history">
            {[...task.history].reverse().map((h, n) => (
              <li key={n}>
                <span className="text-text-muted">{timeAgo(h.at, now)} · {h.by} · </span>
                {h.change}
              </li>
            ))}
          </ul>
        </details>
      )}
      {task && !readOnly && <TaskEditor key={task.updatedAt} item={item} />}
    </div>
  );
}

/** The assignee's face, name and age: a card's foot and the side panel's head. */
function Who({ item, now, quest, removed }: { item: BoardItem; now: number; quest: QuestCtx; removed: readonly string[] }) {
  const assignee = assigneeOf(item.task, removed);
  // The face row: the assignee, else a named owner (lead · alpha), else nobody.
  const owned = !!item.owner && (item.owner.kind !== 'unassigned' || !!item.owner.name);
  const who = assignee?.name ?? (owned ? item.owner?.name : undefined);
  return (
    <span className="quest-who text-sm" data-testid="quest-who">
      {who ? <Face agentId={quest.agents.get(who) ?? null} name={who} size={32} /> : <span className="quest-noface" aria-hidden="true" />}
      <span className="min-w-0">
        {assignee ? (
          <span className={`block truncate ${assignee.removed ? 'text-text-muted' : ''}`} data-testid="task-assignee">
            <DataText text={assignee.removed ? t('tasks.assigneeRemoved', { name: assignee.name }) : assignee.name} />
          </span>
        ) : (
          <span className="block truncate" data-testid="task-owner">
            <DataText text={owned ? ownerText(item.owner) : t('game.quest.noOwner')} />
          </span>
        )}
        {item.updatedAt && <span className="block text-text-muted">{timeAgo(item.updatedAt, now)}</span>}
      </span>
    </span>
  );
}

/** GAME-UI-1: the agents' ids by name (faces), the cards whose stamp is new, the project the spec part reads; the card detail opens in place unless the side panel shows it. */
interface QuestCtx {
  agents: ReadonlyMap<string, number | null>;
  fresh: ReadonlySet<string>;
  spec: string | null;
  inline: boolean;
  /** A Task card may be dragged to another column (columns on screen, a screen that may edit Tasks): the drag's start and end. */
  drag: { start: (key: string) => void; end: () => void } | null;
}

/** "개발실에서 열기" on an issue linked to a worktree (its own) or to an agent in the office: the 개발실 on it. */
function DevroomOpen({ item, quest }: { item: BoardItem; quest: QuestCtx }) {
  const scope = useContext(TaskWorktreeScope);
  const task = item.task;
  if (!task) return null;
  const wt = scope && task.project === scope.project ? worktreeOfTask(scope.worktrees, task.id) : undefined;
  const who = task.assignee?.name ?? (task.owner && task.owner.kind !== 'unassigned' ? task.owner.name : undefined);
  if (!wt && !(who && quest.agents.get(who) != null)) return null;
  return (
    <button
      type="button"
      className={`${button} quest-dev`}
      data-testid="task-open-devroom"
      title={t('tasks.openDevroomTitle', { name: wt?.task ?? who ?? '' })}
      onClick={() => {
        // A maximized window stays above the others: a maximized 현황판 steps aside for the 개발실.
        if (hudGetSnapshot().layout.items.office?.max) minimizeWindow('office');
        openDevRoom(task.project, wt?.task ?? null);
      }}
    >
      {t('devroom.openButton')}
    </button>
  );
}

function TaskCard({
  item,
  now,
  openKey,
  onToggle,
  readOnly,
  removed,
  children,
  quest,
}: {
  item: BoardItem;
  now: number;
  openKey: string | null;
  onToggle: (key: string) => void;
  readOnly: boolean;
  removed: readonly string[];
  children?: BoardItem[];
  quest: QuestCtx;
}) {
  const open = openKey === item.key;
  const stamped = !!item.task && item.status === 'done';
  const drag = item.task && quest.drag;
  return (
    <li
      className="quest-card ui-card"
      {...(drag && {
        draggable: true,
        title: t('tasks.drag.hint'),
        onDragStart: (e: DragEvent) => {
          e.stopPropagation(); // a child card is its own drag, not its parent's
          e.dataTransfer.setData('text/plain', item.key);
          e.dataTransfer.effectAllowed = 'move';
          drag.start(item.key);
        },
        onDragEnd: drag.end,
      })}
      data-done={stamped || undefined}
      data-selected={open || undefined}
      data-testid="task-card"
      data-task-id={item.id}
      data-task-status={item.status}
      {...(item.tracked && { 'data-tracked': item.tracked.key })}
      {...(item.task?.parentId && { 'data-task-parent': item.task.parentId })}
    >
      <button type="button" className="w-full text-left min-w-0 quest-body" aria-expanded={open} onClick={() => onToggle(item.key)}>
        <span className="quest-top">
          <span className="quest-id">{item.id !== item.title ? item.id : ''}</span>
        </span>
        <strong className="quest-title break-words min-w-0" data-testid="task-title">
          {item.title}
        </strong>
        {item.task && quest.spec && (
          <Suspense fallback={null}>
            <QuestReq project={quest.spec} task={item.task} />
          </Suspense>
        )}
        <span className="quest-chips text-xs">
          {item.task?.priority && (
            <span className={chip} data-tone={PRIORITY_PILL[item.task.priority]} data-testid="quest-priority">
              {item.task.priority}
            </span>
          )}
          {item.task?.goal && (
            <span className={`${chip} quest-label`} data-tone="accent" title={goalText(item.task.goal)}>
              {goalText(item.task.goal)}
            </span>
          )}
          {item.task?.status === 'review' && (
            <span className={`${chip} text-accent-text`} data-testid="task-review-chip">
              {t('review.chip')}
            </span>
          )}
          {item.tracked ? (
            <>
              <span className={chip} data-testid="tracked-kind">
                {item.tracked.kind === 'doc' ? t('tasks.tracked.kind.doc') : t('tasks.tracked.session')}
              </span>
              {item.tracked.path && item.tracked.path !== item.title && (
                <span className="text-text-muted break-all">{item.tracked.path}</span>
              )}
              <DocChips item={item.tracked} />
              {item.tracked.ended && (
                <span className={`${chip} text-text-muted`} data-testid="tracked-ended">
                  {t('tasks.tracked.ended')}
                </span>
              )}
            </>
          ) : null}
          {item.trackedDrift && (
            <span className={`${chip} text-red-400`} title={t('tasks.tracked.driftHint')} data-testid="tracked-drift">
              {t('tasks.tracked.drift')}
            </span>
          )}
          <SourceBadge item={item} />
          {item.tracked && item.updatedAt && <span className="text-text-muted">{timeAgo(item.updatedAt, now)}</span>}
          {item.task?.branch && <span className="text-text-muted break-all">⎇ {item.task.branch}</span>}
          <TaskWorktreeChip task={item.task} />
          {item.project && <span className="text-text-muted">{item.project}</span>}
        </span>
        {item.source === 'reported' && item.runs.length > 0 && (
          <span className="flex flex-wrap gap-4">
            {item.runs.map((r) => (
              <RunBadge key={r.id} run={r} now={now} />
            ))}
          </span>
        )}
        {item.source === 'observed' && item.runs[0] && <span className="block text-xs">{runText(item.runs[0], now)}</span>}
        <span className="quest-card-foot">
          {!item.tracked && <Who item={item} now={now} quest={quest} removed={removed} />}
          {!stamped && <StatusPill status={item.status} />}
        </span>
      </button>
      {stamped && (
        <span className="quest-stamp">
          <Stamp still={!quest.fresh.has(item.key)} sub={stampDate(item.updatedAt)}>
            {t('game.quest.done')}
          </Stamp>
        </span>
      )}
      <DevroomOpen item={item} quest={quest} />
      {open && quest.inline && <TaskDetail item={item} now={now} readOnly={readOnly} />}
      <TrackedLines item={item} now={now} />
      {children && children.length > 0 && (
        <ul className="quest-children" data-testid="task-children">
          {children.map((c) => (
            <TaskCard
              key={c.key}
              item={c}
              now={now}
              openKey={openKey}
              onToggle={onToggle}
              readOnly={readOnly}
              removed={removed}
              quest={quest}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function AddTask({ projects, first = 'todo', onDone }: { projects: string[]; first?: BoardTaskStatus; onDone: () => void }) {
  const [title, setTitle] = useState('');
  const [project, setProject] = useState(projects[0] ?? '');
  const [status, setStatus] = useState<BoardTaskStatus>(first);
  const ok = title.trim() && project.trim();
  return (
    <form
      className={`${section} flex flex-wrap gap-8 items-end`}
      data-testid="task-add"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ok) return;
        send(undefined, { title: title.trim(), project: project.trim(), status });
        onDone();
      }}
    >
      <label className="flex flex-col gap-2 text-xs w-full">
        {t('tasks.title')}
        <input aria-label={t('tasks.title')} className={control} value={title} onChange={(e) => setTitle(e.target.value)} />
      </label>
      <label className="flex flex-col gap-2 text-xs min-w-0 flex-1">
        {t('tasks.project')}
        <input
          aria-label={t('tasks.project')}
          className={control}
          list="task-projects"
          value={project}
          onChange={(e) => setProject(e.target.value)}
        />
        <datalist id="task-projects">
          {projects.map((p) => (
            <option key={p} value={p} />
          ))}
        </datalist>
      </label>
      <select aria-label={t('tasks.statusLabel')} className={control} value={status} onChange={(e) => setStatus(e.target.value as BoardTaskStatus)}>
        {STATUS_ORDER.map((s) => (
          <option key={s} value={s}>
            {t(`tasks.status.${s}`)}
          </option>
        ))}
      </select>
      <Button size="sm" variant="accent" type="submit" disabled={!ok}>
        {t('tasks.save')}
      </Button>
      <Button size="sm" onClick={onDone}>
        {t('tasks.cancel')}
      </Button>
    </form>
  );
}

function FilterSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string | null;
  options: Array<[string, string]>;
  onChange: (v: string | null) => void;
}) {
  return (
    <label className="quest-filter text-xs min-w-0">
      <span className="shrink-0 text-text-muted">{label}</span>
      <select aria-label={label} className={control} value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
        <option value="">{t('tasks.filter.all')}</option>
        {options.map(([v, text]) => (
          <option key={v} value={v}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}

function MvpProgress({
  progress,
  filter,
  setFilter,
  open,
  setOpen,
  apart,
}: {
  /** U-48: tracked items the progress does not count. */
  apart: number;
  progress: ReturnType<typeof goalProgress>;
  filter: BoardFilter;
  setFilter: (next: BoardFilter | ((current: BoardFilter) => BoardFilter)) => void;
  open: boolean;
  setOpen: (open: boolean) => void;
}) {
  const percent = progress.overall.total ? Math.round((progress.overall.done / progress.overall.total) * 100) : 0;
  const changeOpen = () => {
    const next = !open;
    setOpen(next);
    saveMvpProgressOpen(next);
  };
  return (
    <section className="quest-tile quest-mvp" data-testid="mvp-progress">
      <div className="flex items-center gap-8 min-w-0">
        <span className="ui-card-tile">
          <PixelIcon name="flag" />
        </span>
        <div className="min-w-0 flex-1 space-y-4">
          <p className="text-xs">{t('tasks.mvp.progress', { ...progress.overall, percent })}</p>
          <span className="quest-bar" aria-hidden="true">
            <span style={{ width: `${percent}%` }} />
          </span>
        </div>
        <Button
          size="icon_md"
          aria-label={t(open ? 'tasks.mvp.hide' : 'tasks.mvp.show')}
          aria-expanded={open}
          onClick={changeOpen}
        >
          {open ? '▼' : '▶'}
        </Button>
      </div>
      {apart > 0 && (
        <p className={muted} data-testid="tracked-apart">
          {t('tasks.tracked.apart', { count: apart })}
        </p>
      )}
      {open && (
        <div className="quest-mvp-rows">
          {progress.goals.map((row) => {
            const goal = row.goal;
            const donePercent = row.total ? (row.done / row.total) * 100 : 0;
            const activePercent = row.total ? (row.active / row.total) * 100 : 0;
            const label = goal === OTHER_GOAL ? t('tasks.goal.other') : goalText(goal);
            const rowClass = `w-full grid grid-cols-[minmax(0,1fr)_minmax(64px,2fr)_auto] items-center gap-6 text-left text-xs min-w-0 ${
              goal !== OTHER_GOAL && filter.goal === goal ? 'text-accent-text' : 'text-text'
            }`;
            const contents = (
              <>
                <span className="truncate">{label}</span>
                <span className="quest-bar" aria-hidden="true">
                  <span style={{ width: `${donePercent}%` }} />
                  <span data-active style={{ width: `${activePercent}%` }} />
                </span>
                <span className="text-text-muted tabular-nums">{row.done}/{row.total}</span>
              </>
            );
            if (goal === OTHER_GOAL) {
              return (
                <div key={goal} className={rowClass}>
                  {contents}
                </div>
              );
            }
            return (
              <button
                key={goal}
                type="button"
                className={rowClass}
                aria-pressed={filter.goal === goal}
                onClick={() => setFilter((current) => toggleGoalFilter(current, goal))}
              >
                {contents}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

export function TaskBoardView({ now }: { now: number }) {
  const { taskBoard, codexTasks, officeJobs, officeReadOnly, tracked, officeSnapshot } = useCldStore();
  const [filter, setFilter] = useState<BoardFilter>(NO_FILTER);
  const [openKey, setOpenKey] = useState<string | null>(null);
  // null: the layout decides (folded in a list, open as a column), a press on the header decides after that.
  const [doneChoice, setDoneChoice] = useState<boolean | null>(null);
  const [adding, setAdding] = useState<BoardTaskStatus | null>(null);
  const [query, setQuery] = useState('');
  const boardRef = useRef<HTMLDivElement>(null);
  const layout = useLayout(boardRef);
  const doneOpen = doneChoice ?? layout !== 'list';
  const [mvpProgressOpen, setMvpProgressOpen] = useState(savedMvpProgressOpen);
  const specProject = useContext(TaskWorktreeScope)?.project ?? null;
  const [reqOpen, setReqOpen] = useState(false);
  const boardOnly = useMemo(
    () => boardItems(taskBoard?.tasks ?? [], codexTasks?.tasks, officeJobs?.jobs, Object.values(tracked)),
    [taskBoard, codexTasks, officeJobs, tracked],
  );
  // FEAT-BOARD-LESS: a dropped card sits in its new column until the daemon answers: saved, the board
  // everyone gets; refused, the truth back to this screen with why (a toast, officeStore). Either
  // answer is a new board, which drops the pending moves, so a refused card goes back by itself.
  // ponytail: a move the daemon never answers (the socket dropped) stays shown until the next board.
  const [moves, setMoves] = useState<{ board: typeof taskBoard; to: Record<string, BoardTaskStatus> }>({ board: taskBoard, to: {} });
  if (moves.board !== taskBoard) setMoves({ board: taskBoard, to: {} });
  const items = useMemo(() => withMoves(boardOnly, moves.board === taskBoard ? moves.to : {}), [boardOnly, moves, taskBoard]);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<BoardTaskStatus | null>(null);
  const drop = (status: BoardTaskStatus, key: string) => {
    setDragging(null);
    setOver(null);
    const item = items.find((i) => i.key === key);
    const edit = dropEdit(item, status, officeReadOnly);
    // Back to the column the board has it in: just forget the move.
    const to = { ...moves.to };
    if (edit) to[key] = status;
    else delete to[key];
    setMoves({ board: taskBoard, to });
    if (edit) send(edit.id, edit.fields);
  };
  const choices = useMemo(() => filterChoices(items), [items]);
  const progress = useMemo(() => goalProgress(items, filter), [items, filter]);
  const shown = filterItems(items, filter);
  const q = query.trim().toLowerCase();
  const matched = q
    ? shown.filter((i) =>
        [i.id, i.title, i.task?.note, i.task?.detail, i.task?.goal, i.owner?.name, i.task?.assignee?.name].some((v) => v?.toLowerCase().includes(q)),
      )
    : shown;
  const nest = nestItems(matched);
  const groups = groupItems(nest.top);
  const removed = taskBoard?.removedAssignees ?? [];
  // GAME-UI-1: a card that turns done while shown gets its 완료 stamp dropped once (React's
  // previous-render pattern: the statuses seen last, the cards newly done since).
  const statusKey = items.map((i) => `${i.key}=${i.status}`).join('\n');
  const [seen, setSeen] = useState(() => ({ key: statusKey, statuses: statusesOf(items), fresh: new Set<string>() }));
  if (seen.key !== statusKey) {
    const statuses = statusesOf(items);
    setSeen({ key: statusKey, statuses, fresh: newlyDone(seen.statuses, statuses) });
  }
  const orchs = officeSnapshot?.orchestrators;
  const canDrag = layout !== 'list' && !officeReadOnly;
  const quest = useMemo(
    () => ({
      agents: new Map((orchs ?? []).map((o) => [o.name, o.agentId] as const)),
      fresh: seen.fresh,
      spec: specProject,
      inline: layout !== 'side',
      drag: canDrag
        ? {
            // After the drag has begun: a DOM change inside dragstart (the empty columns showing) would cancel it.
            start: (key: string) => window.setTimeout(() => setDragging(key)),
            end: () => {
              setDragging(null);
              setOver(null);
            },
          }
        : null,
    }),
    [orchs, seen.fresh, specProject, layout, canDrag],
  );
  const counts = (status: BoardTaskStatus) => matched.filter((i) => i.status === status).length;
  const openItem = layout === 'side' && openKey ? items.find((i) => i.key === openKey) : undefined;
  const tiles: Array<{ id: string; icon: IconName; label: string; value: number }> = [
    { id: 'all', icon: 'list', label: t('questsLook.all'), value: matched.length },
    { id: 'doing', icon: 'gear', label: t('tasks.status.doing'), value: counts('doing') },
    { id: 'review', icon: 'lens', label: t('tasks.status.review'), value: counts('review') },
    ...(counts('blocked') ? [{ id: 'blocked', icon: 'stop' as const, label: t('tasks.status.blocked'), value: counts('blocked') }] : []),
    { id: 'done', icon: 'check', label: t('tasks.status.done'), value: counts('done') },
  ];
  const toggle = (key: string) => setOpenKey(openKey === key ? null : key);
  return (
    <div className="space-y-8 min-w-0 quest-board" data-testid="task-board" data-layout={layout} data-dragging={dragging !== null || undefined} ref={boardRef}>
      {taskBoard?.corrupt && (
        <p className="pixel-panel p-8 text-xs text-red-400 break-words" role="alert">
          {t('tasks.corrupt', { error: serverLine(taskBoard.corrupt) })}
        </p>
      )}
      {/* The overview first (the owner, 10-24 09:18: "진행상황이 한 눈에"): the counts, the MVP, then what runs now. */}
      <div className="quest-summary" style={{ ['--quest-tiles' as string]: tiles.length }}>
        {tiles.map((tile) => (
          <div key={tile.id} className="quest-tile" data-tone={tile.id} data-testid="quest-tile" data-count={tile.value}>
            <span className="ui-card-tile">
              <PixelIcon name={tile.icon} />
            </span>
            <span className="quest-tile-k">{tile.label}</span>
            <span className="quest-tile-v" data-zero={!tile.value || undefined}>
              {tile.value}
            </span>
          </div>
        ))}
        <MvpProgress
          progress={progress}
          filter={filter}
          setFilter={setFilter}
          open={mvpProgressOpen}
          setOpen={setMvpProgressOpen}
          apart={trackedCount(Object.values(tracked), filter.project)}
        />
      </div>
      <NowStrip items={shown} now={now} />
      <div className="quest-filters">
        <label className="quest-search">
          <PixelIcon name="lens" size={16} />
          <input
            type="search"
            aria-label={t('questsLook.searchLabel')}
            placeholder={t('questsLook.search')}
            className="ui-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            data-testid="quest-search"
          />
        </label>
        <FilterSelect
          label={t('tasks.filter.project')}
          value={filter.project}
          options={choices.projects.map((p) => [p, p])}
          onChange={(project) => setFilter({ ...filter, project })}
        />
        <FilterSelect
          label={t('tasks.filter.goal')}
          value={filter.goal}
          options={choices.goals.map((g) => [g, goalText(g)])}
          onChange={(goal) => setFilter({ ...filter, goal })}
        />
        <FilterSelect
          label={t('tasks.filter.owner')}
          value={filter.owner}
          options={choices.owners.map(([key, o]) => [key, ownerText(o)])}
          onChange={(owner) => setFilter({ ...filter, owner })}
        />
        <FilterSelect
          label={t('tasks.priority')}
          value={filter.priority}
          options={choices.priorities.map((p) => [p, p])}
          onChange={(priority) => setFilter({ ...filter, priority })}
        />
        {specProject &&
          (reqOpen || filter.requirement ? (
            <Suspense fallback={null}>
              <ReqFilter
                project={specProject}
                value={filter.requirement}
                onChange={(requirement) => setFilter((f) => ({ ...f, requirement }))}
                onClose={() => setReqOpen(false)}
              />
            </Suspense>
          ) : (
            <button type="button" className={button} onClick={() => setReqOpen(true)} data-testid="spec-issues-filter">
              {t('spec.issues.filter')} ▾
            </button>
          ))}
        {!officeReadOnly && !adding && (
          <Button size="sm" variant="accent" onClick={() => setAdding('todo')}>
            + {t('tasks.add')}
          </Button>
        )}
      </div>
      {adding && <AddTask key={adding} projects={choices.projects} first={adding} onDone={() => setAdding(null)} />}
      {items.length === 0 && <p className={`${muted} py-12 text-center`}>{t('tasks.empty')}</p>}
      {items.length > 0 && matched.length === 0 && (
        <p className={`${muted} py-12 text-center`}>{t('tasks.emptyFilter')}</p>
      )}
      <div className="quest-main">
        <div className="quest-cols">
          {groups
            // While a card is dragged every status is a column it can go to, an empty one too.
            .filter((g) => g.total > 0 || dragging !== null)
            .map((g) => {
              const folded = g.status === 'done' && !doneOpen;
              return (
                <section
                  key={g.status}
                  className="min-w-0 quest-col"
                  data-testid="task-group"
                  data-status={g.status}
                  data-order={COLUMN_ORDER.indexOf(g.status)}
                  data-drop={over === g.status || undefined}
                  {...(quest.drag && {
                    onDragOver: (e: DragEvent) => {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = 'move';
                      if (over !== g.status) setOver(g.status);
                    },
                    onDragLeave: (e: DragEvent) => {
                      if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver(null);
                    },
                    onDrop: (e: DragEvent) => {
                      e.preventDefault();
                      drop(g.status, e.dataTransfer.getData('text/plain'));
                    },
                  })}
                >
                  <div className="quest-colh">
                    {g.status === 'done' ? (
                      <button type="button" className="quest-colt text-left" aria-expanded={!folded} onClick={() => setDoneChoice(!doneOpen)}>
                        <PixelIcon name={STATUS_ICON.done} />
                        {folded ? '▶' : '▼'} {t('tasks.doneFold', { count: g.total })}
                      </button>
                    ) : (
                      <>
                        <h3 className="quest-colt" aria-label={`${t(`tasks.status.${g.status}`)} (${g.total})`}>
                          <PixelIcon name={STATUS_ICON[g.status]} />
                          <span>{t(`tasks.status.${g.status}`)}</span>
                          <span className="quest-colv">{g.total}</span>
                        </h3>
                        {!officeReadOnly && (
                          <Button size="icon_md" aria-label={t('questsLook.addIn', { status: t(`tasks.status.${g.status}`) })} onClick={() => setAdding(g.status)}>
                            +
                          </Button>
                        )}
                      </>
                    )}
                  </div>
                  {!folded && (
                    <ul className="quest-well">
                      {g.items.map((item) => (
                        <TaskCard
                          key={item.key}
                          item={item}
                          now={now}
                          openKey={openKey}
                          onToggle={toggle}
                          readOnly={officeReadOnly}
                          removed={removed}
                          children={nest.children.get(item.key)}
                          quest={quest}
                        />
                      ))}
                      {g.total > g.items.length && (
                        <li className={muted}>{t('tasks.doneMore', { shown: g.items.length, count: g.total })}</li>
                      )}
                    </ul>
                  )}
                </section>
              );
            })}
        </div>
        {openItem && (
          <aside className="quest-side ui-window" aria-label={t('questsLook.side')} data-testid="quest-side">
            <div className="quest-side-head ui-head">
              <span className="quest-id">{openItem.id !== openItem.title ? openItem.id : ''}</span>
              {openItem.task?.priority && (
                <span className={chip} data-tone={PRIORITY_PILL[openItem.task.priority]}>
                  {openItem.task.priority}
                </span>
              )}
              <Button size="icon_md" aria-label={t('questsLook.close')} onClick={() => setOpenKey(null)}>
                ×
              </Button>
            </div>
            <div className="quest-side-body">
              <strong className="quest-title break-words">{openItem.title}</strong>
              <span className="quest-card-foot">
                {!openItem.tracked && <Who item={openItem} now={now} quest={quest} removed={removed} />}
                <StatusPill status={openItem.status} />
              </span>
              <DevroomOpen item={openItem} quest={quest} />
              <TaskDetail item={openItem} now={now} readOnly={officeReadOnly} />
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
