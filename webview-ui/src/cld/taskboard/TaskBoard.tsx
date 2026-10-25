/**
 * 작업 탭의 '업무' (DEV-BOARD): 지금 하는 일, then the board by status. One
 * single-column list on every screen (the 현황판 window and the phone page are
 * both narrow), nothing wider than its box. Cards open in place: note, links,
 * history, the linked runs, and (privileged screens) a status/owner/priority/
 * note editor. D6: the assignee on the card, children under their parent, and
 * in the detail the facts and Executions, each with its source (관측 / 보고 /
 * 추정). The board also has an MVP summary, calculated from reported tasks.
 */
import { useMemo, useState } from 'react';

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
import { t, type TranslationKey } from '../../i18n/index.js';
import { transport } from '../../transport/index.js';
import { timeAgo } from '../format.js';
import { useCldStore } from '../officeStore.js';
import { codexStatus, jobStatus } from '../panels/jobs.js';
import { serverLine } from '../serverText.js';
import { TaskWorktreeChip, TaskWorktreeDetail } from '../workbench/TaskWorktree.js';
import {
  assigneeOf,
  type BoardFilter,
  type BoardItem,
  boardItems,
  docDrift,
  filterChoices,
  filterItems,
  type Goal,
  goalProgress,
  GOALS,
  groupItems,
  nestItems,
  NO_FILTER,
  nowStrip,
  type ObservedRun,
  OTHER_GOAL,
  STATUS_ORDER,
  toggleGoalFilter,
  trackedCount,
} from './taskBoard.js';

const OWNER_KINDS: BoardTaskOwnerKind[] = ['lead', 'worker', 'subagent', 'codex', 'user', 'unassigned'];
const PRIORITIES = ['P0', 'P1', 'P2', 'later'];
const section = 'pixel-panel p-12 min-w-0';
const muted = 'text-text-muted text-xs';
const chip = 'border border-border px-4 text-xs whitespace-nowrap';
const control = 'bg-bg border border-border px-4 py-2 text-xs min-w-0 max-w-full';
const button = 'border border-border px-8 py-4 text-xs pointer-coarse:min-h-44';
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
      <p className="text-text-muted">{t('tasks.facts')}</p>
      {rows.map(([key, value, source, at]) => (
        <p key={key} data-fact={key}>
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
    <section className={section} aria-label={t('tasks.now')} data-testid="task-now">
      <strong className="text-sm">{t('tasks.now')}</strong>
      {rows.length === 0 && <p className={`${muted} mt-4`}>{t('tasks.nowEmpty')}</p>}
      <ul className="mt-4 space-y-8">
        {rows.map((row) => (
          <li key={row.key} className="min-w-0" data-testid="task-now-row">
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
    <div className="mt-8 flex flex-wrap gap-8 items-end" data-testid="task-editor">
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
      <button type="button" className={`${button} border-accent text-accent-text`} onClick={save}>
        {t('tasks.save')}
      </button>
    </div>
  );
}

function TaskDetail({ item, now, readOnly }: { item: BoardItem; now: number; readOnly: boolean }) {
  const task = item.task;
  const links = task?.links ?? [];
  return (
    <div className="mt-8 border-t border-border pt-8 text-xs space-y-6 min-w-0 break-words" data-testid="task-detail">
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
      {task?.executions && task.executions.length > 0 && (
        <div>
          <p className="text-text-muted">{t('tasks.executions')}</p>
          {task.executions.map((e) => (
            <ExecutionRow key={e.id} e={e} now={now} />
          ))}
        </div>
      )}
      {task?.goal && <p className={muted}>{t('tasks.filter.goal')} · {task.goal}</p>}
      {(item.runs.length > 0 || item.missing.length > 0) && (
        <div>
          <p className="text-text-muted">{t('tasks.runs')}</p>
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
          <p className="text-text-muted">{t('tasks.links')}</p>
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
          <summary className="cursor-pointer text-text-muted">{t('tasks.history')} ({task.history.length})</summary>
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

function TaskCard({
  item,
  now,
  openKey,
  onToggle,
  readOnly,
  removed,
  children,
  nested = false,
}: {
  item: BoardItem;
  now: number;
  openKey: string | null;
  onToggle: (key: string) => void;
  readOnly: boolean;
  removed: readonly string[];
  children?: BoardItem[];
  nested?: boolean;
}) {
  const open = openKey === item.key;
  const assignee = assigneeOf(item.task, removed);
  return (
    <li
      className={section}
      data-testid="task-card"
      data-task-id={item.id}
      data-task-status={item.status}
      {...(item.tracked && { 'data-tracked': item.tracked.key })}
      {...(item.task?.parentId && { 'data-task-parent': item.task.parentId })}
    >
      <button type="button" className="w-full text-left min-w-0" aria-expanded={open} onClick={() => onToggle(item.key)}>
        <span className="flex gap-6 items-baseline min-w-0">
          {item.id !== item.title && <span className="text-text-muted text-xs shrink-0">{item.id}</span>}
          <strong className="text-sm break-words min-w-0" data-testid="task-title">
            {item.title}
          </strong>
        </span>
        <span className="mt-4 flex flex-wrap gap-4 items-center text-xs">
          {nested && <span className={`${chip} ${STATUS_TONE[item.status]}`}>{t(`tasks.status.${item.status}`)}</span>}
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
          ) : (
            <span className={chip} data-testid="task-owner">
              {ownerText(item.owner)}
            </span>
          )}
          {assignee && (
            <span className={`${chip} ${assignee.removed ? 'text-text-muted' : ''}`} data-testid="task-assignee">
              {t('tasks.assignee', {
                name: assignee.removed ? t('tasks.assigneeRemoved', { name: assignee.name }) : assignee.name,
              })}
            </span>
          )}
          {item.task?.priority && <span className={`${chip} text-yellow-300`}>{item.task.priority}</span>}
          {item.trackedDrift && (
            <span className={`${chip} text-red-400`} title={t('tasks.tracked.driftHint')} data-testid="tracked-drift">
              {t('tasks.tracked.drift')}
            </span>
          )}
          <SourceBadge item={item} />
          {item.updatedAt && <span className="text-text-muted">{timeAgo(item.updatedAt, now)}</span>}
          {item.task?.branch && <span className="text-text-muted break-all">⎇ {item.task.branch}</span>}
          <TaskWorktreeChip task={item.task} />
          {item.project && <span className="text-text-muted">{item.project}</span>}
        </span>
        {item.source === 'reported' && item.runs.length > 0 && (
          <span className="mt-4 flex flex-wrap gap-4">
            {item.runs.map((r) => (
              <RunBadge key={r.id} run={r} now={now} />
            ))}
          </span>
        )}
        {item.source === 'observed' && item.runs[0] && (
          <span className="mt-4 block text-xs">{runText(item.runs[0], now)}</span>
        )}
      </button>
      {open && <TaskDetail item={item} now={now} readOnly={readOnly} />}
      <TrackedLines item={item} now={now} />
      {children && children.length > 0 && (
        <ul className="mt-8 ml-12 space-y-8" data-testid="task-children">
          {children.map((c) => (
            <TaskCard
              key={c.key}
              item={c}
              now={now}
              openKey={openKey}
              onToggle={onToggle}
              readOnly={readOnly}
              removed={removed}
              nested
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function AddTask({ projects, onDone }: { projects: string[]; onDone: () => void }) {
  const [title, setTitle] = useState('');
  const [project, setProject] = useState(projects[0] ?? '');
  const [status, setStatus] = useState<BoardTaskStatus>('todo');
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
      <button type="submit" className={`${button} border-accent text-accent-text`} disabled={!ok}>
        {t('tasks.save')}
      </button>
      <button type="button" className={button} onClick={onDone}>
        {t('tasks.cancel')}
      </button>
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
    <label className="flex items-center gap-4 text-xs min-w-0">
      <span className="shrink-0">{label}</span>
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
    <section className={`${section} space-y-4`} data-testid="mvp-progress">
      <div className="flex items-center gap-8 min-w-0">
        <p className="text-xs min-w-0 flex-1 leading-4">
          {t('tasks.mvp.progress', { ...progress.overall, percent })}
        </p>
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
        <div className="space-y-2">
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
                <span className="h-6 min-w-0 flex overflow-hidden bg-border" aria-hidden="true">
                  <span className="h-full bg-accent shrink-0" style={{ width: `${donePercent}%` }} />
                  <span className="h-full bg-accent opacity-50 shrink-0" style={{ width: `${activePercent}%` }} />
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
  const { taskBoard, codexTasks, officeJobs, officeReadOnly, tracked } = useCldStore();
  const [filter, setFilter] = useState<BoardFilter>(NO_FILTER);
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [doneOpen, setDoneOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [mvpProgressOpen, setMvpProgressOpen] = useState(savedMvpProgressOpen);
  const items = useMemo(
    () => boardItems(taskBoard?.tasks ?? [], codexTasks?.tasks, officeJobs?.jobs, Object.values(tracked)),
    [taskBoard, codexTasks, officeJobs, tracked],
  );
  const choices = useMemo(() => filterChoices(items), [items]);
  const progress = useMemo(() => goalProgress(items, filter), [items, filter]);
  const shown = filterItems(items, filter);
  const nest = nestItems(shown);
  const groups = groupItems(nest.top);
  const removed = taskBoard?.removedAssignees ?? [];
  return (
    <div className="space-y-8 min-w-0" data-testid="task-board">
      {taskBoard?.corrupt && (
        <p className="pixel-panel p-8 text-xs text-red-400 break-words" role="alert">
          {t('tasks.corrupt', { error: serverLine(taskBoard.corrupt) })}
        </p>
      )}
      {/* The overview first (the owner, 10-24 09:18: "진행상황이 한 눈에"), then what runs now. */}
      <MvpProgress
        progress={progress}
        filter={filter}
        setFilter={setFilter}
        open={mvpProgressOpen}
        setOpen={setMvpProgressOpen}
        apart={trackedCount(Object.values(tracked), filter.project)}
      />
      <NowStrip items={shown} now={now} />
      <div className="flex flex-wrap gap-8 items-center">
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
        {!officeReadOnly && !adding && (
          <button type="button" className={button} onClick={() => setAdding(true)}>
            + {t('tasks.add')}
          </button>
        )}
      </div>
      {adding && <AddTask projects={choices.projects} onDone={() => setAdding(false)} />}
      {items.length === 0 && <p className={`${muted} py-12 text-center`}>{t('tasks.empty')}</p>}
      {items.length > 0 && shown.length === 0 && (
        <p className={`${muted} py-12 text-center`}>{t('tasks.emptyFilter')}</p>
      )}
      {groups
        .filter((g) => g.total > 0)
        .map((g) => {
          const folded = g.status === 'done' && !doneOpen;
          return (
            <section key={g.status} className="space-y-8 min-w-0" data-testid="task-group" data-status={g.status}>
              {g.status === 'done' ? (
                <button
                  type="button"
                  className={`${button} w-full text-left`}
                  aria-expanded={!folded}
                  onClick={() => setDoneOpen(!doneOpen)}
                >
                  {folded ? '▶' : '▼'} {t('tasks.doneFold', { count: g.total })}
                </button>
              ) : (
                <h3 className={`text-sm ${STATUS_TONE[g.status]}`}>
                  {t(`tasks.status.${g.status}`)} ({g.total})
                </h3>
              )}
              {!folded && (
                <ul className="space-y-8">
                  {g.items.map((item) => (
                    <TaskCard
                      key={item.key}
                      item={item}
                      now={now}
                      openKey={openKey}
                      onToggle={(key) => setOpenKey(openKey === key ? null : key)}
                      readOnly={officeReadOnly}
                      removed={removed}
                      children={nest.children.get(item.key)}
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
  );
}
