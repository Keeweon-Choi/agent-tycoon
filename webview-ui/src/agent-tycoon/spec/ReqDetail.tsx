/**
 * SPT-P3-GRAPH (SPT §6.4), RQ2 (RQW §2.3): one requirement's detail, the 요구사항 tab's right pane and
 * the side panel of 지도, 그래프 and an issue's requirements (full screen on a phone). In order: the
 * head (표시 ID, which copies it; the three-state pill, RQ1; 원본 보기; 이웃 그래프), '왜 … 인가요' in
 * words, 원문, 인수 기준 and 확인 방법, the linked issues, 확인된 것 (commits and runs, each with where
 * it comes from: 직접 봄, 글에 적힘, 보고만, a guess dashed with 짐작 and [맞아요]·[아니에요]), then
 * [이 요구사항으로 이슈 만들기] (RQ3) and [이슈 연결], and folded: 더 연결하기 (the other links, 모두
 * 확인, 연결 추가), 내가 확인하기 (SPT-P3-ACCEPT's 수용 판정 per version) and 이력. GAME-UI-1 G2: the
 * current version's 수락 is a gold stamp at the head (dropped only when this panel's own write came back).
 */
import '../../i18n/specStrings.js';
import './score.css';
import './reqs.css';

import { lazy, Suspense, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import {
  reqState,
  type ReqStateView,
  type ReqWhy,
} from '../../../../core/src/agent-tycoon/spec/reqState.js';
import type {
  Acceptance,
  LinkRel,
  TraceAcceptance,
  TraceEdge,
  TraceNode,
  TraceState,
} from '../../../../core/src/agent-tycoon/spec/trace.js';
import { Button } from '../../components/ui/Button.js';
import { Modal } from '../../components/ui/Modal.js';
import {
  SPEC_ACCEPT_NOTE_MAX,
  SPEC_DIALOG_Z,
  SPEC_ISSUE_TITLE_MAX,
  SPEC_ISSUE_TITLE_SHOWN,
  SPEC_SEARCH_WAIT_MS,
  SPEC_WHY_ISSUES,
} from '../../constants.js';
import { t, type TranslationKey } from '../../i18n/index.js';
import { playDoneSound } from '../../notificationSound.js';
import { writeClipboardText } from '../../terminal/clipboard.js';
import { timeAgo } from '../format.js';
import { Stamp } from '../game/parts.js';
import { Icon } from '../icons/Icon.js';
import { Markdown } from '../markdown.js';
import { agtyToast } from '../officeStore.js';
import { openTab, useCanAct } from '../workbench/workbenchStore.js';
import { rememberViewed } from './overviewModel.js';
import { baseName } from './reqsModel.js';
import { tableRowLines } from './tableRow.js';
import {
  getCandidates,
  itemPath,
  PICK_TYPES,
  type PickCandidate,
  type PickType,
  type TraceItem,
  traceWrite,
  useTrace,
} from './traceApi.js';
import { openSource, shortDate, sourceText, whoText } from './traceModel.js';

// The graph's chunk (React Flow, dagre) loads only when [이웃 그래프] is pressed.
const ReqGraph = lazy(() => import('./TraceGraph.js').then((m) => ({ default: m.ReqGraph })));
const muted = 'text-text-muted text-xs';

/** RQ1's state pill; a guess is dashed and says 짐작 beside it (never colour alone). */
export function ReqPill({ view }: { view: ReqStateView }) {
  return (
    <span
      className="inline-flex items-center gap-4 shrink-0"
      title={view.guess ? t('reqs.tip.guess') : undefined}
    >
      <span
        className="rq-pill"
        data-s={view.status}
        data-guess={view.guess || undefined}
        data-testid="reqs-pill"
        data-state={view.status}
      >
        {t(`reqs.state.${view.status}`)}
      </span>
      {view.guess && <span className="rq-guessword">{t('reqs.guess')}</span>}
    </span>
  );
}

/** The 원문: a single table row as `column: value` lines (the narrow column cannot hold a table), anything else as Markdown. */
function TextView({ text }: { text: string }) {
  const row = tableRowLines(text);
  if (!row) return <Markdown text={text} className="break-words leading-relaxed" />;
  return (
    <dl className="space-y-2 break-words leading-relaxed" data-testid="spec-detail-row">
      {row.map((c) => (
        <div key={c.column}>
          <dt className="inline text-text-muted">{c.column}: </dt>
          <dd className="inline whitespace-pre-wrap">{c.value}</dd>
        </div>
      ))}
    </dl>
  );
}
const selectCls =
  'bg-bg border-ui rounded-ui-card border-border px-4 py-2 text-xs pointer-coarse:min-h-44 min-w-0';
const RELS: readonly LinkRel[] = [
  'implements',
  'changes',
  'verifies',
  'discusses',
  'realizes',
  'refs',
];
const PICK_REL: Record<PickType, LinkRel> = {
  task: 'implements',
  commit: 'changes',
  job: 'verifies',
  component: 'realizes',
};
const EVIDENCE_KINDS = ['unit', 'integration', 'deploy', 'other'] as const;

/** Which kind of source an observed link came from ([모두 확인] groups by it). */
const sourceKind = (e: TraceEdge, other?: TraceNode): TranslationKey =>
  e.source?.sha
    ? 'spec.type.commit'
    : e.source?.taskId
      ? 'spec.type.task'
      : e.source?.jobId
        ? 'spec.type.job'
        : e.source?.path
          ? 'spec.type.doc'
          : `spec.type.${other?.type ?? 'doc'}`;
// ── SPT-P3-ACCEPT: 수용 판정 per version (SPT §5.3), the 최신 row's two review branches (§5.4) ──
const ACCEPTANCES: readonly Acceptance[] = ['none', 'validate', 'accepted', 'rejected'];
/** '수락', or '지금 버전 검토 전 · 이전 버전(11-05) 수락' when only an earlier text has a record. */
const acceptanceText = (s?: TraceState) => {
  const a = s?.acceptance;
  return a?.current === 'none' && a.previous
    ? t('spec.accept.previous', {
        now: t('spec.acc.none'),
        when: shortDate(a.previous.at).slice(0, 5),
        state: t(`spec.acc.${a.previous.state}`),
      })
    : t(`spec.acc.${a?.current ?? 'none'}`);
};
function AcceptPanel({
  project,
  uid,
  version,
  s,
  records,
  act,
  reload,
  onRecorded,
  fresh,
}: {
  project: string;
  uid: string;
  /** GAME-UI-1: the state this panel's last write recorded (the server said yes). */
  onRecorded: (a: Acceptance) => void;
  /** That state, while the shown data already has it: the stamp is new here. */
  fresh: Acceptance | null;
  /** The text shown (TraceItem.version); none: the document is gone, nothing to judge. */
  version?: string;
  s?: TraceState;
  records: TraceAcceptance[];
  act: (p: Promise<unknown>) => void;
  reload: () => void;
}) {
  const [memo, setMemo] = useState('');
  const note = memo.trim();
  const current = s?.acceptance?.current ?? 'none';
  // This version's records first, then the earlier versions' (each newest first).
  const rows = [...records.filter((a) => a.current), ...records.filter((a) => !a.current)];
  const canAct = useCanAct();
  const rejected = current === 'rejected' ? records.find((a) => a.current) : undefined;
  return (
    <section
      className="border-ui rounded-ui-card border-border p-6 space-y-6"
      data-testid="spec-accept"
    >
      <h3 className="text-sm">{t('spec.accept.title')}</h3>
      {s?.acceptanceReview && <p className={muted}>{t('spec.accept.reviewHint')}</p>}
      <div className="flex flex-wrap gap-6">
        {ACCEPTANCES.map((a) => (
          <Button
            key={a}
            size="sm"
            variant={a === current ? 'active' : 'default'}
            aria-pressed={a === current}
            disabled={!version || (a === 'rejected' && !note)}
            title={a === 'rejected' && !note ? t('spec.accept.needMemo') : undefined}
            data-testid="spec-accept-set"
            data-state={a}
            onClick={() =>
              version &&
              void traceWrite.accept(project, uid, version, a, note || undefined).then(
                () => (setMemo(''), onRecorded(a), act(Promise.resolve())),
                (err: Error & { code?: string }) => {
                  // The text changed since it was shown: say so and show the new one (the memo stays).
                  if (err.code !== 'spec_stale') return act(Promise.reject(err));
                  agtyToast(t('spec.accept.title'), t('spec.accept.changed'), 'error');
                  reload();
                },
              )
            }
          >
            {t(`spec.accept.set.${a}`)}
          </Button>
        ))}
      </div>
      <input
        aria-label={t('spec.accept.memo')}
        placeholder={t('spec.accept.memo')}
        className={`${selectCls} w-full`}
        maxLength={SPEC_ACCEPT_NOTE_MAX}
        value={memo}
        onChange={(e) => setMemo(e.target.value)}
        data-testid="spec-accept-memo"
      />
      {!rows.length && <p className={muted}>{t('spec.accept.none')}</p>}
      <ul className="space-y-2" data-testid="spec-accept-history">
        {rows.map((a, i) => (
          <li key={i} className="min-w-0 break-words" data-current={a.current}>
            {[
              t(a.current ? 'spec.accept.now' : 'spec.accept.earlier'),
              t(`spec.acc.${a.state}`),
              whoText(a.by),
              shortDate(a.at),
              a.note,
            ]
              .filter(Boolean)
              .join(' · ')}
          </li>
        ))}
      </ul>
      {canAct && rejected && (
        // 반려 is quiet on purpose: no drop, no ink, no score; it just appears (two frames when new) with its memo.
        <p
          className="rej-stamp"
          data-fresh={fresh === 'rejected' || undefined}
          data-testid="spec-reject-stamp"
        >
          <b>{t('spec.acc.rejected')}</b>
          {rejected.note && <small>{rejected.note}</small>}
        </p>
      )}
    </section>
  );
}

/** [연결 추가]'s pickers; `only` keeps one kind (RQ2's [이슈 연결]: issues). */
function AddLink({
  project,
  uid,
  onDone,
  only,
}: {
  project: string;
  uid: string;
  onDone: () => void;
  only?: PickType;
}) {
  const [type, setType] = useState<PickType>(only ?? 'task');
  const [text, setText] = useState('');
  const [kind, setKind] = useState<(typeof EVIDENCE_KINDS)[number]>('unit');
  const [list, setList] = useState<PickCandidate[] | null>(null);
  useEffect(() => {
    let live = true;
    const timer = setTimeout(
      () =>
        getCandidates(project, type, text.trim()).then(
          (r) => live && setList(r.candidates),
          (err: Error) =>
            live && (setList([]), agtyToast(t('spec.detail.add'), err.message, 'error')),
        ),
      SPEC_SEARCH_WAIT_MS,
    );
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [project, type, text]);
  const pick = (c: PickCandidate) =>
    traceWrite
      .add(project, { from: uid, to: c.id, rel: PICK_REL[type], ...(type === 'job' && { kind }) })
      .then(onDone, (err: Error) => agtyToast(t('spec.detail.add'), err.message, 'error'));
  return (
    <div
      className="border-ui rounded-ui-card border-border p-6 space-y-6"
      data-testid="spec-add-link"
    >
      <div className="flex flex-wrap gap-6">
        {!only && (
          <select
            aria-label={t('spec.detail.addType')}
            className={selectCls}
            value={type}
            onChange={(e) => (setType(e.target.value as PickType), setList(null))}
            data-testid="spec-add-type"
          >
            {PICK_TYPES.map((p) => (
              <option key={p} value={p}>
                {t(p === 'component' ? 'spec.type.comp' : `spec.type.${p}`)}
              </option>
            ))}
          </select>
        )}
        {type === 'job' && (
          <select
            aria-label={t('spec.detail.addKind')}
            className={selectCls}
            value={kind}
            onChange={(e) => setKind(e.target.value as typeof kind)}
            data-testid="spec-add-kind"
          >
            {EVIDENCE_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`spec.evk.${k}`)}
              </option>
            ))}
          </select>
        )}
        <input
          type="search"
          aria-label={t('spec.detail.addSearch')}
          placeholder={t('spec.detail.addSearch')}
          className={`${selectCls} flex-1 min-w-[6rem]`}
          value={text}
          onChange={(e) => setText(e.target.value)}
          data-testid="spec-add-search"
        />
      </div>
      {list && !list.length && <p className={muted}>{t('spec.detail.addNone')}</p>}
      <ul className="max-h-[12rem] overflow-y-auto">
        {list?.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              className="w-full text-left px-4 py-2 border-b border-border min-w-0 pointer-coarse:min-h-44"
              onClick={() => void pick(c)}
              data-testid="spec-add-pick"
              data-id={c.id}
            >
              <span className="font-mono">{c.label}</span>{' '}
              {c.title && <span className={muted}>{c.title}</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function DeployConfirm({
  project,
  job,
  onClose,
  onDone,
}: {
  project: string;
  job: TraceNode;
  onClose: () => void;
  onDone: () => void;
}) {
  const [note, setNote] = useState('');
  return (
    <Modal isOpen onClose={onClose} title={t('spec.detail.deploy')} zIndex={SPEC_DIALOG_Z}>
      <div
        className="flex flex-col gap-8 px-10 pb-10 w-[min(420px,calc(100vw-32px))] text-xs"
        data-testid="spec-deploy-dialog"
      >
        <p>{t('spec.detail.deployQuestion')}</p>
        <p className="font-mono">{job.label}</p>
        <p className={muted}>{t('spec.detail.deployHint')}</p>
        <input
          aria-label={t('spec.detail.note')}
          placeholder={t('spec.detail.note')}
          className={selectCls}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <div className="flex justify-end gap-8">
          <Button size="sm" onClick={onClose}>
            {t('spec.wizard.cancel')}
          </Button>
          <Button
            size="sm"
            variant="active"
            data-testid="spec-deploy-confirm"
            onClick={() =>
              traceWrite
                .deployConfirm(project, job.id, note.trim() || undefined)
                .then(onDone, (err: Error) =>
                  agtyToast(t('spec.detail.deploy'), err.message, 'error'),
                )
            }
          >
            {t('spec.detail.deployDone')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** One link chip; SPT-P3-ISSUES reuses it in the Task detail, where `onOpen` opens the requirement. */
export function LinkChip({
  project,
  e,
  other,
  act,
  onDeploy,
  onOpen,
}: {
  project: string;
  e: TraceEdge;
  other?: TraceNode;
  act: (p: Promise<unknown>) => void;
  onDeploy?: () => void;
  onOpen?: () => void;
}) {
  const key = { from: e.from, to: e.to, rel: e.rel, ...(e.kind && { kind: e.kind }) };
  const border = e.status === 'suggested' ? 'border-dashed' : 'border-solid';
  return (
    <li
      className={`border-ui rounded-ui-card ${border} border-border px-6 py-4 min-w-0 ${e.status === 'rejected' ? 'opacity-50' : ''}`}
      data-testid="spec-link"
      data-status={e.status}
      data-to={other?.id ?? e.to}
    >
      <div className="flex flex-wrap items-center gap-6 min-w-0">
        {onOpen ? (
          <button
            type="button"
            className="font-mono break-all underline text-left"
            onClick={onOpen}
            data-testid="spec-link-open"
          >
            {other?.label ?? e.to}
          </button>
        ) : (
          <span className="font-mono break-all">{other?.label ?? e.to}</span>
        )}
        {other?.title && <span className="min-w-0 break-words">{other.title}</span>}
        {e.kind && <span className={muted}>{t(`spec.evk.${e.kind}`)}</span>}
        {e.status !== 'confirmed' && (
          <span className="border-ui rounded-ui-card border-border px-2 text-xs">
            {t(`spec.link.${e.status}`)}
          </span>
        )}
      </div>
      {e.status === 'observed' && sourceText(e.source) && (
        <p className={muted}>
          {t(e.rel === 'realizes' ? 'spec.p4c.whereModule' : 'spec.edge.where', {
            where: sourceText(e.source),
          })}
        </p>
      )}
      {e.rel === 'realizes' && e.status === 'observed' && e.reason && (
        <p className={muted}>{t('spec.p4c.whyModule', { path: e.reason })}</p>
      )}
      {e.status === 'suggested' && e.reason && (
        <p className={muted}>
          {t('spec.edge.why', {
            reason:
              e.rel === 'realizes' && e.reason === 'label' ? t('spec.p4c.whyLabel') : e.reason,
          })}
        </p>
      )}
      {e.status === 'confirmed' && e.by && (
        <p className={muted}>
          {t('spec.edge.by', { who: whoText(e.by), when: e.at ? timeAgo(e.at) : '' })}
        </p>
      )}
      {(e.status === 'observed' || e.status === 'suggested' || onDeploy) && (
        <div className="flex flex-wrap gap-6 mt-4">
          {(e.status === 'observed' || e.status === 'suggested') && (
            <>
              <Button
                size="sm"
                variant="active"
                data-testid="spec-link-confirm"
                onClick={() => act(traceWrite.confirm(project, [key]))}
              >
                {t('spec.detail.confirm')}
              </Button>
              <Button
                size="sm"
                data-testid="spec-link-reject"
                onClick={() =>
                  act(traceWrite.reject(project, { from: e.from, to: e.to, rel: e.rel }))
                }
              >
                {t('spec.detail.reject')}
              </Button>
            </>
          )}
          {onDeploy && (
            <Button size="sm" data-testid="spec-deploy" onClick={onDeploy}>
              {t('spec.detail.deploy')}
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

/** 글에 적힘 · 짐작 · 직접 봄 · 보고만: where a fact comes from, in words (a guess dashed). */
function Src({ k }: { k: 'written' | 'guess' | 'seen' | 'reported' | 'notDeploy' | 'gone' }) {
  return (
    <span className="rq-tag" data-src={k} data-testid="reqs-src" data-kind={k}>
      {k === 'guess' ? t('reqs.guess') : k === 'gone' ? t('reqs.seen.gone') : t(`reqs.src.${k}`)}
    </span>
  );
}
const HOW_OF: Partial<Record<TraceEdge['status'], 'written' | 'guess'>> = {
  observed: 'written',
  suggested: 'guess',
};
const ISSUE_ACTIVE = new Set(['doing', 'review', 'blocked']);
/** The first word of the 왜 box: one sentence per fact, a guess marked. */
function whySentence(w: ReqWhy, note?: string): string {
  switch (w.k) {
    case 'accepted':
      return t('reqs.why.accepted');
    case 'seen':
      return t('reqs.why.seen', { merged: w.merged, passed: w.passed });
    case 'rejected':
      return note ? t('reqs.why.rejectedNote', { note }) : t('reqs.why.rejected');
    case 'issue':
      return w.status === 'done'
        ? t('reqs.why.issueDone', { id: w.id })
        : t(`reqs.why.issue.${w.status as 'doing' | 'review' | 'blocked'}`, { id: w.id });
    case 'commits':
      return w.merged
        ? t('reqs.why.commitsMerged', { count: w.n, merged: w.merged })
        : t('reqs.why.commits', { count: w.n });
    case 'runs':
      return t('reqs.why.runs', { count: w.n, passed: w.passed });
    case 'noRun':
      return t('reqs.why.noRun');
    case 'reported':
      return t('reqs.why.reported');
    case 'changed':
      return t('reqs.why.changed');
    case 'todoIssues':
      return t('reqs.why.todoIssues', { count: w.n });
    case 'none':
      return t('reqs.why.none');
  }
}
const whyGuess = (w: ReqWhy) => (w.k === 'issue' ? w.how === 'guess' : 'guess' in w && w.guess);

/** RQ3: 이 요구사항으로 이슈 만들기. Title and memo prefilled from the requirement; the daemon makes the issue and its confirmed link. */
function IssueDialog({
  project,
  uid,
  title,
  note,
  onClose,
  onDone,
}: {
  project: string;
  uid: string;
  title: string;
  note: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [name, setName] = useState(title);
  const [memo, setMemo] = useState(note);
  const [owner, setOwner] = useState('');
  const [busy, setBusy] = useState(false);
  const create = () => {
    setBusy(true);
    traceWrite
      .issue(project, uid, {
        title: name.trim(),
        ...(memo.trim() && { note: memo.trim() }),
        ...(owner.trim() && { owner: owner.trim() }),
      })
      .then(
        (r) => {
          agtyToast(
            t('reqs.issue.make'),
            t(r.linked ? 'reqs.issue.made' : 'reqs.issue.madeWritten', { id: r.task }),
            r.linked ? 'ok' : 'error',
          );
          onDone();
        },
        (err: Error) => agtyToast(t('reqs.issue.make'), err.message, 'error'),
      )
      .finally(() => setBusy(false));
  };
  return (
    <Modal isOpen onClose={onClose} title={t('reqs.issue.make')} zIndex={SPEC_DIALOG_Z + 2}>
      <div
        className="flex flex-col gap-8 px-10 pb-10 w-[min(480px,calc(100vw-32px))] text-xs"
        data-testid="reqs-issue-dialog"
      >
        <label className="grid gap-2">
          {t('reqs.issue.title')}
          <input
            className="rq-field"
            value={name}
            maxLength={SPEC_ISSUE_TITLE_MAX}
            onChange={(e) => setName(e.target.value)}
            data-testid="reqs-issue-title"
          />
        </label>
        <label className="grid gap-2">
          {t('reqs.issue.note')}
          <input
            className="rq-field"
            value={memo}
            maxLength={SPEC_ACCEPT_NOTE_MAX}
            onChange={(e) => setMemo(e.target.value)}
            data-testid="reqs-issue-note"
          />
        </label>
        <label className="grid gap-2">
          {t('reqs.issue.owner')}
          <input
            className="rq-field"
            value={owner}
            placeholder={t('reqs.issue.ownerNone')}
            onChange={(e) => setOwner(e.target.value)}
            data-testid="reqs-issue-owner"
          />
        </label>
        <div className="flex justify-end gap-8">
          <Button size="sm" onClick={onClose}>
            {t('spec.wizard.cancel')}
          </Button>
          <Button
            size="sm"
            variant="accent"
            disabled={busy || !name.trim()}
            onClick={create}
            data-testid="reqs-issue-create"
          >
            {t('reqs.issue.create')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function ReqDetail({
  project,
  uid,
  mobile,
  onClose,
  onChanged,
  inGraph,
  pane,
  section,
}: {
  project: string;
  uid: string;
  mobile: boolean;
  onClose: () => void;
  onChanged?: () => void;
  /** Opened by the requirements graph: no [이웃 그래프], and over the graph's window on a phone. */
  inGraph?: boolean;
  /** RQ2: the 요구사항 tab's right pane (its whole width, no close button). */
  pane?: boolean;
  /** The heading it sits under, when the caller has it (the tree's row). */
  section?: string;
}) {
  const { data, error, reload } = useTrace<TraceItem>(project, itemPath(uid));
  // SPT-P3-OVERVIEW: the 개요's 최근 본 요구사항.
  const shownLabel = data?.node.label;
  useEffect(() => {
    if (shownLabel) rememberViewed(project, { uid, label: shownLabel });
  }, [project, uid, shownLabel]);
  const [adding, setAdding] = useState(false);
  const [linking, setLinking] = useState(false);
  const [making, setMaking] = useState(false);
  const [graph, setGraph] = useState(false);
  const [deploy, setDeploy] = useState<TraceNode | null>(null);
  // GAME-UI-1: what this panel just recorded (and how many times, for the thunk to replay).
  const [recorded, setRecorded] = useState<{ uid: string; state: Acceptance; n: number } | null>(
    null,
  );
  const canAct = useCanAct();
  const done = () => {
    agtyToast(t('spec.detail.title'), t('spec.done'), 'ok');
    reload();
    onChanged?.();
  };
  const act = (p: Promise<unknown>) =>
    void p.then(done, (err: Error) => agtyToast(t('spec.detail.title'), err.message, 'error'));
  const shell = mobile
    ? 'fixed inset-0 bg-bg overflow-y-auto pt-[calc(var(--agty-safe-top)+8px)] pb-[calc(var(--agty-safe-bottom)+8px)] px-16'
    : pane
      ? 'rq-detail'
      : 'pixel-panel w-[min(380px,100%)] shrink-0 self-start sticky top-0 max-h-[80vh] overflow-y-auto p-12';
  const node = data?.node;
  const s = node?.state;
  const view = reqState(s);
  const label = node?.label ?? uid;
  const nodes = new Map((data?.nodes ?? []).map((n) => [n.id, n] as const));
  const otherOf = (e: TraceEdge) => nodes.get(e.from === uid ? e.to : e.from);
  const edges = data?.edges ?? [];
  const live = edges.filter((e) => e.status !== 'rejected');
  const issueEdges = live.filter((e) => e.rel === 'implements' && otherOf(e)?.type === 'task');
  const seenEdges = live.filter((e) => e.rel === 'changes' || e.rel === 'verifies');
  const moreEdges = edges.filter((e) => !issueEdges.includes(e) && !seenEdges.includes(e));
  const observedBy = new Map<TranslationKey, TraceEdge[]>();
  for (const e of edges)
    if (e.status === 'observed')
      observedBy.set(sourceKind(e, otherOf(e)), [
        ...(observedBy.get(sourceKind(e, otherOf(e))) ?? []),
        e,
      ]);
  const current = s?.acceptance?.current;
  // The stamp is new only once the reloaded detail shows what this panel recorded.
  const fresh = recorded?.uid === uid && recorded.state === current ? recorded.state : null;
  const acceptedBy = current === 'accepted' ? data?.acceptance?.find((a) => a.current) : undefined;
  const rejectNote =
    current === 'rejected' ? data?.acceptance?.find((a) => a.current)?.note : undefined;
  const reported = Object.values(s?.facts?.reported ?? {}).reduce((a, b) => a + (b ?? 0), 0);
  const runs = Object.values(s?.facts?.runs ?? {}).reduce((a, b) => a + (b ?? 0), 0);
  const where = node?.source?.path
    ? [
        t('reqs.detail.where', { doc: baseName(node.source.path), line: node.source.line ?? 0 }),
        section,
      ]
        .filter(Boolean)
        .join(' · ')
    : '';
  const key = (e: TraceEdge) => ({
    from: e.from,
    to: e.to,
    rel: e.rel,
    ...(e.kind && { kind: e.kind }),
  });
  const yesNo = (e: TraceEdge) =>
    canAct &&
    (e.status === 'observed' || e.status === 'suggested') && (
      <span className="inline-flex gap-6 shrink-0">
        <Button
          size="sm"
          data-testid="spec-link-confirm"
          onClick={() => act(traceWrite.confirm(project, [key(e)]))}
        >
          {t('reqs.yes')}
        </Button>
        <Button
          size="sm"
          data-testid="spec-link-reject"
          onClick={() => act(traceWrite.reject(project, { from: e.from, to: e.to, rel: e.rel }))}
        >
          {t('reqs.no')}
        </Button>
      </span>
    );
  const copyId = () =>
    void writeClipboardText(label).then((ok) =>
      agtyToast(
        t('spec.detail.title'),
        t(ok ? 'reqs.detail.copied' : 'reqs.detail.copyFailed', { id: label }),
        ok ? 'ok' : 'error',
      ),
    );
  // The first issues by name, the rest as one count.
  const issueWhys = view.why.filter((w) => w.k === 'issue');
  let named = 0;
  const why = view.why.filter((w) => w.k !== 'issue' || named++ < SPEC_WHY_ISSUES);

  const actions = canAct && data?.version !== undefined && (
    <>
      <Button
        size={mobile ? 'md' : 'sm'}
        variant="accent"
        onClick={() => setMaking(true)}
        data-testid="reqs-issue-make"
      >
        <Icon name="plus" size={14} pixel="+" />
        {t('reqs.issue.make')}
      </Button>
      <Button
        size={mobile ? 'md' : 'sm'}
        aria-expanded={linking}
        onClick={() => setLinking((l) => !l)}
        data-testid="reqs-issue-link"
      >
        <Icon name="paperclip" size={14} pixel="~" />
        {t('reqs.issue.link')}
      </Button>
    </>
  );

  const panel = (
    <aside
      className={`${shell} rq-dbox min-w-0`}
      data-thunk={fresh === 'accepted' ? (recorded!.n % 2 ? 'a' : 'b') : undefined}
      style={mobile ? { zIndex: inGraph ? SPEC_DIALOG_Z + 2 : SPEC_DIALOG_Z } : undefined}
      aria-label={t('spec.detail.title')}
      data-testid="spec-detail"
      data-uid={uid}
      data-state={view.status}
      data-guess={view.guess || undefined}
    >
      {mobile && (
        <div className="flex items-center min-h-44 border-b border-border mb-12">
          <Button variant="ghost" size="sm" onClick={onClose} data-testid="spec-detail-close">
            <Icon name="chevron-left" size={16} pixel="‹" />
            {t('reqs.detail.back')}
          </Button>
        </div>
      )}
      <div className="rq-detail-head">
        <div className="rq-grow">
          <div className="rq-idline">
            <button
              type="button"
              className="rq-id break-all"
              title={t('reqs.detail.copyId', { id: label })}
              onClick={copyId}
              data-testid="spec-detail-id"
            >
              {label}
            </button>
            {data && <ReqPill view={view} />}
            {s?.freshness === 'review' && <span className="rq-tag">{t('reqs.tag.changed')}</span>}
            {s?.freshness === 'missing' && <span className="rq-tag">{t('reqs.tag.missing')}</span>}
            {s?.freshness === 'unresolved' && (
              <span className="rq-tag">{t('reqs.tag.unresolved')}</span>
            )}
            {data?.changing && (
              <span className="rq-tag" data-testid="spec-detail-changing">
                {t(`reqs.tag.changing.${data.changing}`)}
              </span>
            )}
            {data?.decision && (
              <span className="rq-tag" data-testid="spec-detail-decision">
                {t(`reqs.tag.decision.${data.decision}`)}
              </span>
            )}
          </div>
          {node?.title && <h2 className="rq-title">{node.title}</h2>}
          {where && <p className="rq-muted break-all">{where}</p>}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-6 shrink-0">
          {node?.source?.path && (
            <Button
              size="sm"
              onClick={() => openSource(project, node.source)}
              data-testid="spec-detail-open"
            >
              <Icon name="file-text" size={14} pixel="" />
              {t('reqs.detail.open')}
            </Button>
          )}
          {data && !inGraph && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setGraph(true)}
              data-testid="spec-detail-graph"
            >
              {t('reqs.detail.graph')}
            </Button>
          )}
          {!mobile && !pane && (
            <Button
              variant="ghost"
              size="icon_md"
              aria-label={t('spec.graph.close')}
              onClick={onClose}
              data-testid="spec-detail-close"
            >
              <Icon name="x" size={16} pixel="x" />
            </Button>
          )}
        </div>
      </div>
      {canAct && acceptedBy && (
        <div className="acc-row">
          <span
            className="acc-stamp"
            key={fresh ? `n${recorded!.n}` : 'still'}
            // Clicked at the panel's foot, the stamp lands at its head: show the head as it drops.
            ref={fresh ? (el) => el?.closest('aside')?.scrollTo({ top: 0 }) : undefined}
            data-testid="spec-accept-stamp"
            data-fresh={!!fresh || undefined}
          >
            <Stamp
              tone="gold"
              still={!fresh}
              sub={[shortDate(acceptedBy.at).slice(0, 5).replace('-', '.'), whoText(acceptedBy.by)]
                .filter(Boolean)
                .join(' · ')}
            >
              {t('spec.acc.accepted')}
            </Stamp>
            {fresh &&
              [0, 1, 2, 3].map((i) => (
                <i key={i} className="acc-dust" data-i={i} aria-hidden="true" />
              ))}
          </span>
        </div>
      )}
      {error && (
        <p className="text-red-400" role="alert">
          {error}
        </p>
      )}
      {!data && !error && <p className="rq-muted">{t('spec.wizard.loading')}</p>}
      {data && (
        <>
          {graph && (
            <Modal
              isOpen
              onClose={() => setGraph(false)}
              title={`${t('spec.detail.graph')} · ${label}`}
              zIndex={SPEC_DIALOG_Z + 1}
              className={mobile ? 'w-full h-full' : 'w-[min(1180px,calc(100vw-32px))]'}
            >
              <div className="px-8 pb-8" data-testid="spec-detail-graph-window">
                <Suspense fallback={<p className="rq-muted">{t('spec.wizard.loading')}</p>}>
                  <ReqGraph project={project} mobile={mobile} center={{ uid, label }} />
                </Suspense>
              </div>
            </Modal>
          )}
          {s?.linkReview && (
            <div
              className="rq-card mt-12 flex flex-wrap items-center gap-8"
              data-guess
              data-testid="spec-link-review"
            >
              <span className="rq-grow">{t('spec.detail.reviewHint')}</span>
              {canAct && (
                <Button
                  size="sm"
                  data-testid="spec-review"
                  onClick={() => act(traceWrite.review(project, uid))}
                >
                  {t('spec.detail.review')}
                </Button>
              )}
            </div>
          )}
          <section className="rq-why" data-testid="reqs-why">
            <h3>{t(`reqs.why.${view.status}`)}</h3>
            <p>
              {why.map((w, i) => (
                <span key={i} data-guess={whyGuess(w) || undefined} data-k={w.k}>
                  {whySentence(w, rejectNote)}
                  {whyGuess(w) && (
                    <span className="rq-tag mx-4" data-src="guess">
                      {t('reqs.guess')}
                    </span>
                  )}{' '}
                </span>
              ))}
              {issueWhys.length > SPEC_WHY_ISSUES && (
                <span className="rq-muted">
                  {t('reqs.why.more', { count: issueWhys.length - SPEC_WHY_ISSUES })}
                </span>
              )}
            </p>
          </section>
          <section className="rq-sec" data-testid="spec-detail-text">
            <h3>{t('reqs.text')}</h3>
            {data.text !== undefined ? (
              <TextView text={data.text} />
            ) : (
              <p className="rq-muted">{t('spec.accept.noText')}</p>
            )}
          </section>
          <section className="rq-sec" data-testid="spec-detail-criteria">
            <h3>{t('reqs.criteria')}</h3>
            {data.criteria?.length ? (
              <ul className="list-disc pl-20 space-y-2">
                {data.criteria.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            ) : (
              <p className="rq-muted">{t('reqs.criteria.none')}</p>
            )}
            {/* RQ5: the SRS 검증 column is how it is checked, not a criterion. */}
            {!!data.verify?.length && (
              <p className="mt-6" data-testid="spec-detail-verify">
                <span className="rq-muted">{t('reqs.verify')} · </span>
                {data.verify.join(' · ')}
              </p>
            )}
          </section>
          <section className="rq-sec" data-testid="reqs-issues">
            <h3>
              {t('reqs.issues')} <span className="rq-muted">{issueEdges.length}</span>
            </h3>
            {!issueEdges.length && <p className="rq-muted">{t('reqs.issues.none')}</p>}
            <ul>
              {issueEdges.map((e) => {
                const n = otherOf(e)!;
                const st = Object.keys(n.state?.work?.byStatus ?? {})[0] ?? '';
                const how = HOW_OF[e.status];
                return (
                  <li
                    key={e.id}
                    className="rq-card"
                    data-guess={how === 'guess' || undefined}
                    data-testid="reqs-issue"
                    data-id={n.id}
                    data-status={e.status}
                  >
                    <div className="flex items-center gap-8 min-w-0">
                      <button
                        type="button"
                        className="rq-mono rq-b underline shrink-0"
                        title={t('reqs.issues.open', { id: n.id })}
                        onClick={() => openTab('tasks', `status:${st}`)}
                        data-testid="spec-link-open"
                      >
                        {n.id}
                      </button>
                      <span className="rq-ell rq-grow">{n.title}</span>
                      {st && (
                        <span
                          className="rq-pill"
                          data-issue={ISSUE_ACTIVE.has(st) || undefined}
                          data-s={st === 'done' ? 'done' : undefined}
                        >
                          {t(`tasks.status.${st}` as TranslationKey)}
                        </span>
                      )}
                    </div>
                    {how && (
                      <div className="flex flex-wrap items-center gap-6 mt-6">
                        <Src k={how} />
                        <span className="rq-muted rq-grow">
                          {how === 'written'
                            ? t('spec.edge.where', { where: sourceText(e.source) || n.id })
                            : e.reason && t('spec.edge.why', { reason: e.reason })}
                        </span>
                        {yesNo(e)}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
          <section className="rq-sec" data-testid="reqs-seen">
            <h3>
              {t('reqs.seen')}{' '}
              <span className="rq-muted">{seenEdges.length + (reported ? 1 : 0)}</span>
            </h3>
            {!seenEdges.length && !reported && (
              <p className="rq-muted">{t('reqs.seen.none', { id: label })}</p>
            )}
            <ul>
              {seenEdges.map((e) => {
                const n = otherOf(e);
                const how = HOW_OF[e.status];
                const gone = n?.state?.freshness === 'missing';
                const deployable =
                  e.status === 'confirmed' &&
                  e.kind === 'deploy' &&
                  n?.type === 'job' &&
                  s?.evidence?.deploy !== 'observed';
                return (
                  <li
                    key={e.id}
                    className="rq-ev"
                    data-guess={how === 'guess' || undefined}
                    data-testid="reqs-seen-row"
                    data-rel={e.rel}
                    data-status={e.status}
                  >
                    <Icon
                      name={e.rel === 'changes' ? 'git-branch' : 'play'}
                      size={16}
                      pixel={e.rel === 'changes' ? '*' : '>'}
                    />
                    <span className="rq-grow min-w-0">
                      <span className="block">
                        <span className="rq-b">
                          {t(e.rel === 'changes' ? 'reqs.seen.commit' : 'reqs.seen.run')}
                        </span>{' '}
                        <span className="rq-mono">{n?.label ?? e.to}</span>{' '}
                        <span className="break-words">{n?.title}</span>
                      </span>
                      {how === 'guess' && e.reason && (
                        <span className="rq-muted">{t('reqs.seen.via', { id: e.reason })}</span>
                      )}
                      {how === 'written' && (
                        <span className="rq-muted">
                          {t('spec.edge.where', { where: sourceText(e.source) })}
                        </span>
                      )}
                    </span>
                    <span className="inline-flex flex-wrap items-center justify-end gap-6 shrink-0">
                      {how && <Src k={how} />}
                      <Src
                        k={
                          gone
                            ? 'gone'
                            : e.kind === 'deploy' && s?.evidence?.deploy !== 'observed'
                              ? 'notDeploy'
                              : 'seen'
                        }
                      />
                      {yesNo(e)}
                      {canAct && deployable && (
                        <Button size="sm" data-testid="spec-deploy" onClick={() => setDeploy(n)}>
                          {t('spec.detail.deploy')}
                        </Button>
                      )}
                    </span>
                  </li>
                );
              })}
              {!!reported && (
                <li className="rq-ev" data-testid="reqs-seen-reported">
                  <Icon name="flag" size={16} pixel="!" />
                  <span className="rq-grow">{t('reqs.seen.reported', { count: reported })}</span>
                  <Src k="reported" />
                </li>
              )}
              {(!!seenEdges.length || !!reported) && !runs && (
                <li className="rq-ev rq-muted">
                  <Icon name="play" size={16} pixel=">" />
                  {t('reqs.why.noRun')}
                </li>
              )}
            </ul>
          </section>
          {actions && <div className={mobile ? 'rq-bar' : 'rq-acts'}>{actions}</div>}
          {linking && (
            <AddLink
              project={project}
              uid={uid}
              only="task"
              onDone={() => (setLinking(false), done())}
            />
          )}
          <details className="rq-fold" data-testid="reqs-more">
            <summary>{t('reqs.more')} ›</summary>
            <div className="space-y-6">
              {[...observedBy].map(([src, es]) =>
                es.length < 2 ? null : (
                  <div
                    key={src}
                    className="flex flex-wrap items-center gap-8"
                    data-testid="spec-bulk"
                    data-count={es.length}
                  >
                    <span className="flex-1">
                      {t('spec.detail.bulk', { source: t(src), count: es.length })}
                    </span>
                    {canAct && (
                      <Button
                        size="sm"
                        data-testid="spec-confirm-all"
                        onClick={() => act(traceWrite.confirm(project, es.map(key)))}
                      >
                        {t('spec.detail.confirmAll')}
                      </Button>
                    )}
                  </div>
                ),
              )}
              {RELS.map((rel) => {
                const list = moreEdges.filter((e) => e.rel === rel);
                if (!list.length) return null;
                return (
                  <div key={rel} data-testid="spec-rel" data-rel={rel}>
                    <p className="rq-muted mb-2">{t(`spec.rel.${rel}`)}</p>
                    <ul className="space-y-4">
                      {list.map((e) => (
                        <LinkChip key={e.id} project={project} e={e} other={otherOf(e)} act={act} />
                      ))}
                    </ul>
                  </div>
                );
              })}
              {canAct && (
                <Button
                  size="sm"
                  aria-expanded={adding}
                  onClick={() => setAdding((a) => !a)}
                  data-testid="spec-add"
                >
                  {t('spec.detail.add')}
                </Button>
              )}
              {adding && (
                <AddLink project={project} uid={uid} onDone={() => (setAdding(false), done())} />
              )}
            </div>
          </details>
          <details className="rq-fold" data-testid="reqs-mine">
            <summary>
              {t('reqs.mine')} › <span>{acceptanceText(s)}</span>
            </summary>
            <AcceptPanel
              key={uid}
              project={project}
              uid={uid}
              version={data.version}
              s={s}
              records={data.acceptance ?? []}
              act={act}
              reload={reload}
              fresh={fresh}
              onRecorded={(a) => {
                setRecorded((r) => ({ uid, state: a, n: (r?.n ?? 0) + 1 }));
                if (a === 'accepted') void playDoneSound();
              }}
            />
          </details>
          <details className="rq-fold" data-testid="reqs-history">
            <summary>{t('reqs.history')} ›</summary>
            <div>
              {!data.history?.length && <p className="rq-muted">{t('spec.detail.noHistory')}</p>}
              <ul className="space-y-2" data-testid="spec-history">
                {data.history?.map((h, i) => (
                  <li key={i} className="min-w-0 break-words">
                    <span className="rq-muted">{timeAgo(h.at)} · </span>
                    {h.kind === 'acceptance'
                      ? t('spec.accept.hist')
                      : t(`spec.hist.${h.kind}`)}:{' '}
                    {h.kind === 'acceptance' &&
                    (ACCEPTANCES as readonly string[]).includes(h.action)
                      ? t(`spec.acc.${h.action as Acceptance}`)
                      : KNOWN_ACTIONS.has(h.action)
                        ? t(`spec.hist.${h.action}` as TranslationKey)
                        : h.action}
                    {h.detail && <span className="rq-mono"> {h.detail}</span>}
                    {h.by && <span className="rq-muted"> · {whoText(h.by)}</span>}
                  </li>
                ))}
              </ul>
            </div>
          </details>
        </>
      )}
      {making && node && (
        <IssueDialog
          project={project}
          uid={uid}
          title={[node.label, node.title]
            .filter(Boolean)
            .join(' ')
            .slice(0, SPEC_ISSUE_TITLE_SHOWN)}
          note={
            node.source?.path
              ? t('reqs.issue.lineNote', {
                  doc: baseName(node.source.path),
                  line: node.source.line ?? 0,
                })
              : ''
          }
          onClose={() => setMaking(false)}
          onDone={() => (setMaking(false), done())}
        />
      )}
      {deploy && (
        <DeployConfirm
          project={project}
          job={deploy}
          onClose={() => setDeploy(null)}
          onDone={() => (setDeploy(null), done())}
        />
      )}
    </aside>
  );
  // A phone's Dock page may transform its pages: full screen means on the body, like Modal.
  return mobile ? createPortal(panel, document.body) : panel;
}
const KNOWN_ACTIONS = new Set([
  'created',
  'moved',
  'renamed',
  'textChanged',
  'confirmed',
  'rejected',
  'added',
  'edited',
  'unlinked',
  'reviewed',
  'deployConfirmed',
]);
