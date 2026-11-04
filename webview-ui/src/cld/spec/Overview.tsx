/**
 * SPT-P3-OVERVIEW (SPT §6.2): the 현황판's 개요, drawn as GAME-UI-0's cockpit D2 (specs/ui-mock-1103).
 * A header (나를 기다림, 진행 · 검토 · 막힘 counters, the project's name in gold, 명세 numbers, the
 * 수락 HI-SCORE once, its digits rolling up on a rise: GameScore), three panels of counters (이슈, 요구사항, 확인할 것) where every number opens its
 * tab on that filter (openTab; GAME-UI-1: 이번 주 수락 under 요구사항), 진행 중 작업 (each Task's evidence lights and why a light is half),
 * 최근 근거 (`…/recent`: commits, jobs and merges) and 최근 본 요구사항. Light on purpose (it is the
 * default tab): no graph code, the summary and recent requests, plus one `…/task/:id` per Task shown
 * while tracking is on, again on `specChanged` once a burst settles; never polled. Tracking off: the
 * Tasks, git, jobs and 나를 기다림 only, and the 켜기 card (§6.7).
 */
import '../../i18n/specStrings.js';
import './overview.css';

import { type ReactNode, useState } from 'react';

import type { TraceRecent, TraceRecentReq, TraceTaskReqs } from '../../../../core/src/cld/spec/trace.js';
import type { BoardTask } from '../../../../core/src/messages.js';
import { SPEC_LIST_SHOWN, SPEC_OVERVIEW_REFETCH_MS } from '../../constants.js';
import { t } from '../../i18n/index.js';
import { timeAgo } from '../format.js';
import { DataText, HudCounter, type IconName, Led, LedLegend, PixelIcon, SegBar } from '../game/parts.js';
import { openMessenger } from '../messenger/messengerStore.js';
import { useCldStore } from '../officeStore.js';
import { setJobsView } from '../taskboard/taskBoardState.js';
import { useWaitReasons, waitingIds } from '../waiting.js';
import { openTab, setWorkbenchTab, useNow } from '../workbench/workbenchStore.js';
import { HiScore, WeekPanel } from './GameScore.js';
import { questLights, readViewed, TASK_COLUMNS, type TaskColumn, taskCounts } from './overviewModel.js';
import { SpecCard, type Summary, useSpec } from './SpecTabs.js';
import { AXIS_TEXT } from './traceModel.js';

const OPEN = ['doing', 'review', 'blocked'] as const;
const AXES = ['integration', 'test', 'deploy'] as const;
const ACC = ['validate', 'none', 'rejected'] as const; // 수락 is the HI-SCORE, once
const STATUS_ICON: Record<TaskColumn, IconName> = { todo: 'board', doing: 'gear', review: 'lens', blocked: 'stop', done: 'check' };
const ACC_ICON: Record<(typeof ACC)[number], IconName> = { validate: 'lens', none: 'clock', rejected: 'stop' };

const toTasks = (s: TaskColumn) => {
  setJobsView('tasks'); // the 이슈 tab's board half, scrolled to that status column
  openTab('tasks', `status:${s}`);
};
const toReqs = (key: string) => openTab('reqs', key);

/** A number in the data face that opens its list; '—' (not a button) when the daemon does not count it yet. */
function Num({ n, onClick, id, children, className = '' }: { n: number | undefined; onClick: () => void; id: string; children?: ReactNode; className?: string }) {
  if (n === undefined)
    return (
      <span className={`ov-num ${className}`} data-testid={`ov-${id}`} data-zero>
        {children} —
      </span>
    );
  return (
    <button type="button" className={`ov-num ${className}`} onClick={onClick} data-testid={`ov-${id}`} data-count={n} data-zero={!n || undefined}>
      {children}
      <span className="ov-d">{n}</span>
    </button>
  );
}

function Panel({ icon, title, id, count, children }: { icon: IconName; title: string; id: string; count?: number; children: ReactNode }) {
  return (
    <section className="ov-panel" data-testid={`ov-${id}`}>
      <h3>
        <PixelIcon name={icon} />
        {title}
        {count !== undefined && <span className="ov-cnt ov-d">{count}</span>}
      </h3>
      {children}
    </section>
  );
}

/** A requirement chip: opens its detail; an observed one carries the '관측' tag. */
function Chip({ r }: { r: TraceRecentReq }) {
  return (
    <button type="button" className="ov-chip" onClick={() => toReqs(`item:${r.uid}`)} data-testid="ov-chip" data-uid={r.uid} data-status={r.status}>
      {r.label}
      {r.status === 'observed' && <span className="ov-tag">{t('spec.link.observed')}</span>}
    </button>
  );
}

/** One 진행 중 작업 row, quest-like: id, requirement, title, status, owner; its four lights; why a light is half. */
function Quest({ task, link }: { task: BoardTask; link?: TraceTaskReqs }) {
  const edge = link?.edges.find((e) => e.status === 'confirmed') ?? link?.edges.find((e) => e.status === 'observed');
  const node = edge && link?.nodes.find((n) => n.id === (edge.from === task.id ? edge.to : edge.from));
  const lights = questLights(task, node?.state?.evidence);
  return (
    <li className="ov-quest" data-testid="ov-task" data-id={task.id} data-status={task.status}>
      <p className="ov-quest-head">
        <span className="ov-d">{task.id}</span>
        {node && edge && <Chip r={{ uid: node.id, label: node.label, status: edge.status === 'confirmed' ? 'confirmed' : 'observed' }} />}
        <span className="ov-quest-title">{task.title}</span>
        <span className="ov-state">
          <PixelIcon name={STATUS_ICON[task.status as TaskColumn] ?? 'gear'} />
          {t(`tasks.status.${task.status}`)}
        </span>
        {task.assignee && (
          <span className="ov-muted">
            {t('game.ov.assignee')} <span className="ov-dp">{task.assignee.name}</span>
          </span>
        )}
      </p>
      <p className="ov-evbar">
        {lights.map((l) => (
          <span key={l.axis} data-axis={l.axis}>
            <Led state={l.led} reason={l.why} />
            {t(AXIS_TEXT[l.axis])}
          </span>
        ))}
      </p>
      {lights
        .filter((l) => l.led === 'half')
        .map((l) => (
          <p key={l.axis} className="ov-why" data-testid="ov-why" data-axis={l.axis}>
            <Led state="half" reason={l.why} />
            <span>
              <b>
                {t('game.ov.reportedOnly', { axis: t(AXIS_TEXT[l.axis]) })}
                {l.why && ':'}
              </b>
              {l.why && (
                <>
                  {' '}
                  <DataText text={l.why} />
                </>
              )}
            </span>
          </p>
        ))}
    </li>
  );
}
/** A Quest with its requirement (`…/task/:id`, tracking on only). */
function TrackedQuest({ project, task }: { project: string; task: BoardTask }) {
  const { data } = useSpec<TraceTaskReqs>(project, `task/${encodeURIComponent(task.id)}`, SPEC_OVERVIEW_REFETCH_MS);
  return <Quest task={task} link={data?.enabled ? data : undefined} />;
}

export function Overview({ project, agentIds }: { project: string; agentIds: number[] }) {
  const { taskBoard } = useCldStore();
  const reasons = useWaitReasons();
  const waiting = waitingIds(agentIds, reasons);
  const now = useNow();
  const { data: s, error } = useSpec<Summary>(project, 'summary', SPEC_OVERVIEW_REFETCH_MS);
  const { data: recent } = useSpec<TraceRecent>(project, 'recent', SPEC_OVERVIEW_REFETCH_MS);
  const [viewed] = useState(() => readViewed(project));
  const tasks = (taskBoard?.tasks ?? []).filter((x) => x.project === project);
  const c = taskCounts(tasks, project, now);
  const on = !!s?.enabled && !s.corrupt;
  const working = tasks.filter((x) => (OPEN as readonly string[]).includes(x.status));
  const shown = working.slice(0, SPEC_LIST_SHOWN * 2);
  const accepted = s?.acceptance?.accepted;
  const total = s?.items?.total;
  return (
    <div className="ov" data-testid="spec-cockpit" data-enabled={on}>
      <header className="ov-panel ov-mq" data-testid="ov-top">
        <div className="ov-mq-grp">
          <HudCounter
            icon="bell"
            label={t('game.ov.waiting')}
            value={waiting.length}
            active={waiting.length > 0}
            onClick={() => openMessenger(waiting[0])}
            testId="spec-waiting"
            className="ov-row"
          />
          {OPEN.map((st) => (
            <HudCounter key={st} icon={STATUS_ICON[st]} label={t(`tasks.status.${st}`)} value={c[st]} onClick={() => toTasks(st)} testId={`ov-top-${st}`} className="ov-row" />
          ))}
        </div>
        <div className="ov-mq-mid">
          <span className="ov-title">{project}</span>
          {on && (
            <span className="ov-spec">
              <Num id="top-reqs" n={total} onClick={() => toReqs('all')}>
                {t('game.ov.specReqs')}{' '}
              </Num>
              <Num id="top-same" n={s.questions} onClick={() => setWorkbenchTab('docs')}>
                {t('spec.fresh.unresolved')}{' '}
              </Num>
            </span>
          )}
        </div>
        {on && accepted !== undefined && total !== undefined && (
          <button
            type="button"
            className="ov-hi"
            onClick={() => toReqs('acc:accepted')}
            data-testid="ov-acc-accepted"
            data-count={accepted}
            aria-label={t('game.ov.hiScoreName', { count: accepted, total })}
          >
            <span className="ov-hi-k">
              <PixelIcon name="star" />
              {t('spec.acc.accepted')} <span className="ov-d ov-small">{t('game.ov.hiScore')}</span>
            </span>
            <HiScore value={accepted} total={total} big />
          </button>
        )}
      </header>

      <div className="ov-cols" data-on={on}>
        <Panel icon="board" title={t('workbench.tab.tasks')} id="col-issues">
          <div className="ov-tiles ov-t5">
            {TASK_COLUMNS.map((st) => (
              <HudCounter key={st} icon={STATUS_ICON[st]} label={t(`tasks.status.${st}`)} value={c[st]} onClick={() => toTasks(st)} testId={`ov-issues-${st}`} />
            ))}
          </div>
          <p className="ov-muted" data-testid="ov-done-week" data-count={c.doneWeek}>
            <DataText text={t('game.ov.doneWeek', { count: c.doneWeek })} />
          </p>
        </Panel>
        {on && (
          <>
            <Panel icon="scroll" title={t('spec.tab.reqs')} id="col-reqs">
              <div className="ov-lrow">
                <span className="ov-muted">{t('spec.reqs.colAcceptance')}</span>
                <div className="ov-tiles ov-t3">
                  {ACC.map((a) => (
                    <HudCounter key={a} icon={ACC_ICON[a]} label={t(`spec.acc.${a}`)} value={s.acceptance?.[a]} onClick={() => toReqs(`acc:${a}`)} testId={`ov-acc-${a}`} />
                  ))}
                </div>
              </div>
              <div className="ov-lrow">
                <span className="ov-muted">{t('spec.reqs.colEvidence')}</span>
                <div className="ov-tiles ov-t3">
                  {AXES.map((a) => (
                    <div key={a} className="game-hud">
                      <span className="game-hud-k">{t(AXIS_TEXT[a])}</span>
                      <span className="ov-pairs">
                        <Num id={`ev-${a}`} n={s.evidence?.[a]} onClick={() => toReqs(`show:ev:${a}`)} className="ov-pair">
                          <Led state="on" />
                        </Num>
                        <Num id={`evr-${a}`} n={s.evidenceReported?.[a]} onClick={() => toReqs(`show:evr:${a}`)} className="ov-pair">
                          <Led state="half" />
                        </Num>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="ov-meter">
                <span className="ov-muted ov-meter-k">{t('spec.reqs.colWork')}</span>
                <span>{t('spec.overview.linked')}</span>
                <SegBar value={s.work?.linked ?? 0} max={s.work?.total ?? 0} label={t('game.ov.linkedBar', { count: s.work?.linked ?? 0, total: s.work?.total ?? 0 })} />
                <span className="ov-pair">
                  <Num id="work-linked" n={s.work?.linked} onClick={() => toReqs('show:linked')} />
                  <Num id="work-total" n={s.work?.total} onClick={() => toReqs('all')} className="ov-of">
                    /
                  </Num>
                </span>
                <Num id="observed" n={s.observedOnly} onClick={() => toReqs('show:observed')} className="ov-muted">
                  {t('spec.overview.show.observed')}{' '}
                </Num>
              </div>
              {s.week && <WeekPanel week={s.week} />}
            </Panel>
            <Panel icon="eye" title={t('spec.overview.check')} id="col-check">
              <ul className="ov-list">
                {(
                  [
                    ['review', t('spec.fresh.review'), s.reviewNeeded, () => toReqs('show:review')],
                    ['missing', t('spec.fresh.missing'), s.missing, () => toReqs('show:missing')],
                    ['unlinked', t('spec.overview.unlinked'), s.unlinked, () => toReqs('show:unlinked')],
                    ['newdocs', t('spec.overview.newDocs'), s.newDocs, () => setWorkbenchTab('docs')],
                    ['same', t('spec.fresh.unresolved'), s.questions, () => setWorkbenchTab('docs')],
                  ] as const
                ).map(([id, label, n, go]) => (
                  <li key={id}>
                    <Num id={`check-${id}`} n={n} onClick={go} className="ov-leader">
                      <span>{label}</span>
                      <span className="ov-dots" />
                    </Num>
                    <PixelIcon name="play" className="ov-muted" />
                  </li>
                ))}
              </ul>
            </Panel>
          </>
        )}
      </div>

      <div className="ov-lower">
        <div className="ov-stack">
          <Panel icon="gear" title={t('spec.overview.inProgress')} id="working" count={working.length}>
            {!working.length && <p className="ov-muted">{t('spec.noTasks')}</p>}
            <ul className="ov-quests">{shown.map((x) => (on ? <TrackedQuest key={x.id} project={project} task={x} /> : <Quest key={x.id} task={x} />))}</ul>
            <LedLegend />
          </Panel>
          {on && (
            <Panel icon="star" title={t('spec.overview.viewed')} id="viewed">
              {!viewed.length && <p className="ov-muted">{t('spec.overview.noViewed')}</p>}
              <p className="ov-viewed">
                {viewed.map((v) => (
                  <button key={v.uid} type="button" className="ov-chip" data-status="observed" onClick={() => openTab('reqs', `item:${v.uid}`)} data-testid="ov-viewed" data-uid={v.uid}>
                    {v.label}
                  </button>
                ))}
              </p>
            </Panel>
          )}
        </div>
        <Panel icon="flag" title={t('spec.overview.evidence')} id="recent">
          <h4 className="ov-sub">
            {t('spec.commits')}
            {s?.git.branch && (
              <>
                {' · '}
                <span className="ov-dp">{s.git.branch}</span>
              </>
            )}
          </h4>
          {recent && !recent.commits.length && <p className="ov-muted">{t('spec.noCommits')}</p>}
          <ul className="ov-ev ov-ev-scroll">
            {recent?.commits.map((x) => (
              <li key={x.sha} data-testid="ov-commit" data-sha={x.sha}>
                <Led state="on" />
                <span className="ov-d">{x.sha.slice(0, 8)}</span>
                <span className="ov-s ov-dp">{x.subject}</span>
                <span className="ov-tail">
                  <span className="ov-chips">
                    {x.reqs.map((r) => (
                      <Chip key={r.uid} r={r} />
                    ))}
                  </span>
                  <span className="ov-at">
                    <DataText text={timeAgo(x.at, now)} />
                  </span>
                </span>
              </li>
            ))}
          </ul>
          <h4 className="ov-sub">{t('spec.jobs')}</h4>
          {recent && !recent.jobs.length && <p className="ov-muted">{t('spec.noJobs')}</p>}
          <ul className="ov-ev">
            {recent?.jobs.map((j) => (
              <li key={j.id} data-testid="ov-job" data-id={j.id} data-exit={j.exit ?? ''}>
                <Led state={j.exit !== 0 ? 'off' : j.reported ? 'half' : 'on'} reason={j.reported ? t('game.why.jobDeploy') : undefined} />
                <span className="ov-d">{t('spec.exit', { code: j.exit ?? '?' })}</span>
                <span className="ov-s ov-dp">{j.desc}</span>
                <span className="ov-tail">
                  <span className="ov-chips">
                    {j.reqs.map((r) => (
                      <Chip key={r.uid} r={r} />
                    ))}
                  </span>
                  <span className="ov-at">
                    <DataText text={timeAgo(j.at, now)} />
                  </span>
                </span>
                {j.reported && (
                  <span className="ov-wy">
                    {t('game.ov.reportedOnly', { axis: t('spec.ev.deploy') })}: <DataText text={t('game.why.jobDeploy')} />
                  </span>
                )}
              </li>
            ))}
          </ul>
          <h4 className="ov-sub">{t('spec.overview.merges')}</h4>
          {recent && !recent.merges.length && <p className="ov-muted">{t('spec.overview.noMerges')}</p>}
          <ul className="ov-merges">
            {recent?.merges.map((m, i) => (
              <li key={`${m.at}:${i}`} data-testid="ov-merge" data-ok={m.ok}>
                {m.ok ? '✔' : '✖'} {t('spec.overview.merge', { task: m.task ?? m.branch ?? '?', target: m.target })}
                {m.sha && <span className="ov-dp"> {m.sha.slice(0, 8)}</span>}
                <span className="ov-muted"> · {timeAgo(m.at, now)}</span>
                {m.error && <span className="ov-muted ov-block">{m.error}</span>}
              </li>
            ))}
          </ul>
        </Panel>
      </div>

      {error && (
        <p className="text-red-400" role="alert">
          {error}
        </p>
      )}
      {s && <SpecCard project={project} summary={s} onOpenDocs={() => setWorkbenchTab('docs')} onOpenReqs={() => toReqs('all')} />}
    </div>
  );
}
