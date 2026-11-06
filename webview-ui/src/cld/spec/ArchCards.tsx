/**
 * 아키텍처 그래프, the 지도's first view (owner 11-06: window mock v3-2, phone v3-5, the mood of GPT's
 * gpt-6). The structure scan (`GET …/map`, the same one 모듈 지도 reads) as module cards: icon, name,
 * a chip (layer · kind), three lines (its biggest parts with their files, its layer and 7-day
 * commits, the requirement areas that reach it) and a dot (linked to requirements or not). React
 * Flow draws the cards (custom nodes) on a grid band by band, the lines with many imports (step
 * edges) and the zoom; the picked card's lines are bright, every other line dims. Left: the
 * project's structure as a tree, search and filters. Right: the picked card's counts, recent
 * changes (`?block=`), requirement areas, relations and [단계별 들어가기] (모듈 지도, one level in).
 * Under the graph: one summary line. On a phone the graph takes the screen and the detail is a
 * sheet under it (pinch to zoom, [전체 보기] fits).
 * BRN K8: a switch above it (코드 · 설계 · 겹쳐 보기, DesignMap.tsx): 설계 draws the cards of the design's
 * own fold (`?design=1`), 겹쳐 보기 the code cards marked where the design agrees or differs plus ghost
 * cards for what only the design plans, and a number row of the four drifts under the graph.
 */
import '@xyflow/react/dist/style.css';

import {
  Background,
  BackgroundVariant,
  type Edge,
  Handle,
  MarkerType,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useViewport,
} from '@xyflow/react';
import {
  type Dispatch,
  memo,
  type ReactNode,
  type SetStateAction,
  useEffect,
  useMemo,
  useState,
} from 'react';

import type {
  MapBlock,
  MapBlockDetail,
  MapDrift,
  MapStructure,
  TraceMap,
} from '../../../../core/src/cld/spec/trace.js';
import { Button } from '../../components/ui/Button.js';
import { Checkbox } from '../../components/ui/Checkbox.js';
import {
  SPEC_CARD,
  SPEC_CARD_DOTS,
  SPEC_CARD_FIT_PAD,
  SPEC_CARD_ICON,
  SPEC_CARD_INSIDE,
  SPEC_CARD_LINE,
  SPEC_CARD_PHONE,
  SPEC_CARD_RECENT,
  SPEC_CARD_RECENT_PHONE,
  SPEC_CARD_REQS,
  SPEC_GRAPH_ZOOM,
  SPEC_MAP_ARROW_MIN,
} from '../../constants.js';
import { t } from '../../i18n/index.js';
import { HudCounter, type IconName, PixelIcon } from '../game/parts.js';
import {
  type CardFilter,
  cardLines,
  cardOrder,
  cellName,
  gridCells,
  linkedOf,
  NO_FILTER,
  type Relations,
  relationsOf,
  type Side,
  sides,
} from './archCardsModel.js';
import {
  DesignNote,
  DriftBar,
  GhostDetail,
  type GhostNode,
  GhostView,
  MarkTag,
  ViewSwitch,
} from './DesignMap.js';
import {
  type CellMark,
  cellMarks,
  ghosts as ghostsOf,
  type MapView,
  wantsDesign,
} from './designMapModel.js';
import { mapPath, useTrace } from './traceApi.js';

const muted = 'text-text-muted text-xs';
const SIDES: readonly Side[] = ['t', 'r', 'b', 'l'];
const POS: Record<Side, Position> = {
  t: Position.Top,
  r: Position.Right,
  b: Position.Bottom,
  l: Position.Left,
};

const iconOf = (b: MapBlock): IconName =>
  b.kind === 'rail'
    ? b.id === 'tests'
      ? 'check'
      : 'hammer'
    : b.kind === 'layer'
      ? 'case'
      : 'board';
const kindWord = (b: MapBlock) =>
  t(
    b.kind === 'rail'
      ? 'spec.cards.kind.rail'
      : b.rest
        ? 'spec.cards.kind.rest'
        : b.kind === 'layer'
          ? 'spec.cards.kind.layer'
          : 'spec.cards.kind.unit',
  );
const insideText = (b: MapBlock, n = b.inside.length) =>
  b.inside
    .slice(0, n)
    .map((x) => `${x.name || t('spec.map.direct')} ${x.n}`)
    .join(' · ');

interface CardData extends Record<string, unknown> {
  b: MapBlock;
  chip: string;
  lines: string[];
  picked: boolean;
  /** Something else is picked and this one trades with it. */
  near: boolean;
  dim: boolean;
  mobile: boolean;
  /** 겹쳐 보기 only: how the design stands to this card. */
  mark?: CellMark;
  /** 설계: a planned cell has no requirement dot, no commits. */
  plan?: boolean;
}
type CardNode = Node<CardData, 'card'>;

/** The status dot (the shared `.ui-status-dot`): green linked to requirements, amber not. */
const Dot = ({ on }: { on: boolean }) => (
  <span className="ui-status-dot" data-tone={on ? 'ok' : 'warn'} aria-hidden="true" />
);

const CardView = memo(function CardView({ data }: NodeProps<CardNode>) {
  const { b } = data;
  return (
    <div
      className="ui-card ac-card"
      role="button"
      aria-pressed={data.picked}
      data-selected={data.picked || undefined}
      data-testid="arch-card"
      data-id={b.id}
      data-kind={b.kind}
      data-picked={data.picked || undefined}
      data-near={data.near || undefined}
      data-dim={data.dim || undefined}
      data-linked={linkedOf(b) === 'linked' || undefined}
      data-mobile={data.mobile || undefined}
      data-mark={data.mark}
      title={b.kind === 'rail' ? cellName(b) : b.id}
    >
      {SIDES.map((s) => (
        <Handle key={`s${s}`} id={`s-${s}`} type="source" position={POS[s]} isConnectable={false} />
      ))}
      {SIDES.map((s) => (
        <Handle key={`t${s}`} id={`t-${s}`} type="target" position={POS[s]} isConnectable={false} />
      ))}
      <div className="ac-card-head">
        <span className="ui-card-tile ac-tile">
          <PixelIcon
            name={iconOf(b)}
            size={data.mobile ? SPEC_CARD_ICON.phone : SPEC_CARD_ICON.card}
          />
        </span>
        <span className="ac-card-title">
          <span className="ac-card-name">{cellName(b)}</span>
          {!data.mobile && <span className="ui-chip ui-notch ac-chip">{data.chip}</span>}
        </span>
        {!data.plan && <Dot on={linkedOf(b) === 'linked'} />}
      </div>
      {data.mark && <MarkTag mark={data.mark} mobile={data.mobile} />}
      {!data.mobile && (
        <ul className="ui-dots ac-card-lines">
          {data.lines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      )}
    </div>
  );
});
const nodeTypes = { card: CardView, ghost: GhostView };

/** The left column: the structure as a tree (bands, their cells, the rails), search, filters. */
function TreeSide({
  project,
  s,
  shown,
  pick,
  onPick,
  filter,
  setFilter,
}: {
  project: string;
  s: MapStructure;
  shown: number;
  pick: string | null;
  onPick: (id: string) => void;
  filter: CardFilter;
  setFilter: (f: CardFilter) => void;
}) {
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const byId = new Map(s.blocks.map((b) => [b.id, b]));
  const rails = s.blocks.filter((b) => b.kind === 'rail');
  const cells = s.blocks.filter((b) => b.kind !== 'rail');
  const flip = <T,>(set: ReadonlySet<T>, x: T) => {
    const next = new Set(set);
    if (!next.delete(x)) next.add(x);
    return next;
  };
  const row = (b: MapBlock, depth: number) => (
    <li key={b.id}>
      <button
        type="button"
        className="ui-row ac-tree-row pointer-coarse:min-h-44"
        data-depth={depth}
        aria-current={pick === b.id || undefined}
        onClick={() => onPick(b.id)}
        data-testid="arch-tree-row"
        data-id={b.id}
      >
        <PixelIcon name={iconOf(b)} size={SPEC_CARD_ICON.small} />
        <span className="flex-1 min-w-0 truncate">{cellName(b)}</span>
        <span className="cm-muted">{b.files}</span>
      </button>
    </li>
  );
  return (
    <aside className="pixel-panel ac-side" aria-label={t('spec.cards.tree')}>
      <h3 className="ui-head ac-title">
        <PixelIcon name="list" /> {t('spec.cards.tree')}
      </h3>
      <input
        type="search"
        className="ui-input ac-search pointer-coarse:min-h-44"
        placeholder={t('spec.cards.search')}
        aria-label={t('spec.cards.search')}
        value={filter.query}
        onChange={(e) => setFilter({ ...filter, query: e.target.value })}
        data-testid="arch-card-search"
      />
      <ul className="ac-tree">
        <li className="ac-tree-root">
          <span className="flex-1 min-w-0 truncate">{project}</span>
          <span className="cm-muted">{s.files}</span>
        </li>
        {s.bands.map((band) => (
          <li key={band.id}>
            <button
              type="button"
              className="ui-row ac-tree-row pointer-coarse:min-h-44"
              aria-expanded={!folded.has(band.id)}
              onClick={() => setFolded(flip(folded, band.id))}
            >
              <span aria-hidden="true">{folded.has(band.id) ? '▶' : '▼'}</span>
              <span className="flex-1 min-w-0 truncate">{band.name}</span>
              <span className="cm-muted">{band.files}</span>
            </button>
            {!folded.has(band.id) && (
              <ul>
                {band.blocks
                  .map((id) => byId.get(id))
                  .filter((b): b is MapBlock => !!b)
                  .map((b) => row(b, 1))}
              </ul>
            )}
          </li>
        ))}
        {rails.map((b) => row(b, 0))}
      </ul>
      <h3 className="ui-head ac-title">
        <PixelIcon name="eye" /> <span className="flex-1">{t('spec.cards.filter')}</span>
        <button
          type="button"
          className="cm-muted pointer-coarse:min-h-44"
          onClick={() => setFilter(NO_FILTER)}
        >
          {t('spec.cards.clear')}
        </button>
      </h3>
      <div className="ac-filters text-xs" data-testid="arch-card-filters" data-shown={shown}>
        <Checkbox
          checked={!filter.layers.size && !filter.links.size}
          onChange={() => setFilter({ ...filter, layers: new Set(), links: new Set() })}
          label={t('spec.cards.all', { count: cells.length })}
        />
        {s.bands.map((band) => (
          <Checkbox
            key={band.id}
            checked={filter.layers.has(band.id)}
            onChange={() => setFilter({ ...filter, layers: flip(filter.layers, band.id) })}
            label={t('spec.cards.layerCount', { name: band.name, count: band.blocks.length })}
          />
        ))}
        <span className="ac-sep" />
        {(['linked', 'unlinked'] as const).map((k) => (
          <Checkbox
            key={k}
            checked={filter.links.has(k)}
            onChange={() => setFilter({ ...filter, links: flip(filter.links, k) })}
            label={
              <span className="flex items-center gap-6">
                <Dot on={k === 'linked'} />
                {t(`spec.cards.${k}`, { count: cells.filter((b) => linkedOf(b) === k).length })}
              </span>
            }
          />
        ))}
        {!!rails.length && (
          <Checkbox
            checked={filter.rails}
            onChange={() => setFilter({ ...filter, rails: !filter.rails })}
            label={t('spec.cards.rails', { count: rails.length })}
          />
        )}
      </div>
    </aside>
  );
}

/** A relation row: how many, folded open to the names (with their imports that way). */
function RelRow({
  arrow,
  label,
  list,
  s,
}: {
  arrow: string;
  label: string;
  list: Relations['uses'];
  s: MapStructure;
}) {
  const byId = new Map(s.blocks.map((b) => [b.id, b]));
  return (
    <details className="ac-rel">
      <summary className="pointer-coarse:min-h-44">
        <span className="ac-rel-arrow" aria-hidden="true">
          {arrow}
        </span>
        <span className="flex-1">{label}</span>
        <span>{t('spec.cards.rel.count', { count: list.length })}</span>
      </summary>
      <ul>
        {list.map((x) => (
          <li key={x.id} className="flex gap-8">
            <span className="flex-1 min-w-0 truncate">
              {byId.get(x.id) ? cellName(byId.get(x.id)!) : x.id}
            </span>
            <span className="font-mono cm-muted">{x.n}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** The picked card: counts, recent changes, requirement areas, relations, [단계별 들어가기]. */
function Detail({
  s,
  b,
  d,
  rel,
  band,
  mobile,
  plain,
  note,
  onInto,
  onFeature,
  onClose,
}: {
  s: MapStructure;
  b: MapBlock;
  d: MapBlockDetail | null;
  rel: Relations;
  band: string;
  mobile: boolean;
  /** 설계: a planned cell has no recent changes, requirement areas or sub-map. */
  plain: boolean;
  note: ReactNode;
  onInto: () => void;
  onFeature: (key: string) => void;
  onClose: () => void;
}) {
  const [relOpen, setRelOpen] = useState(false);
  const into = (
    <Button
      size="sm"
      variant="active"
      className="ac-into pointer-coarse:min-h-44"
      onClick={onInto}
      data-testid="arch-card-into"
      data-deeper={b.deeper || undefined}
    >
      <PixelIcon name="up" /> {t('spec.cards.into')}
    </Button>
  );
  const relations = (
    <div className="space-y-4">
      <RelRow arrow="→" label={t('spec.cards.rel.uses')} list={rel.uses} s={s} />
      <RelRow arrow="←" label={t('spec.cards.rel.usedBy')} list={rel.usedBy} s={s} />
      <RelRow arrow="↔" label={t('spec.cards.rel.both')} list={rel.both} s={s} />
    </div>
  );
  return (
    <div className="space-y-8 text-xs min-w-0" data-testid="arch-card-detail" data-id={b.id}>
      <div className="flex items-center gap-8 min-w-0">
        <span className="ui-card-tile">
          <PixelIcon name={iconOf(b)} size={SPEC_CARD_ICON.card} />
        </span>
        <h3 className="ac-detail-name flex-1 min-w-0 truncate">{cellName(b)}</h3>
        {mobile && (
          <span className="ui-chip ui-notch ac-chip">
            {b.kind === 'rail' ? kindWord(b) : `${band} · ${kindWord(b)}`}
          </span>
        )}
        <button
          type="button"
          className="ac-close pointer-coarse:min-h-44 pointer-coarse:min-w-44"
          aria-label={t('spec.cards.close')}
          onClick={onClose}
        >
          ✕
        </button>
      </div>
      <p className="cm-muted break-all">
        {b.kind === 'rail' ? (
          kindWord(b)
        ) : (
          <>
            <span className="font-mono">{b.id}</span> · {band} · {kindWord(b)}
          </>
        )}
      </p>
      <div className="grid grid-cols-4 gap-4">
        <HudCounter label={t('spec.map.block.files')} value={b.files} />
        <HudCounter label={t('spec.map.block.inN')} value={b.in} />
        <HudCounter label={t('spec.map.block.outN')} value={b.out} />
        <HudCounter
          label={t('spec.cards.rel.n')}
          value={rel.partners}
          testId="arch-card-partners"
        />
      </div>
      {note}
      {!plain && (
        <section className="ac-sec">
          <h4 className="ac-sec-title">
            <PixelIcon name="clock" /> {t('spec.cards.recent')}
          </h4>
          {!d ? (
            <p className={muted}>{t('spec.wizard.loading')}</p>
          ) : d.recent.length ? (
            <ul data-testid="arch-card-recent">
              {d.recent.slice(0, mobile ? SPEC_CARD_RECENT_PHONE : SPEC_CARD_RECENT).map((c) => (
                <li key={c.sha} className="flex gap-8 py-2 min-w-0">
                  <span className="ac-bullet" aria-hidden="true" />
                  <span className="font-mono shrink-0 cm-muted">{c.at.slice(5, 10)}</span>
                  <span className="flex-1 min-w-0 truncate" title={c.subject}>
                    {c.subject}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className={muted}>{t('spec.cards.noRecent')}</p>
          )}
        </section>
      )}
      {mobile && (
        <div className={`grid ${plain ? '' : 'grid-cols-[1fr_1.4fr]'} gap-8`}>
          <Button
            size="sm"
            className="pointer-coarse:min-h-44"
            aria-expanded={relOpen}
            onClick={() => setRelOpen((x) => !x)}
            data-testid="arch-card-rel"
          >
            {t('spec.cards.rel.short', {
              uses: rel.uses.length,
              usedBy: rel.usedBy.length,
              both: rel.both.length,
            })}
          </Button>
          {!plain && into}
        </div>
      )}
      {mobile && relOpen && relations}
      {!plain && (
        <section className="ac-sec">
          <h4 className="ac-sec-title">
            <PixelIcon name="flag" /> {t('spec.cards.reqAreas')}
          </h4>
          {d?.features.length ? (
            <div className="cm-chips" data-testid="arch-card-features">
              {d.features.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  className="ui-chip ui-notch ui-raise ac-tag pointer-coarse:min-h-44"
                  onClick={() => onFeature(f.key)}
                  title={f.name}
                  data-key={f.key}
                >
                  {f.name || f.short} {f.reqs}
                </button>
              ))}
            </div>
          ) : (
            d && <p className={muted}>{t('spec.cards.noReqAreas')}</p>
          )}
        </section>
      )}
      {!mobile && (
        <>
          <section className="ac-sec">
            <h4 className="ac-sec-title">
              <PixelIcon name="gear" /> {t('spec.cards.rel')}
            </h4>
            {relations}
          </section>
          {!plain && (
            <div className="ac-foot">
              {into}
              <p className={muted}>
                {b.deeper
                  ? t('spec.cards.intoHint', { name: cellName(b), list: insideText(b) })
                  : t('spec.cards.intoFlat')}
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Board({
  project,
  data,
  s,
  view,
  pick,
  setPick,
  onOpen,
  mobile,
  onInto,
  onFeature,
}: {
  project: string;
  data: TraceMap;
  /** The structure drawn: the code's, or (설계) the design's own fold. */
  s: MapStructure;
  view: MapView;
  /** A card's id, or a ghost's (the design module's id). */
  pick: string | null;
  setPick: Dispatch<SetStateAction<string | null>>;
  /** A drift example opens its card (in 겹쳐 보기). */
  onOpen: (id: string) => void;
  mobile: boolean;
  onInto: (id: string, deeper: boolean) => void;
  onFeature: (key: string) => void;
}) {
  const [filter, setFilter] = useState<CardFilter>(NO_FILTER);
  const [legend, setLegend] = useState(true);
  const flow = useReactFlow();
  const { zoom } = useViewport();
  const dims = mobile ? SPEC_CARD_PHONE : SPEC_CARD;
  const shortOf = useMemo(
    () => new Map(data.features.map((f) => [f.key, f.short])),
    [data.features],
  );
  const bandName = useMemo(() => new Map(s.bands.map((b) => [b.id, b.name])), [s.bands]);
  const shown = useMemo(() => cardOrder(s, filter), [s, filter]);
  // BRN K8: the design's pairs and what only it plans (an old server answers without them: the code view).
  const design = view === 'code' ? undefined : data.design;
  const drift: MapDrift | undefined = view === 'code' ? undefined : data.drift;
  const overlay = view === 'overlay' && !!design && !!drift;
  const marks = useMemo(
    () => (overlay ? cellMarks(design, drift, s.blocks) : new Map<string, CellMark>()),
    [overlay, design, drift, s.blocks],
  );
  const ghostList = useMemo(
    () => (overlay ? ghostsOf(design, drift) : []),
    [overlay, design, drift],
  );
  const ids = [...shown.map((b) => b.id), ...ghostList.map((g) => g.id)];
  const key = ids.join('\n');
  const cells = useMemo(() => gridCells(key ? key.split('\n') : [], dims.cols), [key, dims.cols]);
  // The design's arrows are planned, one pair each: every one is drawn.
  const lines = useMemo(
    () =>
      cardLines(s.pairs, new Set(cells.keys()), view === 'design' ? 1 : SPEC_MAP_ARROW_MIN, pick),
    [s.pairs, cells, pick, view],
  );
  const rel = useMemo(() => (pick ? relationsOf(s.pairs, pick) : null), [s.pairs, pick]);
  const near = useMemo(
    () => new Set(rel ? [...rel.uses, ...rel.usedBy].map((x) => x.id) : []),
    [rel],
  );
  const picked = pick ? s.blocks.find((b) => b.id === pick) : undefined;
  const pickedGhost = pick ? ghostList.find((g) => g.id === pick) : undefined;
  // A planned cell has no history to read.
  const { data: bd } = useTrace<TraceMap>(
    project,
    picked && view !== 'design' ? mapPath([], undefined, pick!) : null,
  );
  const d = bd?.block?.id === pick ? (bd?.block ?? null) : null;

  const nodes = useMemo<Array<CardNode | GhostNode>>(
    () => [
      ...shown.map((b): CardNode => {
        const at = cells.get(b.id)!;
        const band = bandName.get(b.layer ?? '') ?? b.layer ?? '';
        const reqs = b.features
          .slice(0, SPEC_CARD_REQS)
          .map((f) => `${shortOf.get(f.key) ?? f.key} ${f.reqs}`);
        if (b.features.length > SPEC_CARD_REQS) reqs.push(`+${b.features.length - SPEC_CARD_REQS}`);
        return {
          id: b.id,
          type: 'card',
          position: { x: at.col * (dims.w + dims.gapX), y: at.row * (dims.h + dims.gapY) },
          width: dims.w,
          height: dims.h,
          data: {
            b,
            chip: b.kind === 'rail' ? kindWord(b) : `${band} · ${kindWord(b)}`,
            lines: [
              b.inside.length
                ? t('spec.map.inside', { list: insideText(b, SPEC_CARD_INSIDE) })
                : t('spec.cards.line.noInside'),
              ...(view === 'design'
                ? [t('brainDesignMap.line.planned', { count: b.files })]
                : [
                    b.kind === 'rail'
                      ? t('spec.cards.line.rail', { out: b.out, in: b.in, week: b.week })
                      : t('spec.cards.line.layer', { layer: band, week: b.week }),
                    reqs.length
                      ? t('spec.cards.line.reqs', { list: reqs.join(' · ') })
                      : t('spec.cards.line.noReqs'),
                  ]),
            ],
            picked: b.id === pick,
            near: near.has(b.id),
            dim: !!picked && b.id !== pick && !near.has(b.id),
            mobile,
            mark: marks.get(b.id),
            plan: view === 'design',
          },
        };
      }),
      ...ghostList.map((g): GhostNode => {
        const at = cells.get(g.id)!;
        return {
          id: g.id,
          type: 'ghost',
          position: { x: at.col * (dims.w + dims.gapX), y: at.row * (dims.h + dims.gapY) },
          width: dims.w,
          height: dims.h,
          data: { g, picked: g.id === pick, mobile },
        };
      }),
    ],
    [shown, ghostList, marks, cells, bandName, shortOf, dims, pick, picked, near, mobile, view],
  );
  const edges = useMemo<Edge[]>(
    () =>
      lines.map((l) => {
        const [from, to] = sides(cells.get(l.from)!, cells.get(l.to)!);
        const on = !!pick && (l.from === pick || l.to === pick);
        const marker = {
          type: MarkerType.ArrowClosed,
          color: on ? SPEC_CARD_LINE.on : l.two ? SPEC_CARD_LINE.two : SPEC_CARD_LINE.plain,
        };
        return {
          id: l.id,
          source: l.from,
          target: l.to,
          sourceHandle: `s-${from}`,
          targetHandle: `t-${to}`,
          type: 'step',
          className: [
            'ac-e',
            l.two && 'ac-e--two',
            l.bold && 'ac-e--bold',
            on && 'ac-e--on',
            pick && !on && 'ac-e--dim',
          ]
            .filter(Boolean)
            .join(' '),
          markerEnd: marker,
          ...(l.two && { markerStart: marker }),
          data: { n: l.n },
        };
      }),
    [lines, cells, pick],
  );
  // A new set of cards (a filter, the search) fits the view again; a pick does not move it.
  // A phone's pane shrinks under a picked card's sheet: fit again.
  const sheet = mobile && !!pick;
  useEffect(() => {
    const frame = requestAnimationFrame(() => void flow.fitView({ padding: SPEC_CARD_FIT_PAD }));
    return () => cancelAnimationFrame(frame);
  }, [key, flow, sheet]);
  const toggle = (id: string) => setPick((p) => (p === id ? null : id));
  const fit = () => void flow.fitView({ padding: SPEC_CARD_FIT_PAD });

  const pane = (
    <div
      className="tg-root ac-flow"
      data-testid="arch-cards-flow"
      data-cards={nodes.length}
      data-lines={edges.length}
      aria-label={t('spec.cards.graph')}
    >
      {nodes.length ? (
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodeClick={(_, n) => toggle(n.id)}
          onPaneClick={() => setPick(null)}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          edgesFocusable={false}
          zoomOnDoubleClick={false}
          fitView
          fitViewOptions={{ padding: SPEC_CARD_FIT_PAD }}
          minZoom={SPEC_GRAPH_ZOOM.min}
          maxZoom={SPEC_GRAPH_ZOOM.max}
          proOptions={{ hideAttribution: true }}
          colorMode="dark"
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={SPEC_CARD_DOTS.gap}
            size={SPEC_CARD_DOTS.size}
          />
        </ReactFlow>
      ) : (
        <p className={`${muted} p-12`}>{t('spec.cards.empty')}</p>
      )}
    </div>
  );
  const scope =
    shown.length === s.blocks.filter((b) => b.kind !== 'rail').length && !filter.rails
      ? t('spec.cards.scopeAll')
      : t('spec.cards.scopeSome', { count: shown.length });
  // The design modules that hold this card: paired with it, or planning a path inside it.
  const holds = (b: MapBlock) =>
    (design?.modules ?? []).filter(
      (m) => m.cells?.includes(b.id) || m.paths.some((p) => p === b.id || p.startsWith(`${b.id}/`)),
    );
  const detail = pickedGhost ? (
    <GhostDetail g={pickedGhost} onClose={() => setPick(null)} />
  ) : (
    picked &&
    rel && (
      <Detail
        s={s}
        b={picked}
        d={d}
        rel={rel}
        band={bandName.get(picked.layer ?? '') ?? ''}
        mobile={mobile}
        plain={view === 'design'}
        note={
          design && view !== 'code' ? (
            <DesignNote mark={marks.get(picked.id)} modules={holds(picked)} />
          ) : null
        }
        onInto={() => onInto(picked.id, picked.deeper)}
        onFeature={onFeature}
        onClose={() => setPick(null)}
      />
    )
  );
  // An example opens a code card or a ghost, whichever view is drawn now (the click switches to 겹쳐 보기).
  const known = new Set([
    ...(data.structure?.blocks ?? []).map((b) => b.id),
    ...(design && drift ? ghostsOf(design, drift) : []).map((g) => g.id),
  ]);
  const driftBar = drift && design && (
    <DriftBar
      drift={drift}
      blocks={data.structure?.blocks ?? []}
      design={design}
      known={known}
      onOpen={onOpen}
    />
  );

  if (mobile)
    return (
      <div
        className="ac-phone"
        data-testid="arch-cards"
        data-mobile=""
        data-picked={pick ? '' : undefined}
      >
        <div className="flex items-center gap-8 min-w-0">
          <span className={`${muted} flex-1 min-w-0 truncate`}>
            {t('spec.cards.crumbs', { project, scope })}
          </span>
          <Button
            size="sm"
            className="pointer-coarse:min-h-44 pointer-coarse:min-w-44"
            onClick={fit}
            aria-label={t('spec.cards.fit')}
            data-testid="arch-card-fit"
          >
            <PixelIcon name="max" />
          </Button>
        </div>
        {pane}
        {driftBar}
        {detail && (
          <div className="ui-window ac-sheet" data-testid="arch-card-sheet">
            <span className="ac-grip" aria-hidden="true" />
            {detail}
          </div>
        )}
      </div>
    );

  const wire = (k: 'import' | 'two') => <span className="ac-wire" data-k={k} aria-hidden="true" />;
  const summary: ReactNode =
    picked && rel ? (
      <>
        <strong>{t('spec.cards.sum.title')}</strong>
        <Dot on={linkedOf(picked) === 'linked'} />
        <span>{cellName(picked)}</span>
        <span>
          ·{' '}
          {t('spec.cards.sum.line', {
            files: picked.files,
            uses: rel.uses.length,
            usedBy: rel.usedBy.length,
            week: picked.week,
          })}
        </span>
        {d?.recent[0] && (
          <span>· {t('spec.cards.sum.recent', { date: d.recent[0].at.slice(5, 10) })}</span>
        )}
      </>
    ) : (
      <>
        <strong>{t('spec.cards.sum.allTitle')}</strong>
        <span>
          {t('spec.cards.sum.all', {
            modules: shown.length,
            files: s.files,
            imports: s.imports,
            lines: edges.length,
          })}
        </span>
      </>
    );
  return (
    <div className="ac-root" data-testid="arch-cards">
      <TreeSide
        project={project}
        s={s}
        shown={shown.length}
        pick={pick}
        onPick={toggle}
        filter={filter}
        setFilter={setFilter}
      />
      <section className="pixel-panel ac-main" aria-label={t('spec.mapTab.arch')}>
        <div className="ac-tools">
          <span className="flex-1 min-w-0 truncate">
            {t('spec.cards.crumbs', { project, scope })}
          </span>
          <span className="ui-chip ac-label">
            <PixelIcon name="board" size={SPEC_CARD_ICON.small} /> {t('spec.cards.layout')}
          </span>
          <span className="ac-zoom">
            <Button
              size="sm"
              onClick={() => void flow.zoomOut()}
              aria-label={t('spec.cards.zoomOut')}
            >
              −
            </Button>
            <span className="ui-input ac-zoom-v" data-testid="arch-card-zoom">
              {Math.round(zoom * 100)}%
            </span>
            <Button
              size="sm"
              onClick={() => void flow.zoomIn()}
              aria-label={t('spec.cards.zoomIn')}
            >
              +
            </Button>
          </span>
          <Button
            size="sm"
            onClick={fit}
            aria-label={t('spec.cards.fit')}
            title={t('spec.cards.fit')}
            data-testid="arch-card-fit"
          >
            <PixelIcon name="max" size={SPEC_CARD_ICON.small} />
          </Button>
          {view !== 'design' && (
            <Button
              size="sm"
              variant={legend ? 'active' : 'default'}
              aria-pressed={legend}
              onClick={() => setLegend((x) => !x)}
            >
              {t('spec.cards.legend')}
            </Button>
          )}
        </div>
        {legend && view !== 'design' && (
          <p className="ui-sunken ac-legend" data-testid="arch-card-legend">
            <span>▸ {t('spec.cards.legend.title')}</span>
            <span className="flex items-center gap-4">
              <Dot on /> {t('spec.cards.legend.linked')}
            </span>
            <span className="flex items-center gap-4">
              <Dot on={false} /> {t('spec.cards.legend.unlinked')}
            </span>
            <span className="flex items-center gap-4">
              {wire('import')} {t('spec.cards.legend.import')}
            </span>
            <span className="flex items-center gap-4">
              {wire('two')} {t('spec.cards.legend.two')}
            </span>
            <span className="cm-muted">
              {t('spec.cards.legend.bold', { min: SPEC_MAP_ARROW_MIN })}
            </span>
          </p>
        )}
        {pane}
        {driftBar}
        <p className="ui-sunken ac-sum" data-testid="arch-card-sum">
          <PixelIcon name="ask" size={SPEC_CARD_ICON.small} />
          {summary}
        </p>
      </section>
      <aside className="pixel-panel ac-detail" aria-label={t('spec.cards.sum.title')}>
        {detail ?? (
          <div className="space-y-8 text-xs">
            <p className={muted}>{t('spec.cards.pickHint')}</p>
            <div className="grid grid-cols-2 gap-4">
              <HudCounter
                label={t('spec.map.count.modules')}
                value={s.blocks.filter((b) => b.kind !== 'rail').length}
              />
              <HudCounter label={t('spec.map.block.files')} value={s.files} />
              <HudCounter label={t('spec.cards.imports')} value={s.imports} />
              <HudCounter label={t('spec.cards.violations')} value={s.violations} />
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}

export function ArchCards({
  project,
  mobile,
  onInto,
  onFeature,
}: {
  project: string;
  mobile: boolean;
  onInto: (id: string, deeper: boolean) => void;
  onFeature: (key: string) => void;
}) {
  const [view, setView] = useState<MapView>('code');
  const [pick, setPick] = useState<string | null>(null);
  // Only 설계 and 겹쳐 보기 ask for the design; the 코드 view reads what it always did.
  // ponytail: the top fold only (the server's drift is top-level): the switch stays out of the sub-map.
  const { data, error } = useTrace<TraceMap>(
    project,
    mapPath([], undefined, undefined, wantsDesign(view)),
  );
  const show = (v: MapView, id: string | null = null) => {
    setView(v);
    setPick(id);
  };
  const body = (() => {
    if (error)
      return (
        <p className="text-red-400" role="alert">
          {error}
        </p>
      );
    if (!data) return <p className={muted}>{t('spec.wizard.loading')}</p>;
    if (!data.enabled)
      return (
        <p className="pixel-panel p-8" data-testid="map-empty" data-why="off">
          {t('spec.map.empty.off')}
        </p>
      );
    // 설계: the design's own fold; the code's when the view is 코드 or 겹쳐 보기.
    const s = view === 'design' ? (data.design?.structure ?? null) : data.structure;
    if (!s || !s.blocks.length)
      return (
        <p
          className={muted}
          data-testid={view === 'design' ? 'dm-empty' : s ? 'map-no-code' : 'map-no-scan'}
        >
          {t(
            view === 'design' ? 'brainDesignMap.empty' : s ? 'spec.map.noCode' : 'spec.map.noScan',
          )}
        </p>
      );
    return (
      <ReactFlowProvider>
        <Board
          key={view}
          project={project}
          data={data}
          s={s}
          view={view}
          pick={pick}
          setPick={setPick}
          onOpen={(id) => show('overlay', id)}
          mobile={mobile}
          onInto={onInto}
          onFeature={onFeature}
        />
      </ReactFlowProvider>
    );
  })();
  return (
    <div
      className={`flex flex-col gap-8 min-w-0 ${mobile ? '' : 'h-full min-h-0'}`}
      data-testid="arch-frame"
      data-view={view}
    >
      <ViewSwitch view={view} onView={(v) => show(v)} />
      <div className={mobile ? 'min-w-0' : 'flex-1 min-h-0 min-w-0'}>{body}</div>
    </div>
  );
}
