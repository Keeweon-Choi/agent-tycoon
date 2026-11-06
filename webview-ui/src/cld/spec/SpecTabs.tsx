/**
 * SPT-P1A/P1B, RQ2: the spec pieces the 개요 (Overview.tsx) and the merged 요구사항 tab (ReqsTab.tsx)
 * share, one lazy chunk: the spec route call and useSpec, the 명세 추적 card and its 켜기 window, the
 * 이어받기 offers, and (SPT-P1C) the old 문서 tab's parts the 요구사항 tab now holds: the alerts (its
 * ⚙ sheet), 같은 항목 확인 with the old-text diff, 확인 권장 and 최근 판정 with 나누기/합치기 (its
 * [확인할 것 N]). Fetched when shown and again on `specChanged`, never polled.
 */
import '../../i18n/specStrings.js';

import { useEffect, useMemo, useState } from 'react';

import type { TraceAcceptanceWeek } from '../../../../core/src/cld/spec/trace.js';
import { Button } from '../../components/ui/Button.js';
import { Modal } from '../../components/ui/Modal.js';
import { SPEC_DIALOG_Z, SPEC_SEARCH_WAIT_MS } from '../../constants.js';
import { t, type TranslationKey } from '../../i18n/index.js';
import { openProjectFile } from '../files/explorerState.js';
import { timeAgo } from '../format.js';
import { cldToast } from '../officeStore.js';
import { serverText } from '../serverText.js';
import { useCanAct, useNow } from '../workbench/workbenchStore.js';
import type { DocRow } from './reqsModel.js';
import { useSpecRev } from './specStore.js';
import { wordDiff } from './wordDiff.js';

type Axis = 'change' | 'integration' | 'test' | 'deploy';
// eslint-disable-next-line react-refresh/only-export-components -- shared with ReqsTab.tsx in the same lazy chunk
export const KINDS = ['requirements', 'design', 'decision', 'test', 'task', 'plan', 'other', 'log'] as const;
type Kind = (typeof KINDS)[number];
type Git = 'committed' | 'modified' | 'untracked' | 'ignored' | 'not-git';
// eslint-disable-next-line react-refresh/only-export-components -- shared with ReqsTab.tsx in the same lazy chunk
export const GIT_KEY: Record<Git, TranslationKey> = {
  committed: 'spec.git.committed',
  modified: 'spec.git.modified',
  untracked: 'spec.git.untracked',
  ignored: 'spec.git.ignored',
  'not-git': 'spec.git.notGit',
};
// eslint-disable-next-line react-refresh/only-export-components -- shared with ReqsTab.tsx in the same lazy chunk
export const kindText = (k: Kind) => t(`spec.kind.${k}`);

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
type DocRef = { uid: string; path: string };
export type Alert =
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
export type Question =
  | { kind: 'item' | 'reuse'; uid: string; displayId?: string; title: string; doc: string; line: number; text?: string; cands: QCand[] }
  | { kind: 'doc'; uid: string; doc: string; items: number; cands: QCand[] };
export interface ReviewRow {
  uid: string;
  displayId?: string;
  title: string;
  doc: string;
  line: number;
  score: number;
}
type How = 'T1' | 'T1n' | 'T2' | 'T2r' | 'T3' | 'new' | 'unresolved' | 'reuse' | 'retired' | 'owner-same' | 'owner-new' | 'owner-split' | 'owner-merge' | 'owner-ok';
export interface DecisionRow {
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
const muted = 'text-text-muted text-xs';
const selectCls = 'bg-bg border border-border px-4 py-2 text-xs pointer-coarse:min-h-44 min-w-0';
const baseName = (p: string) => p.split('/').pop() ?? p;
/** Open a tracked document in the 파일 tab (the 문서 list's size and time, when it has them). */
const openDoc = (project: string, rel: string, d?: DocRow) =>
  openProjectFile(project, { name: baseName(rel), path: rel, kind: 'file', size: d?.size ?? 0, mtime: d?.mtimeMs ?? 0 });
const base = (project: string) => `/api/cld/spec/${encodeURIComponent(project)}`;

// eslint-disable-next-line react-refresh/only-export-components -- shared with ReqsTab.tsx in the same lazy chunk
export async function call<T>(project: string, route: string, body?: object): Promise<T> {
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

export function EnableDialog({ project, onClose }: { project: string; onClose: () => void }) {
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
  // RQW §2.7 문서 직접 고르기: a path typed in, checked by the daemon as a ticked one.
  const [typed, setTyped] = useState('');
  const addTyped = () => {
    const p = typed.trim().replace(/^\.?\//, '');
    if (!p) return;
    setList((l) => (l && !l.docs.some((d) => d.path === p) ? { ...l, docs: [...l.docs, { path: p, kind: 'requirements', git: 'committed', preselect: true }] } : l));
    setPicked((s) => new Set(s).add(p));
    setTyped('');
  };
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
            <div className="flex gap-6 min-w-0">
              <input
                aria-label={t('reqs.wizard.path')}
                placeholder={t('reqs.wizard.pathHint')}
                className={`${selectCls} flex-1`}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addTyped()}
                data-testid="spec-wizard-path"
              />
              <Button size="sm" onClick={addTyped} disabled={!typed.trim()} data-testid="spec-wizard-add">
                {t('reqs.wizard.add')}
              </Button>
            </div>
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
export function InheritOffers({ project, offers }: { project: string; offers: Offer[] }) {
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
    <div className="border-ui rounded-ui-card border-border p-6 mb-6 min-w-0" data-testid="spec-inherit">
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

/** 확인할 것 (SPT §2.7): display IDs defined in more than one place, one line per set of documents; documents tracked by themselves. */
export function Alerts({
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
export function Questions({ questions, act }: { questions: Question[]; act: (route: string, body: object) => void }) {
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
export function Review({ rows, act }: { rows: ReviewRow[]; act: (route: string, body: object) => void }) {
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
export function Decisions({ rows, act }: { rows: DecisionRow[]; act: (route: string, body: object) => void }) {
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

// ── 요구사항 ────────────────────────────────────────────

/** `value`, `wait` after it last changed (the list's search text, the 개요's specChanged burst). */
// eslint-disable-next-line react-refresh/only-export-components -- shared with ReqsTab.tsx in the same lazy chunk
export function useSettled<T>(value: T, wait = SPEC_SEARCH_WAIT_MS): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), wait);
    return () => clearTimeout(timer);
  }, [value, wait]);
  return settled;
}
