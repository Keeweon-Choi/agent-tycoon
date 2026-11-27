/**
 * T-183 개발실 › 이슈 (mockups-1127/board4-dev-issue-*, the target since the owner's 11-27 17:51): left,
 * 하고 있는 일 (the open issues whose worktree the engine recorded: face, title, the state phrase and the
 * Worker's model, elapsed time, id, the six-step position bar), today's merges, a door to the tree view
 * and the tidy-up row; right, the picked issue: its head line, title, one state sentence and six step cards.
 * Every line is a fixed template filled with stored facts, or text a person or an agent wrote (the title,
 * the detail, a review note, the agent's last message) shown as such: nothing is written at display time.
 * The buttons open the existing views (대화, 터미널, 변경, 머지, 정리, the issue board, 실행) on the issue's
 * worktree instead of drawing them again.
 */
import './issueView.css';

import { type ReactNode, useEffect, useState } from 'react';

import type { BoardTask } from '../../../../core/src/messages.js';
import { Button } from '../../components/ui/Button.js';
import { DEVISSUE_FACE_PX, DEVISSUE_FILES_MAX, DEVISSUE_PHONE_FACE_PX } from '../../constants.js';
import { t } from '../../i18n/index.js';
import { transport } from '../../transport/index.js';
import { useEngineStore } from '../engineStore.js';
import { openJobs } from '../game/openJobs.js';
import { Icon, type LucideName } from '../icons/Icon.js';
import { elapsedDuration, elapsedText } from '../kinds.js';
import { useMessenger } from '../messenger/messengerStore.js';
import { modelBadge, modelName } from '../modelBadges.js';
import { useAgtyStore } from '../officeStore.js';
import { setRunsProject } from '../panels/runsFilter.js';
import { detailKey, diffKey, repoCloseDetail, repoCloseDiff, repoRequestDetail, repoRequestDiff, useRepoStore } from '../repo/repoStore.js';
import { diffCounts } from '../repo/repoText.js';
import { reviewKey, useReviewStore } from '../repo/reviewStore.js';
import { useReviewNotes } from '../repo/useRepoView.js';
import { serverText } from '../serverText.js';
import { openIssue, useCanAct, useNow } from '../workbench/workbenchStore.js';
import { BIG, BODY, type Group, type Row, SMALL, TINY, whoName } from './devroomData.js';
import { isMerged } from './devroomState.js';
import { closeDevroomPage, DEVROOM_VIEWS, type DevroomTab, openFromStory, openStory, type Picked, pickWorktree, setDevroomView, useDevroom } from './devroomStore.js';
import { openIssues, runOf, shortPath, type StepId, STEPS, type Story as StoryModel, story, todayMerges } from './issueStory.js';
import { fixingLock, preChecks, testsLine } from './mergeState.js';
import { requestCheck, taskKey, useMergeStore } from './mergeStore.js';
import { NewSpaceSheet } from './NewSpace.js';
import { clock, latestTest } from './runState.js';
import { RowFace } from './WorktreeRail.js';

const send = (msg: Parameters<typeof transport.send>[0]) => transport.send(msg);
const ICON: Record<StepId, LucideName> = {
  assign: 'clipboard-list',
  work: 'hammer',
  changes: 'file-text',
  check: 'shield',
  merge: 'git-branch',
  deploy: 'package',
};
/** A history's `by`: the owner's own writes come from the app (`gui:…`), a Lead is named after its project. */
const byName = (by: string, project: string) => (by.startsWith('gui:') ? t('review.owner') : by === project ? t('devIssue.lead') : by);
/** A review note's author: a Lead's `agent:<name>`, else the owner (as repo/ReviewNotes.tsx reads it). */
const authorOf = (by: string): string | null => (by.startsWith('agent:') ? by.slice('agent:'.length) : null);
/** A time of today as `19:47`, of another day as the merge list writes it. */
const when = (iso: string | undefined) => (iso && new Date(iso).toDateString() === new Date().toDateString() ? clock(iso) : iso ? new Date(iso).toLocaleDateString() : '—');

const CHIP = {
  ok: 'text-devroom-ok border-devroom-resolved-line bg-devroom-resolved-bg',
  now: 'text-devroom-blue border-devroom-work-line bg-devroom-work-bg',
  back: 'text-devroom-bad border-devroom-bad bg-devroom-bad-bg',
  not: 'text-text-muted border-border bg-transparent',
} as const;

function Chip({ tone, children }: { tone: keyof typeof CHIP; children: ReactNode }) {
  return <span className={`shrink-0 inline-flex items-center gap-4 whitespace-nowrap px-8 border-ui rounded-ui-pill leading-[calc(1.5*var(--ui-lh))] ${TINY} ${CHIP[tone]}`} data-chip={tone}>{children}</span>;
}

const Dot = () => <span className="shrink-0 inline-block size-8 rounded-ui-pill bg-devroom-blue" aria-hidden="true" />;

/** The view switch (title bar on the PC, a row on the phone): one button per DEVROOM_VIEWS entry. */
export function ViewSwitch({ className = '' }: { className?: string }) {
  const { view } = useDevroom();
  return (
    <span className={`flex items-center gap-4 ${className}`} role="group" aria-label={t('devIssue.switch')}>
      {DEVROOM_VIEWS.map((v) => (
        <Button key={v.id} size="sm" variant={view === v.id ? 'active' : 'default'} aria-pressed={view === v.id} data-testid="devroom-view" data-view={v.id} onClick={() => setDevroomView(v.id)}>
          {t(v.label)}
        </Button>
      ))}
    </span>
  );
}

interface IssueRow {
  group: Group;
  row: Row;
}

const issueRows = (groups: readonly Group[]): IssueRow[] => groups.flatMap((group) => openIssues(group.rows).map((row) => ({ group, row })));

/** The pick when it is an issue row, else the first one. */
const pickedRow = (rows: readonly IssueRow[], pick: Picked | null): IssueRow | undefined =>
  rows.find((r) => r.group.project === pick?.project && r.row.wt.task === pick.task) ?? rows[0];

/** The story model from what the list already holds (no repository read: the bar and the phrase). */
const rowStory = (row: Row) => story({ task: row.task!, wt: row.wt, merged: isMerged(row.wt, row.task), agent: row.wt.assignee ?? null, files: null, notes: 0, checked: false });

/** The Worker's model as the registry names it ("Opus-5.5", "Codex Terra"), if it names one. */
function useModelOf(agent: string | null | undefined): string | null {
  const engine = useEngineStore().state?.projects ?? [];
  const model = agent ? engine.find((p) => p.name === agent)?.model : undefined;
  return model ? (modelName(modelBadge(model), model) ?? model) : null;
}

/** The state phrase: a wait for the owner first (the rail's own chip words), else the fixed phrase of the issue's state. */
function phraseOf(row: Row, s: StoryModel): { text: string; alert: boolean } {
  if (row.chip === 'conflict' || row.chip === 'approve' || row.chip === 'question')
    return { text: t(`devroom.chip.${row.chip}`, { count: row.wt.conflicts?.length ?? 0 }), alert: true };
  return { text: t(`devIssue.state.${s.state}`), alert: false };
}

/** The six steps as segments: the ones behind the current step full, the current one moving, the rest empty. */
function StepBar({ s }: { s: StoryModel }) {
  return (
    <span className="flex items-center gap-8 min-w-0" data-testid="issue-bar" data-position={s.position}>
      <span className="flex-1 min-w-0 flex gap-2 h-6" aria-hidden="true">
        {STEPS.map((id, i) => (
          <span key={id} className={`flex-1 rounded-ui-pill ${i + 1 < s.position ? 'bg-devroom-blue' : i + 1 === s.position && s.state !== 'merged' ? 'devissue-stripe' : i + 1 === s.position ? 'bg-devroom-blue' : 'bg-devroom-bar'}`} />
        ))}
      </span>
      {s.returned && (
        <span className={`shrink-0 flex items-center gap-2 text-devroom-bad ${TINY}`} data-testid="issue-row-return">
          <Icon name="rotate-ccw" size={12} pixel="↺" />
          {t('devIssue.backMark')}
        </span>
      )}
      <span className={`shrink-0 text-text-muted ${TINY}`}>{t('devIssue.position', { n: s.position, total: STEPS.length })}</span>
    </span>
  );
}

function IssueRowItem({ group, row, on, phone }: { group: Group; row: Row; on: boolean; phone: boolean }) {
  const now = useNow();
  const task = row.task!;
  const s = rowStory(row);
  const model = useModelOf(row.wt.assignee);
  const run = runOf(task);
  const from = run?.live ? run.since : (s.since ?? task.createdAt);
  const phrase = phraseOf(row, s);
  return (
    <button
      type="button"
      className={`w-full flex items-start gap-12 p-12 text-left border-ui rounded-ui-card ${on ? 'border-accent bg-active-bg' : 'border-transparent hover:bg-active-bg'}`}
      data-testid="issue-row"
      data-task-id={task.id}
      aria-current={on || undefined}
      onClick={() => (phone ? openStory(group.project, row.wt.task) : pickWorktree(group.project, row.wt.task))}
    >
      <span className="shrink-0 grid place-items-center border-ui rounded-ui-card border-border bg-bg-dark overflow-hidden">
        <RowFace row={row} size={phone ? DEVISSUE_PHONE_FACE_PX : DEVISSUE_FACE_PX} />
      </span>
      <span className="flex-1 min-w-0 flex flex-col gap-4">
        <span className="flex items-baseline gap-8 min-w-0">
          <b className="flex-1 min-w-0 truncate font-(--ui-weight-strong) text-devroom-title text-sm">{task.title}</b>
          <span className={`shrink-0 text-text-muted ${SMALL}`} data-testid="issue-row-elapsed">{elapsedText(now - Date.parse(from))}</span>
        </span>
        <span className={`flex items-center gap-6 min-w-0 ${SMALL}`}>
          {phrase.alert ? <span className="shrink-0 text-devroom-conf">{phrase.text}</span> : (
            <span className="shrink-0 flex items-center gap-6 text-devroom-blue" data-testid="issue-row-state">
              <Dot />
              {phrase.text}
            </span>
          )}
          {model && <span className="min-w-0 truncate text-text-muted">· {model}</span>}
          <span className={`ml-auto shrink-0 text-text-muted ${TINY}`}>{task.id}</span>
        </span>
        <StepBar s={s} />
      </span>
    </button>
  );
}

function IssueList({ groups, rows, picked, phone }: { groups: readonly Group[]; rows: readonly IssueRow[]; picked: IssueRow | undefined; phone: boolean }) {
  const now = useNow();
  const canAct = useCanAct();
  const { filter } = useDevroom();
  const [making, setMaking] = useState(false);
  const here = groups.find((g) => g.project === (filter ?? picked?.group.project)) ?? groups[0];
  const merges = groups.flatMap((g) => (g.repo?.ok ? todayMerges(g.repo.merges ?? [], now).map((m) => ({ g, m })) : []));
  const mergedRows = groups.reduce((n, g) => n + g.rows.filter((r) => r.chip === 'merged').length, 0);
  return (
    <div className="flex-1 min-h-0 flex flex-col border-ui rounded-ui-card border-border bg-devroom-panel" data-testid="issue-list">
      <div className="flex items-center gap-8 px-14 pt-14 pb-8">
        <Icon name="hammer" size={18} pixel={null} />
        <h3 className="font-(--ui-weight-strong) text-devroom-title text-sm">{t('devIssue.listTitle')}</h3>
        <span className={`px-8 rounded-ui-pill bg-devroom-work-bg text-devroom-blue ${SMALL}`}>{rows.length}</span>
        {canAct && here?.repo?.ok && (
          <Button size="sm" className="ml-auto" data-testid="issue-new-worktree" onClick={() => setMaking(true)}>
            <Icon name="plus" size={14} pixel="+" />
            {t('devIssue.newWorktree')}
          </Button>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-8 pb-8">
        {rows.length === 0 && <p className={`px-8 py-6 text-text-muted ${SMALL}`}>{t('devIssue.empty')}</p>}
        <ul className="flex flex-col gap-4" aria-label={t('devIssue.list')}>
          {rows.map(({ group, row }) => (
            <li key={`${group.project}\0${row.wt.task}`}>
              <IssueRowItem group={group} row={row} on={!phone && picked?.row === row} phone={phone} />
            </li>
          ))}
        </ul>
        {merges.length > 0 && (
          <section className={`mx-8 mt-10 pt-10 border-t-ui border-border ${SMALL}`} data-testid="issue-today">
            <p className="flex items-center gap-8">
              <span className="text-devroom-ok">
                <Icon name="check" size={16} pixel="✓" />
              </span>
              <b className={`font-normal text-devroom-title ${BODY}`}>{t('devIssue.today', { count: merges.length })}</b>
              <span className="ml-auto text-text-muted">{[...new Set([merges.at(-1)!.m.at, merges[0].m.at])].map((at) => clock(at)).join(' · ')}</span>
            </p>
            <p className="mt-4 pl-24 text-text-muted truncate">{merges.map(({ g, m }) => g.rows.find((r) => r.wt.task === m.task)?.title ?? m.branch ?? m.task).join(' · ')}</p>
          </section>
        )}
        <button type="button" className={`mx-8 mt-10 pt-10 w-[calc(100%-16px)] flex items-center gap-8 border-t-ui border-border text-left ${SMALL}`} data-testid="issue-to-tree" onClick={() => setDevroomView('tree')}>
          <span className="text-accent-text">{t('devIssue.toTree')}</span>
          <span className="min-w-0 truncate text-text-muted">{t('devIssue.toTreeHint')}</span>
          <span className="ml-auto text-accent-text">
            <Icon name="chevron-right" size={16} pixel="›" />
          </span>
        </button>
      </div>
      {here && (
        <div className={`shrink-0 flex items-center gap-10 px-14 py-10 border-t-ui border-border ${SMALL}`} data-testid="issue-tidy">
          <Icon name="archive" size={18} pixel={null} />
          <span className="flex-1 min-w-0">
            <span className={`block ${BODY}`}>{t('devIssue.tidy', { count: mergedRows })}</span>
            <span className="block text-text-muted">{t('devIssue.tidyHint')}</span>
          </span>
          <Button size="sm" disabled={mergedRows === 0} data-testid="issue-tidy-open" onClick={() => openFromStory(here.project, null, 'cleanup', phone)}>
            {t('devIssue.tidyButton')}
          </Button>
        </div>
      )}
      {making && here && <NewSpaceSheet group={here} onClose={() => setMaking(false)} />}
    </div>
  );
}

/** The changed files the 변경 tab reads (repoWorktreeDetail), and the first few files' diffs for their +/− counts. */
function useChanges(project: string, task: string, sig: string) {
  const { details, diffs } = useRepoStore();
  useEffect(() => {
    repoRequestDetail(project, task, send);
  }, [project, task, sig]);
  useEffect(() => () => repoCloseDetail(project, task), [project, task]);
  const detail = details[detailKey(project, task)];
  const files = (detail?.files ?? []).map((f) => f.path);
  const shown = files.slice(0, DEVISSUE_FILES_MAX);
  const key = shown.join('\0');
  useEffect(() => {
    const list = key ? key.split('\0') : [];
    for (const path of list) repoRequestDiff(project, path, false, send, false, task);
    return () => list.forEach((path) => repoCloseDiff(project, path, false, task));
  }, [project, task, key, detail?.stamp]);
  const counts = shown.map((path) => {
    const view = diffs[diffKey(project, path, false, task)];
    return { path, ...(view?.text ? diffCounts(view.text) : { add: null, del: null }) };
  });
  return { loaded: detail !== undefined && !detail.loading, files, counts, more: files.length - shown.length };
}

interface CardParts {
  /** The chip beside the name (a time, a state). */
  chip?: ReactNode;
  /** Beside the chip, quieter (the files' count). */
  title?: ReactNode;
  /** The right side, before the buttons. */
  meta?: ReactNode;
  actions?: ReactNode;
  body?: ReactNode;
}

function StepCard({ id, look, open, phone, onToggle, parts }: { id: StepId; look: 'big' | 'back' | 'plain' | 'dim'; open: boolean; phone: boolean; onToggle?: () => void; parts: CardParts }) {
  const frame = {
    big: 'border-devroom-blue bg-devroom-pick',
    back: 'border-devroom-bad bg-devroom-card',
    plain: 'border-border bg-devroom-card',
    dim: 'border-dashed border-border opacity-70',
  }[look];
  const tile = look === 'back' ? 'border-devroom-bad text-devroom-bad' : 'border-border text-text-muted';
  const head = (
    <>
      <span className={`shrink-0 grid place-items-center size-34 border-ui rounded-ui-card bg-bg-dark ${tile}`}>
        <Icon name={ICON[id]} size={18} pixel={null} />
      </span>
      <b className={`shrink-0 font-(--ui-weight-strong) text-sm ${look === 'dim' ? 'text-text-muted' : 'text-devroom-title'}`}>{t(`devIssue.step.${id}`)}</b>
      {parts.chip}
      {parts.title && <span className={`min-w-0 text-text ${BODY}`}>{parts.title}</span>}
      <span className="flex-1" />
      {parts.meta && <span className={`min-w-0 truncate text-text-muted ${SMALL}`}>{parts.meta}</span>}
    </>
  );
  return (
    <div className={`flex flex-col gap-8 p-12 border-ui rounded-ui-card ${frame}`} data-testid="issue-step" data-step={id} data-look={look} data-open={open || undefined}>
      {phone && onToggle && !open ? (
        <button type="button" className="flex items-center gap-10 min-w-0 text-left" onClick={onToggle} data-testid="issue-step-toggle">
          {head}
          <Icon name="chevron-right" size={16} pixel="›" />
        </button>
      ) : (
        <div className={`flex items-center gap-10 min-w-0 ${phone ? 'flex-wrap' : ''}`}>
          {head}
          {!phone && parts.actions && <span className="shrink-0 flex gap-6">{parts.actions}</span>}
        </div>
      )}
      {open && parts.body && <div className={phone ? '' : 'pl-44'}>{parts.body}</div>}
      {open && phone && parts.actions && <div className="flex flex-wrap gap-6">{parts.actions}</div>}
    </div>
  );
}

function Story({ group, row, phone }: { group: Group; row: Row; phone: boolean }) {
  const project = group.project;
  const wt = row.wt;
  const task = row.task!;
  const now = useNow();
  const canAct = useCanAct();
  const { contacts } = useMessenger();
  const { officeJobs } = useAgtyStore();
  const { notes: allNotes } = useReviewStore();
  const { checks } = useMergeStore();
  const [unfolded, setUnfolded] = useState<ReadonlySet<StepId>>(new Set());
  const sig = [wt.ahead, wt.behind, wt.dirty, wt.merged, wt.merge?.at, wt.lastChange, wt.conflicts?.length].join();
  const changes = useChanges(project, wt.task, sig);
  useReviewNotes(project, wt.task, canAct, sig);
  useEffect(() => requestCheck(project, wt.task), [project, wt.task, sig]);
  const notes = allNotes[reviewKey(project, wt.task)]?.notes ?? [];
  const check = checks[taskKey(project, wt.task)];
  const merged = isMerged(wt, task);
  const agent = wt.assignee ?? null;
  const who = whoName(wt) ?? t('devroom.nobody');
  const model = useModelOf(agent);
  const s = story({ task, wt, merged, agent, files: changes.loaded ? changes.files.length : null, notes: notes.length, checked: check !== undefined });
  const base = check?.target ?? group.repo?.branch ?? wt.base;
  const go = (tab: DevroomTab, view?: 'chat' | 'terminal') => openFromStory(project, wt.task, tab, phone, view && agent ? { name: agent, view } : undefined);
  const btn = (label: string, testId: string, icon: LucideName, onClick: () => void, disabled = false, title?: string) => (
    <Button size="sm" data-testid={testId} disabled={disabled} title={title} onClick={onClick}>
      <Icon name={icon} size={14} pixel={null} />
      {label}
    </Button>
  );

  // 맡김: who wrote the issue (its first history line, while the history still holds it) and when.
  const first = task.history[0];
  const by = first && (first.change === 'add' || first.change === 'import') ? byName(first.by, project) : task.createdBy === 'user' ? t('review.owner') : (task.createdBy ?? t('tasks.source.unknown'));
  // 고치는 중: the agent's last line, only when it is the agent's own words (the messenger's contact preview).
  const contact = agent ? contacts.find((c) => c.name === agent) : undefined;
  const said = contact?.lastKind === 'assistant' && contact.preview ? { text: contact.preview, at: contact.lastAt } : null;
  const round = s.rounds.at(-1);
  const roundLive = round && !round.end && s.current === 'work';
  // 검사: the facts as stored, a reported one labelled as reported.
  const fact = task.testsPassed ?? task.testsRan;
  const testsOk = task.testsPassed ? task.testsPassed.value : null;
  const tests = fact && `${t(task.testsPassed ? (task.testsPassed.value ? 'devIssue.testsPassed' : 'devIssue.testsFailed') : 'devIssue.testsRan')} · ${t(`tasks.source.${fact.source}`)}`;
  const lastReview = s.reviewMoves.filter((m) => m.to === 'review').at(-1);
  // 머지: the pre-check's own words; the button is open only when the pre-check lets it be.
  const conflicting = check?.ok === true && check.clean === false;
  const list = check?.ok && !conflicting && check.kind !== 'already' ? preChecks(check, testsLine(task.testsPassed, latestTest(officeJobs?.jobs ?? [], project, wt.task))) : [];
  const locked = check?.ok === true && fixingLock(check, task.status);
  const failing = list.filter((c) => !c.ok);
  const reason = !check
    ? t('merge.loading')
    : !check.ok
      ? serverText(check, t('merge.checkFailed'))
      : check.kind === 'already'
        ? t('merge.already', { base })
        : conflicting
          ? t('merge.conflict.title', { base })
          : locked
            ? t('merge.locked')
            : failing.map((c) => c.text).join(' · ');
  const canMerge = !merged && check?.ok === true && !conflicting && check.kind !== 'already' && !locked && failing.length === 0;
  const totals = changes.counts.reduce((a, c) => ({ add: a.add + (c.add ?? 0), del: a.del + (c.del ?? 0) }), { add: 0, del: 0 });
  const plusMinus = (add: number, del: number) => (
    <span className="whitespace-nowrap">
      <span className="text-devroom-ok">+{add}</span> <span className="text-devroom-bad">-{del}</span>
    </span>
  );
  const not = <Chip tone="not">{t('devIssue.notYet')}</Chip>;
  const okAt = (iso: string | undefined) => (
    <Chip tone="ok">
      <Icon name="check" size={12} pixel="✓" />
      {when(iso)}
    </Chip>
  );

  const parts: Record<StepId, CardParts> = {
    assign: {
      chip: s.current === 'assign' ? <Chip tone="now">{t('devIssue.now')}</Chip> : okAt(task.createdAt),
      meta: t('devIssue.created', { who: by }),
      actions: btn(t('devIssue.openIssue'), 'issue-open-issue', 'file-text', () => openIssue(project, task.id)),
      body: (
        <p className={`line-clamp-3 whitespace-pre-line break-words ${task.detail ? 'text-text' : 'text-text-muted'} ${BODY}`} data-testid="issue-detail">
          {task.detail ?? t('devIssue.noDetail')}
        </p>
      ),
    },
    work: {
      chip: roundLive ? (
        <Chip tone="now">
          <Dot />
          {[s.round > 1 && t('devIssue.round', { n: s.round }), elapsedText(now - Date.parse(round.start))].filter(Boolean).join(' · ')}
        </Chip>
      ) : s.reached.work && round?.end ? okAt(round.end) : s.current === 'work' ? <Chip tone="now">{t('devIssue.now')}</Chip> : undefined,
      meta: [s.round > 1 && s.rounds[0]?.end && t('devIssue.firstRound', { time: elapsedDuration(Date.parse(s.rounds[0].end) - Date.parse(s.rounds[0].start)) }), phone && who].filter(Boolean).join(' · '),
      actions: agent && (
        <>
          {btn(t('devIssue.chat'), 'issue-open-chat', 'message-square-text', () => go('terminal', 'chat'))}
          {btn(t('devIssue.terminal'), 'issue-open-terminal', 'square-terminal', () => go('terminal', 'terminal'))}
        </>
      ),
      body: (
        <blockquote className={`px-12 py-8 border-l-ui border-devroom-blue rounded-ui-chip bg-bg-dark ${BODY}`} data-testid="issue-last-said">
          <p className={`break-words ${said ? '' : 'text-text-muted'}`}>{said ? `"${said.text}"` : t('devIssue.noLastSaid')}</p>
          <footer className={`mt-4 text-text-muted ${SMALL}`}>
            {[who, model].filter(Boolean).join(' · ')}
            {said?.at ? ` · ${t('devIssue.lastSaid', { time: when(new Date(said.at).toISOString()) })}` : ''}
          </footer>
        </blockquote>
      ),
    },
    changes: {
      title: (
        <>
          {changes.loaded ? t('devIssue.files', { count: changes.files.length }) : t('merge.loading')}
          {totals.add + totals.del > 0 && <> · {plusMinus(totals.add, totals.del)}</>}
          <span className={`text-text-muted ${SMALL}`}> · {t('devIssue.sofar')}</span>
        </>
      ),
      meta: !phone && (
        <span className="inline-flex items-center gap-4">
          <Icon name="git-branch" size={14} pixel="⎇" />
          {wt.branch}
        </span>
      ),
      actions: btn(t('devIssue.openChanges'), 'issue-open-changes', 'file-text', () => go('changes')),
      body: (
        <ul className={`flex flex-col gap-4 font-mono ${BODY}`} data-testid="issue-files">
          {changes.counts.map((c) => (
            <li key={c.path} className="flex gap-12 min-w-0" title={c.path}>
              <span className="flex-1 min-w-0 truncate">{shortPath(c.path)}</span>
              {c.add !== null && <span className="shrink-0">{plusMinus(c.add, c.del ?? 0)}</span>}
            </li>
          ))}
          {changes.more > 0 && <li className="text-text-muted">{t('devIssue.moreFiles', { count: changes.more })}</li>}
          {wt.dirty > 0 && <li className="text-text-muted">{t('devIssue.uncommitted', { count: wt.dirty })}</li>}
        </ul>
      ),
    },
    check: {
      chip: s.returned ? (
        <Chip tone="back">
          <Icon name="rotate-ccw" size={12} pixel="↺" />
          {t('devIssue.sentBack')}
        </Chip>
      ) : s.current === 'check' ? <Chip tone="now">{t('devIssue.now')}</Chip> : undefined,
      meta: lastReview && t('devIssue.reviewAt', { n: s.reviewMoves.filter((m) => m.to === 'review').length, time: when(s.returned?.at ?? lastReview.at) }),
      actions: (
        <>
          {btn(t('devIssue.reviewFull'), 'issue-open-review', 'file-text', () => go('changes'))}
          {btn(t('devIssue.testLog'), 'issue-open-runs', 'scroll-text', () => {
            openJobs();
            setRunsProject(project);
          })}
        </>
      ),
      body: (
        <div className={`flex flex-col gap-8 ${BODY}`}>
          {tests && (
            <p className="flex items-center gap-8" data-testid="issue-tests">
              <span className={testsOk === false ? 'text-devroom-bad' : 'text-devroom-ok'}>
                <Icon name={testsOk === false ? 'circle-alert' : 'check'} size={16} pixel={testsOk === false ? '!' : '✓'} />
              </span>
              {tests}
            </p>
          )}
          {notes.map((n) => (
            <p key={n.id} className="flex gap-8 break-words" data-testid="issue-note">
              <span className="shrink-0 text-accent-text">{authorOf(n.by) ?? t('review.owner')}</span>
              <span className="min-w-0">{n.body}</span>
            </p>
          ))}
          {!tests && notes.length === 0 && !s.returned && <p className="text-text-muted">{t('devIssue.nothing')}</p>}
          {s.returned && (
            <div className="flex flex-wrap items-center gap-10 px-12 py-8 border-ui rounded-ui-card border-border bg-bg-dark" data-testid="issue-move" data-return="true">
              <span className="text-devroom-bad">
                <Icon name="rotate-ccw" size={16} pixel="↺" />
              </span>
              <b className="font-(--ui-weight-strong)">{t('devIssue.returned', { to: t(`tasks.status.${s.returned.to as BoardTask['status']}`), n: s.round, time: when(s.returned.at) })}</b>
              {s.current === 'work' && (
                <>
                  <span className="devissue-stripe w-120 h-8 rounded-ui-pill" aria-hidden="true" />
                  <span className="text-text-muted">{elapsedText(now - Date.parse(s.returned.at))}</span>
                </>
              )}
              <span className={`ml-auto text-text-muted ${SMALL}`}>{t('devIssue.thenReview')}</span>
            </div>
          )}
        </div>
      ),
    },
    merge: {
      chip: merged ? okAt(wt.merge?.at) : s.current === 'merge' ? <Chip tone="now">{t('devIssue.now')}</Chip> : not,
      meta: merged ? t('devIssue.merged', { base }) : (
        <span className="inline-flex items-center gap-4" data-testid="issue-merge-reason">
          {!canMerge && <Icon name="lock" size={14} pixel={null} />}
          {reason || t('merge.confirm.title', { base })}
        </span>
      ),
      actions: !merged && btn(t('devIssue.mergeTo', { base }), 'issue-open-merge', 'git-branch', () => go('merge'), !canMerge, reason || undefined),
      body: s.current === 'merge' && list.length > 0 && (
        <ul className={`flex flex-col gap-2 ${SMALL}`}>
          {list.map((c) => (
            <li key={c.id} className={c.ok ? 'text-text-muted' : 'text-devroom-conf-text'} data-testid="issue-merge-check" data-ok={c.ok}>
              {c.ok ? '✔' : '!'} {c.text}
            </li>
          ))}
        </ul>
      ),
    },
    deploy: { chip: not, meta: t('devIssue.deployUntracked') },
  };

  // The larger card: the current step, or 검사 while the issue is back from it (the return is told there).
  const big: StepId = s.returned ? 'check' : s.current;
  const card = (id: StepId) => {
    const shown = s.reached[id] || s.has[id];
    const look = id === big ? (s.returned ? 'back' : 'big') : shown && id !== 'deploy' ? 'plain' : 'dim';
    // The phone folds what is not the larger card into one row (a tap opens it); the PC opens every card with data.
    const open = look !== 'dim' && (!phone || id === big || unfolded.has(id));
    return (
      <StepCard
        key={id}
        id={id}
        look={look}
        open={open}
        phone={phone}
        onToggle={() => setUnfolded((cur) => new Set(cur).add(id))}
        parts={id === 'changes' && !s.has.changes ? { ...parts.changes, body: undefined } : parts[id]}
      />
    );
  };
  // The dashed return connector: a recorded move out of 검사 back to work, drawn from 검사 up to 고치는 중.
  const middle = (
    <div className="relative flex flex-col gap-8">
      {s.returned && <span className="devissue-return top-24 bottom-28" data-testid="issue-return-line" aria-hidden="true" />}
      {(['work', 'changes', 'check'] as const).map(card)}
    </div>
  );
  const sayKey = s.state === 'assign' && !agent ? 'assignNobody' : s.state === 'workAgain' && notes.length > 0 ? 'workAgainNotes' : s.state;
  const goal = task.goal ? ` · ${t('devIssue.goal', { goal: task.goal })}` : '';

  return (
    <article className="flex flex-col gap-12 min-w-0" data-testid="issue-story" data-task-id={task.id} data-current={s.current}>
      <header className={phone ? '' : 'pl-20'}>
        <p className={`text-text-muted ${SMALL}`} data-testid="issue-head">
          {t('devIssue.head', { id: task.id, who: by })}
          {goal}
        </p>
        <h2 className="mt-4 font-(--ui-weight-strong) text-devroom-title text-xl break-words" data-testid="issue-title">
          {task.title}
        </h2>
        <p className={`mt-6 flex items-start gap-8 ${BODY}`} data-testid="issue-say">
          <span className="mt-6">
            <Dot />
          </span>
          {t(`devIssue.say.${sayKey}`, { who, n: s.round, notes: notes.length, base })}
        </p>
        {phone && (
          <div className="mt-10 flex flex-wrap gap-6">
            {agent && btn(t('devIssue.chat'), 'issue-phone-chat', 'message-square-text', () => go('terminal', 'chat'))}
            {agent && btn(t('devIssue.terminal'), 'issue-phone-terminal', 'square-terminal', () => go('terminal', 'terminal'))}
            {btn(t('devIssue.openChanges'), 'issue-phone-changes', 'file-text', () => go('changes'))}
          </div>
        )}
      </header>
      <div className="flex flex-col gap-8 pl-20" aria-label={t('devIssue.steps', { title: task.title })}>
        {card('assign')}
        {middle}
        {card('merge')}
        {card('deploy')}
      </div>
    </article>
  );
}

/** The PC's 이슈 view: the list left, the picked issue's story right. */
export function IssueView({ groups, pick }: { groups: readonly Group[]; pick: Picked | null }) {
  const rows = issueRows(groups);
  const picked = pickedRow(rows, pick);
  return (
    <div className="flex flex-1 min-h-0 gap-16 p-16 bg-bg" data-testid="issue-view">
      <aside className="w-380 shrink-0 min-h-0 flex flex-col">
        <IssueList groups={groups} rows={rows} picked={picked} phone={false} />
      </aside>
      <section className="flex-1 min-w-0 overflow-y-auto px-24 py-20 border-ui rounded-ui-card border-border bg-devroom-panel">
        {picked ? <Story key={`${picked.group.project}\0${picked.row.wt.task}`} group={picked.group} row={picked.row} phone={false} /> : <p className={`m-auto text-text-muted ${BODY}`}>{t('devIssue.pickHint')}</p>}
      </section>
    </div>
  );
}

/** The phone: the list is the first screen. */
export function PhoneIssueList({ groups }: { groups: readonly Group[] }) {
  const rows = issueRows(groups);
  return (
    <div className="flex flex-col px-12 pt-8 min-h-[60vh]">
      <IssueList groups={groups} rows={rows} picked={undefined} phone />
    </div>
  );
}

/** The phone's story page (devroomStore `page: 'story'`): its own head, ‹ 하고 있는 일 back to the list. */
export function PhoneStory({ groups, pick }: { groups: readonly Group[]; pick: Picked }) {
  const row = issueRows(groups).find((r) => r.group.project === pick.project && r.row.wt.task === pick.task);
  return (
    <>
      <div className="shrink-0 h-46 flex items-center gap-8 px-12 bg-bg-dark border-b-ui border-border">
        <button type="button" className={`flex items-center gap-4 text-accent-text ${BIG}`} data-testid="devroom-back" onClick={closeDevroomPage}>
          <Icon name="chevron-left" size={18} pixel="‹" />
          {t('devIssue.listTitle')}
        </button>
        <span className={`ml-auto text-text-muted ${SMALL}`}>{row?.row.task?.id}</span>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto p-12">
        {row ? <Story group={row.group} row={row.row} phone /> : <p className={`p-16 text-text-muted ${BODY}`}>{t('devIssue.empty')}</p>}
      </div>
    </>
  );
}
