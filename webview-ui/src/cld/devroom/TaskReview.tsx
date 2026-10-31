/**
 * P4 검토 (mockups-1101/review-loop-R1..R4): one task worktree's review, for the dev room's 변경 tab
 * and the 작업실's 검토 page. The header (who made it, the chip, 의견 N개 보내기, 병합), then either
 * the whole diff with the notes on it (R1; R2 once sent, with the Lead's room beside it) or, on
 * 다시 보기, the six-step strip, the sent notes and only what changed since the send (R4). The
 * notes themselves are repo/ReviewNotes.tsx's. A task with notes merges only by the owner's 병합:
 * the button is locked while its Worker fixes, and the footer says why.
 */
import { type ReactNode, useEffect, useRef, useState } from 'react';

import type { BoardTask, RepoWorktree, ReviewNote } from '../../../../core/src/messages.js';
import { Button } from '../../components/ui/Button.js';
import { REVIEW_REFRESH_MS } from '../../constants.js';
import { useIsMobile } from '../../hooks/useIsMobile.js';
import { t } from '../../i18n/index.js';
import { transport } from '../../transport/index.js';
import { useEngineStore } from '../engineStore.js';
import { timeAgo } from '../format.js';
import { messengerSend, useMessenger } from '../messenger/messengerStore.js';
import { useCldStore } from '../officeStore.js';
import {
  detailKey,
  diffKey,
  repoCloseDetail,
  repoCloseDiff,
  repoRequestDetail,
  repoRequestDiff,
  useRepoStore,
} from '../repo/repoStore.js';
import { diffCounts } from '../repo/repoText.js';
import { ReviewDiff } from '../repo/ReviewNotes.js';
import { reviewKey, reviewSendNotes, unsentNotes, useReviewStore } from '../repo/reviewStore.js';
import { useReviewNotes } from '../repo/useRepoView.js';
import { teamOf } from '../workbench/workbenchState.js';
import { BODY, SMALL } from './devroomData.js';
import { REVIEW_STEPS, reviewStep } from './reviewSteps.js';
import { Face } from './WorktreeRail.js';

const send = (msg: Parameters<typeof transport.send>[0]) => transport.send(msg);
const clock = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const FACE_PX = 44;
const SMALL_FACE_PX = 22;

/** The worktree under review and everything the header and footer say about it. */
function useReviewTarget(project: string, task: string) {
  const { states } = useRepoStore();
  const { officeSnapshot, officeReadOnly, taskBoard } = useCldStore();
  const engine = useEngineStore().state?.projects;
  const repo = states[project];
  const wt = repo?.ok ? repo.worktrees?.find((w) => w.task === task) : undefined;
  const board: BoardTask | undefined = wt?.taskId ? taskBoard?.tasks.find((x) => x.id === wt.taskId) : undefined;
  const orchs = officeSnapshot?.orchestrators ?? [];
  const assignee = wt?.assignee ? orchs.find((o) => o.name === wt.assignee) : undefined;
  const lead = teamOf(project, officeSnapshot, engine).find((m) => m.role === 'lead');
  return {
    wt,
    board,
    assignee,
    lead,
    canWrite: !!officeSnapshot && !officeSnapshot.readOnly && !officeReadOnly,
  };
}

function Chip({ kind, children }: { kind: 'review' | 'fixing' | 'merged'; children: ReactNode }) {
  const look = {
    review: 'text-devroom-review border-devroom-review-line bg-devroom-review-bg',
    fixing: 'text-devroom-blue border-devroom-work-line bg-devroom-work-bg',
    merged: 'text-text-muted border-border bg-devroom-done-bg',
  }[kind];
  return (
    <span className={`inline-flex items-center whitespace-nowrap border-2 px-6 py-1 leading-[1.2] ${SMALL} ${look}`} data-testid="review-chip" data-kind={kind}>
      {children}
    </span>
  );
}

/** R4: the six steps, "지금 여기" on the current one, and the ↺ bracket from 2 to 5. */
function StepStrip({ current, base }: { current: number; base: string }) {
  return (
    <div className="shrink-0 px-14 pt-16 pb-10 bg-bg-dark border-b-2 border-border" data-testid="review-steps" data-step={current}>
      <ol className="grid grid-cols-6 gap-x-20 gap-y-8">
        {REVIEW_STEPS.map((id, i) => {
          const no = i + 1;
          const state = no < current ? 'done' : no === current ? 'cur' : 'next';
          return (
            <li
              key={id}
              data-state={state}
              className={`relative min-w-0 border-2 p-8 ${state === 'cur' ? 'border-devroom-main-line bg-devroom-main shadow-pixel' : 'border-border bg-devroom-card'} ${state === 'done' ? 'opacity-70' : state === 'next' ? 'opacity-60' : ''}`}
            >
              {state === 'cur' && (
                <span className={`absolute left-8 -top-12 border-2 border-devroom-main-line bg-accent px-5 leading-[1.3] text-white ${SMALL}`}>{t('review.stepNow')}</span>
              )}
              <b className={`flex items-center gap-6 font-normal ${BODY}`}>
                <span
                  className={`shrink-0 inline-flex items-center justify-center size-22 border-2 ${SMALL} ${state === 'done' ? 'bg-review-go border-review-go-line text-devroom-ok' : state === 'cur' ? 'bg-accent border-devroom-main-line text-white' : 'bg-bg-dark border-border'}`}
                >
                  {state === 'done' ? '✔' : no}
                </span>
                <span className="min-w-0">{t(`review.step.${id}`)}</span>
              </b>
              <small className={`block mt-4 ${SMALL} ${state === 'cur' ? 'text-devroom-tab-on' : 'text-text-muted'}`}>{t(`review.step.${id}.hint`, { base })}</small>
              {no < REVIEW_STEPS.length && <span className="absolute -right-14 top-1/2 -translate-y-1/2 text-devroom-trunk" aria-hidden="true">▸</span>}
            </li>
          );
        })}
        <li className={`col-start-2 col-span-4 flex items-center justify-center h-26 border-2 border-t-0 border-devroom-trunk text-devroom-review ${SMALL}`}>
          {t('review.loop')}
        </li>
      </ol>
    </div>
  );
}

/** R1/R3: the changed files with their +a −d and the notes waiting on each. */
function FileList({ project, wt, files, picked, onPick, testsOk }: { project: string; wt: RepoWorktree; files: string[]; picked: string | undefined; onPick: (path: string) => void; testsOk: boolean }) {
  const { diffs } = useRepoStore();
  const { notes } = useReviewStore();
  const mine = notes[reviewKey(project, wt.task)]?.notes ?? [];
  return (
    <aside className="w-220 shrink-0 overflow-auto p-10 bg-devroom-rail border-r-2 border-border" data-testid="review-files">
      <h3 className={`mb-8 font-normal ${BODY}`}>{t('review.files', { count: files.length })}</h3>
      {files.map((path) => {
        const view = diffs[diffKey(project, path, false, wt.task)];
        const counts = view?.text ? diffCounts(view.text) : null;
        const waiting = unsentNotes(mine.filter((n) => n.file === path)).length;
        const sent = mine.filter((n) => n.file === path && n.sentAt).length;
        const on = path === picked;
        return (
          <button
            key={path}
            type="button"
            data-testid="review-file-item"
            className={`block w-full text-left px-6 py-7 border-b-2 border-devroom-card-line ${SMALL} ${on ? 'bg-active-bg outline-2 outline-devroom-tab-line' : ''}`}
            onClick={() => onPick(path)}
          >
            <span className="break-all">{path}</span>
            {(waiting > 0 || sent > 0) && (
              <span
                className={`float-right ml-4 inline-flex items-center justify-center min-w-18 h-18 px-4 border-2 text-white ${waiting > 0 ? 'bg-accent border-devroom-main-line' : 'bg-review-go border-review-go-line'}`}
                data-testid="review-file-count"
              >
                {waiting || sent}
              </span>
            )}
            {counts && (
              <small className="block mt-2">
                <span className="text-devroom-ok">+{counts.add}</span> <span className="text-devroom-bad">-{counts.del}</span>
              </small>
            )}
          </button>
        );
      })}
      <p className={`mt-14 text-text-muted ${SMALL}`}>{t('review.folder')}</p>
      <p className={`text-accent-text break-all ${BODY}`}>{wt.task}</p>
      <p className={`mt-10 text-text-muted ${SMALL}`}>{t('review.base')}</p>
      <p className={BODY}>{wt.base}</p>
      {testsOk && <p className={`mt-12 text-devroom-ok ${SMALL}`}>{t('devroom.tests')}</p>}
    </aside>
  );
}

/** One file's diff (the whole of it, or only what changed since `since`), fetched while mounted. */
function FileDiff({ project, wt, file, since, tick, canWrite, face, onCompose }: { project: string; wt: RepoWorktree; file: string; since?: string; tick: number; canWrite: boolean; face: (a: string | null) => ReactNode; onCompose: (file: string, open: boolean) => void }) {
  const { diffs } = useRepoStore();
  const key = diffKey(project, file, false, wt.task, since);
  // ponytail: refreshed when the counts move (every 10 s poll); an edit that keeps them equal waits for the next move.
  useEffect(() => {
    repoRequestDiff(project, file, false, send, false, wt.task, since);
  }, [project, wt.task, file, since, wt.ahead, wt.behind, wt.dirty, tick]);
  useEffect(() => () => repoCloseDiff(project, file, false, wt.task, since), [project, wt.task, file, since]);
  const view = diffs[key];
  if (!view) return null;
  // 다시 보기 lists only the files that changed since the send.
  if (since && !view.loading && !view.error && view.text === '') return null;
  return (
    <ReviewDiff
      project={project}
      task={wt.task}
      file={file}
      view={view}
      canWrite={canWrite}
      face={face}
      onCompose={(open) => onCompose(file, open)}
      onMore={() => repoRequestDiff(project, file, false, send, true, wt.task, since)}
      {...(since && { caption: t('review.sinceTitle'), hideSent: true })}
    />
  );
}

/** R4 left: the notes that were sent, each saying 고침 / 고치는 중… / 그대로예요. */
function SentList({ sent, fixing }: { sent: ReviewNote[]; fixing: boolean }) {
  const at = sent.map((n) => n.sentAt!).sort().at(-1);
  return (
    <aside className="w-380 shrink-0 overflow-auto p-14 flex flex-col gap-10 bg-devroom-rail border-r-2 border-border" data-testid="review-sent-list">
      <h3 className={`font-normal text-accent-text ${BODY}`}>
        {t('review.sentList', { count: sent.length, time: at ? clock(at) : '' })}
      </h3>
      {sent.map((n) => (
        <div key={n.id} className={`border-2 border-border bg-devroom-card p-8 shadow-pixel ${BODY}`} data-testid="review-sent-item" data-fixed={n.fixed ? 'yes' : 'no'}>
          <div className={`flex justify-between gap-8 mb-2 text-text-muted ${SMALL}`}>
            <span className="min-w-0 break-all">
              {n.file.split('/').pop()} · {n.line > 0 ? t('review.line', { line: n.line }) : t('review.wholeFile')}
            </span>
            <span className={`shrink-0 ${n.fixed ? 'text-devroom-ok' : fixing ? 'text-devroom-blue' : ''}`}>
              {n.fixed ? t('review.fixedTag') : fixing ? t('review.fixingTag') : t('review.sameTag')}
            </span>
          </div>
          <span className="break-words whitespace-pre-wrap">{n.body}</span>
        </div>
      ))}
      {fixing && <p className={`border-2 border-devroom-conf-line bg-devroom-conf-bg p-8 text-devroom-conf ${BODY}`}>{t('review.fixNote')}</p>}
    </aside>
  );
}

/** R2: the Lead's room beside the diff: the line the send left there, and one line to say more. */
function LeadRoom({ lead, worker, sent }: { lead: { name: string; agentId: number | null }; worker: string; sent: ReviewNote[] }) {
  const { pending } = useMessenger();
  const [text, setText] = useState('');
  const at = sent.map((n) => n.sentAt!).sort().at(-1);
  const count = sent.filter((n) => n.sentAt === at).length;
  const say = () => {
    if (!text.trim() || lead.agentId === null) return;
    messengerSend(send, transport.state === 'connected', lead.agentId, lead.name, text.trim());
    setText('');
  };
  const mine = lead.agentId === null ? [] : (pending[lead.agentId] ?? []);
  return (
    <aside className="w-300 shrink-0 flex flex-col border-l-2 border-border bg-devroom-rail" data-testid="review-lead-room">
      <div className={`flex items-center gap-8 px-10 py-8 bg-devroom-foot border-b-2 border-border ${BODY}`}>
        <Face agentId={lead.agentId} name={lead.name} size={SMALL_FACE_PX} />
        <span className="min-w-0 truncate">{t('review.leadRoom', { lead: lead.name })}</span>
      </div>
      <div className="flex-1 min-h-0 overflow-auto flex flex-col justify-end gap-8 p-10">
        {at && (
          <div className={`border-2 border-devroom-review-line bg-devroom-main p-8 shadow-pixel ${BODY}`} data-testid="review-lead-line">
            {t('review.leadLine', { worker, count })}
            <small className={`block mt-2 text-text-muted ${SMALL}`}>{clock(at)}</small>
          </div>
        )}
        {mine.map((m) => (
          <div key={m.requestId} className={`self-end max-w-full border-2 border-border bg-bg-dark p-8 break-words ${BODY}`}>
            {m.text}
          </div>
        ))}
      </div>
      <input
        className={`m-10 border-2 border-border bg-bg-dark px-8 py-6 ${BODY}`}
        placeholder={t('review.leadPlaceholder')}
        aria-label={t('review.leadPlaceholder')}
        data-testid="review-lead-input"
        value={text}
        disabled={lead.agentId === null}
        maxLength={4000}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            say();
          }
        }}
      />
    </aside>
  );
}

export function TaskReview({
  project,
  task,
  onMerge,
  onBack,
}: {
  project: string;
  task: string;
  /** 병합: the dev room opens its 병합 tab, the 작업실 asks the usual confirmation. */
  onMerge: (wt: RepoWorktree) => void;
  onBack?: () => void;
}) {
  const phone = useIsMobile();
  const { wt, board, assignee, lead, canWrite } = useReviewTarget(project, task);
  const { details } = useRepoStore();
  const { notes: allNotes, sending } = useReviewStore();
  const [again, setAgain] = useState(false);
  const [picked, setPicked] = useState<string>();
  const [composing, setComposing] = useState<ReadonlySet<string>>(new Set());
  const [tick, setTick] = useState(0);
  const mainRef = useRef<HTMLDivElement>(null);
  useReviewNotes(project, task, canWrite, tick);
  // The file list: what the worktree changed against its base (refreshed as the poll moves the counts).
  const sentHead = allNotes[reviewKey(project, task)]?.sentHead;
  const sinceHead = again ? sentHead : undefined;
  useEffect(() => {
    if (wt) repoRequestDetail(project, task, send, sinceHead);
  }, [project, task, sinceHead, tick, wt?.ahead, wt?.behind, wt?.dirty]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => repoCloseDetail(project, task, sinceHead), [project, task, sinceHead]);
  const fixingNow = (allNotes[reviewKey(project, task)]?.notes ?? []).some((n) => n.sentAt && !n.fixed);
  // ponytail: while sent notes are not yet fixed, ask again every few seconds; no push for a worktree's edits.
  useEffect(() => {
    if (!fixingNow) return;
    const id = setInterval(() => setTick((n) => n + 1), REVIEW_REFRESH_MS);
    return () => clearInterval(id);
  }, [fixingNow]);
  const onCompose = (file: string, open: boolean) =>
    setComposing((cur) => {
      if (cur.has(file) === open) return cur;
      const next = new Set(cur);
      if (open) next.add(file);
      else next.delete(file);
      return next;
    });

  if (!wt) return <p className={`m-auto text-text-muted ${BODY}`}>{t('review.noWorktree')}</p>;
  const view = allNotes[reviewKey(project, task)];
  const notes = view?.notes ?? [];
  const sent = notes.filter((n) => n.sentAt);
  const waiting = unsentNotes(notes).length;
  const busy = sending[reviewKey(project, task)] !== undefined;
  const merged = wt.merged && (wt.merge?.ok === true || board?.status === 'done');
  // Its Worker is on the notes: the Task went back to doing at the send (no Task: the Worker's turn runs).
  const fixing = sent.length > 0 && !merged && (board ? board.status === 'doing' : assignee?.busy === true);
  const step = reviewStep({ notes, sending: busy, fixing, merged });
  const rereview = again && !!sentHead;
  const worker = wt.assignee;
  const title = board?.title ?? wt.task;
  const detail = details[detailKey(project, task, sinceHead)];
  const files = (detail?.files ?? []).map((f) => f.path);
  const file = files.includes(picked ?? '') ? picked : files[0];
  // A Lead's note shows its face; the owner's note keeps ReviewNotes' own mark.
  const face = (author: string | null) =>
    author ? <Face agentId={lead?.name === author ? lead.agentId : null} name={author} size={SMALL_FACE_PX} /> : undefined;
  const lockWhy = fixing ? t('review.mergeLocked', { name: worker ?? '' }) : undefined;
  const canMerge = canWrite && !merged && wt.ahead > 0 && !fixing;
  const done = sent.filter((n) => n.fixed).length;
  const sendLabel = busy ? t('review.sending') : fixing && waiting === 0 ? t('review.sentDone') : t('review.send', { count: waiting });
  const buttons = (
    <>
      {canWrite && (
        <Button
          size="sm"
          variant="accent"
          className={`${phone ? 'flex-[1.6] h-40' : ''} shadow-pixel`}
          disabled={waiting === 0 || busy}
          data-testid="review-send"
          onClick={() => reviewSendNotes(project, task, send)}
        >
          {sendLabel}
        </Button>
      )}
      {canWrite && (
        <Button
          size="sm"
          className={`${phone ? 'flex-1 h-40' : ''} bg-review-go! border-review-go-line! text-devroom-ok shadow-pixel`}
          disabled={!canMerge}
          title={lockWhy}
          data-testid="review-merge"
          data-locked={fixing ? 'yes' : 'no'}
          onClick={() => onMerge(wt)}
        >
          {t('repo.merge')}
        </Button>
      )}
    </>
  );
  const agentFace = (
    <Face agentId={assignee?.agentId ?? null} name={worker ?? title} size={phone ? 30 : FACE_PX} />
  );
  const fileDiffs = (list: string[], since?: string) =>
    list.map((path) => (
      <FileDiff key={`${path}@${since ?? ''}`} project={project} wt={wt} file={path} {...(since && { since })} tick={tick} canWrite={canWrite} face={face} onCompose={onCompose} />
    ));
  const writing = rereview && fixing && (
    <p className={`px-12 py-6 text-text-muted ${BODY}`}>{t('review.writing', { name: worker ?? '' })}</p>
  );
  const sinceDiff = rereview && sentHead ? fileDiffs(files, sentHead) : null;

  const footLeft = fixing ? (
    <span className="text-devroom-blue">{rereview ? (t('review.footProgress', { name: worker ?? '', done, total: sent.length })) : t('review.footFixing', { name: worker ?? '' })}</span>
  ) : rereview ? (
    <span className="text-devroom-blue">{t('review.footProgressIdle', { done, total: sent.length })}</span>
  ) : (
    <>
      <span className="text-accent-text">{t('review.waiting', { count: waiting })}</span>
      {composing.size > 0 && <span className="text-text-muted">· {t('review.footComposing')}</span>}
    </>
  );
  const footRight = fixing
    ? t('review.footFixingRight')
    : notes.length > 0
      ? `${t('review.footMerge', { base: wt.base })} · ${t('review.footOwnerOnly')}`
      : t('review.footMerge', { base: wt.base });

  return (
    <div className="flex-1 min-h-0 min-w-0 flex flex-col bg-bg" data-testid="task-review" data-project={project} data-task={task} data-step={step} data-mode={rereview ? 'again' : 'full'}>
      {rereview && !phone && <StepStrip current={step} base={wt.base} />}
      <header className={`shrink-0 flex items-center gap-12 ${phone ? 'px-10 py-8' : 'px-14 py-8 min-h-72'} bg-devroom-box border-b-2 border-border`}>
        {onBack && (
          <Button size="sm" data-testid="review-back" onClick={onBack}>
            {t('review.back')}
          </Button>
        )}
        <span className="shrink-0 border-2 border-border bg-bg-dark p-2">{agentFace}</span>
        <div className="flex-1 min-w-0">
          <b className={`block font-normal truncate text-devroom-title ${phone ? BODY : 'text-sm'}`} data-testid="review-title">
            {title}
          </b>
          <span className={`block truncate text-text-muted ${SMALL}`}>
            {worker
              ? t('review.madeBy', { name: worker, folder: wt.task, ago: timeAgo(wt.lastChange ?? wt.created) })
              : t('review.madeByNobody', { folder: wt.task, ago: timeAgo(wt.lastChange ?? wt.created) })}
          </span>
        </div>
        {phone && step >= 4 && step <= 5 && (
          <span className={`shrink-0 text-devroom-blue ${SMALL}`} data-testid="review-step-line">
            {t('review.stepLine', { n: step, title: t(`review.step.${REVIEW_STEPS[step - 1]}`) })}
          </span>
        )}
        {merged ? <Chip kind="merged">{t('review.chip.merged')}</Chip> : fixing ? <Chip kind="fixing">{t('review.chip.fixing')}</Chip> : <Chip kind="review">{t('review.chip.reviewing')}</Chip>}
        {sentHead && !merged && (
          <Button size="sm" aria-pressed={rereview} data-testid="review-again" onClick={() => setAgain(!rereview)}>
            {rereview ? t('review.fullButton') : t('review.againButton')}
          </Button>
        )}
        {!phone && buttons}
      </header>
      {phone ? (
        <div className="flex-1 min-h-0 flex flex-col">
          <nav className="shrink-0 flex bg-devroom-foot border-b-2 border-border" aria-label={t('review.files', { count: files.length })}>
            {files.map((path) => {
              const count = unsentNotes(notes.filter((n) => n.file === path)).length;
              return (
                <button
                  key={path}
                  type="button"
                  data-testid="review-file-tab"
                  className={`flex-1 min-w-0 truncate px-4 py-8 border-r-2 border-border last:border-r-0 ${SMALL} ${path === file ? 'bg-active-bg text-devroom-tab-on' : 'text-text-muted'}`}
                  onClick={() => setPicked(path)}
                >
                  {path.split('/').pop()}
                  {count > 0 && <span className="ml-4 text-devroom-ok">({count})</span>}
                </button>
              );
            })}
          </nav>
          <div ref={mainRef} className="flex-1 min-h-0 overflow-auto bg-devroom-term">
            {files.length === 0 && <p className={`p-12 ${detail?.error ? 'text-devroom-bad' : 'text-text-muted'} ${BODY}`}>{detail?.error ?? (detail?.loading ? t('messenger.loading') : t('repo.noChangedFilesWt'))}</p>}
            {file && fileDiffs([file], rereview ? sentHead : undefined)}
            {writing}
          </div>
          <div className="shrink-0 flex items-center gap-8 p-10 bg-bg-dark border-t-2 border-border" data-testid="review-bar">{buttons}</div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 flex">
          {rereview ? (
            <SentList sent={sent} fixing={fixing} />
          ) : (
            <FileList
              project={project}
              wt={wt}
              files={files}
              picked={file}
              testsOk={board?.testsPassed?.value === true}
              onPick={(path) => {
                setPicked(path);
                mainRef.current?.querySelector(`[data-file="${CSS.escape(path)}"]`)?.scrollIntoView({ block: 'start' });
              }}
            />
          )}
          <div ref={mainRef} className="flex-1 min-w-0 overflow-auto bg-devroom-term" data-testid="review-main">
            {files.length === 0 && <p className={`p-12 ${detail?.error ? 'text-devroom-bad' : 'text-text-muted'} ${BODY}`}>{detail?.error ?? (detail?.loading ? t('messenger.loading') : t('repo.noChangedFilesWt'))}</p>}
            {rereview ? (
              <>
                {sinceDiff}
                {writing}
              </>
            ) : (
              fileDiffs(files)
            )}
          </div>
          {!rereview && sent.length > 0 && lead && <LeadRoom lead={lead} worker={worker ?? ''} sent={sent} />}
        </div>
      )}
      {!phone && (
        <footer className={`shrink-0 flex items-center gap-10 px-14 h-40 bg-devroom-foot border-t-2 border-border ${SMALL}`} data-testid="review-footer">
          {footLeft}
          <span className="flex-1" />
          <span className="text-text-muted">{footRight}</span>
        </footer>
      )}
    </div>
  );
}
