/**
 * SPT-P1A/P1B: the 현황판's 요구사항 and 문서 tabs, the 명세 추적 card and its 켜기 window, one lazy
 * chunk (the 개요 is Overview.tsx, SPT-P3-OVERVIEW, built on this card and useSpec).
 * 요구사항 lists the tracked documents' items (by display ID, or 문서 · 절 without one) with the four
 * states (SPT-P3: 작업, 근거, 수용, 최신), a row opens the requirement detail (ReqDetail); 문서 lists
 * the tracked documents with their UIDs, extraction switches and the 확인할 것 alerts, and (SPT-P1C) 같은 항목 확인
 * with the old-text diff, 확인 권장, 최근 판정 with 나누기/합치기, 참조만 하는 표 and 민감. Fetched when shown and
 * again on `specChanged`, never polled.
 */
import '../../i18n/specStrings.js';

import { useEffect, useMemo, useState } from 'react';

import type { TraceAcceptanceWeek } from '../../../../core/src/cld/spec/trace.js';
import { Button } from '../../components/ui/Button.js';
import { Modal } from '../../components/ui/Modal.js';
import { SPEC_DEPTH_MAX, SPEC_DIALOG_Z, SPEC_SEARCH_WAIT_MS, SPEC_UID_SHOWN } from '../../constants.js';
import { t, type TranslationKey } from '../../i18n/index.js';
import { writeClipboardText } from '../../terminal/clipboard.js';
import { openProjectFile } from '../files/explorerState.js';
import { timeAgo } from '../format.js';
import { Led } from '../game/parts.js';
import { cldToast } from '../officeStore.js';
import { serverText } from '../serverText.js';
import { tabFocus, useCanAct, useNow } from '../workbench/workbenchStore.js';
import { Digits } from './Digits.js';
import { showText } from './overviewModel.js';
import { ReqDetail } from './ReqDetail.js';
import { useSpecRev } from './specStore.js';
import type { ItemTrace } from './traceApi.js';
import { EVIDENCE_AXES, evidenceReason, ledOf, workText } from './traceModel.js';
import { wordDiff } from './wordDiff.js';

type Axis = 'change' | 'integration' | 'test' | 'deploy';
const KINDS = ['requirements', 'design', 'decision', 'test', 'task', 'plan', 'other', 'log'] as const;
type Kind = (typeof KINDS)[number];
type Git = 'committed' | 'modified' | 'untracked' | 'ignored' | 'not-git';
const GIT_KEY: Record<Git, TranslationKey> = {
  committed: 'spec.git.committed',
  modified: 'spec.git.modified',
  untracked: 'spec.git.untracked',
  ignored: 'spec.git.ignored',
  'not-git': 'spec.git.notGit',
};
const kindText = (k: Kind) => t(`spec.kind.${k}`);
const MODES = ['auto', 'headings', 'off', 'refs'] as const;
type Mode = (typeof MODES)[number];
const DEPTHS = Array.from({ length: SPEC_DEPTH_MAX }, (_, i) => i + 1);

export interface Summary {
  enabled: boolean;
  corrupt?: boolean;
  candidates?: number;
  docs?: { total: number; byKind: Partial<Record<Kind, number>>; byGit: Partial<Record<Git, number>> };
  items?: { total: number; byKind: Partial<Record<Kind, number>> };
  alerts?: number;
  questions?: number;
  review?: number;
  /** SPT §2.8: orphaned Registries this project may be (offered only). */
  inherit?: Offer[];
  // SPT-P2 and SPT-P3-OVERVIEW: the 개요's counts (tracking on); SPT-P3-ACCEPT adds `acceptance`.
  unlinked?: number;
  linkReview?: number;
  missing?: number;
  observedOnly?: number;
  reviewNeeded?: number;
  newDocs?: number;
  evidence?: Record<Axis, number>;
  evidenceReported?: Record<Axis, number>;
  work?: { linked: number; total: number };
  acceptance?: { none: number; validate: number; accepted: number; rejected: number; review: number };
  /** GAME-UI-1: 이번 주 수락 (tracking on). */
  week?: TraceAcceptanceWeek;
  git: { branch: string | null; head: string | null; recent: Array<{ sha: string; subject: string; time: string }> };
}
interface Offer {
  from: string;
  name: string;
  items: number;
  docs: number;
  lastSeenAt: string;
  why: 'samePath' | 'moved' | 'remote' | 'history' | 'docs';
  share?: number;
}
interface Candidate {
  path: string;
  kind: Kind;
  git: Git;
  preselect: boolean;
}
interface DocRow {
  uid: string;
  path: string;
  kind: Kind;
  mode: Mode;
  depth: number;
  tracked: boolean;
  state: 'active' | 'retired' | 'unresolved';
  git: Git;
  changedAt: string;
  size: number;
  mtimeMs: number;
  fresh: boolean;
  sensitive: boolean;
  items: number;
}
type DocRef = { uid: string; path: string };
type Alert =
  | { type: 'duplicateIds'; docs: DocRef[]; repeater?: DocRef; count: number; ids: string[]; places: Array<{ uid: string; doc: string; line: number }> }
  | { type: 'newDoc'; uid: string; path: string }
  | { type: 'revived'; count: number; places: Place[] }
  | ({ type: 'maybeSame'; cand: Place & { score: number } } & Place);
type Place = { uid: string; displayId?: string; doc: string; line: number };
type Why = 'text' | 'title' | 'sameDoc' | 'neighbours' | 'sameId' | 'retired' | 'content' | 'path';
interface QCand {
  uid: string;
  score: number;
  why: Why[];
  displayId?: string;
  doc: string;
  line?: number;
  state: string;
  text?: string;
}
type Question =
  | { kind: 'item' | 'reuse'; uid: string; displayId?: string; title: string; doc: string; line: number; text?: string; cands: QCand[] }
  | { kind: 'doc'; uid: string; doc: string; items: number; cands: QCand[] };
interface ReviewRow {
  uid: string;
  displayId?: string;
  title: string;
  doc: string;
  line: number;
  score: number;
}
type How = 'T1' | 'T1n' | 'T2' | 'T2r' | 'T3' | 'new' | 'unresolved' | 'reuse' | 'retired' | 'owner-same' | 'owner-new' | 'owner-split' | 'owner-merge' | 'owner-ok';
interface DecisionRow {
  uid: string;
  how: How;
  score?: number;
  by: 'engine' | 'owner';
  at: string;
  displayId?: string;
  title: string;
  doc: string;
  line: number;
  canSplit: boolean;
  mergeInto?: Array<{ uid: string; displayId?: string; doc: string; line: number }>;
}
interface ItemRow {
  uid: string;
  displayId?: string;
  title: string;
  section: string;
  doc: string;
  docUid: string;
  kind: Kind;
  state: 'active' | 'retired' | 'unresolved';
  line: number;
  /** SPT-P3: the four states (P2 adds them to the list). */
  trace?: ItemTrace;
}

const muted = 'text-text-muted text-xs';
const selectCls = 'bg-bg border border-border px-4 py-2 text-xs pointer-coarse:min-h-44 min-w-0';
const baseName = (p: string) => p.split('/').pop() ?? p;
/** Open a tracked document in the 파일 tab (the 문서 list's size and time, when it has them). */
const openDoc = (project: string, rel: string, d?: DocRow) =>
  openProjectFile(project, { name: baseName(rel), path: rel, kind: 'file', size: d?.size ?? 0, mtime: d?.mtimeMs ?? 0 });
const base = (project: string) => `/api/cld/spec/${encodeURIComponent(project)}`;

async function call<T>(project: string, route: string, body?: object): Promise<T> {
  const r = await fetch(`${base(project)}/${route}`, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...(body && { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const json = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(serverText(json, t('spec.error', { why: r.status })));
  return json;
}

/** `route`'s answer, fetched while mounted and again when the project's Registry changes (only while the page is shown); with `wait`, once a burst of changes settles. */
// eslint-disable-next-line react-refresh/only-export-components -- shared with Overview.tsx in the same lazy chunk
export function useSpec<T>(project: string, route: string, wait = 0): { data: T | null; error: string; reload: () => void } {
  const live = useSpecRev(project);
  const settled = useSettled(live, wait);
  const rev = wait ? settled : live;
  const [n, setN] = useState(0);
  const [state, setState] = useState<{ data: T | null; error: string }>({ data: null, error: '' });
  useEffect(() => {
    let live = true;
    const load = () =>
      call<T>(project, route).then(
        (data) => live && setState({ data, error: '' }),
        (err: Error) => live && setState((s) => ({ ...s, error: err.message })),
      );
    if (!document.hidden) void load();
    else {
      const onShow = () => {
        if (document.hidden) return;
        document.removeEventListener('visibilitychange', onShow);
        void load();
      };
      document.addEventListener('visibilitychange', onShow);
      return () => {
        live = false;
        document.removeEventListener('visibilitychange', onShow);
      };
    }
    return () => {
      live = false;
    };
  }, [project, route, rev, n]);
  return { ...state, reload: () => setN((x) => x + 1) };
}

export function Tag({ children, testId }: { children: string; testId?: string }) {
  return (
    <span className="border border-border px-4 text-xs shrink-0" data-testid={testId}>
      {children}
    </span>
  );
}

const counts = <K extends string>(m: Partial<Record<K, number>>, label: (k: K) => string) =>
  (Object.entries(m) as Array<[K, number]>).map(([k, n]) => `${label(k)} ${n}`).join(' · ');

// ── 켜기 window ─────────────────────────────────────────

function EnableDialog({ project, onClose }: { project: string; onClose: () => void }) {
  const [list, setList] = useState<{ docs: Candidate[]; capped: boolean } | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ docs: number; byKind: Partial<Record<Kind, number>> } | null>(null);
  useEffect(() => {
    let live = true;
    call<{ docs: Candidate[]; capped: boolean }>(project, 'candidates').then(
      (r) => {
        if (!live) return;
        setList(r);
        setPicked(new Set(r.docs.filter((d) => d.preselect).map((d) => d.path)));
      },
      (err: Error) => live && setError(err.message),
    );
    return () => {
      live = false;
    };
  }, [project]);
  const toggle = (p: string) =>
    setPicked((s) => {
      const next = new Set(s);
      if (!next.delete(p)) next.add(p);
      return next;
    });
  const confirm = () => {
    setBusy(true);
    call<{ docs: number; byKind: Partial<Record<Kind, number>> }>(project, 'enable', { docs: [...picked] })
      .then(setDone, (err: Error) => setError(err.message))
      .finally(() => setBusy(false));
  };
  return (
    <Modal isOpen onClose={onClose} title={t('spec.wizard.title')} zIndex={SPEC_DIALOG_Z}>
      <div className="flex flex-col gap-8 px-10 pb-10 w-[min(560px,calc(100vw-32px))] max-h-[70vh] text-xs" data-testid="spec-wizard">
        {error && (
          <p className="text-red-400 break-words" role="alert">
            {error}
          </p>
        )}
        {done ? (
          <>
            <p data-testid="spec-wizard-done">{t('spec.wizard.done', { count: done.docs })}</p>
            <p className={muted}>{counts(done.byKind, kindText)}</p>
            <div className="flex justify-end">
              <Button size="sm" variant="active" onClick={onClose}>
                {t('spec.wizard.close')}
              </Button>
            </div>
          </>
        ) : !list ? (
          !error && <p className={muted}>{t('spec.wizard.loading')}</p>
        ) : (
          <>
            {list.capped && <p className={muted}>{t('spec.wizard.capped')}</p>}
            {list.docs.length === 0 && <p className={muted}>{t('spec.wizard.none')}</p>}
            <div className="overflow-y-auto min-h-0 space-y-8">
              {KINDS.map((k) => {
                const docs = list.docs.filter((d) => d.kind === k);
                if (!docs.length) return null;
                return (
                  <section key={k}>
                    <h3 className="text-accent-text mb-4">
                      {kindText(k)} {docs.length}
                    </h3>
                    <ul className="space-y-2">
                      {docs.map((d) => (
                        <li key={d.path} data-testid="spec-candidate" data-path={d.path} data-git={d.git}>
                          <label className="flex items-center gap-6 min-w-0 pointer-coarse:min-h-44">
                            <input type="checkbox" checked={picked.has(d.path)} onChange={() => toggle(d.path)} />
                            <span className="break-all min-w-0 flex-1">{d.path}</span>
                            <Tag>{t(GIT_KEY[d.git])}</Tag>
                          </label>
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              })}
            </div>
            <div className="flex justify-end gap-8">
              <Button size="sm" onClick={onClose}>
                {t('spec.wizard.cancel')}
              </Button>
              <Button size="sm" variant="active" disabled={busy || picked.size === 0} onClick={confirm} data-testid="spec-wizard-confirm">
                {t('spec.wizard.confirm', { count: picked.size })}
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

/** 이어받기 (SPT §2.8): each orphaned Registry this project may be, with its evidence; nothing moves until the owner picks. */
function InheritOffers({ project, offers }: { project: string; offers: Offer[] }) {
  const canAct = useCanAct();
  const now = useNow();
  const [busy, setBusy] = useState(false);
  const answer = (from: string, ans: 'accept' | 'dismiss') => {
    setBusy(true);
    call<{ items: number }>(project, 'inherit', { from, answer: ans })
      .then(
        (r) => cldToast(t('spec.card.title'), ans === 'accept' ? t('spec.inherit.done', { count: r.items }) : t('spec.done'), 'ok'),
        (err: Error) => cldToast(t('spec.card.title'), err.message, 'error'),
      )
      .finally(() => setBusy(false));
  };
  return (
    <div className="border-2 border-border p-6 mb-6 min-w-0" data-testid="spec-inherit">
      <p className="text-accent-text mb-4">{t('spec.inherit.title')}</p>
      <ul className="space-y-6">
        {offers.map((o) => (
          <li key={o.from} className="min-w-0" data-testid="spec-inherit-offer" data-from={o.from} data-why={o.why}>
            <p className="break-words">
              {t('spec.inherit.line', { name: o.name || t('spec.inherit.unnamed'), items: o.items, docs: o.docs, when: timeAgo(o.lastSeenAt, now) })}
            </p>
            <p className={o.why === 'history' ? 'text-accent-text' : muted} data-testid="spec-inherit-why">
              {t(`spec.inherit.why.${o.why}`, { share: Math.round((o.share ?? 0) * 100) })}
            </p>
            {canAct && (
              <div className="flex flex-wrap gap-8 mt-4">
                <Button size="sm" variant="active" disabled={busy} onClick={() => answer(o.from, 'accept')} data-testid="spec-inherit-accept">
                  {t('spec.inherit.accept')}
                </Button>
                <Button size="sm" disabled={busy} onClick={() => answer(o.from, 'dismiss')} data-testid="spec-inherit-dismiss">
                  {t('spec.inherit.dismiss')}
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      <p className={`${muted} mt-4`}>{t('spec.inherit.hint')}</p>
    </div>
  );
}

/** The 명세 추적 card: '켜기' with the count while off; documents by kind and git state while on. */
export function SpecCard({
  project,
  summary,
  onOpenDocs,
  onOpenReqs,
}: {
  project: string;
  summary: Summary;
  onOpenDocs: () => void;
  onOpenReqs: () => void;
}) {
  const canAct = useCanAct();
  const [wizard, setWizard] = useState(false);
  const [error, setError] = useState('');
  return (
    <section className="pixel-panel p-8 min-w-0 text-xs" data-testid="spec-card" data-enabled={summary.enabled}>
      <h3 className="text-accent-text mb-4">{t('spec.card.title')}</h3>
      {summary.corrupt ? (
        <p className="text-red-400" role="alert">
          {t('spec.card.corrupt')}
        </p>
      ) : summary.enabled && summary.docs ? (
        <>
          <button type="button" className="underline text-left" onClick={onOpenDocs}>
            {t('spec.card.on', { count: summary.docs.total })}
          </button>
          <p className={muted} data-testid="spec-card-kinds">
            {counts(summary.docs.byKind, kindText)}
          </p>
          <p className={muted} data-testid="spec-card-git">
            {counts(summary.docs.byGit, (g) => t(GIT_KEY[g]))}
          </p>
          {summary.items && (
            <p className="mt-4" data-testid="spec-card-items">
              <button type="button" className="underline text-left" onClick={onOpenReqs}>
                {t('spec.card.items', { count: summary.items.total })}
              </button>
              <span className={muted}> {counts(summary.items.byKind, kindText)}</span>
            </p>
          )}
          {(!!summary.questions || !!summary.review || !!summary.alerts) && (
            <p className="flex flex-wrap gap-8 mt-4">
              {!!summary.questions && (
                <button type="button" className="underline text-left" onClick={onOpenDocs} data-testid="spec-card-questions" data-count={summary.questions}>
                  {t('spec.card.questions', { count: summary.questions })}
                </button>
              )}
              {!!summary.review && (
                <button type="button" className="underline text-left" onClick={onOpenDocs} data-testid="spec-card-review" data-count={summary.review}>
                  {t('spec.card.review', { count: summary.review })}
                </button>
              )}
              {!!summary.alerts && (
                <button type="button" className="underline text-left" onClick={onOpenDocs} data-testid="spec-card-alerts" data-count={summary.alerts}>
                  {t('spec.card.alerts', { count: summary.alerts })}
                </button>
              )}
            </p>
          )}
          {canAct && (
            <div className="mt-4">
              <Button size="sm" onClick={() => call(project, 'disable', {}).catch((err: Error) => setError(err.message))}>
                {t('spec.card.turnOff')}
              </Button>
            </div>
          )}
        </>
      ) : (
        <>
          {!!summary.inherit?.length && <InheritOffers project={project} offers={summary.inherit} />}
          <p data-testid="spec-card-found">{t('spec.card.found', { count: summary.candidates ?? 0 })}</p>
          {canAct && (
            <div className="mt-4">
              <Button size="sm" variant="active" onClick={() => setWizard(true)} data-testid="spec-turn-on">
                {t('spec.card.turnOn')}
              </Button>
            </div>
          )}
        </>
      )}
      {error && (
        <p className="text-red-400 mt-4" role="alert">
          {error}
        </p>
      )}
      {wizard && <EnableDialog project={project} onClose={() => setWizard(false)} />}
    </section>
  );
}

// ── 문서 ────────────────────────────────────────────────

/** Tracking off on the 문서 tab: the same card as the 개요's. */
function OffCard({ project }: { project: string }) {
  const { data } = useSpec<Summary>(project, 'summary');
  return data ? <SpecCard project={project} summary={data} onOpenDocs={() => undefined} onOpenReqs={() => undefined} /> : null;
}

/** 확인할 것 (SPT §2.7): display IDs defined in more than one place, one line per set of documents; documents tracked by themselves. */
function Alerts({
  project,
  alerts,
  docs,
  onSeen,
  onRefs,
  act,
}: {
  project: string;
  alerts: Alert[];
  docs: DocRow[];
  onSeen: (uid: string) => void;
  onRefs: (uid: string) => void;
  act: (route: string, body: object) => void;
}) {
  const canAct = useCanAct();
  if (!alerts.length) return null;
  const docOf = (rel: string) => docs.find((d) => d.path === rel);
  return (
    <section className="pixel-panel p-8 min-w-0" data-testid="spec-alerts">
      <h3 className="text-accent-text mb-4">
        {t('spec.alert.title')} {alerts.length}
      </h3>
      <ul className="space-y-4">
        {alerts.map((a) =>
          a.type === 'duplicateIds' ? (
            <li key={`ids:${a.repeater?.uid ?? ''}:${a.docs.map((d) => d.uid).join()}`} data-testid="spec-alert" data-type={a.type} data-count={a.count}>
              <div className="flex flex-wrap items-center gap-8">
                <span className="break-all min-w-0 flex-1">
                  {a.repeater
                    ? t('spec.alert.repeats', { repeater: baseName(a.repeater.path), count: a.count, docs: a.docs.map((d) => baseName(d.path)).join(', ') })
                    : t('spec.alert.sameIds', { count: a.count, docs: a.docs.map((d) => baseName(d.path)).join(', ') })}
                </span>
                {canAct && a.repeater && (
                  <Button size="sm" onClick={() => onRefs(a.repeater!.uid)} data-testid="spec-alert-refs">
                    {t('spec.alert.refs')}
                  </Button>
                )}
              </div>
              <p className={`${muted} font-mono break-all`}>{a.ids.join(' ')}{a.count > a.ids.length ? ' …' : ''}</p>
              <ul className={muted}>
                {a.places.map((pl) => (
                  <li key={pl.uid}>
                    <button type="button" className="underline break-all text-left" onClick={() => openDoc(project, pl.doc, docOf(pl.doc))}>
                      {pl.doc} · {t('spec.reqs.line', { line: pl.line })}
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          ) : a.type === 'revived' ? (
            <li key="revived" data-testid="spec-alert" data-type={a.type} data-count={a.count}>
              <div className="flex flex-wrap items-center gap-8">
                <span className="break-all min-w-0 flex-1">{t('spec.alert.revived', { count: a.count })}</span>
                {canAct && (
                  <Button size="sm" onClick={() => act('resolve', { uid: 'revived', answer: 'seen' })} data-testid="spec-alert-revived-ok">
                    {t('spec.alert.seen')}
                  </Button>
                )}
              </div>
              <ul className={muted}>
                {a.places.map((pl) => (
                  <li key={pl.uid}>
                    <button type="button" className="underline break-all text-left" onClick={() => openDoc(project, pl.doc, docOf(pl.doc))}>
                      {itemLabel(pl)} · {pl.doc}
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          ) : a.type === 'maybeSame' ? (
            <li key={`maybe:${a.uid}`} className="flex flex-wrap items-center gap-8" data-testid="spec-alert" data-type={a.type} data-uid={a.uid}>
              <span className="break-all min-w-0 flex-1">
                {t('spec.alert.maybe', { item: itemLabel(a), cand: itemLabel(a.cand), score: a.cand.score.toFixed(2) })}
              </span>
              {canAct && (
                <>
                  <Button size="sm" onClick={() => act('resolve', { uid: a.uid, answer: 'same', target: a.cand.uid })} data-testid="spec-alert-maybe-same">
                    {t('spec.alert.maybeSame')}
                  </Button>
                  <Button size="sm" onClick={() => act('resolve', { uid: a.uid, answer: 'new' })} data-testid="spec-alert-maybe-not">
                    {t('spec.alert.maybeNot')}
                  </Button>
                </>
              )}
            </li>
          ) : (
            <li key={`doc:${a.uid}`} className="flex flex-wrap items-center gap-8" data-testid="spec-alert" data-type={a.type} data-path={a.path}>
              <span className="break-all min-w-0 flex-1">{t('spec.alert.newDoc', { path: a.path })}</span>
              {canAct && (
                <Button size="sm" onClick={() => onSeen(a.uid)}>
                  {t('spec.alert.seen')}
                </Button>
              )}
            </li>
          ),
        )}
      </ul>
    </section>
  );
}

/** An item's label: its display ID, else 문서 · line. */
const itemLabel = (x: { displayId?: string; doc: string; line?: number }) =>
  `${x.displayId ?? baseName(x.doc)}${x.line ? ` · ${t('spec.reqs.line', { line: x.line })}` : ''}`;
const whyText = (why: Why[]) => why.map((w) => t(`spec.why.${w}`)).join(' · ');

/** A candidate's old text against the current one, word by word. */
function Diff({ before, now }: { before: string; now: string }) {
  const d = useMemo(() => wordDiff(before, now), [before, now]);
  const box = 'border border-border p-4 max-h-[10rem] overflow-y-auto break-words whitespace-pre-wrap';
  return (
    <div className="grid gap-4 min-w-0" data-testid="spec-q-diff">
      <p className={box}>
        <span className={muted}>{t('spec.q.old')} </span>
        {d.old.map((x, i) => (
          <span key={i} className={x.changed ? 'line-through text-text-muted' : ''}>
            {x.text}
          </span>
        ))}
      </p>
      <p className={box}>
        <span className={muted}>{t('spec.q.now')} </span>
        {d.now.map((x, i) => (
          <span key={i} className={x.changed ? 'underline text-accent-text' : ''}>
            {x.text}
          </span>
        ))}
      </p>
    </div>
  );
}

/** 같은 항목 확인 (SPT §2.7): each open question with its candidates, evidence and answers. */
function Questions({ questions, act }: { questions: Question[]; act: (route: string, body: object) => void }) {
  const canAct = useCanAct();
  if (!questions.length) return null;
  return (
    <section className="pixel-panel p-8 min-w-0" data-testid="spec-questions">
      <h3 className="text-accent-text mb-4">
        {t('spec.q.title')} {questions.length}
      </h3>
      <ul className="space-y-8">
        {questions.map((q) => (
          <li key={q.uid} className="border-b border-border pb-8 min-w-0" data-testid="spec-question" data-kind={q.kind} data-uid={q.uid}>
            <p className="mb-4">
              {t(q.kind === 'doc' ? 'spec.q.doc' : q.kind === 'reuse' ? 'spec.q.reuse' : 'spec.q.item')}{' '}
              <span className="break-all">{q.kind === 'doc' ? q.doc : `${itemLabel(q)} · ${q.title}`}</span>
            </p>
            {q.kind === 'doc' && <p className={muted}>{t('spec.q.docItems', { count: q.items })}</p>}
            <ul className="space-y-4">
              {q.cands.map((c) => (
                <li key={c.uid} className="min-w-0" data-testid="spec-q-cand" data-uid={c.uid} data-state={c.state}>
                  <p className="flex flex-wrap items-center gap-6">
                    <span className="break-all min-w-0 flex-1">
                      {q.kind === 'doc' ? c.doc : itemLabel(c)} <span className={muted}>· {c.state === 'active' || c.state === 'retired' ? t(`spec.q.state.${c.state}`) : c.state}</span>
                    </span>
                    <Tag>{t('spec.q.score', { score: c.score.toFixed(2) })}</Tag>
                    <span className={muted}>{whyText(c.why)}</span>
                  </p>
                  {q.kind !== 'doc' &&
                    (c.text !== undefined && q.text !== undefined ? <Diff before={c.text} now={q.text} /> : <p className={muted}>{t('spec.q.noText')}</p>)}
                  {canAct && (
                    <div className="flex flex-wrap gap-8 mt-4">
                      <Button
                        size="sm"
                        variant="active"
                        disabled={c.state === 'active'}
                        onClick={() => act('resolve', { uid: q.uid, answer: 'same', target: c.uid })}
                        data-testid="spec-q-same"
                      >
                        {t(q.kind === 'doc' ? 'spec.q.sameDoc' : 'spec.q.same')}
                      </Button>
                      {q.kind !== 'doc' && (
                        <Button size="sm" onClick={() => act('resolve', { uid: q.uid, answer: 'split', target: c.uid })} data-testid="spec-q-split">
                          {t('spec.q.split')}
                        </Button>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
            {canAct && (
              <div className="mt-4">
                <Button size="sm" onClick={() => act('resolve', { uid: q.uid, answer: 'new' })} data-testid="spec-q-new">
                  {t(q.kind === 'doc' ? 'spec.q.newDoc' : 'spec.q.new')}
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** 확인 권장 (SPT 0.3): T3 matches under 0.7, not blocking. */
function Review({ rows, act }: { rows: ReviewRow[]; act: (route: string, body: object) => void }) {
  const canAct = useCanAct();
  if (!rows.length) return null;
  return (
    <section className="pixel-panel p-8 min-w-0" data-testid="spec-review">
      <h3 className="text-accent-text mb-4">
        {t('spec.review.title')} {rows.length}
      </h3>
      <p className={`${muted} mb-4`}>{t('spec.review.hint')}</p>
      <ul className="space-y-4">
        {rows.map((r) => (
          <li key={r.uid} className="flex flex-wrap items-center gap-8 min-w-0" data-testid="spec-review-row" data-uid={r.uid}>
            <span className="break-all min-w-0 flex-1">
              {itemLabel(r)} · {r.title}
            </span>
            <Tag>{t('spec.q.score', { score: r.score.toFixed(2) })}</Tag>
            {canAct && (
              <>
                <Button size="sm" onClick={() => act('resolve', { uid: r.uid, answer: 'same', target: r.uid })} data-testid="spec-review-ok">
                  {t('spec.review.ok')}
                </Button>
                <Button size="sm" onClick={() => act('undo', { action: 'split', uid: r.uid })} data-testid="spec-review-split">
                  {t('spec.dec.split')}
                </Button>
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/** 최근 판정 (SPT §2.5): each item's latest decision, with 나누기 and 합치기. */
function Decisions({ rows, act }: { rows: DecisionRow[]; act: (route: string, body: object) => void }) {
  const canAct = useCanAct();
  const now = useNow();
  const [into, setInto] = useState<Record<string, string>>({});
  return (
    <section className="pixel-panel p-8 min-w-0" data-testid="spec-decisions">
      <h3 className="text-accent-text mb-4">{t('spec.dec.title')}</h3>
      {!rows.length && <p className={muted}>{t('spec.dec.none')}</p>}
      <ul className="space-y-4">
        {rows.map((r) => (
          <li key={r.uid} className="flex flex-wrap items-center gap-6 min-w-0" data-testid="spec-decision" data-uid={r.uid} data-how={r.how}>
            <span className="break-all min-w-0 flex-1">
              {itemLabel(r)} {r.title && `· ${r.title}`}
            </span>
            <Tag>{t(`spec.how.${r.how}`)}</Tag>
            {r.score !== undefined && <Tag>{t('spec.q.score', { score: r.score.toFixed(2) })}</Tag>}
            <span className={muted}>
              {t(r.by === 'owner' ? 'spec.dec.owner' : 'spec.dec.engine')} · {timeAgo(r.at, now)}
            </span>
            {canAct && r.canSplit && (
              <Button size="sm" onClick={() => act('undo', { action: 'split', uid: r.uid })} data-testid="spec-dec-split">
                {t('spec.dec.split')}
              </Button>
            )}
            {canAct && !!r.mergeInto?.length && (
              <span className="flex flex-wrap items-center gap-4 min-w-0">
                <select
                  aria-label={t('spec.dec.mergeInto')}
                  className={`${selectCls} max-w-full`}
                  value={into[r.uid] ?? r.mergeInto[0].uid}
                  onChange={(e) => setInto((m) => ({ ...m, [r.uid]: e.target.value }))}
                >
                  {r.mergeInto.map((x) => (
                    <option key={x.uid} value={x.uid}>
                      {itemLabel(x)}
                    </option>
                  ))}
                </select>
                <Button size="sm" onClick={() => act('undo', { action: 'merge', uid: r.uid, into: into[r.uid] ?? r.mergeInto![0].uid })} data-testid="spec-dec-merge">
                  {t('spec.dec.merge')}
                </Button>
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function DocsTab({ project }: { project: string }) {
  const canAct = useCanAct();
  const { data, error, reload } = useSpec<{ enabled: boolean; docs: DocRow[]; alerts: Alert[] }>(project, 'docs');
  const q = useSpec<{ enabled: boolean; questions: Question[]; review: ReviewRow[] }>(project, 'questions');
  const dec = useSpec<{ enabled: boolean; decisions: DecisionRow[] }>(project, 'decisions');
  const now = useNow();
  const reloadAll = () => {
    reload();
    q.reload();
    dec.reload();
  };
  const set = (uid: string, body: Partial<Pick<DocRow, 'kind' | 'tracked' | 'mode' | 'depth' | 'sensitive'>> | { seen: true }) =>
    call(project, `docs/${uid}`, body).then(reloadAll, (err: Error) => cldToast(t('spec.card.title'), err.message, 'error'));
  const act = (route: string, body: object) =>
    void call(project, route, body).then(
      () => {
        cldToast(t('spec.card.title'), t('spec.done'), 'ok');
        reloadAll();
      },
      (err: Error) => cldToast(t('spec.card.title'), err.message, 'error'),
    );
  const copy = (uid: string) =>
    void writeClipboardText(uid).then((ok) =>
      cldToast(t('spec.card.title'), ok ? t('spec.docs.copied') : t('spec.docs.copyFailed'), ok ? 'ok' : 'error'),
    );
  if (error) return <p className="text-red-400 text-xs" role="alert">{error}</p>;
  if (!data) return <p className={muted}>{t('spec.wizard.loading')}</p>;
  if (!data.enabled)
    return (
      <div className="space-y-8" data-testid="spec-docs" data-enabled="false">
        <p className={muted}>{t('spec.docs.off')}</p>
        <OffCard project={project} />
      </div>
    );
  return (
    <div className="space-y-8 min-w-0 text-xs">
      <Questions questions={q.data?.questions ?? []} act={act} />
      <Review rows={q.data?.review ?? []} act={act} />
      <Alerts
        project={project}
        alerts={data.alerts}
        docs={data.docs}
        onSeen={(uid) => void set(uid, { seen: true })}
        onRefs={(uid) => void set(uid, { mode: 'refs' })}
        act={act}
      />
      <ul className="space-y-4 min-w-0" data-testid="spec-docs" data-enabled="true">
        {data.docs.map((d) => (
          <li
            key={d.uid}
            className={`pixel-panel p-8 min-w-0 ${d.tracked && d.state === 'active' ? '' : 'opacity-65'}`}
            data-testid="spec-doc"
            data-path={d.path}
            data-uid={d.uid}
            data-git={d.git}
            data-mode={d.mode}
            data-items={d.items}
          >
            <div className="flex flex-wrap items-center gap-6 min-w-0">
              <button type="button" className="underline break-all text-left min-w-0 flex-1" onClick={() => openDoc(project, d.path, d)}>
                {d.path}
              </button>
              {d.fresh && <Tag testId="spec-doc-new">{t('spec.docs.new')}</Tag>}
              <Tag testId="spec-doc-git">{t(GIT_KEY[d.git])}</Tag>
              {d.state === 'retired' && <Tag>{t('spec.docs.retired')}</Tag>}
              {d.state === 'unresolved' && <Tag testId="spec-doc-unresolved">{t('spec.docs.unresolved')}</Tag>}
              {d.sensitive && <Tag>{t('spec.docs.sensitive')}</Tag>}
            </div>
            <div className="flex flex-wrap items-center gap-8 mt-4 min-w-0">
              <span className="font-mono" title={d.uid}>
                {d.uid.slice(0, 2 + SPEC_UID_SHOWN)}
              </span>
              <Button size="sm" onClick={() => copy(d.uid)} aria-label={t('spec.docs.copy')}>
                {t('spec.docs.copy')}
              </Button>
              <span className={muted}>{t('spec.docs.changed', { when: timeAgo(d.changedAt, now) })}</span>
              <span className={muted}>{t('spec.docs.items', { count: d.items })}</span>
              {canAct ? (
                <>
                  <label className="flex items-center gap-4">
                    {t('spec.docs.kind')}
                    <select className={selectCls} value={d.kind} onChange={(e) => void set(d.uid, { kind: e.target.value as Kind })}>
                      {KINDS.map((k) => (
                        <option key={k} value={k}>
                          {kindText(k)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="flex items-center gap-4">
                    {t('spec.docs.mode')}
                    <select
                      className={selectCls}
                      value={d.mode}
                      onChange={(e) => void set(d.uid, { mode: e.target.value as Mode })}
                      data-testid="spec-doc-mode"
                    >
                      {MODES.map((m) => (
                        <option key={m} value={m}>
                          {t(`spec.mode.${m}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                  {d.mode === 'headings' && (
                    <label className="flex items-center gap-4">
                      {t('spec.docs.depth')}
                      <select
                        className={selectCls}
                        value={d.depth}
                        onChange={(e) => void set(d.uid, { depth: Number(e.target.value) })}
                        data-testid="spec-doc-depth"
                      >
                        {DEPTHS.map((n) => (
                          <option key={n} value={n}>
                            {t('spec.docs.depthLevel', { level: n })}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <label className="flex items-center gap-4 pointer-coarse:min-h-44">
                    <input type="checkbox" checked={d.tracked} onChange={(e) => void set(d.uid, { tracked: e.target.checked })} />
                    {t('spec.docs.tracked')}
                  </label>
                  <label className="flex items-center gap-4 pointer-coarse:min-h-44" title={t('spec.docs.sensitiveHint')}>
                    <input
                      type="checkbox"
                      checked={d.sensitive}
                      onChange={(e) => void set(d.uid, { sensitive: e.target.checked })}
                      data-testid="spec-doc-sensitive"
                    />
                    {t('spec.docs.sensitive')}
                  </label>
                </>
              ) : (
                <span className={muted}>
                  {kindText(d.kind)} · {t(`spec.mode.${d.mode}`)}
                </span>
              )}
            </div>
          </li>
        ))}
      </ul>
      <Decisions rows={dec.data?.decisions ?? []} act={act} />
    </div>
  );
}

// ── 요구사항 ────────────────────────────────────────────

/** `value`, `wait` after it last changed (the list's search text, the 개요's specChanged burst). */
function useSettled<T>(value: T, wait = SPEC_SEARCH_WAIT_MS): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), wait);
    return () => clearTimeout(timer);
  }, [value, wait]);
  return settled;
}

/** SPT-P3-ACCEPT: 수용▾ (the daemon filters, as it does the other list filters). */
const ACCEPTANCE_FILTERS = ['none', 'validate', 'accepted', 'rejected', 'review'] as const;
type AcceptanceFilter = (typeof ACCEPTANCE_FILTERS)[number] | '';

export function ReqsTab({ project, mobile = false }: { project: string; mobile?: boolean }) {
  // SPT-P3-OVERVIEW: opened from a 개요 number, on its filter (every kind) or on a requirement's detail.
  const [focus] = useState(() => tabFocus('reqs')?.key ?? '');
  const [open, setOpen] = useState<string | null>(focus.startsWith('item:') ? focus.slice(5) : null);
  const [kind, setKind] = useState<Kind | ''>(focus ? '' : 'requirements');
  const [show, setShow] = useState(focus.startsWith('show:') ? focus.slice(5) : '');
  const [doc, setDoc] = useState('');
  const [text, setText] = useState('');
  const [retired, setRetired] = useState(false);
  // SPT-P3-ACCEPT: a 개요 acceptance number opens on `acc:<state>`; its own dimension, it combines with `show`.
  const [acceptance, setAcceptance] = useState<AcceptanceFilter>(() => {
    const a = focus.startsWith('acc:') ? focus.slice(4) : '';
    return (ACCEPTANCE_FILTERS as readonly string[]).includes(a) ? (a as AcceptanceFilter) : '';
  });
  const q = useSettled(text.trim());
  const query = new URLSearchParams({ ...(kind && { kind }), ...(doc && { doc }), ...(q && { q }), ...(retired && { state: 'all' }), ...(show && { show }), ...(acceptance && { acceptance }) }).toString();
  const { data, error } = useSpec<{ enabled: boolean; total: number; items: ItemRow[] }>(project, query ? `items?${query}` : 'items');
  const { data: docs } = useSpec<{ enabled: boolean; docs: DocRow[] }>(project, 'docs');
  const tracked = (docs?.docs ?? []).filter((d) => d.tracked && d.state === 'active');
  if (error) return <p className="text-red-400 text-xs" role="alert">{error}</p>;
  if (!data) return <p className={muted}>{t('spec.wizard.loading')}</p>;
  if (!data.enabled)
    return (
      <div className="space-y-8" data-testid="spec-reqs" data-enabled="false">
        <p className={muted}>{t('spec.docs.off')}</p>
        <OffCard project={project} />
      </div>
    );
  return (
    <div className="flex gap-8 min-w-0 items-start">
      <div className="space-y-8 min-w-0 flex-1 text-xs" data-testid="spec-reqs" data-enabled="true">
        <div className="pixel-panel p-8 flex flex-wrap items-center gap-8 min-w-0">
          <select aria-label={t('spec.reqs.kind')} className={selectCls} value={kind} onChange={(e) => setKind(e.target.value as Kind | '')} data-testid="spec-reqs-kind">
            <option value="">{t('spec.reqs.allKinds')}</option>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {kindText(k)}
              </option>
            ))}
          </select>
          <select aria-label={t('spec.reqs.doc')} className={`${selectCls} max-w-full`} value={doc} onChange={(e) => setDoc(e.target.value)} data-testid="spec-reqs-doc">
            <option value="">{t('spec.reqs.allDocs')}</option>
            {tracked.map((d) => (
              <option key={d.uid} value={d.uid}>
                {d.path}
              </option>
            ))}
          </select>
          <input
            type="search"
            aria-label={t('spec.reqs.search')}
            placeholder={t('spec.reqs.searchHint')}
            className={`${selectCls} flex-1 min-w-[8rem]`}
            value={text}
            onChange={(e) => setText(e.target.value)}
            data-testid="spec-reqs-search"
          />
          <select aria-label={t('spec.accept.filter')} className={selectCls} value={acceptance} onChange={(e) => setAcceptance(e.target.value as AcceptanceFilter)} data-testid="spec-reqs-acceptance">
            <option value="">{t('spec.accept.filterAll')}</option>
            {ACCEPTANCE_FILTERS.map((a) => (
              <option key={a} value={a}>
                {a === 'review' ? t('spec.accept.filterReview') : t(`spec.acc.${a}`)}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-4 pointer-coarse:min-h-44">
            <input type="checkbox" checked={retired} onChange={(e) => setRetired(e.target.checked)} data-testid="spec-reqs-retired" />
            {t('spec.reqs.retired')}
          </label>
          {show && (
            <Button size="sm" variant="active" onClick={() => setShow('')} aria-label={t('spec.overview.clearShow', { what: showText(show) })} data-testid="spec-reqs-show" data-show={show}>
              {showText(show)} ✕
            </Button>
          )}
          <span className={muted} data-testid="spec-reqs-count">
            {data.total > data.items.length ? t('spec.reqs.shown', { total: data.total, shown: data.items.length }) : t('spec.reqs.count', { count: data.total })}
          </span>
        </div>
        {!data.items.length && <p className={muted}>{t('spec.reqs.none')}</p>}
        {data.items.length > 0 && (
          <p className={`${muted} grid grid-cols-4 gap-6 px-4`} aria-hidden>
            <span>{t('spec.reqs.colWork')}</span>
            <span>{t('spec.reqs.colEvidence')}</span>
            <span>{t('spec.reqs.colAcceptance')}</span>
            <span>{t('spec.reqs.colFreshness')}</span>
          </p>
        )}
        <ul className="min-w-0" aria-label={t('spec.tab.reqs')}>
          {data.items.map((r) => (
            <li key={r.uid} data-testid="spec-item" data-uid={r.uid} data-id={r.displayId ?? ''} data-state={r.state}>
              <button
                type="button"
                className={`w-full text-left border-b border-border px-4 py-4 block min-w-0 pointer-coarse:min-h-44 ${r.state === 'retired' ? 'opacity-65' : ''} ${open === r.uid ? 'bg-active-bg' : ''}`}
                aria-pressed={open === r.uid}
                onClick={() => setOpen(r.uid)}
              >
                <span className="flex flex-wrap items-center gap-6 min-w-0">
                  {/* A display ID in the code font; 문서 · 절 (any script) in the UI font. */}
                  <span className={`${r.displayId ? 'font-mono' : ''} break-all min-w-0 flex-1`} title={t('spec.reqs.colId')} data-testid="spec-item-id">
                    {r.displayId ?? (r.section ? `${baseName(r.doc)} · ${r.section}` : baseName(r.doc))}
                  </span>
                  <Tag>{kindText(r.kind)}</Tag>
                  <Tag testId="spec-item-state">{t(`spec.state.${r.state}`)}</Tag>
                </span>
                <span className="block break-words" title={t('spec.reqs.colTitle')}>
                  {r.title || t('spec.reqs.gone')}
                </span>
                <span className={`${muted} block break-all`} title={t('spec.reqs.colDoc')}>
                  {r.doc} · {t('spec.reqs.line', { line: r.line })}
                </span>
                <span className="grid grid-cols-4 gap-6 mt-2" data-testid="spec-item-trace">
                  <span title={t('spec.reqs.colWork')} data-col="work">
                    {r.trace?.work?.total && workText(r.trace) ? <Digits text={workText(r.trace)} /> : '—'}
                  </span>
                  <span className="inline-flex items-center gap-2" data-col="evidence">
                    {EVIDENCE_AXES.map((k) => {
                      const led = ledOf(r.trace?.evidence?.[k]);
                      return <Led key={k} state={led} reason={evidenceReason(k, led)} />;
                    })}
                  </span>
                  <span title={t('spec.reqs.colAcceptance')} data-col="acceptance">
                    {/* GAME-UI-1: 수락 a small framed mark, 반려 a dashed one; the rest words. */}
                    <span
                      className={
                        r.trace?.acceptance?.current === 'accepted'
                          ? 'inline-block border-2 border-text-muted px-6 text-text'
                          : r.trace?.acceptance?.current === 'rejected'
                            ? 'inline-block border-2 border-dashed border-text-muted px-6 text-text-muted'
                            : ''
                      }
                    >
                      {t(`spec.acc.${r.trace?.acceptance?.current ?? 'none'}`)}
                    </span>
                  </span>
                  <span title={t('spec.reqs.colFreshness')} data-col="freshness">
                    {r.trace?.freshness ? t(`spec.fresh.${r.trace.freshness}`) : '—'}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
      {open && <ReqDetail project={project} uid={open} mobile={mobile} onClose={() => setOpen(null)} />}
    </div>
  );
}
