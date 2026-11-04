/**
 * SPT-P4A (SPT §8): the 그래프 tab's 아키텍처 view, in the graph's lazy chunk. The structure read from
 * the documents (`GET …/arch`): components by kind, subgraphs as groups that fold and unfold,
 * composition edges as solid arrows; the interaction layer (sequence messages) is folded by default
 * and a toggle shows it as thin labelled arrows. The count line is always above the graph; a node
 * click shows where it is written with [원본 열기]; the blocks not drawn are listed under the graph.
 *
 * SPT-P4B: what the owner decides. Each diagram read from the documents has [이 구조 승인] and shows
 * its standing (재검토 필요 once it changed); a node's detail sets its kind, merges it as
 * '같은 구성요소' and lists what was merged into it; [구성요소 추가] and [관계 추가] add by hand; the
 * '제안' toggle shows the folder skeleton dimmed, each folder with [승인] [이름 바꾸기] [합치기] [빼기].
 * On a phone the detail and the dialogs take the full screen.
 *
 * SPT C1: the 지도's [설계 그림] (a secondary view of the structure); [제안 모두 승인] and its
 * [되돌리기] moved here from the old map's head (the arch read carries `pending` and `lastBatch`).
 */
import { Controls, Handle, type Node, type NodeChange, type NodeProps, Position, ReactFlow } from '@xyflow/react';
import { createContext, memo, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

import { ARCH_KINDS, type ArchKind, type ArchNode, type TraceArch } from '../../../../core/src/cld/spec/trace.js';
import { Button } from '../../components/ui/Button.js';
import { Modal } from '../../components/ui/Modal.js';
import { SPEC_DIALOG_Z, SPEC_GRAPH_ZOOM } from '../../constants.js';
import { t } from '../../i18n/index.js';
import { cldToast } from '../officeStore.js';
import { useCanAct } from '../workbench/workbenchStore.js';
import { type ArchFoldData, type ArchGroupData, type ArchNodeData, foldArch, layoutArch, toArchFlow } from './archModel.js';
import { ReqDetail } from './ReqDetail.js';
import { archWrite, useTrace } from './traceApi.js';
import { openSource } from './traceModel.js';

const muted = 'text-text-muted text-xs';
const kindText = (n: ArchNode) => t(`spec.arch.kind.${n.kind}`);
/** A folder's file count; `N+` when the repository's file listing was cut. */
const filesText = (n: ArchNode) => t(n.filesPartial ? 'spec.arch.filesMore' : 'spec.arch.files', { count: n.files ?? 0 });
const selectCls = 'bg-bg border-2 border-border px-4 py-2 text-xs pointer-coarse:min-h-44 min-w-0';
/** Folding is the view's own: a click on a group's name, or on a folded group. */
const FoldToggle = createContext<(id: string) => void>(() => undefined);

const ArchNodeView = memo(function ArchNodeView({ data }: NodeProps<Node<ArchNodeData, 'arch'>>) {
  const n = data.node;
  return (
    <div className={`tg-n ag-n ag-n--${n.kind} ag-s--${n.standing}`} data-testid="arch-node" data-id={n.id} data-kind={n.kind} data-standing={n.standing}>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <span className="ag-label">{n.label}</span>
      {n.reqs && (
        <span className="tg-sub" data-testid="arch-req-count">
          {t('spec.p4c.reqCount', { count: n.reqs.count })}
        </span>
      )}
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
});
const ArchGroupView = memo(function ArchGroupView({ data }: NodeProps<Node<ArchGroupData, 'archGroup'>>) {
  const g = data.group;
  const toggle = useContext(FoldToggle);
  return (
    <div className="tg-box ag-box" data-testid="arch-group" data-id={g.id}>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <button
        type="button"
        className="tg-box-head ag-box-head"
        aria-expanded
        aria-label={t('spec.arch.fold', { name: g.label })}
        onClick={() => toggle(g.id)}
        data-testid="arch-group-fold"
      >
        ▾ {g.label}
      </button>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
});
const ArchFoldView = memo(function ArchFoldView({ data }: NodeProps<Node<ArchFoldData, 'archFold'>>) {
  const { group, count } = data.fold;
  return (
    <div className="tg-n ag-fold" data-testid="arch-fold" data-id={group.id} aria-expanded={false} title={t('spec.arch.unfold', { name: group.label })}>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <span className="ag-label">▸ {group.label}</span>
      <span className="tg-sub">{t('spec.arch.folded', { count })}</span>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
});
/** Stable: React Flow re-creates every node when this object changes. */
const nodeTypes = { arch: ArchNodeView, archGroup: ArchGroupView, archFold: ArchFoldView };

type Dialog = { t: 'comp' } | { t: 'rel' } | { t: 'rename'; path: string } | { t: 'merge'; path: string } | { t: 'alias'; uid: string };
type Act = (p: Promise<unknown>, after?: () => void) => void;

function KindSelect({ value, onChange, testId }: { value: ArchKind; onChange: (k: ArchKind) => void; testId: string }) {
  return (
    <select aria-label={t('spec.arch.kindLabel')} className={selectCls} value={value} onChange={(e) => onChange(e.target.value as ArchKind)} data-testid={testId}>
      {ARCH_KINDS.map((k) => (
        <option key={k} value={k}>
          {t(`spec.arch.kind.${k}`)}
        </option>
      ))}
    </select>
  );
}

/** A proposed folder's four decisions (the list under '제안' and the node's detail). */
function SkeletonActions({ project, n, act, open }: { project: string; n: ArchNode; act: Act; open: (d: Dialog) => void }) {
  const path = n.folder ?? '';
  return (
    <span className="flex flex-wrap gap-4">
      <Button size="sm" onClick={() => act(archWrite.skeleton(project, path, 'approved'))} data-testid="arch-sk-approve">
        {t('spec.arch.sk.approve')}
      </Button>
      <Button size="sm" onClick={() => open({ t: 'rename', path })} data-testid="arch-sk-rename">
        {t('spec.arch.sk.rename')}
      </Button>
      <Button size="sm" onClick={() => open({ t: 'merge', path })} data-testid="arch-sk-merge">
        {t('spec.arch.sk.merge')}
      </Button>
      <Button size="sm" onClick={() => act(archWrite.skeleton(project, path, 'removed'))} data-testid="arch-sk-remove">
        {t('spec.arch.sk.remove')}
      </Button>
    </span>
  );
}

function ArchPop({
  project,
  n,
  data,
  mobile,
  act,
  open,
  onClose,
  onOpen,
}: {
  project: string;
  n: ArchNode;
  data: TraceArch;
  mobile: boolean;
  act: Act;
  open: (d: Dialog) => void;
  onClose: () => void;
  /** SPT-P4C: a requirement chip opens its detail. */
  onOpen: (uid: string) => void;
}) {
  const label = new Map(data.nodes.map((x) => [x.id, x.label] as const));
  const rels = data.edges.filter((e) => e.owner && (e.from === n.id || e.to === n.id));
  const where = n.from === 'owner' ? t('spec.arch.byHand') : n.from === 'folder' ? t('spec.arch.fromFolder', { path: n.folder ?? '' }) : '';
  const panel = (
    <div
      className={mobile ? 'fixed inset-0 bg-bg overflow-y-auto pt-[calc(var(--cld-safe-top)+8px)] pb-[calc(var(--cld-safe-bottom)+8px)] px-8 text-xs space-y-8' : 'tg-pop space-y-4 max-h-[calc(100%-16px)] overflow-y-auto'}
      style={mobile ? { zIndex: SPEC_DIALOG_Z } : undefined}
      role="status"
      data-testid="arch-node-pop"
      data-id={n.id}
    >
      <div className="flex items-center gap-8">
        <span className="flex-1 break-words ag-label">{n.label}</span>
        <Button variant="ghost" size="icon_md" aria-label={t('spec.graph.close')} onClick={onClose}>
          x
        </Button>
      </div>
      <p className="text-text-muted" data-testid="arch-pop-standing">
        {kindText(n)} · {t(`spec.arch.standing.${n.standing}`)}
        {where && ` · ${where}`}
        {n.files !== undefined && ` · ${filesText(n)}`}
      </p>
      {n.note && <p className="break-words">{n.note}</p>}
      {n.standing === 'proposed' ? (
        <SkeletonActions project={project} n={n} act={act} open={open} />
      ) : (
        <div className="flex flex-wrap items-center gap-4">
          <KindSelect value={n.kind} onChange={(kind) => act(archWrite.editComp(project, n.id, { kind }))} testId="arch-kind" />
          <Button size="sm" onClick={() => open({ t: 'alias', uid: n.id })} data-testid="arch-same">
            {t('spec.arch.sameAs')}
          </Button>
          {n.from === 'owner' && (
            <Button size="sm" onClick={() => act(archWrite.deleteComp(project, n.id), onClose)} data-testid="arch-delete">
              {t('spec.arch.delete')}
            </Button>
          )}
        </div>
      )}
      {!!n.merged?.length && (
        <>
          <p className="text-text-muted">{t('spec.arch.merged')}</p>
          <ul>
            {n.merged.map((m) => (
              <li key={m.id} className="flex items-center gap-8 min-w-0" data-testid="arch-merged" data-id={m.id}>
                <span className="flex-1 break-words">{m.label}</span>
                <Button size="sm" onClick={() => act(archWrite.unalias(project, m.id))} data-testid="arch-unmerge">
                  {t('spec.arch.unmerge')}
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}
      {!!n.folders?.length && (
        <p className="text-text-muted break-all" data-testid="arch-folders">
          {t('spec.arch.folders')}: <span className="font-mono">{n.folders.join(', ')}</span>
        </p>
      )}
      {!!rels.length && (
        <>
          <p className="text-text-muted">{t('spec.arch.rels')}</p>
          <ul>
            {rels.map((e) => (
              <li key={e.id} className="flex items-center gap-8 min-w-0" data-testid="arch-rel">
                <span className="flex-1 break-words">
                  {t('spec.arch.relRow', { from: label.get(e.from) ?? e.from, to: label.get(e.to) ?? e.to })}
                  {e.label && ` · ${e.label}`}
                </span>
                <Button size="sm" onClick={() => act(archWrite.deleteRel(project, e.id))} data-testid="arch-rel-delete">
                  {t('spec.arch.delete')}
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}
      {!!n.sources.length && <p className="text-text-muted">{t('spec.arch.sources')}</p>}
      <ul>
        {n.sources.map((s) => (
          <li key={`${s.path}:${s.line}`} className="flex items-center gap-8 min-w-0" data-testid="arch-source">
            <span className="flex-1 break-all font-mono">
              {s.path}:{s.line}
            </span>
            <Button size="sm" onClick={() => openSource(project, s)} data-testid="arch-open-source">
              {t('spec.detail.openSource')}
            </Button>
          </li>
        ))}
      </ul>
      {/* SPT-P4C: its requirements (confirmed or observed); a chip opens the requirement detail. */}
      <p className="text-text-muted">{n.reqs ? t('spec.p4c.reqs', { count: n.reqs.count }) : t('spec.p4c.noReqs')}</p>
      {n.reqs && (
        <span className="flex flex-wrap gap-4">
          {n.reqs.list.map((r) => (
            <button key={r.uid} type="button" className="border-2 border-border px-4 font-mono pointer-coarse:min-h-44" data-status={r.status} onClick={() => onOpen(r.uid)} data-testid="arch-req">
              {r.label}
            </button>
          ))}
        </span>
      )}
    </div>
  );
  return mobile ? createPortal(panel, document.body) : panel;
}

/** One of the owner's small forms: a component, a relation, a folder's new name, a merge target, the '같은 구성요소' target. */
function ArchDialog({ project, d, comps, mobile, act, onClose }: { project: string; d: Dialog; comps: ArchNode[]; mobile: boolean; act: Act; onClose: () => void }) {
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState<ArchKind>('component');
  const [note, setNote] = useState('');
  const others = d.t === 'alias' ? comps.filter((c) => c.id !== d.uid) : comps;
  const [from, setFrom] = useState(others[0]?.id ?? '');
  const [to, setTo] = useState(others[1]?.id ?? others[0]?.id ?? '');
  const title = { comp: 'spec.arch.addComp', rel: 'spec.arch.addRel', rename: 'spec.arch.sk.rename', merge: 'spec.arch.mergeInto', alias: 'spec.arch.sameAsPick' } as const;
  const pick = (value: string, set: (v: string) => void, name: string, testId: string) => (
    <select aria-label={name} className={selectCls} value={value} onChange={(e) => set(e.target.value)} data-testid={testId}>
      {others.map((c) => (
        <option key={c.id} value={c.id}>
          {c.label} · {kindText(c)}
        </option>
      ))}
    </select>
  );
  const input = (value: string, set: (v: string) => void, name: string, testId: string) => (
    <input aria-label={name} placeholder={name} className={selectCls} value={value} onChange={(e) => set(e.target.value)} data-testid={testId} />
  );
  const submit = () => {
    const l = label.trim();
    const done = (p: Promise<unknown>) => act(p, onClose);
    if (d.t === 'comp') done(archWrite.addComp(project, { label: l, kind, ...(note.trim() && { note: note.trim() }) }));
    else if (d.t === 'rel') done(archWrite.addRel(project, from, to, l || undefined));
    else if (d.t === 'rename') done(archWrite.skeleton(project, d.path, 'renamed', { label: l }));
    else if (d.t === 'merge') done(archWrite.skeleton(project, d.path, 'merged', { into: from }));
    else done(archWrite.alias(project, d.uid, from));
  };
  const ready = d.t === 'comp' || d.t === 'rename' ? !!label.trim() : d.t === 'rel' ? !!from && !!to && from !== to : !!from;
  return (
    <Modal isOpen onClose={onClose} title={t(title[d.t])} zIndex={SPEC_DIALOG_Z} className={mobile ? 'w-full h-full' : ''}>
      <div className={`flex flex-col gap-8 px-10 pb-10 text-xs ${mobile ? '' : 'w-[min(420px,calc(100vw-32px))]'}`} data-testid="arch-dialog" data-kind={d.t}>
        {(d.t === 'rename' || d.t === 'merge') && <p className="font-mono break-all">{d.path}</p>}
        {(d.t === 'comp' || d.t === 'rename') && input(label, setLabel, t('spec.arch.label'), 'arch-dialog-label')}
        {d.t === 'comp' && <KindSelect value={kind} onChange={setKind} testId="arch-dialog-kind" />}
        {d.t === 'comp' && input(note, setNote, t('spec.arch.note'), 'arch-dialog-note')}
        {(d.t === 'rel' || d.t === 'merge' || d.t === 'alias') && pick(from, setFrom, d.t === 'rel' ? t('spec.arch.relFrom') : t('spec.arch.pick'), 'arch-dialog-from')}
        {d.t === 'rel' && pick(to, setTo, t('spec.arch.relTo'), 'arch-dialog-to')}
        {d.t === 'rel' && input(label, setLabel, t('spec.arch.relLabel'), 'arch-dialog-label')}
        <div className="flex justify-end gap-8">
          <Button size="sm" onClick={onClose}>
            {t('spec.wizard.cancel')}
          </Button>
          <Button size="sm" variant="active" disabled={!ready} onClick={submit} data-testid="arch-dialog-ok">
            {d.t === 'comp' || d.t === 'rel' ? t('spec.arch.add') : d.t === 'rename' ? t('spec.arch.sk.rename') : t('spec.arch.sk.merge')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function ArchGraph({ project, mobile, head }: { project: string; mobile: boolean; head: ReactNode }) {
  const [interaction, setInteraction] = useState(false);
  const [proposals, setProposals] = useState(false);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const [sel, setSel] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const { data, error, reload } = useTrace<TraceArch>(project, `arch?layer=${interaction ? 'interaction' : 'composition'}`);
  const toggle = useCallback(
    (id: string) =>
      setFolded((f) => {
        const next = new Set(f);
        if (!next.delete(id)) next.add(id);
        return next;
      }),
    [],
  );
  // The proposed folders are drawn only with '제안' on.
  const shown = useMemo(() => (data && !proposals ? { ...data, nodes: data.nodes.filter((n) => n.standing !== 'proposed') } : data), [data, proposals]);
  const view = useMemo(() => (shown ? foldArch(shown, folded) : null), [shown, folded]);
  const flow = useMemo(() => (view ? toArchFlow(view, layoutArch(view), sel) : null), [view, sel]);
  const byId = useMemo(() => new Map((data?.nodes ?? []).map((n) => [n.id, n] as const)), [data]);
  const comps = useMemo(() => (data?.nodes ?? []).filter((n) => n.standing !== 'proposed'), [data]);
  const proposed = useMemo(() => (data?.nodes ?? []).filter((n) => n.standing === 'proposed'), [data]);
  const onNodesChange = (changes: NodeChange[]) => {
    for (const c of changes) {
      if (c.type !== 'select' || !c.selected) continue;
      if (byId.has(c.id)) setSel(c.id);
      else if (view?.folds.some((f) => f.group.id === c.id)) toggle(c.id);
    }
  };
  const act: Act = (p, after) =>
    void p.then(
      () => {
        cldToast(t('spec.arch.title'), t('spec.arch.done'), 'ok');
        after?.();
        reload();
      },
      (err: Error) => cldToast(t('spec.arch.title'), err.message, 'error'),
    );
  const picked = sel ? byId.get(sel) : undefined;
  const height = mobile ? 'h-[60dvh]' : 'h-[min(560px,65vh)]';
  const c = data?.counts;
  const canAct = useCanAct();
  const pending = data?.pending;
  const nPending = (pending?.diagrams.length ?? 0) + (pending?.folders.length ?? 0);

  return (
    <div className="flex-1 min-w-0 space-y-8 text-xs" data-testid="arch-graph">
      <div className="pixel-panel p-8 flex flex-wrap items-center gap-8 min-w-0">
        {head}
        <span className="flex-1" />
        <Button size="sm" onClick={() => setDialog({ t: 'comp' })} data-testid="arch-add-comp">
          {t('spec.arch.addComp')}
        </Button>
        <Button size="sm" disabled={comps.length < 2} onClick={() => setDialog({ t: 'rel' })} data-testid="arch-add-rel">
          {t('spec.arch.addRel')}
        </Button>
        <Button size="sm" variant={proposals ? 'active' : 'default'} aria-pressed={proposals} onClick={() => setProposals((x) => !x)} data-testid="arch-proposals-toggle">
          {t('spec.arch.proposals', { count: c?.proposed ?? 0 })}
        </Button>
        <Button size="sm" variant={interaction ? 'active' : 'default'} aria-pressed={interaction} onClick={() => setInteraction((x) => !x)} data-testid="arch-interaction">
          {t('spec.arch.interaction')}
        </Button>
      </div>
      {canAct && (!!nPending || !!data?.lastBatch) && (
        <div className="flex flex-wrap items-center gap-8" data-testid="arch-batch">
          {!!nPending && (
            <Button size="sm" variant="active" onClick={() => act(archWrite.approveAll(project, pending!))} data-testid="arch-approve-all">
              {t('spec.arch.approveAll', { diagrams: pending!.diagrams.length, folders: pending!.folders.length })}
            </Button>
          )}
          {data?.lastBatch && (
            <Button size="sm" onClick={() => act(archWrite.undoAll(project, data.lastBatch!.id))} data-testid="arch-undo-all">
              {t('spec.arch.undoAll', { diagrams: data.lastBatch.diagrams, folders: data.lastBatch.folders })}
            </Button>
          )}
          {!!nPending && <span className={muted}>{t('spec.arch.approveHint')}</span>}
        </div>
      )}
      {c && (
        <p data-testid="arch-counts" data-approved={c.approved} data-proposed={c.proposed} data-from-docs={c.fromDocs}>
          {t('spec.arch.counts', { approved: c.approved, proposed: c.proposed, fromDocs: c.fromDocs })}
        </p>
      )}
      {!!data?.hidden && <p className={muted}>{t('spec.arch.hidden', { count: data.hidden })}</p>}
      {!!data?.hiddenEdges && <p className={muted} data-testid="arch-hidden-edges">{t('spec.arch.hiddenEdges', { count: data.hiddenEdges })}</p>}
      {error && (
        <p className="text-red-400" role="alert">
          {error}
        </p>
      )}
      {!data && !error && <p className={muted}>{t('spec.wizard.loading')}</p>}
      {/* No structure but the folder proposals: 아키텍처 정보 없음, whether the proposals are drawn or not. */}
      {data && !comps.length && (
        <div className="pixel-panel p-8 flex flex-wrap items-center gap-8" data-testid="arch-empty-box">
          <p className="flex-1 min-w-0" data-testid="arch-empty">
            {t('spec.arch.empty')}
          </p>
          <Button size="sm" variant="active" onClick={() => setDialog({ t: 'comp' })} data-testid="arch-empty-add">
            {t('spec.arch.add')}
          </Button>
        </div>
      )}
      {flow && data && !!shown?.nodes.length && (
        <div className="flex flex-wrap gap-8 min-w-0">
          <div className={`tg-root ${height} flex-[3_1_320px] min-w-0`} role="region" aria-label={t('spec.arch.title')}>
            <FoldToggle.Provider value={toggle}>
            <ReactFlow
              nodes={flow.nodes}
              edges={flow.edges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onPaneClick={() => setSel(null)}
              nodesDraggable={false}
              nodesConnectable={false}
              edgesFocusable={false}
              zoomOnDoubleClick={false}
              fitView
              minZoom={SPEC_GRAPH_ZOOM.min}
              maxZoom={SPEC_GRAPH_ZOOM.max}
              colorMode="dark"
            >
              <Controls showInteractive={false} />
            </ReactFlow>
            </FoldToggle.Provider>
            {picked && <ArchPop project={project} n={picked} data={data} mobile={mobile} act={act} open={setDialog} onClose={() => setSel(null)} onOpen={setDetail} />}
          </div>
          <ul className={`flex-[1_1_180px] min-w-0 overflow-y-auto ${mobile ? '' : 'max-h-[min(560px,65vh)]'}`} aria-label={t('spec.arch.list')} data-testid="arch-list">
            {shown.nodes.map((n) => (
              <li key={n.id} className="border-b border-border min-w-0" data-id={n.id}>
                <button type="button" className="w-full text-left px-4 py-2 min-w-0 break-words pointer-coarse:min-h-44" aria-pressed={sel === n.id} onClick={() => setSel(n.id)} data-testid="arch-item">
                  <span className="text-text-muted">
                    {kindText(n)} · {t(`spec.arch.standing.${n.standing}`)} ·{' '}
                  </span>
                  {n.label}
                  {n.reqs && <span className="text-text-muted"> · {t('spec.p4c.reqCount', { count: n.reqs.count })}</span>}
                </button>
              </li>
            ))}
          </ul>
          {detail && <ReqDetail project={project} uid={detail} mobile={mobile} onClose={() => setDetail(null)} />}
        </div>
      )}
      {proposals && (
        <section className="pixel-panel p-8 space-y-4 min-w-0" data-testid="arch-proposals">
          <h3>{t('spec.arch.standing.proposed')}</h3>
          {!proposed.length && <p className={muted}>{t('spec.arch.noProposals')}</p>}
          <ul className="space-y-4">
            {proposed.map((n) => (
              <li key={n.id} className="flex flex-wrap items-center gap-8 min-w-0" data-testid="arch-proposal" data-path={n.folder}>
                <span className="flex-[1_1_12rem] min-w-0 break-all">
                  <span className="font-mono">{n.folder}</span> <span className={muted}>{filesText(n)}</span>
                </span>
                <SkeletonActions project={project} n={n} act={act} open={setDialog} />
              </li>
            ))}
          </ul>
        </section>
      )}
      {!!data?.diagrams.length && (
        <section className="pixel-panel p-8 space-y-4 min-w-0" data-testid="arch-diagrams">
          <h3>{t('spec.arch.diagrams')}</h3>
          <ul className="space-y-4">
            {data.diagrams.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-8 min-w-0" data-testid="arch-diagram" data-id={d.id} data-standing={d.standing}>
                <span className="flex-[1_1_12rem] min-w-0 break-all">{t('spec.arch.diagram', { path: d.path, line: d.line, type: t(`spec.arch.type.${d.type}`) })}</span>
                <span className={`ag-standing ag-standing--${d.standing}`} data-testid="arch-diagram-standing">
                  {t(`spec.arch.standing.${d.standing}`)}
                </span>
                {d.standing !== 'approved' && (
                  <Button size="sm" onClick={() => act(archWrite.approve(project, d))} data-testid="arch-approve">
                    {t('spec.arch.approve')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {!!data?.unsupported.length && (
        <section className="pixel-panel p-8 space-y-8 min-w-0" data-testid="arch-unsupported">
          <h3>{t('spec.arch.unsupported')}</h3>
          <ul className="space-y-8">
            {data.unsupported.map((u) => (
              <li key={`${u.doc}:${u.line}`} className="space-y-4 min-w-0" data-testid="arch-unsupported-item" data-line={u.firstBlockedLine}>
                <p className="break-all">
                  <span className="font-mono">{u.doc}</span> · {u.type === 'document' ? t('spec.arch.document') : u.type}
                  {u.big && ` · ${t('spec.arch.tooBig')}`}
                </p>
                <p className="text-text-muted break-all" data-testid="arch-blocked">
                  {t('spec.arch.blocked', { line: u.firstBlockedLine, text: u.text })}
                </p>
                {u.source && <pre className="bg-bg border-2 border-border p-4 overflow-x-auto max-h-160 font-mono">{u.source}</pre>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {dialog && <ArchDialog key={JSON.stringify(dialog)} project={project} d={dialog} comps={comps} mobile={mobile} act={act} onClose={() => setDialog(null)} />}
    </div>
  );
}
