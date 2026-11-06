/**
 * A5 (GPT mockup gpt-1 "오케스트레이터 현황판"): the 현황판's parts around the orchestrator list: the
 * count cards, the projects on the left, the issues in progress and who waits on the owner in the
 * middle, the feed and the usage and hardware on the right. Every number is a count of the records
 * the daemon sent (dashboardModel.ts); nothing here is a trend, a rate or a progress, and every
 * number says on hover what it counts (FEAT-BOARD-LESS: show less, explain what stays).
 * An answer to a permission is given in the messenger's card only: a row here opens it.
 */
import './dashboard.css';

import { type ReactNode, useState } from 'react';

import { CharacterMugShot } from '../../components/CharacterMugShot.js';
import { Button } from '../../components/ui/Button.js';
import { BOARD_LOOK_ACTIVITY_ROWS, BOARD_LOOK_BAD_FRAC, BOARD_LOOK_FACE_PX, BOARD_LOOK_METER_SEGMENTS, BOARD_LOOK_TASK_ROWS, BOARD_LOOK_WARN_FRAC } from '../../constants.js';
import { t } from '../../i18n/index.js';
import { openBoard } from '../board/boardOpen.js';
import { lookByName } from '../characters/looks.js';
import type { RingState } from '../ez/visuals.js';
import { timeAgo } from '../format.js';
import { gaugeWindows, windowLeft } from '../game/gameState.js';
import { openJobs } from '../game/openJobs.js';
import { type IconName, PixelIcon, SegBar, type SegTone } from '../game/parts.js';
import { HwSensorNotes } from '../HwSensorNotes.js';
import { openMessenger } from '../messenger/messengerStore.js';
import { isFeedNoise } from '../notify/newsList.js';
import { useCldStore } from '../officeStore.js';
import { serverLine } from '../serverText.js';
import { openWorkbench, setWorkbenchTab } from '../workbench/workbenchStore.js';
import { activityIcon, type Approval, type Kpi, kpis, type Pill, type TaskRow } from './dashboardModel.js';
import { workCounts } from './jobs.js';
import { type BoardFilter, type Room, rowState, setRoomFilter } from './statusTree.js';

/** A box of the board: its head (icon, title, count, an action) and its body. */
export function Panel({
  icon,
  title,
  count,
  countHint,
  action,
  children,
  className = '',
  testId,
}: {
  icon: IconName;
  title: string;
  count?: number;
  /** What the count counts, on hover. */
  countHint?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  testId?: string;
}) {
  return (
    <section className={`sb-panel ${className}`} aria-label={title} data-testid={testId}>
      <header className="sb-head">
        <PixelIcon name={icon} className="sb-head-icon" />
        <h3 title={countHint ? `${title}: ${countHint}` : title}>
          {title}
          {count !== undefined && <span className="sb-count"> ({count})</span>}
        </h3>
        {action && <span className="sb-head-action">{action}</span>}
      </header>
      {children}
    </section>
  );
}

/** An agent's mug shot (the look the office draws for that name), or its initial in the same square. */
export function Face({ name }: { name: string }) {
  const look = lookByName(name, useCldStore().characterPresets);
  return (
    <span className="sb-face" aria-hidden="true">
      {look ? <CharacterMugShot palette={look.palette} hueShift={look.hueShift} size={BOARD_LOOK_FACE_PX} /> : [...name][0]}
    </span>
  );
}

/** The 프로젝트 tab's 이슈 page: the issue board's one home (the dock has no 퀘스트). */
const openIssues = () => {
  setWorkbenchTab('tasks');
  openWorkbench();
};

// ── The count cards ─────────────────────────────────────────

function KpiCard({
  icon,
  tone,
  label,
  hint,
  value,
  sub,
  onClick,
  id,
}: {
  icon: IconName;
  tone: 'accent' | 'warn' | 'bad' | 'ok';
  label: string;
  /** What it counts, on hover; a press on a card with nowhere to go shows it under the number (a phone has no hover). */
  hint: string;
  value: number;
  sub?: string;
  onClick?: () => void;
  id: string;
}) {
  const [told, setTold] = useState(false);
  const go = onClick && value > 0 ? onClick : undefined;
  const body = (
    <>
      <span className="ui-card-tile sb-kpi-tile" data-tone={tone}>
        <PixelIcon name={icon} size={24} />
      </span>
      <span className="sb-kpi-text">
        <span className="sb-kpi-label">{label}</span>
        <span className="sb-kpi-value" data-zero={value === 0 || undefined}>
          {value}
          {sub && <small>{sub}</small>}
        </span>
        {told && <small className="sb-kpi-hint">{hint}</small>}
      </span>
    </>
  );
  return (
    <button
      type="button"
      className="ui-card sb-kpi"
      data-testid="board-kpi"
      data-kpi={id}
      data-count={value}
      title={hint}
      aria-label={`${label} ${value}`}
      {...(!go && { 'aria-expanded': told })}
      onClick={go ?? (() => setTold(!told))}
    >
      {body}
    </button>
  );
}

/** 일하는 에이전트 · 나를 기다림 · 막힌 이슈 · 오늘 끝난 이슈 · 실행 중: the office's own counts, the whole office. */
export function KpiRow({ rings, waiting, now }: { rings: RingState[]; waiting: Approval[]; now: number }) {
  const { taskBoard, officeJobs, codexTasks } = useCldStore();
  const cards = kpis({
    working: rings.filter((r) => rowState(r) === 'working').length,
    waiting: waiting.length,
    tasks: taskBoard?.tasks ?? [],
    work: workCounts(officeJobs?.jobs ?? [], codexTasks?.tasks ?? []),
    now,
  });
  const press: Partial<Record<Kpi['id'], () => void>> = { waiting: () => openMessenger(waiting[0]?.agentId), jobs: openJobs };
  return (
    <div className="sb-kpis">
      {cards.map((k) => (
        <KpiCard
          key={k.id}
          id={k.id}
          icon={k.icon}
          tone={k.tone}
          label={t(`boardLook.kpi.${k.id}`)}
          hint={t(`boardLook.hint.${k.id}`)}
          value={k.value}
          sub={k.queued ? t('game.hud.queued', { count: k.queued }) : undefined}
          onClick={press[k.id]}
        />
      ))}
    </div>
  );
}

// ── The left column: the projects ───────────────────────────

/** 프로젝트: each with how many issues are in progress there; a press narrows the middle column to it. */
export function RoomColumn({
  rooms,
  rows,
  roomOf,
  filter,
  children,
}: {
  rooms: Room[];
  /** Every issue in progress with its pill (taskRows). */
  rows: TaskRow[];
  roomOf: ReadonlyMap<string, string>;
  filter: BoardFilter;
  /** The engine's buttons (새 오케스트레이터, ...), when it runs. */
  children?: ReactNode;
}) {
  return (
    <Panel icon="home" title={t('boardLook.rooms')} className="sb-left">
      <ul className="sb-rooms" role="list">
        {[null, ...rooms.map((room) => room.name)].map((name) => {
          const label = name === null ? t('status.filter.all') : serverLine(name);
          const count = name === null ? rows.length : rows.filter((r) => roomOf.get(r.task.project) === name).length;
          return (
            <li key={name ?? ''}>
              <button
                type="button"
                className="ui-row sb-room"
                aria-current={filter.room === name}
                data-testid="board-room"
                title={t('boardLook.hint.room', { name: label, count })}
                onClick={() => setRoomFilter(name)}
              >
                <PixelIcon name={name === null ? 'board' : 'case'} />
                <span className="sb-room-name">{label}</span>
                <span className="sb-num">{count}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {children}
    </Panel>
  );
}

// ── 진행 중 이슈 ─────────────────────────────────────────────

const PILL_WORD: Record<Pill, () => string> = {
  permission: () => t('boardLook.pill.permission'),
  question: () => t('boardLook.pill.question'),
  blocked: () => t('tasks.status.blocked'),
  doing: () => t('tasks.status.doing'),
  review: () => t('tasks.status.review'),
};

export function StatusPill({ pill }: { pill: Pill }) {
  return (
    <span className="sb-pill ui-notch" data-pill={pill}>
      {PILL_WORD[pill]()}
    </span>
  );
}

function TaskLine({ row, now }: { row: TaskRow; now: number }) {
  const { task } = row;
  return (
    <li>
      <button
        type="button"
        className="ui-row sb-trow"
        data-testid="board-task-row"
        data-task={task.id}
        data-pill={row.pill}
        title={t('boardLook.openTask', { project: task.project })}
        onClick={() => openWorkbench(task.project)}
      >
        <span className="sb-task">
          <span className="ui-chip ui-notch sb-id">{task.id}</span>
          <span className="sb-ttitle">
            <b title={task.title}>{task.title}</b>
            <small title={`${task.project} · ${timeAgo(task.updatedAt, now)}`}>
              {task.project} · {timeAgo(task.updatedAt, now)}
            </small>
          </span>
        </span>
        <span className="sb-who">
          {row.who ? (
            <>
              <Face name={row.who} />
              <span title={row.who}>{row.who}</span>
            </>
          ) : (
            <span className="sb-muted">{t('boardLook.nobody')}</span>
          )}
        </span>
        <StatusPill pill={row.pill} />
      </button>
    </li>
  );
}

export function TaskTable({ rows, now }: { rows: TaskRow[]; now: number }) {
  const [all, setAll] = useState(false);
  const shown = all ? rows : rows.slice(0, BOARD_LOOK_TASK_ROWS);
  return (
    <Panel
      icon="play"
      title={t('boardLook.tasks')}
      count={rows.length}
      countHint={t('boardLook.hint.tasks')}
      testId="board-tasks"
      action={
        <button type="button" className="sb-link" data-testid="board-issues-open" onClick={() => openIssues()}>
          {t('boardLook.issuesOpen')} →
        </button>
      }
    >
      {rows.length === 0 ? (
        <p className="sb-empty">{t('boardLook.tasksEmpty')}</p>
      ) : (
        <>
          <div className="sb-thead" aria-hidden="true">
            <span>{t('boardLook.col.task')}</span>
            <span>{t('boardLook.col.who')}</span>
            <span>{t('boardLook.col.state')}</span>
          </div>
          <ul className="sb-tbody" role="list">
            {shown.map((row) => (
              <TaskLine key={`${row.task.project}/${row.task.id}`} row={row} now={now} />
            ))}
          </ul>
          {rows.length > BOARD_LOOK_TASK_ROWS && (
            <button type="button" className="ui-row sb-more" aria-expanded={all} onClick={() => setAll(!all)}>
              {all ? t('boardLook.less') : t('boardLook.more', { count: rows.length - BOARD_LOOK_TASK_ROWS })} {all ? '▲' : '▼'}
            </button>
          )}
        </>
      )}
    </Panel>
  );
}

// ── 나를 기다림 ─────────────────────────────────────────────

export function ApprovalList({ rows }: { rows: Approval[] }) {
  return (
    <Panel icon="ask" title={t('boardLook.approvals')} count={rows.length} countHint={t('boardLook.hint.waiting')} testId="board-approvals">
      {rows.length === 0 ? (
        <p className="sb-empty">{t('boardLook.approvalsEmpty')}</p>
      ) : (
        <ul className="sb-tbody" role="list">
          {rows.map((a) => (
            <li key={a.agentId} className="sb-arow" data-testid="board-approval" data-reason={a.reason}>
              <span className="ui-chip ui-notch sb-kind" data-reason={a.reason}>
                <PixelIcon name={a.reason === 'permission' ? 'lock' : 'ask'} />
                {a.reason === 'permission' ? t('boardLook.approval.permission') : t('boardLook.approval.question')}
              </span>
              <span className="sb-ttitle">
                <b title={a.what ?? undefined}>{a.what ? serverLine(a.what) : a.reason === 'permission' ? t('boardLook.approval.permissionWhat') : t('boardLook.approval.questionWhat')}</b>
                <small className="sb-who" title={a.name}>
                  <Face name={a.name} />
                  {a.name}
                </small>
              </span>
              <Button
                size="sm"
                variant="accent"
                title={t('boardLook.approval.answerTitle')}
                aria-label={`${a.name}: ${t('boardLook.approval.answerTitle')}`}
                onClick={() => openMessenger(a.agentId)}
              >
                {t('boardLook.approval.answer')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

// ── The right column ────────────────────────────────────────

export function ActivityList({ now }: { now: number }) {
  const { events } = useCldStore();
  const shown = events.filter((event) => !isFeedNoise(event.kind)).slice(0, BOARD_LOOK_ACTIVITY_ROWS);
  return (
    <Panel icon="log" title={t('status.recent')}>
      {shown.length === 0 ? (
        <p className="sb-empty">{t('hudpc.log.empty')}</p>
      ) : (
        <ol className="sb-feed">
          {shown.map((event, i) => (
            <li key={`${event.ts}-${i}`} data-testid="board-activity" data-kind={event.kind}>
              <span className="sb-feed-icon" data-icon={activityIcon(event.kind)}>
                <PixelIcon name={activityIcon(event.kind)} />
              </span>
              <span className="sb-ttitle">
                <b title={serverLine(event.summary)}>{serverLine(event.summary)}</b>
                <small title={event.name ?? undefined}>
                  {event.name ? `${event.name} · ` : ''}
                  {timeAgo(event.ts, now)}
                </small>
              </span>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

/** A load: high reads warn, then bad. */
const loadTone = (frac: number | null): SegTone | undefined =>
  frac === null ? undefined : frac >= BOARD_LOOK_BAD_FRAC ? 'bad' : frac >= BOARD_LOOK_WARN_FRAC ? 'warn' : 'ok';

function Meter({
  label,
  hint,
  frac,
  text,
  testId,
  tone = loadTone(frac),
}: {
  label: string;
  /** What it measures and where from, on hover. */
  hint: string;
  frac: number | null;
  text: string;
  testId?: string;
  tone?: SegTone;
}) {
  return (
    <div className="sb-meter" data-testid={testId} title={`${label} ${text}: ${hint}`}>
      <span>{label}</span>
      <SegBar value={frac ?? 0} max={1} segments={BOARD_LOOK_METER_SEGMENTS} tone={tone} label={`${label} ${text}`} className="sb-seg" />
      <b>{text}</b>
    </div>
  );
}

const pct = (frac: number | null | undefined) => (frac == null ? null : Math.max(0, Math.min(1, frac)));
const pctWord = (frac: number | null) => (frac === null ? '—' : `${Math.round(frac * 100)}%`);

/** 사용량 · 장비: what is left of each provider's window and what the host measures now (its H/W screen has the
 *  rest). What runs and what waits is the 실행 중 card's, so it is not counted again here. */
export function SystemSummary() {
  const { hwSample: hw, usageState } = useCldStore();
  const ram = hw?.ramUsedGib != null && hw.ramTotalGib ? hw.ramUsedGib / hw.ramTotalGib : null;
  return (
    <Panel
      icon="gear"
      title={t('boardLook.system')}
      action={
        <button type="button" className="sb-link" onClick={() => openBoard('hw')}>
          {t('boardLook.hwMore')} →
        </button>
      }
    >
      {!!usageState?.providers.length && (
        <div className="sb-meters">
          {usageState.providers.map((provider) => {
            const left = windowLeft(gaugeWindows(provider.windows, true).main);
            return (
              <Meter
                key={provider.id}
                label={t('boardLook.sys.left', { name: provider.name })}
                hint={left === null ? t('boardLook.hint.usageUnknown', { name: provider.name }) : t('boardLook.hint.usage', { name: provider.name })}
                // What is left: a full bar is plenty, the tone warns as it runs out.
                frac={left === null ? null : left / 100}
                tone={left === null ? undefined : loadTone(1 - left / 100)}
                text={left === null ? t('usage.unknownShort') : `${left}%`}
              />
            );
          })}
        </div>
      )}
      {hw ? (
        <div className="sb-meters">
          <Meter label="CPU" hint={t('boardLook.hint.cpu')} frac={pct(hw.cpuUtil)} text={pctWord(pct(hw.cpuUtil))} testId="board-sys-cpu" />
          <Meter label="GPU" hint={t('boardLook.hint.gpu')} frac={pct(hw.gpuUtil)} text={pctWord(pct(hw.gpuUtil))} />
          {ram !== null && <Meter label="RAM" hint={t('boardLook.hint.ram')} frac={pct(ram)} text={`${hw.ramUsedGib!.toFixed(1)}/${Math.round(hw.ramTotalGib!)}G`} />}
        </div>
      ) : (
        <p className="sb-empty">{t('board.waitingHardware')}</p>
      )}
      {hw && <HwSensorNotes hw={hw} look="summary" />}
    </Panel>
  );
}
