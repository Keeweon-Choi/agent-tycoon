/**
 * MAP-A: the 현황판's 지도 tab (the graph's lazy chunk). Three views share one selected item:
 * 구조 (the selected level's card on top and its child modules below, an Inspector on the right, the
 * 불확실 bundle and the dependencies the documents or the owner name), 기능 흐름 (Slice B: an honest
 * empty state) and 요구사항 추적 (the selected module's requirements, one centred in the existing
 * requirements graph; a component node there comes back to the structure). '그림으로 보기' keeps the
 * 4a/4b drawing (ArchGraph). Everything comes from `GET …/map` (useTrace: again on `specChanged`,
 * the cards are plain DOM so a refetch moves nothing and the selection stays).
 *
 * Keys: Tab walks the cards, Enter or Space picks one, Enter again goes in, Esc goes up.
 * On a phone the left pane folds and the Inspector is a full-screen sheet.
 */
import './traceGraph.css';
import '../../i18n/specStrings.js';

import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { MapCard, MapModule, TraceMap } from '../../../../core/src/cld/spec/trace.js';
import { Button } from '../../components/ui/Button.js';
import { Modal } from '../../components/ui/Modal.js';
import { SPEC_DIALOG_Z, SPEC_MAP_INDENT_MAX, SPEC_MAP_INDENT_PX, SPEC_MAP_SEARCH_MAX, SPEC_SEARCH_WAIT_MS } from '../../constants.js';
import { t } from '../../i18n/index.js';
import { HudCounter, Led, LedLegend } from '../game/parts.js';
import { cldToast } from '../officeStore.js';
import { tabFocus, useCanAct } from '../workbench/workbenchStore.js';
import { ArchGraph } from './ArchGraph.js';
import { archWrite, mapPath, useTrace } from './traceApi.js';
import { ReqGraph } from './TraceGraph.js';
import { EVIDENCE_AXES, evidenceReason, ledOf, openSource } from './traceModel.js';

const muted = 'text-text-muted text-xs';
const ROOT = 'root';
const VIEWS = ['structure', 'flow', 'trace'] as const;
type View = (typeof VIEWS)[number];

const kindText = (c: Pick<MapCard, 'kind' | 'id'>) => (c.id === ROOT ? t('spec.map.root') : c.kind === 'group' ? t('spec.map.kind.group') : t(`spec.arch.kind.${c.kind}`));
const cardCls = (c: MapCard) =>
  ['pm-card', c.standing === 'doc' || c.standing === 'review' ? 'pm-card--doc' : '', c.standing === 'proposed' ? 'pm-card--proposed' : '', c.standing === 'review' ? 'pm-card--review' : '', c.kind === 'group' ? 'pm-card--group' : ''].join(' ');

/** The three requirement counts, apart; a suggestion is never shown as confirmed. */
function ReqChips({ c }: { c: MapCard }) {
  const { confirmed, observed, suggested } = c.reqs;
  return (
    <span className="pm-chips" data-testid="map-req-counts" data-confirmed={confirmed} data-observed={observed} data-suggested={suggested} data-tasks={c.activeTasks}>
      {!confirmed && !observed && !suggested && <span className="pm-chip">{t('spec.map.noReqs')}</span>}
      {(['confirmed', 'observed', 'suggested'] as const).map((s) =>
        c.reqs[s] ? (
          <span key={s} className={`pm-chip pm-chip--${s}`}>
            {t(`spec.link.${s}`)} {c.reqs[s]}
          </span>
        ) : null,
      )}
      {!!c.activeTasks && <span className="pm-chip pm-chip--tasks">{t('spec.map.tasks', { count: c.activeTasks })}</span>}
      {c.standing === 'review' && <span className="pm-chip pm-chip--review">{t('spec.arch.standing.review')}</span>}
    </span>
  );
}

function Card({ c, name, picked, onPick, onOpen, root }: { c: MapCard; name: string; picked: boolean; onPick: () => void; onOpen: () => void; root?: boolean }) {
  const onKeyDown = (e: KeyboardEvent) => {
    // Enter on the picked card goes in; the first Enter (or Space) only picks it (the click).
    if (e.key === 'Enter' && picked && !root) {
      e.preventDefault();
      onOpen();
    }
  };
  return (
    <button
      type="button"
      className={`${cardCls(c)} ${root ? 'pm-card--root' : ''}`}
      aria-pressed={picked}
      onClick={onPick}
      onDoubleClick={root ? undefined : onOpen}
      onKeyDown={onKeyDown}
      data-testid={root ? 'map-root-card' : 'map-card'}
      data-id={c.id}
      data-standing={c.standing}
      data-origin={c.origin}
      data-parent-from={c.parentFrom ?? ''}
    >
      <span className="font-bold">{name}</span>
      <span className={muted}>
        {kindText(c)}
        {c.id !== ROOT && ` · ${t(`spec.arch.standing.${c.standing}`)}`}
        {!!c.children && ` · ${t('spec.map.children', { count: c.children })}`}
      </span>
      <ReqChips c={c} />
    </button>
  );
}

/** The selected item's detail: on the right on a desktop, a full-screen sheet on a phone. */
function Inspector({
  project,
  data,
  mobile,
  onClose,
  onIn,
  onModule,
  onTrace,
  onParent,
}: {
  project: string;
  data: TraceMap | null;
  mobile: boolean;
  onClose: () => void;
  onIn: (id: string) => void;
  onModule: (id: string) => void;
  onTrace: () => void;
  onParent: (m: MapModule) => void;
}) {
  const canAct = useCanAct();
  const m = data?.selected;
  const name = m ? (m.id === ROOT ? project : m.label) : '';
  const body = !m ? (
    <p className={muted}>{t('spec.wizard.loading')}</p>
  ) : (
    <>
      <div className="flex items-start gap-8">
        <div className="flex-1 min-w-0">
          <h3 className="break-words" data-testid="map-inspector-name">
            {name}
          </h3>
          <p className={muted} data-testid="map-inspector-standing">
            {kindText(m)}
            {m.id !== ROOT && ` · ${t(`spec.arch.standing.${m.standing}`)} · ${t(`spec.map.origin.${m.origin}`)}`}
          </p>
          {m.parentFrom && <p className={muted}>{t(`spec.map.from.${m.parentFrom}`)}</p>}
        </div>
        {mobile && (
          <Button size="sm" onClick={onClose} data-testid="map-inspector-close">
            {t('spec.graph.close')}
          </Button>
        )}
      </div>
      {m.note && <p className="break-words">{m.note}</p>}
      {/* Counts as the game's counters; confirmed, observed and suggested never added together. */}
      <div className="grid grid-cols-2 gap-4" data-testid="map-req-counts" data-confirmed={m.reqs.confirmed} data-observed={m.reqs.observed} data-suggested={m.reqs.suggested} data-tasks={m.activeTasks}>
        <HudCounter icon="check" label={t('spec.link.confirmed')} value={m.reqs.confirmed} />
        <HudCounter icon="eye" label={t('spec.link.observed')} value={m.reqs.observed} />
        <HudCounter icon="lens" label={t('spec.link.suggested')} value={m.reqs.suggested} />
        <HudCounter icon="hammer" label={t('spec.map.activeTasks')} value={m.activeTasks} />
      </div>
      {m.standing === 'review' && <span className="pm-chip pm-chip--review self-start">{t('spec.arch.standing.review')}</span>}
      {m.id === ROOT && <p className={muted}>{t('spec.map.reqTotal', { total: data!.reqTotal, linked: m.reqs.confirmed + m.reqs.observed + m.reqs.suggested })}</p>}
      <div className="flex flex-wrap gap-4">
        {!!m.children && m.id !== ROOT && (
          <Button size="sm" onClick={() => onIn(m.id)} data-testid="map-into">
            {t('spec.map.into')}
          </Button>
        )}
        <Button size="sm" variant="active" onClick={onTrace} data-testid="map-to-trace">
          {t('spec.map.toTrace')}
        </Button>
        {canAct && m.id.startsWith('c_') && (
          <Button size="sm" onClick={() => onParent(m)} data-testid="map-set-parent">
            {t('spec.map.setParent')}
          </Button>
        )}
      </div>
      <p className={muted}>{t('spec.map.subs')}</p>
      {!data!.cards.length && <p className={muted}>{t('spec.map.noSubs')}</p>}
      <ul>
        {data!.cards.map((c) => (
          <li key={c.id} className="border-b border-border">
            <button type="button" className="w-full text-left px-4 py-2 break-words pointer-coarse:min-h-44" onClick={() => onModule(c.id)} data-testid="map-sub" data-id={c.id}>
              {c.label} <span className={muted}>{t(`spec.arch.standing.${c.standing}`)}</span>
            </button>
          </li>
        ))}
        {!!data!.more && <li className={muted}>{t('spec.map.more', { count: data!.more })}</li>}
      </ul>
      {!!m.sources.length && <p className={muted}>{t('spec.map.sources')}</p>}
      <ul>
        {m.sources.map((s) => (
          <li key={`${s.path}:${s.line}`} className="flex items-center gap-8 min-w-0" data-testid="map-source">
            <span className="flex-1 break-all font-mono">
              {s.path}:{s.line}
            </span>
            <Button size="sm" onClick={() => openSource(project, s)}>
              {t('spec.detail.openSource')}
            </Button>
          </li>
        ))}
      </ul>
    </>
  );
  const panel = (
    <aside
      className={
        mobile
          ? 'fixed inset-0 bg-bg overflow-y-auto pt-[calc(var(--cld-safe-top)+8px)] pb-[calc(var(--cld-safe-bottom)+8px)] px-8 text-xs space-y-8'
          : 'pixel-panel p-8 w-[min(320px,100%)] shrink-0 self-start space-y-8 text-xs'
      }
      style={mobile ? { zIndex: SPEC_DIALOG_Z } : undefined}
      aria-label={t('spec.map.inspector')}
      data-testid="map-inspector"
      data-id={m?.id ?? ''}
    >
      {body}
    </aside>
  );
  return mobile ? createPortal(panel, document.body) : panel;
}

/** [부모 정하기]: one of this project's components (never itself or one below it), or none (the document's or folder's parent again). */
function ParentDialog({ project, m, data, mobile, onClose, onDone }: { project: string; m: MapModule; data: TraceMap; mobile: boolean; onClose: () => void; onDone: () => void }) {
  const below = useMemo(() => {
    const out = new Set([m.id]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const r of data.tree) if (r.parent && out.has(r.parent) && !out.has(r.id)) grew = !!out.add(r.id);
    }
    return out;
  }, [m.id, data.tree]);
  const choices = data.tree.filter((r) => r.id.startsWith('c_') && !below.has(r.id));
  const [to, setTo] = useState(m.parentFrom === 'owner' ? (m.parent ?? '') : '');
  const save = () =>
    void archWrite.parent(project, m.id, to || null).then(
      () => (cldToast(t('spec.map.setParent'), t('spec.arch.done'), 'ok'), onDone()),
      (err: Error) => cldToast(t('spec.map.setParent'), err.message, 'error'),
    );
  return (
    <Modal isOpen onClose={onClose} title={t('spec.map.setParent')} zIndex={SPEC_DIALOG_Z} className={mobile ? 'w-full h-full' : ''}>
      <div className={`flex flex-col gap-8 px-10 pb-10 text-xs ${mobile ? '' : 'w-[min(420px,calc(100vw-32px))]'}`} data-testid="map-parent-dialog">
        <p className="break-words">{m.label}</p>
        <select aria-label={t('spec.map.setParent')} className="bg-bg border-2 border-border px-4 py-2 text-xs pointer-coarse:min-h-44 min-w-0" value={to} onChange={(e) => setTo(e.target.value)} data-testid="map-parent-pick">
          <option value="">{t('spec.map.parentNone')}</option>
          {choices.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </select>
        <div className="flex justify-end gap-8">
          <Button size="sm" onClick={onClose}>
            {t('spec.wizard.cancel')}
          </Button>
          <Button size="sm" variant="active" onClick={save} data-testid="map-parent-ok">
            {t('spec.map.save')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function useSettled(value: string): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), SPEC_SEARCH_WAIT_MS);
    return () => clearTimeout(timer);
  }, [value]);
  return settled;
}

/** The left pane: search (modules here, requirements by `…/items?q=`), the module tree with counts, the legend. */
function NavPane({ project, data, at, onModule, onReq }: { project: string; data: TraceMap | null; at: string; onModule: (id: string) => void; onReq: (uid: string, label: string) => void }) {
  const [text, setText] = useState('');
  const q = useSettled(text.trim());
  const found = useTrace<{ items: Array<{ uid: string; displayId?: string; title?: string }> }>(project, q ? `items?${new URLSearchParams({ q, limit: String(SPEC_MAP_SEARCH_MAX) })}` : null);
  const tree = useMemo(() => data?.tree ?? [], [data]);
  const depth = useMemo(() => {
    const parent = new Map(tree.map((r) => [r.id, r.parent]));
    return (id: string) => {
      let d = 0;
      for (let p = parent.get(id); p && d < SPEC_MAP_INDENT_MAX; p = parent.get(p)) d++;
      return d;
    };
  }, [tree]);
  const rows = q ? tree.filter((r) => r.label.toLowerCase().includes(q.toLowerCase())) : tree;
  return (
    <div className="space-y-8 text-xs min-w-0" data-testid="map-nav">
      <input
        type="search"
        aria-label={t('spec.map.search')}
        placeholder={t('spec.map.search')}
        className="w-full bg-bg border-2 border-border px-4 py-2 text-xs pointer-coarse:min-h-44 min-w-0"
        value={text}
        onChange={(e) => setText(e.target.value)}
        data-testid="map-search"
      />
      {q && !!found.data?.items.length && (
        <ul aria-label={t('spec.map.reqsFound')}>
          {found.data.items.map((r) => (
            <li key={r.uid}>
              <button type="button" className="w-full text-left px-4 py-2 border-b border-border break-words pointer-coarse:min-h-44" onClick={() => onReq(r.uid, r.displayId ?? r.uid)} data-testid="map-search-req" data-uid={r.uid}>
                <span className="font-mono">{r.displayId}</span> <span className="text-text-muted">{r.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className={muted}>{t('spec.map.tree')}</p>
      <ul aria-label={t('spec.map.tree')} className="max-h-[50vh] overflow-y-auto" data-testid="map-tree">
        <li>
          <button type="button" className="w-full text-left px-4 py-2 pointer-coarse:min-h-44" aria-current={at === ROOT ? 'true' : undefined} onClick={() => onModule(ROOT)} data-testid="map-tree-row" data-id={ROOT}>
            {project}
          </button>
        </li>
        {rows.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              className="w-full text-left px-4 py-2 break-words pointer-coarse:min-h-44 flex gap-4"
              style={{ paddingLeft: (q ? 0 : depth(r.id) + 1) * SPEC_MAP_INDENT_PX }}
              aria-current={at === r.id ? 'true' : undefined}
              onClick={() => onModule(r.id)}
              data-testid="map-tree-row"
              data-id={r.id}
            >
              <span className="flex-1 min-w-0">{r.label}</span>
              {!!r.children && <span className="text-text-muted">{r.children}</span>}
            </button>
          </li>
        ))}
        {!!data?.treeMore && <li className={muted}>{t('spec.map.more', { count: data.treeMore })}</li>}
      </ul>
      <div className="space-y-4" data-testid="map-legend">
        <p className={muted}>{t('spec.map.legend')}</p>
        <p>
          <span className="pm-legend-line pm-legend-line--doc" />
          {t('spec.map.origin.document_explicit')}
        </p>
        <p>
          <span className="pm-legend-line" />
          {t('spec.map.origin.owner_confirmed')}
        </p>
        <p>
          <span className="pm-legend-line pm-legend-line--suggested" />
          {t('spec.map.origin.algorithm_suggested')}
        </p>
      </div>
    </div>
  );
}

export function MapTab({ project, mobile }: { project: string; mobile: boolean }) {
  // SPT-P3-OVERVIEW's 최근 본 요구사항 opens this tab on that requirement's trace.
  const [focus] = useState(() => tabFocus('graph'));
  const [view, setView] = useState<View>(focus ? 'trace' : 'structure');
  const [drawing, setDrawing] = useState(false);
  /** The level whose children are the cards, and the item picked (the Inspector's, the trace's). */
  const [at, setAt] = useState(ROOT);
  const [pick, setPick] = useState(ROOT);
  const [sheet, setSheet] = useState(false);
  const [req, setReq] = useState<{ uid: string; label: string } | null>(focus ? { uid: focus.key, label: focus.label ?? focus.key } : null);
  const [parentOf, setParentOf] = useState<MapModule | null>(null);
  const level = useTrace<TraceMap>(project, mapPath(at));
  const picked = useTrace<TraceMap>(project, pick === at ? null : mapPath(pick));
  const pd = pick === at ? level.data : picked.data;
  const data = level.data;
  const canAct = useCanAct();
  const cardsRef = useRef<HTMLDivElement>(null);
  const reload = () => (level.reload(), picked.reload());

  const parentOfId = (id: string) => data?.tree.find((r) => r.id === id)?.parent ?? ROOT;
  /** Into a module: its children become the cards. */
  const goIn = (id: string) => {
    setAt(id);
    setPick(id);
  };
  /** A module from anywhere (the tree, the Inspector's list, the trace): its level, picked. */
  const goModule = (id: string) => {
    if (id === ROOT) goIn(ROOT);
    else {
      setAt(parentOfId(id));
      setPick(id);
    }
    setView('structure');
    setDrawing(false);
    if (mobile) setSheet(true);
  };
  const up = () => {
    if (at === ROOT) return;
    const p = parentOfId(at);
    setAt(p);
    setPick(at);
  };
  const choose = (id: string) => {
    setPick(id);
    if (mobile) setSheet(true);
  };
  // A level drawn anew: the keyboard starts on its first card.
  useEffect(() => {
    if (!mobile) cardsRef.current?.querySelector<HTMLElement>('[data-testid="map-card"]')?.focus({ preventScroll: true });
  }, [data?.selected.id, mobile]);
  const act = (p: Promise<unknown>) =>
    void p.then(
      () => (cldToast(t('spec.map.title'), t('spec.arch.done'), 'ok'), reload()),
      (err: Error) => cldToast(t('spec.map.title'), err.message, 'error'),
    );

  const switcher = (
    <div role="group" aria-label={t('spec.map.views')} className="flex flex-wrap items-center gap-4" data-testid="map-views">
      {VIEWS.map((v) => (
        <Button key={v} size="sm" variant={view === v ? 'active' : 'default'} aria-pressed={view === v} onClick={() => setView(v)} data-view={v}>
          {t(`spec.map.view.${v}`)}
        </Button>
      ))}
    </div>
  );
  const drawSwitch = (
    <div role="group" aria-label={t('spec.map.drawing')} className="flex items-center gap-4" data-testid="spec-graph-switch">
      {(['cards', 'arch'] as const).map((v) => (
        <Button key={v} size="sm" variant={drawing === (v === 'arch') ? 'active' : 'default'} aria-pressed={drawing === (v === 'arch')} onClick={() => setDrawing(v === 'arch')} data-view={v}>
          {t(`spec.map.draw.${v}`)}
        </Button>
      ))}
    </div>
  );
  const nameOf = (id: string, label: string) => (id === ROOT ? project : label);
  const pending = data?.pending;
  const nPending = (pending?.diagrams.length ?? 0) + (pending?.folders.length ?? 0);

  const structure = !data ? null : !data.enabled ? (
    <p className="pixel-panel p-8" data-testid="map-empty" data-why="off">
      {t('spec.map.empty.off')}
    </p>
  ) : (
    <div className="flex gap-8 min-w-0 items-start">
      <div className="flex-1 min-w-0 space-y-8" onKeyDown={(e) => e.key === 'Escape' && (e.preventDefault(), up())}>
        <nav aria-label={t('spec.map.crumbs')} className="flex flex-wrap items-center gap-4 min-w-0" data-testid="map-crumbs">
          {data.crumbs.map((c, i) => (
            <span key={c.id} className="flex items-center gap-4 min-w-0">
              {i > 0 && <span className="text-text-muted">›</span>}
              <Button size="sm" variant={i === data.crumbs.length - 1 ? 'active' : 'default'} aria-current={i === data.crumbs.length - 1 ? 'page' : undefined} onClick={() => goIn(c.id)} data-id={c.id}>
                {nameOf(c.id, c.label)}
              </Button>
            </span>
          ))}
        </nav>
        <div className="pm-tree" ref={cardsRef} data-testid="map-cards" data-at={at}>
          <div className="pm-top">
            <Card c={data.selected} name={nameOf(data.selected.id, data.selected.label)} picked={pick === at} onPick={() => choose(at)} onOpen={() => undefined} root />
          </div>
          {!!data.cards.length && <div className="pm-stem" />}
          {data.cards.length ? (
            <div className="pm-kids">
              {data.cards.map((c) => (
                <div key={c.id}>
                  <Card c={c} name={c.label} picked={pick === c.id} onPick={() => choose(c.id)} onOpen={() => c.children && goIn(c.id)} />
                </div>
              ))}
            </div>
          ) : (
            <p className={`${muted} text-center pt-8`} data-testid="map-empty" data-why={at === ROOT ? 'none' : 'leaf'}>
              {at === ROOT ? t('spec.map.empty.none') : t('spec.map.noSubs')}
            </p>
          )}
          {!!data.more && (
            <details className="pt-8 text-xs" data-testid="map-more">
              <summary className={`${muted} pointer-coarse:min-h-44`}>{t('spec.map.more', { count: data.more })}</summary>
              {/* The rest of this level, from the tree (its own cap). */}
              <span className="flex flex-wrap gap-4 pt-4">
                {data.tree
                  .filter((r) => (r.parent ?? ROOT) === at && !data.cards.some((c) => c.id === r.id))
                  .map((r) => (
                    <Button key={r.id} size="sm" variant={pick === r.id ? 'active' : 'default'} onClick={() => choose(r.id)} data-testid="map-more-item" data-id={r.id}>
                      {r.label}
                    </Button>
                  ))}
              </span>
            </details>
          )}
        </div>
        <p className={muted}>{t('spec.map.levelHint')}</p>
        {!!data.deps.length && (
          <section className="pixel-panel p-8 space-y-4 min-w-0 text-xs" data-testid="map-deps">
            <h3>{t('spec.map.deps')}</h3>
            <ul>
              {data.deps.map((d) => {
                const label = (id: string) => data.cards.find((c) => c.id === id)?.label ?? id;
                return (
                  <li key={`${d.from}|${d.to}|${d.origin}`} className="break-words" data-testid="map-dep" data-origin={d.origin}>
                    <span className={`pm-legend-line ${d.origin === 'document_explicit' ? 'pm-legend-line--doc' : ''}`} />
                    {t('spec.map.depRow', { from: label(d.from), to: label(d.to) })}
                    {d.label && ` · ${d.label}`} <span className="text-text-muted">· {t(`spec.map.origin.${d.origin}`)}</span>
                    {d.count > 1 && <span className="text-text-muted"> ×{d.count}</span>}
                  </li>
                );
              })}
            </ul>
          </section>
        )}
        {(!!data.uncertain.length || !!nPending || !!data.lastBatch) && (
          <section className="pixel-panel p-8 space-y-4 min-w-0 text-xs" data-testid="map-uncertain">
            <h3>{t('spec.map.uncertain')}</h3>
            {canAct && (!!nPending || !!data.lastBatch) && (
              <div className="flex flex-wrap items-center gap-8">
                {!!nPending && (
                  <Button size="sm" variant="active" onClick={() => act(archWrite.approveAll(project, pending!))} data-testid="map-approve-all">
                    {t('spec.map.approveAll', { diagrams: pending!.diagrams.length, folders: pending!.folders.length })}
                  </Button>
                )}
                {data.lastBatch && (
                  <Button size="sm" onClick={() => act(archWrite.undoAll(project, data.lastBatch!.id))} data-testid="map-undo-all">
                    {t('spec.map.undoAll', { diagrams: data.lastBatch.diagrams, folders: data.lastBatch.folders })}
                  </Button>
                )}
                {!!nPending && <span className="text-text-muted">{t('spec.map.approveHint')}</span>}
              </div>
            )}
            <ul>
              {data.uncertain.map((u) => (
                <li key={u.id}>
                  <button type="button" className="w-full text-left px-4 py-2 border-b border-border break-words pointer-coarse:min-h-44" onClick={() => choose(u.id)} data-testid="map-uncertain-item" data-id={u.id} data-why={u.why}>
                    {u.label} <span className="text-text-muted">· {t(`spec.map.why.${u.why}`)}</span>
                  </button>
                </li>
              ))}
              {!!data.uncertainMore && <li className={muted}>{t('spec.map.more', { count: data.uncertainMore })}</li>}
            </ul>
          </section>
        )}
      </div>
      {(!mobile || sheet) && (
        <Inspector
          project={project}
          data={pd}
          mobile={mobile}
          onClose={() => setSheet(false)}
          onIn={(id) => (goIn(id), setSheet(false))}
          onModule={goModule}
          onTrace={() => (setView('trace'), setSheet(false))}
          onParent={setParentOf}
        />
      )}
      {parentOf && data && (
        <ParentDialog project={project} m={parentOf} data={data} mobile={mobile} onClose={() => setParentOf(null)} onDone={() => (setParentOf(null), reload())} />
      )}
    </div>
  );

  const trace = (
    <div className="flex flex-wrap gap-8 min-w-0 items-start">
      <section className="pixel-panel p-8 space-y-4 min-w-0 flex-[1_1_220px] text-xs" data-testid="map-trace-reqs" data-id={pick}>
        <h3 className="break-words">{t('spec.map.traceList', { name: pd ? nameOf(pd.selected.id, pd.selected.label) : '' })}</h3>
        {pd && !pd.reqs.length && <p className={muted}>{t('spec.map.noTraceReqs')}</p>}
        <ul>
          {pd?.reqs.map((r) => (
            <li key={r.uid}>
              <button
                type="button"
                className="w-full text-left px-4 py-2 border-b border-border break-words pointer-coarse:min-h-44"
                aria-pressed={req?.uid === r.uid}
                onClick={() => setReq({ uid: r.uid, label: r.label })}
                data-testid="map-trace-req"
                data-uid={r.uid}
                data-status={r.status}
              >
                <span className="font-mono">{r.label}</span> <span className={`pm-chip pm-chip--${r.status}`}>{t(`spec.link.${r.status}`)}</span>{' '}
                {/* 근거 (four lights) and 수용 apart: a passed test never reads as accepted. */}
                <span className="inline-flex items-center gap-2" data-testid="map-trace-evidence">
                  {EVIDENCE_AXES.map((k) => {
                    const led = ledOf(r.state?.evidence?.[k]);
                    return <Led key={k} state={led} reason={evidenceReason(k, led)} />;
                  })}
                </span>{' '}
                <span className="text-text-muted" data-testid="map-trace-acceptance">
                  {t(`spec.acc.${r.state?.acceptance?.current ?? 'none'}`)}
                </span>
                {r.title && <span className="block text-text-muted">{r.title}</span>}
              </button>
            </li>
          ))}
          {!!pd?.reqsMore && <li className={muted}>{t('spec.map.more', { count: pd.reqsMore })}</li>}
        </ul>
        <LedLegend compact />
        {!req && <p className={muted}>{t('spec.map.traceHint')}</p>}
      </section>
      <div className="flex-[3_1_480px] min-w-0">
        <ReqGraph key={req?.uid ?? 'overview'} project={project} mobile={mobile} center={req ?? undefined} onComp={goModule} />
      </div>
    </div>
  );

  return (
    <div className="flex gap-8 min-w-0 items-start text-xs" data-testid="map-tab" data-view={view}>
      {mobile ? null : (
        <aside className="pixel-panel p-8 w-[220px] shrink-0 self-start" aria-label={t('spec.map.nav')}>
          <NavPane project={project} data={data} at={pick} onModule={goModule} onReq={(uid, label) => (setReq({ uid, label }), setView('trace'))} />
        </aside>
      )}
      <div className="flex-1 min-w-0 space-y-8">
        {mobile && (
          <details className="pixel-panel p-8" data-testid="map-nav-fold">
            <summary className="pointer-coarse:min-h-44">{t('spec.map.nav')}</summary>
            <NavPane project={project} data={data} at={pick} onModule={goModule} onReq={(uid, label) => (setReq({ uid, label }), setView('trace'))} />
          </details>
        )}
        <div className="pixel-panel p-8 flex flex-wrap items-center gap-8 min-w-0">
          <h2 className={mobile ? 'w-full' : 'flex-1 min-w-0'}>{t('spec.map.title')}</h2>
          {switcher}
        </div>
        {level.error && (
          <p className="text-red-400" role="alert">
            {level.error}
          </p>
        )}
        {!data && !level.error && <p className={muted}>{t('spec.wizard.loading')}</p>}
        {view === 'structure' && (
          <>
            {data?.enabled && <div className="flex flex-wrap items-center gap-8">{!drawing && drawSwitch}</div>}
            {drawing ? <ArchGraph project={project} mobile={mobile} head={drawSwitch} /> : structure}
          </>
        )}
        {view === 'flow' && (
          <p className="pixel-panel p-8" data-testid="map-flow-empty">
            {t('spec.map.flowEmpty')}
          </p>
        )}
        {view === 'trace' &&
          (data && !data.enabled ? (
            <p className="pixel-panel p-8" data-testid="map-empty" data-why="off">
              {t('spec.map.empty.off')}
            </p>
          ) : (
            trace
          ))}
      </div>
    </div>
  );
}
