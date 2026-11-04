/**
 * SPT-P3-GRAPH (SPT §6.4): one requirement's detail, the right side of 그래프 and 요구사항 (full
 * screen on a phone). Header with [원본 열기], the four states, the links grouped by rel (confirmed
 * chips; observed with a '관측' tag and source; suggested dashed with the reason; [확인]·[아님];
 * [모두 확인] per source; [연결 검토함]; [연결 추가] pickers; 배포 확인 on a deploy job) and history.
 * SPT-P3-ACCEPT: 원문 (Markdown), 인수 기준, 수용 판정 per version with its history, the 최신 row's
 * branches. No React Flow here (the 요구사항 tab uses it).
 * GAME-UI-1 G2 (cockpit 11): the current version's 수락 is a gold stamp beside [원본 열기] (dropped,
 * with the panel's 2px thunk, only when this panel's own write came back; else already there),
 * 반려 a quiet dashed stamp with its memo; none on a read-only screen, none on a failed or stale write.
 */
import '../../i18n/specStrings.js';
import './score.css';

import { type ReactNode, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

import type {
  Acceptance,
  LinkRel,
  TraceAcceptance,
  TraceEdge,
  TraceNode,
  TraceState,
} from '../../../../core/src/cld/spec/trace.js';
import { Button } from '../../components/ui/Button.js';
import { Modal } from '../../components/ui/Modal.js';
import { SPEC_ACCEPT_NOTE_MAX, SPEC_DIALOG_Z, SPEC_SEARCH_WAIT_MS } from '../../constants.js';
import { t, type TranslationKey } from '../../i18n/index.js';
import { playDoneSound } from '../../notificationSound.js';
import { timeAgo } from '../format.js';
import { Led, LedLegend, Stamp } from '../game/parts.js';
import { Markdown } from '../markdown.js';
import { cldToast } from '../officeStore.js';
import { useCanAct } from '../workbench/workbenchStore.js';
import { Digits } from './Digits.js';
import { rememberViewed } from './overviewModel.js';
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
import {
  AXIS_TEXT,
  EVIDENCE_AXES,
  evidenceReason,
  ledOf,
  openSource,
  shortDate,
  sourceText,
  whoText,
  workText,
} from './traceModel.js';

const muted = 'text-text-muted text-xs';

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
const selectCls = 'bg-bg border-2 border-border px-4 py-2 text-xs pointer-coarse:min-h-44 min-w-0';
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
function State({
  label,
  children,
  testId,
}: {
  label: string;
  children: ReactNode;
  testId: string;
}) {
  return (
    <div className="flex gap-8 min-w-0 py-2" data-testid={testId}>
      <span className="text-text-muted shrink-0 w-[5rem]">{label}</span>
      <span className="min-w-0 flex-1 break-words">{children}</span>
    </div>
  );
}

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
/** '재검토 필요 · 연결 재검토 · 수용 재검토': which branch is open. */
const freshnessText = (s?: TraceState) =>
  !s?.freshness
    ? '–'
    : [
        t(`spec.fresh.${s.freshness}`),
        ...(s.freshness === 'review'
          ? [
              s.linkReview && t('spec.accept.linkReview'),
              s.acceptanceReview && t('spec.accept.acceptanceReview'),
            ]
          : []),
      ]
        .filter(Boolean)
        .join(' · ');

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
    <section className="border-2 border-border p-6 space-y-6" data-testid="spec-accept">
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
                  cldToast(t('spec.accept.title'), t('spec.accept.changed'), 'error');
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
        <p className="rej-stamp" data-fresh={fresh === 'rejected' || undefined} data-testid="spec-reject-stamp">
          <b>{t('spec.acc.rejected')}</b>
          {rejected.note && <small>{rejected.note}</small>}
        </p>
      )}
    </section>
  );
}

function AddLink({ project, uid, onDone }: { project: string; uid: string; onDone: () => void }) {
  const [type, setType] = useState<PickType>('task');
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
            live && (setList([]), cldToast(t('spec.detail.add'), err.message, 'error')),
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
      .then(onDone, (err: Error) => cldToast(t('spec.detail.add'), err.message, 'error'));
  return (
    <div className="border-2 border-border p-6 space-y-6" data-testid="spec-add-link">
      <div className="flex flex-wrap gap-6">
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
                  cldToast(t('spec.detail.deploy'), err.message, 'error'),
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
      className={`border-2 ${border} border-border px-6 py-4 min-w-0 ${e.status === 'rejected' ? 'opacity-50' : ''}`}
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
          <span className="border-2 border-border px-2 text-xs">{t(`spec.link.${e.status}`)}</span>
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
            reason: e.rel === 'realizes' && e.reason === 'label' ? t('spec.p4c.whyLabel') : e.reason,
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

export function ReqDetail({
  project,
  uid,
  mobile,
  onClose,
  onChanged,
}: {
  project: string;
  uid: string;
  mobile: boolean;
  onClose: () => void;
  onChanged?: () => void;
}) {
  const { data, error, reload } = useTrace<TraceItem>(project, itemPath(uid));
  // SPT-P3-OVERVIEW: the 개요's 최근 본 요구사항.
  const shownLabel = data?.node.label;
  useEffect(() => {
    if (shownLabel) rememberViewed(project, { uid, label: shownLabel });
  }, [project, uid, shownLabel]);
  const [adding, setAdding] = useState(false);
  const [deploy, setDeploy] = useState<TraceNode | null>(null);
  // GAME-UI-1: what this panel just recorded (and how many times, for the thunk to replay).
  const [recorded, setRecorded] = useState<{ uid: string; state: Acceptance; n: number } | null>(null);
  const canAct = useCanAct();
  const done = () => {
    cldToast(t('spec.detail.title'), t('spec.done'), 'ok');
    reload();
    onChanged?.();
  };
  const act = (p: Promise<unknown>) =>
    void p.then(done, (err: Error) => cldToast(t('spec.detail.title'), err.message, 'error'));
  const shell = mobile
    ? 'fixed inset-0 bg-bg overflow-y-auto pt-[calc(var(--cld-safe-top)+8px)] pb-[calc(var(--cld-safe-bottom)+8px)] px-8'
    : 'pixel-panel w-[min(380px,100%)] shrink-0 self-start sticky top-0 max-h-[80vh] overflow-y-auto';
  const node = data?.node;
  const s = node?.state;
  const nodes = new Map((data?.nodes ?? []).map((n) => [n.id, n] as const));
  const otherOf = (e: TraceEdge) => nodes.get(e.from === uid ? e.to : e.from);
  const edges = data?.edges ?? [];
  const tasks = edges
    .filter((e) => e.status === 'confirmed' && e.rel === 'implements')
    .map(otherOf)
    .filter((n): n is TraceNode => n?.type === 'task');
  const observedBy = new Map<TranslationKey, TraceEdge[]>();
  for (const e of edges)
    if (e.status === 'observed')
      observedBy.set(sourceKind(e, otherOf(e)), [
        ...(observedBy.get(sourceKind(e, otherOf(e))) ?? []),
        e,
      ]);
  const w = s?.work;
  const current = s?.acceptance?.current;
  // The stamp is new only once the reloaded detail shows what this panel recorded.
  const fresh = recorded?.uid === uid && recorded.state === current ? recorded.state : null;
  const acceptedBy = current === 'accepted' ? data?.acceptance?.find((a) => a.current) : undefined;
  const panel = (
    <aside
      className={`${shell} text-xs p-8 space-y-8 min-w-0`}
      data-thunk={fresh === 'accepted' ? (recorded!.n % 2 ? 'a' : 'b') : undefined}
      style={mobile ? { zIndex: SPEC_DIALOG_Z } : undefined}
      aria-label={t('spec.detail.title')}
      data-testid="spec-detail"
      data-uid={uid}
    >
      <div className="flex items-start gap-8 min-w-0">
        <div className="min-w-0 flex-1">
          <p className="font-mono text-sm break-all" data-testid="spec-detail-id">
            {node?.label ?? uid}
          </p>
          {node?.title && <p className="break-words">{node.title}</p>}
          {node?.source?.path && (
            <p className={`${muted} break-all`}>
              {node.source.path}
              {node.source.line ? ` · ${t('spec.reqs.line', { line: node.source.line })}` : ''}
            </p>
          )}
        </div>
        <Button
          variant="ghost"
          size="icon_md"
          aria-label={t('spec.graph.close')}
          onClick={onClose}
          data-testid="spec-detail-close"
        >
          x
        </Button>
      </div>
      {error && (
        <p className="text-red-400" role="alert">
          {error}
        </p>
      )}
      {!data && !error && <p className={muted}>{t('spec.wizard.loading')}</p>}
      {data && (
        <>
          {(node?.source?.path || (canAct && acceptedBy)) && (
            <div className="acc-row">
              {node?.source?.path && (
                <Button
                  size="sm"
                  onClick={() => openSource(project, node.source)}
                  data-testid="spec-detail-open"
                >
                  {t('spec.detail.openSource')}
                </Button>
              )}
              {canAct && acceptedBy && (
                <span
                  className="acc-stamp"
                  key={fresh ? `n${recorded!.n}` : 'still'}
                  // Clicked at the panel's foot, the stamp lands at its head: show the head as it drops.
                  ref={fresh ? (el) => el?.closest('aside')?.scrollTo({ top: 0 }) : undefined}
                  data-testid="spec-accept-stamp"
                  data-fresh={!!fresh || undefined}
                >
                  <Stamp tone="gold" still={!fresh} sub={[shortDate(acceptedBy.at).slice(0, 5).replace('-', '.'), whoText(acceptedBy.by)].filter(Boolean).join(' · ')}>
                    {t('spec.acc.accepted')}
                  </Stamp>
                  {fresh && [0, 1, 2, 3].map((i) => <i key={i} className="acc-dust" data-i={i} aria-hidden="true" />)}
                </span>
              )}
            </div>
          )}
          <section className="border-2 border-border p-6 min-w-0" data-testid="spec-detail-text">
            <h3 className="text-sm mb-4">{t('spec.accept.text')}</h3>
            {data.text !== undefined ? (
              <TextView text={data.text} />
            ) : (
              <p className={muted}>{t('spec.accept.noText')}</p>
            )}
          </section>
          {!!data.criteria?.length && (
            <section className="border-2 border-border p-6" data-testid="spec-detail-criteria">
              <h3 className="text-sm mb-4">{t('spec.accept.criteria')}</h3>
              <ul className="list-disc pl-20 space-y-2">
                {data.criteria.map((c, i) => (
                  <li key={i} className="break-words">
                    {c}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section className="border-2 border-border p-6">
            <State label={t('spec.detail.work')} testId="spec-detail-work">
              {w?.total ? (
                <Digits text={`${t('spec.detail.workCount', { count: w.total })}: ${workText(s)}`} />
              ) : (
                t('spec.detail.noWork')
              )}
              {tasks.length > 0 && (
                <span className="flex flex-wrap gap-4 mt-2">
                  {tasks.map((n) => (
                    <span
                      key={n.id}
                      className="border-2 border-border px-4 font-mono"
                      data-testid="spec-task-chip"
                    >
                      {n.label}
                    </span>
                  ))}
                </span>
              )}
            </State>
            <State label={t('spec.detail.evidence')} testId="spec-detail-evidence">
              <span className="flex flex-wrap gap-x-8 gap-y-2">
                {[...EVIDENCE_AXES.map((k) => [k, ledOf(s?.evidence?.[k])] as const), ['reported', s?.evidence?.reported ? 'half' : 'off'] as const].map(([k, led]) => (
                  <span key={k} data-axis={k} data-led={led} className="inline-flex items-center gap-6">
                    <Led state={led} reason={evidenceReason(k, led)} />
                    {t(AXIS_TEXT[k])}
                  </span>
                ))}
              </span>
              <span className="block mt-2">
                <LedLegend compact />
              </span>
            </State>
            <State label={t('spec.detail.acceptance')} testId="spec-detail-acceptance">
              {acceptanceText(s)}
            </State>
            <State label={t('spec.detail.freshness')} testId="spec-detail-freshness">
              {freshnessText(s)}
            </State>
          </section>
          {s?.linkReview && (
            <div
              className="border-2 border-dashed border-border p-6 flex flex-wrap items-center gap-8"
              data-testid="spec-link-review"
            >
              <span className="flex-1 min-w-[8rem]">{t('spec.detail.reviewHint')}</span>
              <Button
                size="sm"
                variant="active"
                data-testid="spec-review"
                onClick={() => act(traceWrite.review(project, uid))}
              >
                {t('spec.detail.review')}
              </Button>
            </div>
          )}
          <section className="space-y-6">
            <h3 className="text-sm">{t('spec.detail.links')}</h3>
            {!edges.length && <p className={muted}>{t('spec.detail.noLinks')}</p>}
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
                  <Button
                    size="sm"
                    data-testid="spec-confirm-all"
                    onClick={() =>
                      act(
                        traceWrite.confirm(
                          project,
                          es.map((e) => ({
                            from: e.from,
                            to: e.to,
                            rel: e.rel,
                            ...(e.kind && { kind: e.kind }),
                          })),
                        ),
                      )
                    }
                  >
                    {t('spec.detail.confirmAll')}
                  </Button>
                </div>
              ),
            )}
            {RELS.map((rel) => {
              const list = edges.filter((e) => e.rel === rel);
              if (!list.length) return null;
              return (
                <div key={rel} data-testid="spec-rel" data-rel={rel}>
                  <p className="text-text-muted mb-2">{t(`spec.rel.${rel}`)}</p>
                  <ul className="space-y-4">
                    {list.map((e) => {
                      const other = otherOf(e);
                      const deployable =
                        e.status === 'confirmed' &&
                        e.kind === 'deploy' &&
                        other?.type === 'job' &&
                        s?.evidence?.deploy !== 'observed';
                      return (
                        <LinkChip
                          key={e.id}
                          project={project}
                          e={e}
                          other={other}
                          act={act}
                          onDeploy={deployable ? () => setDeploy(other) : undefined}
                        />
                      );
                    })}
                  </ul>
                </div>
              );
            })}
            <Button
              size="sm"
              aria-expanded={adding}
              onClick={() => setAdding((a) => !a)}
              data-testid="spec-add"
            >
              {t('spec.detail.add')}
            </Button>
            {adding && (
              <AddLink project={project} uid={uid} onDone={() => (setAdding(false), done())} />
            )}
          </section>
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
          <section>
            <h3 className="text-sm mb-4">{t('spec.detail.history')}</h3>
            {!data.history?.length && <p className={muted}>{t('spec.detail.noHistory')}</p>}
            <ul className="space-y-2" data-testid="spec-history">
              {data.history?.map((h, i) => (
                <li key={i} className="min-w-0 break-words">
                  <span className={muted}>{timeAgo(h.at)} · </span>
                  {h.kind === 'acceptance' ? t('spec.accept.hist') : t(`spec.hist.${h.kind}`)}:{' '}
                  {h.kind === 'acceptance' && (ACCEPTANCES as readonly string[]).includes(h.action)
                    ? t(`spec.acc.${h.action as Acceptance}`)
                    : KNOWN_ACTIONS.has(h.action)
                      ? t(`spec.hist.${h.action}` as TranslationKey)
                      : h.action}
                  {h.detail && <span className="font-mono"> {h.detail}</span>}
                  {h.by && <span className={muted}> · {whoText(h.by)}</span>}
                </li>
              ))}
            </ul>
          </section>
        </>
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
