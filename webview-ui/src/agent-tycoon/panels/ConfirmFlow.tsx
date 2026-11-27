/**
 * T-182 차례대로 확인하기 (mock-up board4-confirm-*): the issues waiting in 검토 for the owner to try them, one
 * card at a time, each answered with one press. Nothing here is written at display time: the card shows the
 * Task as stored (title, 확인 방법 with what was wrong and what changed, its pictures, detail, note), each
 * with who wrote it from the Task's own history; the honesty line is a template over the facts the engine
 * holds, each with its source; a missing part shows its quiet fixed fallback in its own slot. Answers go
 * through the board's own `taskEdit`; 아직 이상해요 also tells the project's Lead through the messenger's send.
 */
import './confirm.css';

import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';

import type { BoardFactSource, BoardTask, RepoWorktree } from '../../../../core/src/messages.js';
import { Button } from '../../components/ui/Button.js';
import { CONFIRM_GROUP_ROWS, CONFIRM_ICON_PX, CONFIRM_LINE_MAX, CONFIRM_PRESS_GUARD_MS } from '../../constants.js';
import { t } from '../../i18n/index.js';
import { transport } from '../../transport/index.js';
import { rootFileTicket } from '../files/filesStore.js';
import { hostDateTime, timeAgo } from '../format.js';
import { type IconName, PixelIcon, SegBar } from '../game/parts.js';
import { Icon, type LucideName } from '../icons/Icon.js';
import { messengerSend } from '../messenger/messengerStore.js';
import { agtyToast, useAgtyStore } from '../officeStore.js';
import { useRepoStore } from '../repo/repoStore.js';
import { worktreeOfTask } from '../repo/repoText.js';
import { useRepoView } from '../repo/useRepoView.js';
import {
  answerEdit,
  authorOf,
  type ConfirmAnswer,
  confirmCount,
  confirmMerge,
  confirmPosition,
  confirmQueue,
  currentTask,
  type DeviceGroup,
  deviceGroups,
  deviceOf,
  groupRows,
  lastWriter,
  pressAllowed,
  reviewEntry,
} from './confirmModel.js';
import { Face } from './Dashboard.js';

/** One icon in both screen styles: the Lucide outline (모던), the pixel glyph (픽셀 감성). */
const I = ({ name, pixel, size = CONFIRM_ICON_PX }: { name: LucideName; pixel: IconName; size?: number }) => (
  <Icon name={name} size={size} pixel={<PixelIcon name={pixel} />} />
);

function DeviceIcon({ device }: { device: DeviceGroup }) {
  if (device === 'phone') return <I name="smartphone" pixel="device" />;
  if (device === 'pc') return <I name="monitor" pixel="term" />;
  if (device === 'both')
    return (
      <span className="cf-icons">
        <I name="smartphone" pixel="device" />
        <I name="monitor" pixel="term" />
      </span>
    );
  return <I name="file-text" pixel="scroll" />;
}

/** The time of a press (read in the handlers, never while drawing). */
const clock = () => Date.now();

/** `agty` run without an agent's token: the owner's own terminal (or a local process). */
const CLI_BY = 'cli';
/** A history `by` as a name a person reads: the owner, the project's Lead (named after it), or as written. */
const nameOf = (by: string, project: string) => {
  const a = authorOf(by);
  if (a.kind === 'owner') return t('tasks.owner.user');
  if (a.name === CLI_BY) return t('confirm.byCli');
  return a.name === project ? t('confirm.lead') : a.name;
};
/** An agent's face beside what it wrote (the owner and the terminal have none here). */
const faceOf = (by: string) => {
  const a = authorOf(by);
  return a.kind === 'name' && a.name !== CLI_BY ? <Face name={a.name} /> : null;
};

/** The 요약's row beside 나를 기다림: how many issues wait to be tried, and the way in. */
export function ConfirmEntry({ count, onStart }: { count: number; onStart: () => void }) {
  if (count === 0) return null;
  return (
    <section className="sb-panel cf-entry" data-testid="confirm-entry" data-count={count}>
      <span className="cf-stamp">
        <I name="stamp" pixel="check" />
      </span>
      <span className="cf-entry-text">
        <b>
          {t('confirm.entry.title')} <span className="sb-num">{count}</span>
        </b>
        <small className="sb-muted">{t('confirm.entry.hint')}</small>
      </span>
      <Button size="sm" variant="accent" data-testid="confirm-start" onClick={onStart}>
        {t('confirm.start')}
      </Button>
    </section>
  );
}

/** The issue's worktree as git sees it (observed), read while the card shows. */
function useWorktreeOf(task: BoardTask | null): { loading: boolean; worktree: RepoWorktree | undefined } {
  useRepoView(task?.project ?? null);
  const repo = useRepoStore().states[task?.project ?? ''];
  if (!task) return { loading: false, worktree: undefined };
  return { loading: repo === undefined, worktree: repo?.ok ? worktreeOfTask(repo.worktrees, task.id) : undefined };
}

/** 확인했어요 · 아직 이상해요 · 나중에: in the card on a wide board, in a bar above the dock on a phone (CSS picks one). */
function Answers({
  place,
  merges,
  busy,
  asking,
  onAnswer,
  onAsk,
}: {
  place: 'card' | 'bar';
  merges: boolean;
  /** The worktree is still being read: the merge warning is not known yet. */
  busy: boolean;
  asking: boolean;
  onAnswer: (a: ConfirmAnswer) => void;
  onAsk: () => void;
}) {
  return (
    <div className={`cf-ans cf-ans-${place}`} data-testid={`confirm-answers-${place}`}>
      <Button size="md" variant="accent" className="cf-btn cf-yes" data-testid="confirm-yes" disabled={busy} onClick={() => onAnswer('done')}>
        <I name="stamp" pixel="check" />
        {merges ? t('confirm.yesMerge') : t('confirm.yes')}
      </Button>
      <Button size="md" className="cf-btn cf-out" data-testid="confirm-no" disabled={busy} aria-expanded={asking} onClick={onAsk}>
        <I name="circle-alert" pixel="ask" />
        {t('confirm.no')}
      </Button>
      <span className="cf-sp" />
      <button type="button" className="cf-later" data-testid="confirm-later" disabled={busy} onClick={() => onAnswer('later')}>
        <I name="clock" pixel="clock" />
        {t('confirm.later')}
      </button>
    </div>
  );
}

function Source({ source }: { source: BoardFactSource }) {
  return (
    <span className="cf-src" data-testid="fact-source" data-source={source}>
      {t(`tasks.source.${source}`)}
    </span>
  );
}

/** A labelled text slot: the stored text, or its quiet fallback. */
function Slot({ label, text, testId, children }: { label: string; text: string | undefined; testId: string; children?: ReactNode }) {
  return (
    <div className="cf-sec" data-testid={testId} data-written={text ? 'yes' : 'no'}>
      <span className="cf-k">{label}</span>
      <span className={text ? 'cf-v' : 'cf-v cf-quiet'}>{text || t('confirm.notWritten')}</span>
      {children}
    </div>
  );
}

/** Who wrote a part and when, with the agent's face. */
function By({ by, at, project, now }: { by: string; at: string; project: string; now: number }) {
  return (
    <span className="cf-by">
      {faceOf(by)}
      {t('confirm.wrote', { name: nameOf(by, project), time: timeAgo(at, now) })}
    </span>
  );
}

/** 고쳐졌다면 이렇게 보여요: the pictures the issue names (project files, served like 파일's), or the quiet line. */
function Pictures({ task }: { task: BoardTask }) {
  const before = task.check?.before;
  const after = task.check?.after;
  const shots = [
    ...(before ? [{ kind: 'before' as const, file: before }] : []),
    ...(after ? [{ kind: 'after' as const, file: after }] : []),
  ];
  const [urls, setUrls] = useState<Record<string, string>>({});
  useEffect(() => {
    let live = true;
    for (const file of [before, after])
      if (file)
        rootFileTicket({ kind: 'project', project: task.project }, file, 'preview')
          .then((url) => {
            if (live) setUrls((held) => ({ ...held, [file]: url }));
          })
          .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [task.project, before, after]);
  return (
    <div className="cf-look" data-testid="confirm-look" data-pictures={shots.length}>
      <span className="cf-k">{t('confirm.look')}</span>
      {shots.length === 0 ? (
        <p className="cf-quiet">{t('confirm.noPictures')}</p>
      ) : (
        <div className="cf-pair">
          {shots.map((s, i) => (
            <div key={s.kind} className="cf-pair-item">
              {i > 0 && (
                <span className="cf-arrow" aria-hidden="true">
                  <I name="arrow-right" pixel="right" />
                </span>
              )}
              <figure className="cf-shot">
                {urls[s.file] ? <img src={urls[s.file]} alt={s.file} /> : <span className="cf-shot-empty" />}
                <figcaption className={`cf-cap cf-cap-${s.kind}`}>
                  {s.kind === 'after' ? <I name="check" pixel="check" /> : <I name="x" pixel="stop" />}
                  {t(s.kind === 'after' ? 'confirm.after' : 'confirm.before')}
                </figcaption>
              </figure>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** The honesty line: what the store knows about this issue, each fact with its source. */
function Honest({ task, loading, worktree, now }: { task: BoardTask; loading: boolean; worktree: RepoWorktree | undefined; now: number }) {
  const review = reviewEntry(task);
  const tests = task.testsPassed ?? task.testsRan;
  const testText = task.testsPassed
    ? t(task.testsPassed.value ? 'confirm.honest.testsPassed' : 'confirm.honest.testsFailed')
    : task.testsRan
      ? t(task.testsRan.value ? 'confirm.honest.testsRan' : 'confirm.honest.testsNotRun')
      : t('confirm.honest.testsNone');
  return (
    <div className="cf-hon" role="note" data-testid="confirm-honest">
      <I name="info" pixel="eye" />
      <span>
        <b>
          {review ? t('confirm.honest.review', { name: nameOf(review.by, task.project), time: timeAgo(review.at, now) }) : t('confirm.honest.reviewUnknown')}
          {review && <Source source="reported" />}
          {' · '}
          <span data-testid="confirm-tests">
            {testText}
            {tests && <Source source={tests.source} />}
          </span>
          {' · '}
          <span data-testid="confirm-branch" data-merged={worktree ? String(worktree.merged) : loading ? 'loading' : 'none'}>
            {loading
              ? t('confirm.honest.loading')
              : worktree
                ? t(worktree.merged ? 'confirm.honest.merged' : 'confirm.honest.open', { base: worktree.base })
                : t('confirm.honest.noWorktree')}
            {worktree && <Source source="observed" />}
          </span>
        </b>{' '}
        {t('confirm.honest.owner')}
      </span>
    </div>
  );
}

function Card({
  task,
  now,
  canAct,
  loading,
  worktree,
  open,
  setOpen,
  onAnswer,
}: {
  task: BoardTask;
  now: number;
  canAct: boolean;
  loading: boolean;
  worktree: RepoWorktree | undefined;
  open: boolean;
  setOpen: (open: boolean) => void;
  onAnswer: (answer: ConfirmAnswer, line?: string) => void;
}) {
  const [line, setLine] = useState('');
  const merge = confirmMerge(worktree);
  const check = task.check;
  const checkBy = check ? lastWriter(task, 'check') : null;
  const detailBy = task.detail ? lastWriter(task, 'detail') : null;
  const noteBy = task.note ? lastWriter(task, 'note') : null;
  const device = deviceOf(task);
  const steps = check?.steps ?? [];
  // What was wrong / what changed when written; else the issue's own detail under a plain heading.
  const told = !!(check?.problem || check?.change) || !task.detail;
  const send = (e: FormEvent) => {
    e.preventDefault();
    if (line.trim()) onAnswer('back', line);
  };
  return (
    <article className="cf-pn cf-card" data-testid="confirm-card" data-task={task.id} aria-label={`${task.id} ${task.title}`}>
      <div className="cf-ctop">
        {device !== 'none' && (
          <span className="cf-dev" data-device={device}>
            <DeviceIcon device={device} />
            {t(`confirm.chip.${device}`)}
          </span>
        )}
        <span className="cf-sp" />
        <span className="cf-id sb-num">
          {task.project} · {task.id}
        </span>
      </div>
      <h2 className="cf-h1">{task.title}</h2>

      <div className="cf-cols">
        <div className="cf-left">
          {told ? (
            <>
              <Slot label={t('confirm.problem')} text={check?.problem} testId="confirm-problem" />
              <Slot label={t('confirm.change')} text={check?.change} testId="confirm-change" />
            </>
          ) : (
            <Slot label={t('confirm.detail')} text={task.detail} testId="confirm-detail">
              {detailBy && <By by={detailBy.by} at={detailBy.at} project={task.project} now={now} />}
            </Slot>
          )}
          {task.note && (
            <Slot label={t('confirm.note')} text={task.note} testId="confirm-note">
              {noteBy && <By by={noteBy.by} at={noteBy.at} project={task.project} now={now} />}
            </Slot>
          )}

          <div className="cf-how" data-testid="confirm-steps" data-written={steps.length || check?.expect ? 'yes' : 'no'}>
            <div className="cf-how-k">
              {t('confirm.steps')}
              {check?.minutes && <span className="cf-f">{t('confirm.minutes', { count: check.minutes })}</span>}
            </div>
            {steps.map((step, i) => (
              <div key={i} className="cf-st">
                <span className="cf-n sb-num">{i + 1}</span>
                <span>{step}</span>
              </div>
            ))}
            {check?.expect && (
              <div className="cf-st cf-goal" data-testid="confirm-expect">
                <span className="cf-n sb-num">{steps.length + 1}</span>
                <span>{check.expect}</span>
              </div>
            )}
            {!steps.length && !check?.expect && (
              <p className="cf-quiet">
                {t('confirm.noSteps')} {t('confirm.noStepsAdvice')}
              </p>
            )}
            {checkBy && (
              <div className="cf-by" data-testid="confirm-steps-by">
                {faceOf(checkBy.by)}
                {checkBy.by === CLI_BY ? t('confirm.stepsByCli') : t('confirm.stepsBy', { name: nameOf(checkBy.by, task.project) })}
              </div>
            )}
          </div>
        </div>
        <Pictures task={task} />
      </div>

      <Honest task={task} loading={loading} worktree={worktree} now={now} />
      {merge && worktree && (
        <p className="cf-merge" role="note" data-testid="confirm-merge" data-merge={merge}>
          <I name="git-branch" pixel="bolt" />
          {t(merge === 'auto' ? 'confirm.merge' : 'confirm.noMerge', { branch: worktree.branch, base: worktree.base })}
        </p>
      )}

      {canAct && (
        <>
          <Answers place="card" merges={merge === 'auto'} busy={loading} asking={open} onAnswer={onAnswer} onAsk={() => setOpen(true)} />
          {open ? (
            <form className="cf-fold cf-fold-open" onSubmit={send} data-testid="confirm-line">
              <label className="cf-fold-head" htmlFor={`cf-line-${task.id}`}>
                <I name="chevron-down" pixel="right" />
                {t('confirm.fold')}
                <span className="cf-f">{t('confirm.foldHint')}</span>
              </label>
              <div className="cf-line-row">
                <input
                  id={`cf-line-${task.id}`}
                  className="cf-input"
                  value={line}
                  maxLength={CONFIRM_LINE_MAX}
                  placeholder={t('confirm.linePlaceholder')}
                  autoFocus
                  onChange={(e) => setLine(e.target.value)}
                />
                <Button size="md" variant="accent" type="submit" disabled={!line.trim()}>
                  {t('confirm.send')}
                </Button>
              </div>
            </form>
          ) : (
            <button type="button" className="cf-fold" data-testid="confirm-fold" aria-expanded={false} onClick={() => setOpen(true)}>
              <I name="chevron-right" pixel="right" />
              {t('confirm.fold')}
              <span className="cf-f">{t('confirm.foldHint')}</span>
            </button>
          )}
        </>
      )}
    </article>
  );
}

function Queue({ queue, answered, current }: { queue: BoardTask[]; answered: Record<string, ConfirmAnswer>; current: BoardTask | null }) {
  const [open, setOpen] = useState<Partial<Record<DeviceGroup, boolean>>>({});
  const left = queue.filter((task) => task.status === 'review' && answered[task.id] === undefined).length;
  return (
    <aside className="cf-pn cf-qp" data-testid="confirm-queue" aria-label={t('confirm.queue')}>
      <div className="cf-ph">
        <span className="cf-stamp">
          <I name="stamp" pixel="check" size={CONFIRM_ICON_PX + 2} />
        </span>
        {t('confirm.queue')}
        <span className="cf-sp" />
        <span className="cf-meta sb-num">{t('confirm.left', { count: left })}</span>
      </div>
      <div className="cf-qb">
        {deviceGroups(queue).map((g) => {
          const { rows, more } = groupRows(g.tasks, current, CONFIRM_GROUP_ROWS, !!open[g.device]);
          return (
            <section key={g.device} className="cf-group" data-device={g.device}>
              <h4 className="cf-gh">
                <DeviceIcon device={g.device} />
                {t(`confirm.device.${g.device}`)}
                <span className="cf-c sb-num">{g.tasks.length}</span>
              </h4>
              <ul role="list">
                {rows.map((task) => {
                  const a = answered[task.id];
                  const mark = task === current ? 'now' : a === 'later' ? 'later' : a && task.status === 'review' ? 'sending' : a;
                  return (
                    <li key={task.id} className="cf-qr" data-testid="confirm-queue-row" data-task={task.id} data-mark={mark ?? 'waiting'}>
                      <span className="cf-o" aria-hidden="true">
                        {mark === 'done' && <I name="check" pixel="check" size={CONFIRM_ICON_PX - 6} />}
                      </span>
                      <span className="cf-t" title={task.title}>
                        {task.title}
                      </span>
                      <span className="cf-qid sb-num">{mark ? t(`confirm.mark.${mark}`) : task.id}</span>
                    </li>
                  );
                })}
              </ul>
              {more > 0 && (
                <button type="button" className="cf-qmore" onClick={() => setOpen({ ...open, [g.device]: true })}>
                  {t('confirm.more', { count: more })}
                  <I name="chevron-right" pixel="right" />
                </button>
              )}
            </section>
          );
        })}
        <p className="cf-qf">{t('confirm.queueNote')}</p>
      </div>
    </aside>
  );
}

/** The flow in place of the 요약's boxes: a slim head, the card, and the queue beside it (under it on a phone). */
export function ConfirmFlow({ shown, onBack, now }: { shown: (task: BoardTask) => boolean; onBack: () => void; now: number }) {
  const { taskBoard, officeSnapshot, officeReadOnly, hostInfo } = useAgtyStore();
  const [answered, setAnswered] = useState<Record<string, ConfirmAnswer>>({});
  const queue = confirmQueue(taskBoard?.tasks ?? [], shown, answered);
  const current = currentTask(queue, answered);
  const count = confirmCount(queue, answered);
  const { loading, worktree } = useWorktreeOf(current);
  // 아직 이상해요 opens the card's folded line, for the card on screen only.
  const [asking, setAsking] = useState<string | null>(null);
  // Which card is on screen and since when; the answers given (a ref: a second click arrives before the re-render).
  const shownCard = useRef<{ id: string; at: number } | null>(null);
  const given = useRef(new Set<string>());
  const currentId = current?.id ?? null;
  useEffect(() => {
    shownCard.current = currentId ? { id: currentId, at: clock() } : null;
  }, [currentId]);
  const tally = (a: ConfirmAnswer) => Object.values(answered).filter((x) => x === a).length;
  /** Answer issue `id`, the one on screen when the press began; any other press is dropped. */
  const answer = (id: string, a: ConfirmAnswer, line = '') => {
    const task = queue.find((x) => x.id === id);
    if (!task || given.current.has(id) || !pressAllowed(shownCard.current, id, clock(), CONFIRM_PRESS_GUARD_MS)) return;
    const stamp = t('confirm.noteStamp', {
      time: hostDateTime(clock(), hostInfo?.utcOffsetMin ?? -new Date().getTimezoneOffset()),
    });
    const fields = answerEdit(a, line, stamp, task.note);
    if (a === 'back' && !fields) return;
    given.current.add(id);
    if (fields) transport.send({ type: 'taskEdit', id, fields });
    if (a === 'back') {
      // The Lead is named after its project; one the office does not show cannot be sent to. Only the fixed
      // prefix, the id and the owner's own line go: nothing an agent wrote travels as the owner's words.
      const lead = officeSnapshot?.orchestrators.find((o) => o.name === task.project && o.agentId != null);
      if (lead && lead.agentId != null) {
        const text = t('confirm.leadMessage', { id, line: line.trim() });
        messengerSend((m) => transport.send(m), transport.state === 'connected', lead.agentId, lead.name, text);
        agtyToast(lead.name, t('confirm.leadSending', { lead: lead.name }), 'info');
      } else agtyToast(task.project, t('confirm.leadAway'), 'info');
    }
    setAnswered((cur) => ({ ...cur, [id]: a }));
  };
  return (
    <div className="cf" data-testid="confirm-flow">
      <div className="cf-hd">
        <button type="button" className="cf-bk" aria-label={t('confirm.backLabel')} data-testid="confirm-back" onClick={onBack}>
          <I name="arrow-left" pixel="right" />
          {t('confirm.back')}
        </button>
        <span className="cf-ttl sb-num" title={t('confirm.countHint')} data-testid="confirm-count">
          {t('confirm.headWord')} <b>{confirmPosition(queue, current)}</b> / {count.total}
        </span>
        {/* One cell per issue: the bar is the count of answered ones, nothing estimated. */}
        <SegBar value={count.answered} max={count.total} segments={Math.max(1, count.total)} label={t('confirm.countHint')} className="cf-bar" />
        <span className="cf-dn sb-num">
          <b>{t('confirm.doneLine', { count: tally('done') })}</b>
          {current && ` · ${t(`confirm.doing.${deviceOf(current)}`)}`}
        </span>
      </div>
      <div className="cf-main">
        {current ? (
          <Card
            key={current.id}
            task={current}
            now={now}
            canAct={!officeReadOnly}
            loading={loading}
            worktree={worktree}
            open={asking === current.id}
            setOpen={(on) => setAsking(on ? current.id : null)}
            onAnswer={(a, line) => answer(current.id, a, line)}
          />
        ) : (
          <section className="cf-pn cf-card cf-finished" data-testid="confirm-finished">
            <h2 className="cf-h1">{queue.length ? t('confirm.finished') : t('confirm.empty')}</h2>
            {queue.length > 0 && <p className="cf-quiet">{t('confirm.summary', { done: tally('done'), back: tally('back'), later: tally('later') })}</p>}
            <Button size="md" onClick={onBack}>
              {t('confirm.back')}
            </Button>
          </section>
        )}
        {queue.length > 0 && <Queue queue={queue} answered={answered} current={current} />}
      </div>
      {current && !officeReadOnly && (
        <Answers
          key={current.id}
          place="bar"
          merges={confirmMerge(worktree) === 'auto'}
          busy={loading}
          asking={asking === current.id}
          onAnswer={(a) => answer(current.id, a)}
          onAsk={() => {
            setAsking(current.id);
            // The folded line is in the card, above: bring it into view.
            requestAnimationFrame(() => document.getElementById(`cf-line-${current.id}`)?.scrollIntoView({ block: 'center' }));
          }}
        />
      )}
    </div>
  );
}
