/**
 * T-184 개발실 브랜치 보기 (mockups-1127/board4-dev-branches): the dev room's main content while it is
 * open. A tool row; the picture (the base branch as a trunk with its Lead, each unmerged worktree as a
 * branch with a tip card, today's merges as loops, a job running on the base as a box at the trunk's
 * end); under it the picked worktree's panel, whose tabs are the dev room's own panes. Every word is a
 * fixed template filled with facts (counts, names, times, the rail's chip) or stored content shown as
 * what it is (the issue title, review notes with their author, the agent's last message, a job's
 * description). Layout and facts: branchMapLayout.ts. The phone gets the same tips and loops as a list.
 */
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react';

import type { BoardTask, OfficeJob, RepoMerge } from '../../../../core/src/messages.js';
import {
  DEVBRANCH_FILES_MAX,
  DEVBRANCH_LANE_PX,
  DEVBRANCH_LOWER_MIN_PX,
  DEVBRANCH_PAD_PX,
  DEVBRANCH_PANEL_FACE_PX,
  DEVBRANCH_TICK_PX,
  DEVBRANCH_TIP_FACE_PX,
  DEVBRANCH_TRUNK_LABEL_W_PX,
  DEVROOM_FACE_PX,
} from '../../constants.js';
import { t } from '../../i18n/index.js';
import { transport } from '../../transport/index.js';
import { useEngineStore } from '../engineStore.js';
import { resetClock, timeAgo } from '../format.js';
import { HostClock } from '../HostClock.js';
import { useBounds } from '../hud/useBounds.js';
import { Icon } from '../icons/Icon.js';
import { elapsedText } from '../kinds.js';
import { useMessenger } from '../messenger/messengerStore.js';
import { modelBadge, modelName } from '../modelBadges.js';
import { useAgtyStore } from '../officeStore.js';
import { detailKey, diffKey, repoCloseDetail, repoCloseDiff, repoRequestDetail, repoRequestDiff, useRepoStore } from '../repo/repoStore.js';
import { diffCounts } from '../repo/repoText.js';
import { reviewKey, useReviewStore } from '../repo/reviewStore.js';
import { useReviewNotes } from '../repo/useRepoView.js';
import { serverText } from '../serverText.js';
import { ModelBadge } from '../TempList.js';
import { useCanAct, useNow } from '../workbench/workbenchStore.js';
import { TerminalColumns } from './AgentColumns.js';
import { askBoardLayout } from './boardLayout.js';
import { baseJobs, layoutMap, mergedToday, orderTips, roundedPath } from './branchMapLayout.js';
import { BODY, type Group, type Row, SMALL, TINY, useCurrentPick, useDevroomGroups, useTerminalColumns, whoName } from './devroomData.js';
import { type Chip, lastActivity } from './devroomState.js';
import { devroomGetSnapshot, openFromStory, pickWorktree, setDevroomView } from './devroomStore.js';
import { type Story, story } from './issueStory.js';
import { fixingLock, preChecks } from './mergeState.js';
import { requestCheck, taskKey, useMergeStore } from './mergeStore.js';
import { MergeTab } from './MergeTab.js';
import { NewSpaceSheet } from './NewSpace.js';
import { PaneChat } from './PaneChat.js';
import { RunArea } from './RunRow.js';
import { TaskReview } from './TaskReview.js';
import { Face, FilterBox, RowFace } from './WorktreeRail.js';

const send = (msg: Parameters<typeof transport.send>[0]) => transport.send(msg);
const LINE = 'fill-none [stroke-linecap:round]';
const THIN = '[stroke-width:calc(var(--ui-bw)*2)]';
const THICK = '[stroke-width:calc(var(--ui-bw)*5)]';
const STRONG = 'font-(--ui-weight-strong)';
const PANEL = 'border-ui border-devroom-card-line rounded-ui-win bg-devroom-rail';
const SEG = `px-12 h-34 -ml-px first:ml-0 border-ui border-devroom-card-line first:rounded-l-ui-card last:rounded-r-ui-card bg-devroom-box text-devroom-title hover:bg-devroom-pick ${SMALL}`;
const TOOL = `inline-flex items-center gap-6 px-12 h-34 border-ui border-devroom-card-line rounded-ui-card bg-devroom-box text-devroom-title hover:bg-devroom-pick ${SMALL}`;

/** The state line's colour per chip (the rail's own tones). */
const STATE_TONE: Record<Chip, string> = {
  conflict: 'text-devroom-conf',
  approve: 'text-devroom-conf',
  question: 'text-devroom-conf',
  review: 'text-devroom-review',
  fixing: 'text-devroom-blue',
  working: 'text-devroom-blue',
  idle: 'text-text-muted',
  merged: 'text-devroom-ok',
};

// ── the facts of one worktree ─────────────────────────────────

interface Facts {
  row: Row;
  /** Who works there (assignee, else a temp Codex employee), or null. */
  who: string | null;
  live: boolean;
  /** T-183's story of its issue (state, the return from review, the run), when the worktree has one. */
  s: Story | null;
}

function factsOf(row: Row, live: boolean): Facts {
  const s = row.task ? story({ task: row.task, wt: row.wt, merged: false, agent: row.wt.assignee ?? null, files: null, notes: 0, checked: false }) : null;
  return { row, who: whoName(row.wt) ?? null, live, s };
}

/**
 * The state line, worded as T-183's issue rows: a wait for the owner first (the rail's chip words),
 * else the issue's state phrase (no issue: the rail's chip), then who, then the live run's time.
 */
function stateLine(f: Facts, now: number): string {
  const { chip } = f.row;
  const alert = chip === 'conflict' || chip === 'approve' || chip === 'question';
  const phrase = alert || !f.s ? t(`devroom.chip.${chip}`, { count: f.row.wt.conflicts?.length ?? 0 }) : t(`devIssue.state.${f.s.state}`);
  const run = f.s?.run?.live ? elapsedText(now - Date.parse(f.s.run.since)) : null;
  return [phrase, f.who, run].filter(Boolean).join(' · ');
}

/** The issue id (`T-12`) next to the title, when the worktree has an issue. */
const IssueId = ({ task }: { task?: BoardTask }) => (task ? <span className={`shrink-0 text-text-muted ${SMALL}`}>{task.id}</span> : null);

/** T-183's 검토에서 돌려보냄: the issue's latest move into or out of review sent it back (its stored history). */
function ReturnedBadge({ s }: { s: Story }) {
  return (
    <span
      className={`inline-flex items-center gap-4 self-start px-8 py-1 border-ui border-devroom-bad rounded-ui-pill bg-devroom-bad-bg text-devroom-bad ${TINY}`}
      title={t('devIssue.round', { n: s.round })}
      data-testid="devbranch-returned"
    >
      <Icon name="rotate-ccw" pixel="↺" size={12} />
      {t('devIssue.sentBack')}
    </span>
  );
}

/** A small model chip (badge letter and name) when the agent's model is known. */
function ModelChip({ model }: { model: string | undefined }) {
  if (!model) return null;
  const badge = modelBadge(model);
  return (
    <span className={`inline-flex items-center gap-4 px-6 py-1 border-ui border-devroom-card-line rounded-ui-pill bg-devroom-box text-devroom-title ${TINY}`} data-testid="devbranch-model">
      {badge && <ModelBadge badge={badge} modelId={model} />}
      {modelName(badge, model) ?? model}
    </span>
  );
}

/** A face with the live dot of the mock-up's tiles. */
function LiveFace({ row, size, live }: { row: Row; size: number; live: boolean }) {
  return (
    <span className="relative shrink-0 grid place-items-center rounded-ui-card overflow-hidden bg-bg-dark border-ui border-devroom-card-line" style={{ width: size, height: size }}>
      <RowFace row={row} size={size - DEVBRANCH_LANE_PX / 2} />
      {live && <span className="absolute right-2 bottom-2 size-8 rounded-ui-pill bg-devroom-blue" aria-hidden="true" />}
    </span>
  );
}

// ── data hooks ────────────────────────────────────────────────

/** The last file count each tip's 변경 answer gave (detailKey): the pane's own close drops the answer, not the count. */
const knownCounts = new Map<string, number>();

/** Each tip's changed files from the 변경 pane's data: asked once per change of the worktree, never polled. */
function useFileCounts(project: string, rows: readonly Row[]): Record<string, number | undefined> {
  const { details } = useRepoStore();
  const sig = JSON.stringify(rows.map((r) => [r.wt.task, r.wt.lastChange ?? '', r.wt.dirty]));
  useEffect(() => {
    const tasks = (JSON.parse(sig) as [string][]).map(([task]) => task);
    for (const task of tasks) repoRequestDetail(project, task, send);
    return () => {
      // The picked worktree's 변경 pane may be reading the same answer.
      const keep = devroomGetSnapshot().picked?.task;
      for (const task of tasks) if (task !== keep) repoCloseDetail(project, task);
    };
  }, [project, sig]);
  return Object.fromEntries(
    rows.map((r) => {
      const key = detailKey(project, r.wt.task);
      const d = details[key];
      if (d && !d.loading && !d.error) knownCounts.set(key, d.files.length);
      return [r.wt.task, knownCounts.get(key)];
    }),
  );
}

/** Everything the picture and the panel read for one project. */
function useBranchData(project: string) {
  const { groups } = useDevroomGroups();
  const engine = useEngineStore().state?.projects ?? [];
  const { officeSnapshot, taskBoard, officeJobs } = useAgtyStore();
  const now = useNow();
  const group = groups.find((g) => g.project === project);
  const repo = group?.repo?.ok ? group.repo : undefined;
  const base = repo?.branch ?? group?.rows[0]?.wt.base ?? '';
  const rows = (group?.rows ?? []).filter((r) => r.chip !== 'merged');
  const isLive = (r: Row) => !!r.wt.assignee && engine.some((p) => p.name === r.wt.assignee && p.live);
  const { shown, folded } = orderTips(rows.map((r) => ({ key: r.wt.task, live: isLive(r), last: lastActivity(r.wt) })));
  const tips = shown.map((key) => {
    const row = rows.find((r) => r.wt.task === key)!;
    return factsOf(row, isLive(row));
  });
  const counts = useFileCounts(project, tips.map((f) => f.row));
  const tasks = taskBoard?.tasks ?? [];
  const merges = mergedToday(repo?.merges ?? [], base, now);
  const lead = engine.find((p) => p.name === project && !p.role);
  const leadId = lead ? (officeSnapshot?.orchestrators.find((o) => o.name === lead.name)?.agentId ?? null) : null;
  const jobs = baseJobs(officeJobs?.jobs ?? [], project, new Set((group?.rows ?? []).map((r) => r.wt.task)));
  const merged = (group?.rows ?? []).filter((r) => r.chip === 'merged').length;
  return { group, base, rows, tips, folded, counts, tasks, merges, lead, leadId, jobs, merged, now, engine };
}

const mergeTask = (m: RepoMerge, project: string, tasks: readonly BoardTask[]) =>
  tasks.find((x) => x.project === project && !!m.branch && x.branch === m.branch);

// ── the view ──────────────────────────────────────────────────

/** The one entry (the switch's 브랜치): the whole branch view of `project` (desktop), or its list (phone). */
export function BranchView({ project, phone = false }: { project: string; phone?: boolean }) {
  const data = useBranchData(project);
  const { groups } = useDevroomGroups();
  const pick = useCurrentPick(groups);
  const picked = pick?.project === project ? data.tips.find((f) => f.row.wt.task === pick.task) : undefined;
  const [pane, setPane] = useState<Pane>('changes');
  const choose = (task: string) => {
    pickWorktree(project, task);
    setPane('changes');
  };
  if (phone) return <PhoneBranches project={project} data={data} picked={picked} onPick={choose} />;
  return (
    <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-12 p-12 bg-bg" data-testid="devbranch" role="region" aria-label={t('devBranch.label')}>
      <ToolRow project={project} group={data.group} merged={data.merged} onSplit={(n) => {
        setPane('terminal');
        askBoardLayout(n);
      }} />
      <Picture project={project} data={data} picked={picked?.row.wt.task ?? null} onPick={choose} />
      {picked && <PickedPanel project={project} facts={picked} files={data.counts[picked.row.wt.task]} base={data.base} pane={pane} onPane={setPane} />}
    </div>
  );
}

type Data = ReturnType<typeof useBranchData>;

function ToolRow({ project, group, merged, onSplit }: { project: string; group: Group | undefined; merged: number; onSplit: (n: 1 | 2 | 4) => void }) {
  const canAct = useCanAct();
  const { projects } = useDevroomGroups();
  const [making, setMaking] = useState(false);
  return (
    <div className="shrink-0 flex flex-wrap items-center gap-10" data-testid="devbranch-tools">
      <FilterBox projects={projects} className="w-240" />
      <span className="text-text-muted">
        <HostClock size={SMALL} part="full" />
      </span>
      <span className="flex-1" />
      <span className={`text-text-muted ${SMALL}`}>{t('devBranch.split')}</span>
      <span className="inline-flex" role="group" aria-label={t('devBranch.split')}>
        {([1, 2, 4] as const).map((n) => (
          <button key={n} type="button" className={SEG} data-testid={`devbranch-split-${n}`} onClick={() => onSplit(n)}>
            {t(`msgSplit.layout${n}`)}
          </button>
        ))}
      </span>
      <button
        type="button"
        className={TOOL}
        data-testid="devbranch-cleanup"
        onClick={() => openFromStory(project, null, 'cleanup', false)}
      >
        <Icon name="folder-open" pixel={null} size={14} />
        {t('devBranch.cleanup', { count: merged })}
      </button>
      {canAct && group?.repo?.ok && (
        <button type="button" className={TOOL} data-testid="devbranch-new" onClick={() => setMaking(true)}>
          <Icon name="plus" pixel="+" size={14} />
          {t('devIssue.newWorktree')}
        </button>
      )}
      {making && group && <NewSpaceSheet group={group} onClose={() => setMaking(false)} />}
    </div>
  );
}

/** `{n}` and `{m}` of a template as coloured counts. */
function Counted({ text, n, m }: { text: string; n: number; m: number }) {
  return (
    <>
      {text.split(/(\{n\}|\{m\})/).map((part, i) =>
        part === '{n}' ? (
          <b key={i} className={`text-devroom-blue ${STRONG}`}>{n}</b>
        ) : part === '{m}' ? (
          <b key={i} className={`text-devroom-ok ${STRONG}`}>{m}</b>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

function Headline({ data }: { data: Data }) {
  const m = data.merges.length;
  return (
    <h2 className={`text-devroom-title text-base ${STRONG}`} data-testid="devbranch-headline">
      <Counted text={t(m ? 'devBranch.headlineMerged' : 'devBranch.headline', { base: data.base })} n={data.rows.length} m={m} />
    </h2>
  );
}

function Picture({ project, data, picked, onPick }: { project: string; data: Data; picked: string | null; onPick: (task: string) => void }) {
  const probe = useRef<HTMLSpanElement>(null);
  const width = useBounds(probe)?.w ?? 0;
  const job = data.jobs[0];
  const map = layoutMap(width, data.tips.map((f) => f.row.wt.task), data.folded, data.merges.map((_, i) => `${i}`), !!job);
  const shownMerges = data.merges.slice(data.merges.length - map.loops.length);
  // The trunk takes the merges' colour from today's first drawn loop on.
  const tintFrom = map.loops[0]?.line[0][0] ?? map.trunkEnd;
  return (
    <section className={`shrink-0 relative ${PANEL} pt-16`}>
      <div className="px-24">
        <Headline data={data} />
      </div>
      <div className="relative">
        <span ref={probe} className="absolute left-0 top-0" aria-hidden="true" />
        {width > 0 && (
          <div className="relative" style={{ height: map.height }}>
            <svg className="absolute inset-0" width={map.width} height={map.height} aria-hidden="true">
              <line x1={DEVBRANCH_PAD_PX} y1={map.trunkY} x2={tintFrom} y2={map.trunkY} className={`${LINE} ${THICK} stroke-devroom-trunk`} data-testid="devbranch-trunk-line" />
              {tintFrom < map.trunkEnd && <line x1={tintFrom} y1={map.trunkY} x2={map.trunkEnd} y2={map.trunkY} className={`${LINE} ${THICK} stroke-devroom-resolved-line`} />}
              {map.tips.map((tip) => {
                const on = tip.key !== null && tip.key === picked;
                const f = tip.key === null ? undefined : data.tips.find((x) => x.row.wt.task === tip.key);
                const tone = on ? 'stroke-devroom-main-line' : f?.live ? 'stroke-devroom-blue' : 'stroke-devroom-box-line';
                return (
                  <g key={tip.key ?? '+'}>
                    <path d={roundedPath(tip.line, DEVBRANCH_LANE_PX)} className={`${LINE} ${THIN} ${tone}`} />
                    <circle cx={tip.line[0][0]} cy={map.trunkY} r={DEVBRANCH_LANE_PX / 3} className={`${THIN} fill-devroom-rail ${tone}`} />
                  </g>
                );
              })}
              {map.loops.map((loop) => {
                const [, a, b] = loop.line;
                return (
                  <g key={loop.key}>
                    <path d={roundedPath(loop.line, DEVBRANCH_LANE_PX * 2)} className={`${LINE} ${THIN} stroke-devroom-on-line`} />
                    <circle cx={(a[0] + b[0]) / 2} cy={a[1]} r={DEVBRANCH_TICK_PX / 2} className={`${THIN} fill-devroom-rail stroke-devroom-on-line`} />
                    <path
                      d={`M${(a[0] + b[0]) / 2 - 5} ${a[1]} l3.5 3.5 l6.5 -6.5`}
                      className={`${LINE} ${THIN} stroke-devroom-ok`}
                    />
                  </g>
                );
              })}
            </svg>

            {map.tips.map((tip) => {
              const style = { left: tip.x, top: tip.y, width: tip.w, height: tip.h };
              if (tip.key === null)
                return (
                  <button
                    key="+"
                    type="button"
                    className={`absolute flex items-center justify-center border-ui border-dashed rounded-ui-card border-devroom-card-line bg-devroom-card text-text-muted hover:text-text ${BODY}`}
                    style={style}
                    data-testid="devbranch-more"
                    title={t('devBranch.moreTitle')}
                    onClick={() => setDevroomView('tree')}
                  >
                    {t('devBranch.more', { count: map.folded })}
                  </button>
                );
              const f = data.tips.find((x) => x.row.wt.task === tip.key)!;
              return <TipCard key={tip.key} facts={f} files={data.counts[f.row.wt.task]} now={data.now} on={tip.key === picked} style={style} onPick={() => onPick(f.row.wt.task)} />;
            })}

            <div
              className="absolute flex items-start gap-10 min-w-0"
              style={{ left: DEVBRANCH_PAD_PX, top: map.trunkY + DEVBRANCH_LANE_PX, width: DEVBRANCH_TRUNK_LABEL_W_PX - DEVBRANCH_PAD_PX }}
              data-testid="devbranch-trunk"
            >
              {data.lead && (
                <span className="shrink-0 grid place-items-center rounded-ui-card overflow-hidden bg-bg-dark border-ui border-devroom-card-line" style={{ width: DEVBRANCH_TIP_FACE_PX, height: DEVBRANCH_TIP_FACE_PX }}>
                  <Face agentId={data.leadId} name={data.lead.name} size={DEVBRANCH_TIP_FACE_PX - DEVBRANCH_LANE_PX / 2} />
                </span>
              )}
              <span className="flex flex-col gap-3 min-w-0">
                <span className="flex items-baseline gap-6 min-w-0">
                  <b className={`text-devroom-title ${BODY} ${STRONG}`}>{t('devBranch.trunkName')}</b>
                  <span className={`truncate text-text-muted ${SMALL}`} data-testid="devbranch-base">{data.base}</span>
                </span>
                <span className={`text-text-muted ${TINY}`}>{t('devBranch.trunkCaption')}</span>
                {data.lead && (
                  <span className="flex items-center gap-6 min-w-0">
                    <span className={`text-text-muted ${TINY}`}>{t('devBranch.trunkLead')}</span>
                    <ModelChip model={data.lead.model} />
                  </span>
                )}
              </span>
            </div>

            {map.loops.map((loop, i) => {
              const m = shownMerges[i];
              const task = mergeTask(m, project, data.tasks);
              const files = task?.filesChanged;
              return (
                <div
                  key={loop.key}
                  className={`absolute flex flex-col items-center text-center px-4 pt-14 gap-2 ${TINY}`}
                  style={{ left: loop.x, top: loop.y, width: loop.w }}
                  data-testid="devbranch-loop"
                >
                  <span className={`inline-flex items-center gap-4 text-devroom-ok ${SMALL}`}>
                    <Icon name="check" pixel="✔" size={12} />
                    {t('devBranch.merged', { time: resetClock(m.at)?.split(' ')[1] ?? '' })}
                  </span>
                  <span className={`w-full truncate text-devroom-title ${BODY}`}>{task?.title ?? m.branch ?? m.task ?? ''}</span>
                  <span className="w-full truncate text-text-muted">
                    {[task?.id, files && `${t('devBranch.files', { count: files.value })}${files.source === 'reported' ? ` (${t('devBranch.reported')})` : ''}`].filter(Boolean).join(' · ')}
                  </span>
                </div>
              );
            })}
            {map.loopsMore > 0 && (
              <span className={`absolute text-text-muted ${TINY}`} style={{ left: map.moreX, top: map.trunkY + DEVBRANCH_LANE_PX }} data-testid="devbranch-loops-more">
                {t('devBranch.loopsMore', { count: map.loopsMore })}
              </span>
            )}
            {job && map.box && <JobBox job={job} base={data.base} now={data.now} style={{ left: map.box.x, top: map.box.y, width: map.box.w, height: map.box.h }} />}
          </div>
        )}
      </div>
      <Legend empty={data.rows.length === 0} />
    </section>
  );
}

function Legend({ empty }: { empty: boolean }) {
  return (
    <p className={`flex flex-wrap items-center gap-x-18 gap-y-4 px-24 pb-12 text-text-muted ${TINY}`} data-testid="devbranch-legend">
      {empty && <span>{t('devBranch.empty')}</span>}
      <span className="inline-flex items-center gap-6">
        <svg width="28" height="12" aria-hidden="true">
          <path d="M2 11 Q10 11 14 6 T26 1" className={`${LINE} ${THIN} stroke-devroom-box-line`} />
        </svg>
        {t('devBranch.legendBranch')}
      </span>
      <span className="inline-flex items-center gap-6">
        <svg width="28" height="12" aria-hidden="true">
          <path d="M2 1 Q8 11 14 11 T26 1" className={`${LINE} ${THIN} stroke-devroom-on-line`} />
        </svg>
        {t('devBranch.legendLoop')}
      </span>
    </p>
  );
}

function TipCard({ facts: f, files, now, on, style, onPick }: { facts: Facts; files: number | undefined; now: number; on: boolean; style: CSSProperties; onPick: () => void }) {
  const { row } = f;
  return (
    <button
      type="button"
      className={`absolute flex gap-10 px-12 py-10 text-left border-ui rounded-ui-card overflow-hidden ${on ? 'border-devroom-accent-line bg-devroom-main shadow-(--ui-glow)' : 'border-devroom-card-line bg-devroom-card hover:bg-devroom-pick'}`}
      style={style}
      aria-pressed={on}
      data-testid="devbranch-tip"
      data-task={row.wt.task}
      onClick={onPick}
    >
      <LiveFace row={row} size={DEVBRANCH_TIP_FACE_PX} live={f.live} />
      <span className="flex-1 min-w-0 flex flex-col gap-3">
        <span className="flex items-baseline gap-6 min-w-0">
          <span className={`truncate text-devroom-title ${BODY} ${STRONG}`}>{row.title}</span>
          <IssueId task={row.task} />
        </span>
        <span className={`truncate ${STATE_TONE[row.chip]} ${SMALL}`} data-testid="devbranch-state" data-chip={row.chip}>
          {stateLine(f, now)}
        </span>
        {f.s?.returned && <ReturnedBadge s={f.s} />}
        <span className={`truncate text-text-muted ${TINY}`}>
          {files !== undefined && <span data-testid="devbranch-files">{t('devBranch.files', { count: files })} · </span>}
          {t('devBranch.next', { next: t(`devBranch.nextShort.${row.chip}`) })}
        </span>
        <span className={`truncate text-text-muted opacity-70 ${TINY}`}>{row.wt.branch}</span>
      </span>
    </button>
  );
}

/** A job running on the base: its stored description, a bar only when it reports a count, else its minutes. */
function JobBox({ job, base, now, style }: { job: OfficeJob; base: string; now: number; style: CSSProperties }) {
  const p = job.progress;
  const measured = p && !p.indeterminate;
  const started = job.started ? Date.parse(job.started) : NaN;
  return (
    <div className={`absolute flex flex-col gap-6 px-14 py-10 border-ui border-devroom-work-line rounded-ui-card bg-devroom-work-bg`} style={style} data-testid="devbranch-job">
      <span className="flex items-center gap-8 min-w-0">
        <Icon name="shield" pixel={null} size={16} />
        <b className={`truncate text-devroom-title ${BODY} ${STRONG}`}>{job.label ?? job.cmd}</b>
        {Number.isFinite(started) && <span className={`ml-auto shrink-0 text-devroom-blue ${SMALL}`}>{elapsedText(now - started)}</span>}
      </span>
      <span className="h-6 rounded-ui-pill bg-bg-dark overflow-hidden">
        {measured ? <span className="block h-full bg-devroom-blue" style={{ width: `${Math.round(p.pct)}%` }} /> : <span className="block h-full w-1/3 bg-devroom-work-line animate-pulse" />}
      </span>
      <span className={`flex items-center gap-6 text-text-muted ${TINY}`}>
        <span className="truncate">{t('devBranch.baseJob', { base })}</span>
        {measured && <span className="ml-auto shrink-0 text-devroom-title">{Math.round(p.pct)}%</span>}
      </span>
    </div>
  );
}

// ── the picked worktree's panel ───────────────────────────────

type Pane = 'chat' | 'changes' | 'diff' | 'check' | 'terminal';
const TABS: readonly { id: Exclude<Pane, 'diff'>; icon: 'message-square-text' | 'file' | 'check' | 'square-terminal' }[] = [
  { id: 'chat', icon: 'message-square-text' },
  { id: 'changes', icon: 'file' },
  { id: 'check', icon: 'check' },
  { id: 'terminal', icon: 'square-terminal' },
];

/** The left half: who, where, the state sentence, the sent review notes as written, 다음, the agent's last message. */
/** The panel's sentence: T-183's story sentence of the issue (its devIssue.say templates), unless a wait for the owner comes first. */
function sayOf(f: Facts, notes: number, base: string): string | null {
  const { chip } = f.row;
  if (!f.s || chip === 'conflict' || chip === 'approve' || chip === 'question') return null;
  const key = f.s.state === 'assign' && !f.row.wt.assignee ? 'assignNobody' : f.s.state === 'workAgain' && notes > 0 ? 'workAgainNotes' : f.s.state;
  return t(`devIssue.say.${key}`, { who: f.who ?? t('devroom.nobody'), n: f.s.round, notes, base });
}

function PickedInfo({ project, facts: f, base }: { project: string; facts: Facts; base: string }) {
  const { row } = f;
  const engine = useEngineStore().state?.projects ?? [];
  const { contacts } = useMessenger();
  const { notes } = useReviewStore();
  const now = useNow();
  const agent = engine.find((p) => p.name === row.wt.assignee);
  useReviewNotes(project, row.wt.task, useCanAct());
  const sent = (notes[reviewKey(project, row.wt.task)]?.notes ?? []).filter((n) => n.sentAt && !n.fixed);
  const contact = row.agentId === null ? undefined : contacts.find((c) => c.agentId === row.agentId);
  const said = contact?.lastFrom === 'peer' && contact.preview ? contact : undefined;
  return (
    <div className="flex flex-col gap-10 min-w-0" data-testid="devbranch-info">
      <div className="flex items-start gap-12 min-w-0">
        <LiveFace row={row} size={DEVBRANCH_PANEL_FACE_PX} live={f.live} />
        <div className="flex flex-col gap-6 min-w-0">
          <span className="flex items-baseline gap-8 min-w-0">
            <b className={`truncate text-devroom-title text-sm ${STRONG}`}>{row.title}</b>
            <IssueId task={row.task} />
          </span>
          <span className="flex items-center gap-8 min-w-0">
            {f.who && (
              <span className={`inline-flex items-center gap-4 px-6 py-1 border-ui border-devroom-card-line rounded-ui-pill bg-devroom-box text-devroom-title ${TINY}`}>
                {f.who}
              </span>
            )}
            <ModelChip model={agent?.model} />
            <span className={`truncate text-text-muted ${TINY}`}>{row.wt.branch}</span>
          </span>
        </div>
      </div>
      <p className={`flex items-center gap-8 ${STATE_TONE[row.chip]} ${BODY}`}>
        <span className="size-8 shrink-0 rounded-ui-pill bg-current" aria-hidden="true" />
        <span data-testid="devbranch-say">{sayOf(f, sent.length, base) ?? stateLine(f, now)}</span>
      </p>
      {sent.length > 0 && (
        <div className={`flex flex-col gap-4 text-devroom-bad ${SMALL}`} data-testid="devbranch-notes">
          <span className="inline-flex items-center gap-6">
            <Icon name="rotate-ccw" pixel="↺" size={12} />
            {t('devBranch.notesSent', { count: sent.length })}
          </span>
          {sent.map((n) => (
            <span key={n.id} className="pl-18 text-text">
              {n.body} <span className="text-text-muted">· {n.by}</span>
            </span>
          ))}
        </div>
      )}
      <p className={`${BODY}`}>
        <b className={`mr-8 text-devroom-title ${STRONG}`}>{t('devBranch.nextLabel')}</b>
        <span className="text-text-muted">{t(`devBranch.nextLong.${row.chip}`)}</span>
      </p>
      {said && (
        <blockquote className={`border-l-ui border-devroom-card-line pl-12 flex flex-col gap-4 ${SMALL}`} data-testid="devbranch-said">
          <span className="text-text-muted">{t('devBranch.lastSaid', { name: said.name, ago: said.lastAt ? timeAgo(new Date(said.lastAt).toISOString(), now) : '' })}</span>
          <span className="text-text line-clamp-3">{said.preview}</span>
        </blockquote>
      )}
    </div>
  );
}

function PickedPanel({ project, facts, files, base, pane, onPane }: { project: string; facts: Facts; files: number | undefined; base: string; pane: Pane; onPane: (p: Pane) => void }) {
  const task = facts.row.wt.task;
  const lines = useLineCounts(project, task, pane === 'changes');
  return (
    <section className={`flex min-h-0 ${PANEL} overflow-hidden`} style={{ minHeight: DEVBRANCH_LOWER_MIN_PX }} data-testid="devbranch-panel">
      <div className="w-[38%] shrink-0 p-18 border-r-ui border-devroom-card-line overflow-y-auto">
        <PickedInfo project={project} facts={facts} base={base} />
      </div>
      <div className="flex-1 min-w-0 flex flex-col">
        <nav className="shrink-0 flex items-center gap-6 px-14 h-52 border-b-ui border-devroom-card-line" aria-label={t('devBranch.tabs')}>
          {TABS.map(({ id, icon }) => {
            const on = pane === id || (id === 'changes' && pane === 'diff');
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={on}
                data-pane={id}
                className={`inline-flex items-center gap-6 px-12 h-34 border-ui rounded-ui-card ${on ? 'border-devroom-accent-line bg-devroom-main text-devroom-title' : 'border-transparent text-text-muted hover:text-text'} ${BODY}`}
                onClick={() => onPane(id)}
              >
                <Icon name={icon} pixel={null} size={14} />
                {t(`devBranch.tab.${id}`)}
                {id === 'changes' && files !== undefined && <span className="text-devroom-review">{files}</span>}
              </button>
            );
          })}
          {lines && (
            <span className={`ml-auto ${SMALL}`} data-testid="devbranch-lines">
              <span className="text-devroom-ok">+{lines.add}</span> <span className="text-devroom-bad">-{lines.del}</span>
            </span>
          )}
        </nav>
        <div className="flex-1 min-h-0 flex flex-col" data-testid="devbranch-pane" data-pane={pane}>
          <PaneBody project={project} facts={facts} base={base} pane={pane} onPane={onPane} lines={lines} />
        </div>
      </div>
    </section>
  );
}

/** +a −d of the picked worktree's files while its 바뀐 것 list shows (the review's own diffs); null until all are in. */
function useLineCounts(project: string, task: string, on: boolean): { add: number; del: number; per: Record<string, { add: number; del: number }> } | null {
  const { details, diffs } = useRepoStore();
  const files = (details[detailKey(project, task)]?.files ?? []).slice(0, DEVBRANCH_FILES_MAX).map((f) => f.path);
  const sig = files.join('\0');
  useEffect(() => {
    if (!on || !sig) return;
    const paths = sig.split('\0');
    for (const path of paths) repoRequestDiff(project, path, false, send, false, task);
    return () => {
      for (const path of paths) repoCloseDiff(project, path, false, task);
    };
  }, [project, task, sig, on]);
  if (!files.length) return null;
  const per: Record<string, { add: number; del: number }> = {};
  for (const path of files) {
    const view = diffs[diffKey(project, path, false, task)];
    if (!view || view.loading) return null;
    per[path] = diffCounts(view.text);
  }
  const all = Object.values(per);
  return { add: all.reduce((n, c) => n + c.add, 0), del: all.reduce((n, c) => n + c.del, 0), per };
}

type Lines = ReturnType<typeof useLineCounts>;

function PaneBody({ project, facts: f, base, pane, onPane, lines }: { project: string; facts: Facts; base: string; pane: Pane; onPane: (p: Pane) => void; lines: Lines }) {
  const { row } = f;
  const task = row.wt.task;
  const term = useTerminalColumns(project, row.wt);
  if (pane === 'chat')
    return row.agentId !== null ? <PaneChat agentId={row.agentId} project={project} on onTerminal={() => onPane('terminal')} /> : <p className={`m-auto text-text-muted ${BODY}`}>{t('devBranch.noChat')}</p>;
  if (pane === 'diff') return <TaskReview project={project} task={task} live onMerge={() => onPane('check')} />;
  if (pane === 'check') return <MergeTab project={project} task={task} view="merge" />;
  if (pane === 'terminal')
    return (
      <RunArea project={project} task={task} assignee={row.wt.assignee}>
        <TerminalColumns project={project} cols={term.cols} subs={term.subs} focus={term.focus} on />
      </RunArea>
    );
  return <ChangesList project={project} row={row} base={base} onPane={onPane} lines={lines} />;
}

function shortPath(path: string): { dir: string; name: string } {
  const parts = path.split('/');
  const name = parts.pop() ?? path;
  return { dir: parts.length > 2 ? `${parts[0]}/…/${parts[parts.length - 1]}/` : parts.length ? `${parts.join('/')}/` : '', name };
}

/** 바뀐 것: the files with their line counts, 바뀐 내용 보기 (the review's diff), and the merge with the pre-check's own reason. */
function ChangesList({ project, row, base, onPane, lines }: { project: string; row: Row; base: string; onPane: (p: Pane) => void; lines: Lines }) {
  const task = row.wt.task;
  const { details } = useRepoStore();
  const { checks } = useMergeStore();
  const canAct = useCanAct();
  const detail = details[detailKey(project, task)];
  const all = detail?.files ?? [];
  const sig = [row.wt.ahead, row.wt.behind, row.wt.dirty, row.wt.merged, row.wt.conflicts?.length].join();
  useEffect(() => repoRequestDetail(project, task, send), [project, task, sig]);
  useEffect(() => requestCheck(project, task), [project, task, sig]);
  const check = checks[taskKey(project, task)];
  const conflicting = check?.ok === true && check.clean === false;
  const blocked = !check
    ? t('merge.loading')
    : !check.ok
      ? serverText(check, t('merge.checkFailed'))
      : conflicting
        ? t('devroom.chip.conflict', { count: check.conflicts?.length ?? row.wt.conflicts?.length ?? 0 })
        : fixingLock(check, row.task?.status)
          ? t('merge.locked')
          : row.wt.ahead === 0
            ? t('devBranch.mergeNothing')
            : null;
  const warn = check?.ok && !blocked ? preChecks(check, null).find((c) => !c.ok)?.text : undefined;
  return (
    <div className="flex-1 min-h-0 flex flex-col" data-testid="devbranch-changes">
      <div className="flex-1 min-h-0 overflow-y-auto px-14">
        {all.length === 0 && <p className={`py-16 text-text-muted ${BODY}`}>{detail?.error ?? (detail?.loading !== false ? t('merge.loading') : t('devBranch.noFiles'))}</p>}
        {all.slice(0, DEVBRANCH_FILES_MAX).map((file) => {
          const { dir, name } = shortPath(file.path);
          const c = lines?.per[file.path];
          return (
            <div key={file.path} className={`flex items-center gap-10 py-10 border-b-ui border-devroom-menu-line ${BODY}`} data-testid="devbranch-file">
              <Icon name="file" pixel={null} size={14} className="shrink-0 text-text-muted" />
              <span className="min-w-0 truncate">
                <span className="text-text-muted">{dir}</span>
                <span className="text-devroom-title">{name}</span>
              </span>
              {c && (
                <span className={`ml-auto shrink-0 ${SMALL}`}>
                  <span className="text-devroom-ok">+{c.add}</span> <span className="text-devroom-bad">-{c.del}</span>
                </span>
              )}
            </div>
          );
        })}
        {all.length > DEVBRANCH_FILES_MAX && <p className={`py-8 text-text-muted ${SMALL}`}>{t('devBranch.filesMore', { count: all.length - DEVBRANCH_FILES_MAX })}</p>}
      </div>
      <div className="shrink-0 flex flex-wrap items-center gap-10 px-14 py-12 border-t-ui border-devroom-card-line">
        <button type="button" className={`inline-flex items-center gap-6 px-14 h-36 rounded-ui-card bg-accent text-white hover:brightness-110 ${BODY}`} data-testid="devbranch-show-diff" onClick={() => onPane('diff')} disabled={all.length === 0}>
          <Icon name="eye" pixel={null} size={14} />
          {t('devBranch.showDiff')}
        </button>
        <span className="flex-1" />
        {(blocked ?? warn) && <span className={`min-w-0 truncate ${blocked ? 'text-text-muted' : 'text-devroom-conf-text'} ${SMALL}`} data-testid="devbranch-merge-why">{blocked ?? warn}</span>}
        {canAct && (
          <button
            type="button"
            className={`inline-flex items-center gap-6 px-14 h-36 border-ui rounded-ui-card ${blocked ? 'border-devroom-card-line text-text-muted' : 'border-devroom-accent-line bg-devroom-main text-devroom-title hover:bg-accent'} ${BODY}`}
            data-testid="devbranch-merge"
            disabled={!!blocked}
            onClick={() => onPane('check')}
          >
            {blocked && <Icon name="lock" pixel={null} size={14} />}
            {t('devBranch.mergeGo', { base })}
          </button>
        )}
      </div>
    </div>
  );
}

// ── phone: the same tips and loops as a list, then the picked one ──

/** The phone's sub-pages (DevRoomPhone) under the mock-up's tab names: the terminal page holds the 대화 too. */
const PHONE_PAGES = [['terminal', 'terminal'], ['changes', 'changes'], ['merge', 'check']] as const;

function PhoneBranches({ project, data, picked, onPick }: { project: string; data: Data; picked: Facts | undefined; onPick: (task: string) => void }) {
  // The phone's own sub-pages; 뒤로 comes back to this list (the view stays 브랜치).
  const page = (p: 'terminal' | 'changes' | 'merge') => picked && openFromStory(project, picked.row.wt.task, p, true);
  return (
    <div className="flex flex-col gap-10 p-10" data-testid="devbranch" data-phone>
      <Headline data={data} />
      <p className={`flex items-center gap-8 text-text-muted ${SMALL}`} data-testid="devbranch-trunk">
        <span className="h-6 w-24 rounded-ui-pill bg-devroom-trunk" aria-hidden="true" />
        <b className="text-devroom-title">{data.base}</b>
        <span className="truncate">{t('devBranch.trunkCaption')}</span>
      </p>
      {data.tips.map((f) => (
        <PhoneTip key={f.row.wt.task} facts={f} files={data.counts[f.row.wt.task]} now={data.now} on={picked?.row.wt.task === f.row.wt.task} onPick={() => onPick(f.row.wt.task)} />
      ))}
      {data.folded > 0 && (
        <button type="button" className={`${TOOL} justify-center border-dashed`} data-testid="devbranch-more" onClick={() => setDevroomView('tree')}>
          {t('devBranch.more', { count: data.folded })}
        </button>
      )}
      {data.merges.map((m, i) => {
        const task = mergeTask(m, project, data.tasks);
        return (
          <div key={i} className={`flex items-center gap-8 px-10 py-6 border-l-ui border-devroom-on-line ${SMALL}`} data-testid="devbranch-loop">
            <span className="shrink-0 text-devroom-ok">{t('devBranch.merged', { time: resetClock(m.at)?.split(' ')[1] ?? '' })}</span>
            <span className="truncate">{task?.title ?? m.branch ?? m.task ?? ''}</span>
            {task && <span className="ml-auto shrink-0 text-text-muted">{task.id}</span>}
          </div>
        );
      })}
      {data.jobs[0] && (
        <div className="relative h-96">
          <JobBox job={data.jobs[0]} base={data.base} now={data.now} style={{ left: 0, top: 0, right: 0, height: '100%' }} />
        </div>
      )}
      {picked && (
        <section className={`${PANEL} p-12 flex flex-col gap-10`} data-testid="devbranch-panel">
          <PickedInfo project={project} facts={picked} base={data.base} />
          <div className="grid grid-cols-3 gap-6">
            {PHONE_PAGES.map(([p, label]) => (
              <button key={p} type="button" className={`${TOOL} justify-center`} data-page={p} onClick={() => page(p)}>
                {t(`devBranch.tab.${label}`)}
              </button>
            ))}
          </div>
        </section>
      )}
      <Legend empty={data.rows.length === 0} />
    </div>
  );
}

function PhoneTip({ facts: f, files, now, on, onPick }: { facts: Facts; files: number | undefined; now: number; on: boolean; onPick: () => void }): ReactNode {
  const { row } = f;
  return (
    <button
      type="button"
      className={`flex gap-10 p-10 text-left border-ui rounded-ui-card ${on ? 'border-devroom-accent-line bg-devroom-main' : 'border-devroom-card-line bg-devroom-card'}`}
      aria-pressed={on}
      data-testid="devbranch-tip"
      data-task={row.wt.task}
      onClick={onPick}
    >
      <LiveFace row={row} size={DEVROOM_FACE_PX * 2} live={f.live} />
      <span className="flex-1 min-w-0 flex flex-col gap-3">
        <span className="flex items-baseline gap-6 min-w-0">
          <span className={`truncate text-devroom-title ${BODY} ${STRONG}`}>{row.title}</span>
          <IssueId task={row.task} />
        </span>
        <span className={`truncate ${STATE_TONE[row.chip]} ${SMALL}`}>{stateLine(f, now)}</span>
        {f.s?.returned && <ReturnedBadge s={f.s} />}
        <span className={`truncate text-text-muted ${TINY}`}>
          {files !== undefined && `${t('devBranch.files', { count: files })} · `}
          {t('devBranch.next', { next: t(`devBranch.nextShort.${row.chip}`) })}
        </span>
        <span className={`truncate text-text-muted opacity-70 ${TINY}`}>{row.wt.branch}</span>
      </span>
    </button>
  );
}
