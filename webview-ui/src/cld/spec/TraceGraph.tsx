/**
 * SPT-P3-GRAPH (SPT §7, §7.1): the requirements graph, a lazy chunk with React Flow + dagre.
 * Three levels (overview of groups → a group's requirements → one requirement's neighbourhood)
 * with breadcrumbs; our own pixel nodes; edges styled by status, a click shows the provenance;
 * filters with '숨긴 것 N개 · 보기'; commits folded into '커밋 +N'; a text list of the same nodes
 * beside the graph; the requirement detail on the right (full screen on a phone). SPT C1: opened from
 * a requirement detail's [이웃 그래프] (ReqDetail.tsx), centred on it. Edges are not
 * focusable; Tab walks the nodes, Enter or Space picks one, Enter again or a double click opens it.
 */
import '@xyflow/react/dist/style.css';
import './traceGraph.css';
import '../../i18n/specStrings.js';

import {
  Controls,
  Handle,
  MiniMap,
  type Node,
  type NodeChange,
  type NodeProps,
  Position,
  ReactFlow,
} from '@xyflow/react';
import { type KeyboardEvent, memo, type ReactNode, useMemo, useState } from 'react';

import type {
  TraceEdge,
  TraceGraph,
  TraceNode,
  TraceNodeType,
} from '../../../../core/src/cld/spec/trace.js';
import { Button } from '../../components/ui/Button.js';
import { SPEC_GRAPH_MINIMAP, SPEC_GRAPH_ZOOM } from '../../constants.js';
import { t } from '../../i18n/index.js';
import { timeAgo } from '../format.js';
import { ReqDetail } from './ReqDetail.js';
import { type Crumb, type Depth, graphPath, useTrace } from './traceApi.js';
import { layoutTrace } from './traceLayout.js';
import {
  applyFilters,
  type BoxNodeData,
  drillFrom,
  foldCommits,
  foldOwner,
  type GraphFilters,
  LINK_LEVELS,
  type LinkLevel,
  moveTo,
  NO_FILTERS,
  openSource,
  sourceText,
  stateTones,
  toFlow,
  type TraceNodeData,
  whoText,
} from './traceModel.js';

const muted = 'text-text-muted text-xs';
const selectCls = 'bg-bg border-2 border-border px-4 py-2 text-xs pointer-coarse:min-h-44 min-w-0';
const TYPE_ORDER: readonly TraceNodeType[] = [
  'group',
  'req',
  'doc',
  'task',
  'commit',
  'job',
  'msg',
  'comp',
];
const AXES = [
  'spec.detail.work',
  'spec.detail.evidence',
  'spec.detail.acceptance',
  'spec.detail.freshness',
] as const;

const nodeText = (n: TraceNode) =>
  n.type === 'commit' && n.count ? t('spec.graph.folded', { count: n.count }) : n.label;

const TraceNodeView = memo(function TraceNodeView({
  data,
}: NodeProps<Node<TraceNodeData, 'trace'>>) {
  const n = data.node;
  const tones = stateTones(n.state);
  const w = n.state?.work;
  const cls = [
    'tg-n',
    `tg-n--${n.type}`,
    n.type === 'commit' && n.count ? 'tg-n--fold' : '',
    data.center ? 'tg-n--center' : '',
    n.state?.freshness === 'missing' ? 'tg-n--missing' : '',
  ].join(' ');
  return (
    <div className={cls} data-testid="spec-graph-node" data-id={n.id} data-type={n.type}>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      {(n.type === 'task' || n.type === 'job') && <span className="tg-in" />}
      {n.type === 'commit' ? (
        <>
          <span className="tg-diamond" />
          <span className="tg-id">{nodeText(n)}</span>
        </>
      ) : (
        <>
          <span className="tg-row">
            <span className="tg-id">{n.label}</span>
            {data.unlinked && <span className="tg-tag">{t('spec.graph.unlinked')}</span>}
            {(n.type === 'req' || n.type === 'group') && (
              <span className="tg-dots" aria-hidden>
                {tones.map((tone, i) => (
                  <span key={AXES[i]} className={`tg-dot tg-dot--${tone}`} title={t(AXES[i])} />
                ))}
              </span>
            )}
          </span>
          {n.type === 'group' ? (
            <>
              <span className="tg-sub">{t('spec.graph.groupCount', { count: n.count ?? 0 })}</span>
              <span className="tg-bar" aria-hidden>
                <span
                  style={{
                    width: `${w?.total ? Math.round((100 * (w.byStatus.done ?? 0)) / w.total) : 0}%`,
                  }}
                />
              </span>
            </>
          ) : (
            n.title && <span className="tg-sub">{n.title}</span>
          )}
        </>
      )}
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
  );
});
const BoxView = memo(function BoxView({ data }: NodeProps<Node<BoxNodeData, 'box'>>) {
  return (
    <div className="tg-box">
      <div className="tg-box-head">{data.label}</div>
    </div>
  );
});
/** Stable: React Flow re-creates every node when this object changes (R3). */
const nodeTypes = { trace: TraceNodeView, box: BoxView };
const minimapClass = (n: Node) =>
  n.type === 'box' ? 'tg-mm-box' : `tg-mm-${(n.data as TraceNodeData).node.type}`;

function EdgePop({ e, onClose }: { e: TraceEdge; onClose: () => void }) {
  const lines =
    e.status === 'observed'
      ? [sourceText(e.source) ? t('spec.edge.where', { where: sourceText(e.source) }) : e.reason]
      : e.status === 'suggested'
        ? [e.reason && t('spec.edge.why', { reason: e.reason })]
        : [
            e.by && t('spec.edge.by', { who: whoText(e.by), when: e.at ? timeAgo(e.at) : '' }),
            e.reason,
          ];
  return (
    <div className="tg-pop" role="status" data-testid="spec-edge-pop" data-status={e.status}>
      <div className="flex items-center gap-8">
        <span className="flex-1">
          {t(`spec.rel.${e.rel}`)} · {t(`spec.link.${e.status}`)}
          {e.kind && ` · ${t(`spec.evk.${e.kind}`)}`}
        </span>
        <Button variant="ghost" size="icon_md" aria-label={t('spec.graph.close')} onClick={onClose}>
          x
        </Button>
      </div>
      {lines.filter(Boolean).map((l, i) => (
        <p key={i} className="text-text-muted break-words">
          {l}
        </p>
      ))}
    </div>
  );
}

function NodePop({ project, n, onClose }: { project: string; n: TraceNode; onClose: () => void }) {
  return (
    <div className="tg-pop" role="status" data-testid="spec-node-pop">
      <div className="flex items-center gap-8">
        <span className="flex-1 break-all">
          {t(`spec.type.${n.type}`)} · <span className="font-mono">{nodeText(n)}</span>
        </span>
        <Button variant="ghost" size="icon_md" aria-label={t('spec.graph.close')} onClick={onClose}>
          x
        </Button>
      </div>
      {n.title && <p className="break-words">{n.title}</p>}
      {sourceText(n.source) && <p className="text-text-muted break-all">{sourceText(n.source)}</p>}
      {n.source?.path && (
        <Button size="sm" onClick={() => openSource(project, n.source)}>
          {t('spec.detail.openSource')}
        </Button>
      )}
    </div>
  );
}

/** The requirements graph, centred on `center` (a requirement detail's [이웃 그래프]), else the overview. */
export function ReqGraph({
  project,
  mobile,
  head,
  center,
}: {
  project: string;
  mobile: boolean;
  head?: ReactNode;
  center?: { uid: string; label: string };
}) {
  const [path, setPath] = useState<Crumb[]>(() =>
    center ? [{ level: 'overview' }, { level: 'neighbourhood', center: center.uid, label: center.label }] : [{ level: 'overview' }],
  );
  const crumb = path[path.length - 1];
  const [depth, setDepth] = useState<Depth>(1);
  const [filters, setFilters] = useState<GraphFilters>(NO_FILTERS);
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set());
  const [sel, setSel] = useState<string | null>(null);
  const [selEdge, setSelEdge] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const route = graphPath(crumb, depth);
  const { data, error, reload } = useTrace<TraceGraph>(project, route);
  const filtered = useMemo(() => (data ? applyFilters(data, filters) : null), [data, filters]);
  const shown = useMemo(
    () => (filtered ? foldCommits(filtered.graph, unfolded) : null),
    [filtered, unfolded],
  );
  const laid = useMemo(() => (shown ? layoutTrace(shown) : null), [shown]);
  const flow = useMemo(
    () =>
      shown && laid
        ? toFlow(shown, laid, {
            selected: sel,
            selectedEdge: selEdge,
            observedTag: t('spec.link.observed'),
          })
        : null,
    [shown, laid, sel, selEdge],
  );
  const byId = useMemo(() => new Map((shown?.nodes ?? []).map((n) => [n.id, n] as const)), [shown]);

  const go = (next: Crumb) => {
    setPath((p) => moveTo(p, next));
    setSel(null);
    setSelEdge(null);
    setUnfolded(new Set());
  };
  /** Click, Enter or Space on a node, or its row in the list. */
  const pick = (n: TraceNode) => {
    setSel(n.id);
    setSelEdge(null);
    const owner = foldOwner(n.id);
    if (owner) setUnfolded((u) => new Set([...u, owner]));
    else if (n.type === 'group') go(drillFrom(n)!);
    else if (n.type === 'req') setDetail(n.id);
  };
  /** Double click or Enter on the picked node: a level down, or the source. */
  const open = (n: TraceNode) => {
    const next = drillFrom(n);
    if (next && !(n.type === 'req' && crumb.level === 'neighbourhood' && n.id === data?.center))
      go(next);
    else openSource(project, n.source);
  };
  const onNodesChange = (changes: NodeChange[]) => {
    for (const c of changes)
      if (c.type === 'select' && c.selected && byId.has(c.id)) pick(byId.get(c.id)!);
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    const id = (e.target as HTMLElement).closest('.react-flow__node')?.getAttribute('data-id');
    if (id && id === sel && byId.has(id)) open(byId.get(id)!);
  };
  const types = TYPE_ORDER.filter((ty) => data?.nodes.some((n) => n.type === ty) && ty !== 'group');
  const listed = [...(shown?.nodes ?? [])].sort(
    (a, b) =>
      Number(b.id === shown?.center) - Number(a.id === shown?.center) ||
      TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type),
  );
  const edge = selEdge ? shown?.edges.find((e) => e.id === selEdge) : undefined;
  const picked = sel && !edge ? byId.get(sel) : undefined;
  const height = mobile ? 'h-[60dvh]' : 'h-[min(560px,65vh)]';

  return (
    <div
      className="flex gap-8 min-w-0 items-start text-xs"
      data-testid="spec-graph"
      data-level={data?.level ?? crumb.level}
    >
      <div className="flex-1 min-w-0 space-y-8">
        <div className="pixel-panel p-8 flex flex-wrap items-center gap-8 min-w-0">
          {head}
          <nav
            aria-label={t('spec.graph.levels')}
            className="flex flex-wrap items-center gap-4 min-w-0"
            data-testid="spec-graph-crumbs"
          >
            {path.map((c, i) => (
              <span key={c.level} className="flex items-center gap-4 min-w-0">
                {i > 0 && <span className="text-text-muted">›</span>}
                <Button
                  size="sm"
                  variant={i === path.length - 1 ? 'active' : 'default'}
                  aria-current={i === path.length - 1 ? 'page' : undefined}
                  onClick={() => go(c)}
                >
                  {c.level === 'overview' ? t('spec.graph.all') : c.label}
                </Button>
              </span>
            ))}
          </nav>
          <span className="flex-1" />
          <select
            aria-label={t('spec.graph.links')}
            className={selectCls}
            value={filters.links}
            onChange={(e) => setFilters((f) => ({ ...f, links: e.target.value as LinkLevel }))}
            data-testid="spec-graph-links"
          >
            {LINK_LEVELS.map((l) => (
              <option key={l} value={l}>
                {t(`spec.graph.links.${l}`)}
              </option>
            ))}
          </select>
          {crumb.level === 'neighbourhood' && (
            <select
              aria-label={t('spec.graph.depth')}
              className={selectCls}
              value={depth}
              onChange={(e) => setDepth(Number(e.target.value) as Depth)}
              data-testid="spec-graph-depth"
            >
              {[1, 2].map((d) => (
                <option key={d} value={d}>
                  {t('spec.graph.depthN', { depth: d })}
                </option>
              ))}
            </select>
          )}
        </div>
        {types.length > 1 && (
          <fieldset
            className="flex flex-wrap items-center gap-8 min-w-0"
            data-testid="spec-graph-types"
          >
            <legend className="sr-only">{t('spec.graph.types')}</legend>
            {types.map((ty) => (
              <label key={ty} className="flex items-center gap-4 pointer-coarse:min-h-44">
                <input
                  type="checkbox"
                  checked={!filters.hiddenTypes.has(ty)}
                  data-type={ty}
                  onChange={() =>
                    setFilters((f) => {
                      const hiddenTypes = new Set(f.hiddenTypes);
                      if (!hiddenTypes.delete(ty)) hiddenTypes.add(ty);
                      return { ...f, hiddenTypes };
                    })
                  }
                />
                {t(`spec.type.${ty}`)}
              </label>
            ))}
            {unfolded.size > 0 && (
              <Button
                size="sm"
                onClick={() => setUnfolded(new Set())}
                data-testid="spec-graph-refold"
              >
                {t('spec.graph.refold')}
              </Button>
            )}
          </fieldset>
        )}
        {!!filtered?.hidden && (
          <p
            className="flex items-center gap-8"
            data-testid="spec-graph-hidden"
            data-count={filtered.hidden}
          >
            {t('spec.graph.hidden', { count: filtered.hidden })} ·
            <Button
              size="sm"
              onClick={() => setFilters(NO_FILTERS)}
              data-testid="spec-graph-show-all"
            >
              {t('spec.graph.showAll')}
            </Button>
          </p>
        )}
        {error && (
          <p className="text-red-400" role="alert">
            {error}
          </p>
        )}
        {!data && !error && <p className={muted}>{t('spec.wizard.loading')}</p>}
        {flow && (
          <div className="flex flex-wrap gap-8 min-w-0">
            <div
              className={`tg-root ${height} flex-[3_1_320px] min-w-0`}
              onKeyDown={onKeyDown}
              role="region"
              aria-label={t('spec.graph.title')}
            >
              <ReactFlow
                key={route}
                nodes={flow.nodes}
                edges={flow.edges}
                nodeTypes={nodeTypes}
                onNodesChange={onNodesChange}
                onNodeDoubleClick={(_, n) => byId.has(n.id) && open(byId.get(n.id)!)}
                onEdgeClick={(_, e) => (setSelEdge(e.id), setSel(null))}
                onPaneClick={() => (setSel(null), setSelEdge(null))}
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
                {!mobile && <MiniMap pannable zoomable nodeClassName={minimapClass} style={SPEC_GRAPH_MINIMAP} />}
              </ReactFlow>
              {edge && <EdgePop e={edge} onClose={() => setSelEdge(null)} />}
              {picked && picked.type !== 'req' && picked.type !== 'group' && (
                <NodePop project={project} n={picked} onClose={() => setSel(null)} />
              )}
              {!shown?.nodes.length && <p className={`${muted} tg-pop`}>{t('spec.graph.empty')}</p>}
            </div>
            <ul
              className={`flex-[1_1_180px] min-w-0 overflow-y-auto ${mobile ? '' : 'max-h-[min(560px,65vh)]'}`}
              aria-label={t('spec.graph.list')}
              data-testid="spec-graph-list"
            >
              {listed.map((n) => (
                <li
                  key={n.id}
                  className="flex items-center gap-4 border-b border-border min-w-0"
                  data-id={n.id}
                >
                  <button
                    type="button"
                    className="flex-1 text-left px-4 py-2 min-w-0 break-words pointer-coarse:min-h-44"
                    aria-pressed={sel === n.id}
                    onClick={() => pick(n)}
                    data-testid="spec-graph-item"
                  >
                    <span className="text-text-muted">{t(`spec.type.${n.type}`)} · </span>
                    <span className={n.count ? '' : 'font-mono'}>{nodeText(n)}</span>
                    {n.title && <span className="text-text-muted"> {n.title}</span>}
                  </button>
                  {drillFrom(n) && n.id !== shown?.center && (
                    <Button size="sm" onClick={() => open(n)} data-testid="spec-graph-open">
                      {t('spec.graph.open')}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      {detail ? (
        <ReqDetail
          project={project}
          uid={detail}
          mobile={mobile}
          onClose={() => setDetail(null)}
          onChanged={reload}
          inGraph
        />
      ) : (
        // The detail's column is kept on a desktop: a selection never narrows the canvas under the pointer (a double click lands where it began).
        !mobile && (
          <p className={`pixel-panel p-8 w-[min(380px,100%)] shrink-0 self-start ${muted}`} data-testid="spec-detail-slot">
            {t('spec.graph.detailHint')}
          </p>
        )
      )}
    </div>
  );
}
