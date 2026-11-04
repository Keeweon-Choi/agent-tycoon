/**
 * SPT C1 (§6.8): the 현황판's 지도 tab, features × structure on one screen (R4's b-cockpit.png).
 * Left: the features (LEDs 진행·막힘·원문 바뀜, 볼 것 먼저) and 공통 기준. Middle: the structure, bands
 * top to bottom in import order, at most 9 cells, the rails dashed, arrows (SVG) only between cells
 * with many imports, ⇄ text inside a crowded band, the layer violations and two-way pairs below;
 * a cell picked twice (or Enter) goes one level in, Esc comes up. Right: the picked feature's
 * requirements (a row opens the requirement detail, whose [이웃 그래프] is the requirements graph)
 * or the picked cell. [설계 그림] shows the documents' drawing (ArchGraph). C2 (FR-TRC-018): a picked
 * feature lights the cells it reaches (요구 N, the others dimmed) and shows its chain (요구 → 작업 →
 * 커밋 → 파일, its tasks, [요구→작업→근거 펼치기] by path); a picked cell lights the features that reach
 * it and shows its 7-day activity, recent work and 꼬리표로만 이어진 커밋. Each feature row has its bar
 * (linked / reqs). Everything comes from `GET …/map` (again on `specChanged`).
 * On a phone: [기능]·[구조], a feature row opens its chain in place, the bands stack, no arrows.
 */
import './cockpitMap.css';
import './traceGraph.css';
import '../../i18n/specStrings.js';

import { type KeyboardEvent, lazy, type ReactNode, type RefObject, Suspense, useLayoutEffect, useMemo, useRef, useState } from 'react';

import type { MapBlock, MapFeature, MapFeatureDetail, MapLinkPath, MapPair, MapStructure, TraceMap } from '../../../../core/src/cld/spec/trace.js';
import { Button } from '../../components/ui/Button.js';
import { SPEC_MAP_ARROW_HEAD, SPEC_MAP_ARROW_MIN, SPEC_MAP_BAR_SEGMENTS, SPEC_MAP_CHIPS, SPEC_MAP_LIST_SHOW, SPEC_MAP_TEXT_PAIRS_FROM } from '../../constants.js';
import { t } from '../../i18n/index.js';
import { HudCounter } from '../game/parts.js';
import { ReqDetail } from './ReqDetail.js';
import { mapPath, useTrace } from './traceApi.js';

// [설계 그림] is the graph's chunk (React Flow, dagre): this screen is DOM and one SVG, so it loads only when asked.
const ArchGraph = lazy(() => import('./ArchGraph.js').then((m) => ({ default: m.ArchGraph })));
const muted = 'text-text-muted text-xs';
type Pick = { t: 'feature'; key: string } | { t: 'block'; id: string } | null;

const PATHS: readonly MapLinkPath[] = ['confirmed', 'direct', 'commit', 'task'];
/** A bar of segments: `n` of `of` (근거 막대, a cell's 7-day activity against the busiest). */
function Bar({ n, of, testId }: { n: number; of: number; testId?: string }) {
  const on = of ? Math.round((n / of) * SPEC_MAP_BAR_SEGMENTS) : 0;
  return (
    <span className="cm-bar" aria-hidden="true" data-testid={testId} data-n={n} data-of={of}>
      {Array.from({ length: SPEC_MAP_BAR_SEGMENTS }, (_, i) => (
        <span key={i} className="cm-bar-seg" data-on={i < on || (i === 0 && n > 0) || undefined} />
      ))}
    </span>
  );
}
/** A list shown SPEC_MAP_LIST_SHOW at a time, `+N ▼` for the rest. */
function Folded<T>({ items, more = 0, row }: { items: readonly T[]; more?: number; row: (x: T) => ReactNode }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, SPEC_MAP_LIST_SHOW);
  const rest = items.length - shown.length + more;
  return (
    <ul>
      {shown.map(row)}
      {rest > 0 && (
        <li>
          <button type="button" className="cm-muted pointer-coarse:min-h-44" onClick={() => setAll(true)} disabled={all} data-testid="map-more">
            {t('spec.map.feature.more', { count: rest })} ▼
          </button>
        </li>
      )}
    </ul>
  );
}

const cellName = (b: MapBlock) => (b.kind === 'rail' ? t(`spec.map.rail.${b.id === 'tests' ? 'tests' : 'tools'}`) : b.rest ? t('spec.map.rest', { name: b.name }) : b.name);
const insideText = (b: MapBlock) => b.inside.map((x) => `${x.name || t('spec.map.direct')} ${x.n}`).join(' · ');

function Leds({ f }: { f: Pick3 }) {
  return (
    <span className="cm-leds" aria-hidden="true">
      <span className="cm-led" data-k="progress" data-on={f.progress || undefined} />
      <span className="cm-led" data-k="blocked" data-on={f.blocked || undefined} />
      <span className="cm-led" data-k="changed" data-on={f.changed > 0 || undefined} />
    </span>
  );
}
type Pick3 = { progress: boolean; blocked: boolean; changed: number };
const ledWords = (f: Pick3) =>
  [f.progress && t('spec.map.led.progress'), f.blocked && t('spec.map.led.blocked'), f.changed > 0 && `${t('spec.map.led.changed')} ${f.changed}`].filter(Boolean).join(', ');

function LedLegendLine() {
  return (
    <span className="flex flex-wrap items-center gap-8 text-xs" data-testid="map-legend">
      {(['progress', 'blocked', 'changed'] as const).map((k) => (
        <span key={k} className="flex items-center gap-4">
          <span className="cm-led" data-k={k} data-on />
          {t(`spec.map.legend.${k}`)}
        </span>
      ))}
    </span>
  );
}

/** The left column: features first (볼 것 먼저, the server's order), then 공통 기준 folded by its head. */
function FeatureList({
  data,
  pick,
  onFeature,
  expanded,
  lit,
}: {
  data: TraceMap;
  pick: Pick;
  onFeature: (key: string) => void;
  /** Phone: the open row's body, under it. */
  expanded?: (key: string) => ReactNode;
  /** A cell is picked: the features that reach it (the other rows dim). */
  lit?: ReadonlyMap<string, number> | null;
}) {
  const [common, setCommon] = useState(false);
  const heads = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of data.common) m.set(c.key.split('-')[0], (m.get(c.key.split('-')[0]) ?? 0) + c.reqs);
    return [...m];
  }, [data.common]);
  const row = (key: string, short: string, name: string, n: number, f: Pick3, linked?: number) => (
    <li key={key} data-lit={(lit && lit.has(key)) || undefined} data-dim={(lit && !lit.has(key)) || undefined} className="cm-li">
      <button
        type="button"
        className="cm-row pointer-coarse:min-h-44"
        aria-pressed={pick?.t === 'feature' && pick.key === key}
        aria-label={`${short} ${name} ${t('spec.map.reqs', { count: n })}${ledWords(f) ? `, ${ledWords(f)}` : ''}`}
        onClick={() => onFeature(key)}
        data-testid="map-feature"
        data-key={key}
        data-progress={f.progress || undefined}
        data-blocked={f.blocked || undefined}
        data-changed={f.changed || undefined}
        data-linked={linked}
        data-lit={(lit && lit.has(key)) || undefined}
      >
        <Leds f={f} />
        <span className="cm-short font-mono" title={short}>
          {short}
        </span>
        <span className="flex-1 min-w-0 truncate" title={name}>
          {name}
        </span>
        {lit?.has(key) && <span className="cm-badge">{t('spec.map.badge', { count: lit.get(key)! })}</span>}
        {linked !== undefined && <Bar n={linked} of={n} />}
        <span className="cm-muted shrink-0">{linked !== undefined ? `${linked}/${n}` : n}</span>
      </button>
      {expanded?.(key)}
    </li>
  );
  if (!data.features.length && !data.common.length)
    return (
      <p className={muted} data-testid="map-no-reqs">
        {t('spec.map.noReqs')}
      </p>
    );
  return (
    <div className="space-y-4 min-w-0" data-testid="map-features">
      <p className="flex items-center gap-8">
        <span className="flex-1">{t('spec.map.features', { count: data.features.length })}</span>
        <span className={muted}>{t('spec.map.sort')}</span>
      </p>
      <ul>{data.features.map((f: MapFeature) => row(f.key, f.short, f.name, f.reqs, f, f.linked))}</ul>
      {!!data.common.length && (
        <>
          <button type="button" className="cm-row pointer-coarse:min-h-44" aria-expanded={common} onClick={() => setCommon((x) => !x)} data-testid="map-common">
            <span className="flex-1 min-w-0">
              {t('spec.map.common')} <span className="cm-muted">{heads.map(([h, n]) => `${h} ${n}`).join(' · ')}</span>
            </span>
            <span aria-hidden="true">{common ? '▼' : '▶'}</span>
          </button>
          {common && <ul>{data.common.map((c) => row(c.key, c.key.split('-')[0], c.key, c.reqs, { progress: false, blocked: false, changed: c.changed }))}</ul>}
        </>
      )}
    </div>
  );
}

/**
 * The arrows between cells (desktop): drawn after layout from the cells' boxes, again on a resize.
 * Measured against the SVG's own parent: a parent's ref is attached only after its children's layout effects.
 */
function Arrows({ cells, s }: { cells: RefObject<Map<string, HTMLElement>>; s: MapStructure }) {
  const svg = useRef<SVGSVGElement>(null);
  const [lines, setLines] = useState<Array<{ key: string; x1: number; y1: number; x2: number; y2: number; two: boolean }>>([]);
  const drawn = useMemo(() => {
    const byId = new Map(s.blocks.map((b) => [b.id, b]));
    const size = new Map(s.bands.map((b) => [b.id, b.blocks.length]));
    return s.pairs.filter((p) => {
      const a = byId.get(p.a)!;
      const b = byId.get(p.b)!;
      const crowded = a.layer === b.layer && (size.get(a.layer ?? '') ?? 0) >= SPEC_MAP_TEXT_PAIRS_FROM;
      return !crowded && Math.max(p.ab, p.ba) >= SPEC_MAP_ARROW_MIN;
    });
  }, [s]);
  useLayoutEffect(() => {
    const el = svg.current?.parentElement;
    if (!el) return;
    const rank = new Map(s.bands.map((b, i) => [b.id, i]));
    const layerOf = new Map(s.blocks.map((b) => [b.id, b.layer ?? '']));
    const draw = () => {
      const box = el.getBoundingClientRect();
      const r = (id: string) => cells.current.get(id)?.getBoundingClientRect();
      setLines(
        drawn.flatMap((p: MapPair) => {
          // From the importer to the imported (two-way: both heads).
          const [from, to] = p.ab >= p.ba ? [p.a, p.b] : [p.b, p.a];
          const a = r(from);
          const b = r(to);
          if (!a || !b) return [];
          const same = layerOf.get(from) === layerOf.get(to);
          const down = (rank.get(layerOf.get(from)!) ?? 0) < (rank.get(layerOf.get(to)!) ?? 0);
          const mid = (x: DOMRect) => x.left + x.width / 2 - box.left;
          const [x1, y1, x2, y2] = same
            ? a.left < b.left
              ? [a.right - box.left, a.top + a.height / 2 - box.top, b.left - box.left, b.top + b.height / 2 - box.top]
              : [a.left - box.left, a.top + a.height / 2 - box.top, b.right - box.left, b.top + b.height / 2 - box.top]
            : down
              ? [mid(a), a.bottom - box.top, mid(b), b.top - box.top]
              : [mid(a), a.top - box.top, mid(b), b.bottom - box.top];
          return [{ key: `${p.a}|${p.b}`, x1, y1, x2, y2, two: p.ab > 0 && p.ba > 0 }];
        }),
      );
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(el);
    return () => ro.disconnect();
  }, [cells, s, drawn]);
  const h = SPEC_MAP_ARROW_HEAD;
  return (
    <svg ref={svg} className="cm-arrows" aria-hidden="true" data-testid="map-arrows" data-count={lines.length}>
      <defs>
        <marker id="cm-head" viewBox={`0 0 ${h} ${h}`} refX={h} refY={h / 2} markerWidth={h} markerHeight={h} orient="auto-start-reverse">
          <path d={`M0,0 L${h},${h / 2} L0,${h} z`} className="cm-head" />
        </marker>
        <marker id="cm-head-two" viewBox={`0 0 ${h} ${h}`} refX={h} refY={h / 2} markerWidth={h} markerHeight={h} orient="auto-start-reverse">
          <path d={`M0,0 L${h},${h / 2} L0,${h} z`} className="cm-head--two" />
        </marker>
      </defs>
      {lines.map((l) => (
        <line
          key={l.key}
          x1={l.x1}
          y1={l.y1}
          x2={l.x2}
          y2={l.y2}
          className={`cm-arrow ${l.two ? 'cm-arrow--two' : ''}`}
          markerEnd={`url(#${l.two ? 'cm-head-two' : 'cm-head'})`}
          markerStart={l.two ? 'url(#cm-head-two)' : undefined}
        />
      ))}
    </svg>
  );
}

/** The middle column: bands of cells, rails, and the foot line. */
function Structure({
  s,
  mobile,
  pick,
  onBlock,
  onIn,
  onUp,
  shortOf,
}: {
  s: MapStructure;
  mobile: boolean;
  pick: Pick;
  onBlock: (id: string) => void;
  onIn: (id: string) => void;
  onUp: () => void;
  shortOf: ReadonlyMap<string, string>;
}) {
  const cells = useRef(new Map<string, HTMLElement>());
  const byId = useMemo(() => new Map(s.blocks.map((b) => [b.id, b])), [s]);
  // A picked feature: the cells it reaches and with how many of its requirements (요구 N).
  const feature = pick?.t === 'feature' ? pick.key : null;
  const light = useMemo(() => (feature ? new Map(s.blocks.flatMap((b) => b.features.filter((f) => f.key === feature).map((f) => [b.id, f.reqs] as const))) : null), [s, feature]);
  const most = light ? Math.max(1, ...light.values()) : 1;
  const busiest = Math.max(1, ...s.blocks.map((b) => b.week));
  /** A crowded band's cell says its biggest partner there: ⇄ name out·in. */
  const pairText = (b: MapBlock) => {
    const band = s.bands.find((x) => x.id === b.layer);
    if (!band || band.blocks.length < SPEC_MAP_TEXT_PAIRS_FROM || b.kind !== 'unit') return null;
    const p = s.pairs.find((x) => (x.a === b.id || x.b === b.id) && byId.get(x.a === b.id ? x.b : x.a)?.layer === b.layer);
    if (!p) return null;
    const mine = p.a === b.id;
    return t('spec.map.pairText', { name: cellName(byId.get(mine ? p.b : p.a)!), out: mine ? p.ab : p.ba, in: mine ? p.ba : p.ab });
  };
  const cell = (b: MapBlock) => {
    const picked = pick?.t === 'block' && pick.id === b.id;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && picked && b.deeper) {
        e.preventDefault();
        onIn(b.id);
      }
    };
    const pt = pairText(b);
    const lit = light?.get(b.id);
    const chips = b.features.filter((f) => shortOf.has(f.key));
    return (
      <button
        key={b.id}
        ref={(el) => void (el ? cells.current.set(b.id, el) : cells.current.delete(b.id))}
        type="button"
        className="cm-cell pointer-coarse:min-h-44"
        data-kind={b.kind}
        data-rest={(b.rest && !mobile) || undefined}
        aria-pressed={picked}
        onClick={() => onBlock(b.id)}
        onDoubleClick={() => b.deeper && onIn(b.id)}
        onKeyDown={onKeyDown}
        data-testid="map-cell"
        data-id={b.id}
        data-files={b.files}
        data-lit={lit}
        data-dim={(light && lit === undefined) || undefined}
        data-week={b.week}
      >
        {lit !== undefined && (
          <span className="cm-badge cm-cell-badge" data-testid="map-cell-badge" style={{ ['--cm-w' as string]: lit / most }}>
            {t('spec.map.badge', { count: lit })}
          </span>
        )}
        <span className="cm-cell-name">
          {cellName(b)} <span className="cm-muted">{b.files}</span>
        </span>
        <span className="cm-pair cm-muted flex items-center gap-4">
          <Bar n={b.week} of={busiest} /> {t('spec.map.week', { count: b.week })}
        </span>
        {!light && !!chips.length && (
          <span className="cm-chips">
            {chips.slice(0, SPEC_MAP_CHIPS).map((f) => (
              <span key={f.key} className="cm-chip">
                {shortOf.get(f.key)} {f.reqs}
              </span>
            ))}
            {chips.length > SPEC_MAP_CHIPS && <span className="cm-muted">+{chips.length - SPEC_MAP_CHIPS}</span>}
          </span>
        )}
        {b.kind !== 'unit' && !!b.inside.length && <span className="cm-muted cm-pair">{t('spec.map.inside', { list: insideText(b) })}</span>}
        {b.kind === 'rail' && <span className="cm-muted cm-pair">{`${t('spec.map.block.out', { count: b.out })} · ${t('spec.map.block.in', { count: b.in })}`}</span>}
        {pt && <span className="cm-two-text cm-pair">{pt}</span>}
      </button>
    );
  };
  const two = s.pairs.filter((p) => p.ab && p.ba);
  const rails = s.blocks.filter((b) => b.kind === 'rail');
  const litCells = light ? [...light.keys()].map((id) => byId.get(id)!) : [];
  return (
    <div className="space-y-4 min-w-0" onKeyDown={(e) => e.key === 'Escape' && s.crumbs.length > 0 && (e.preventDefault(), onUp())}>
      {feature && (
        <p className="text-xs" data-testid="map-reach" data-cells={litCells.filter((b) => b.kind !== 'rail').length} data-rails={litCells.filter((b) => b.kind === 'rail').length}>
          {t('spec.map.reach', { short: shortOf.get(feature) ?? feature, cells: litCells.filter((b) => b.kind !== 'rail').length, rails: litCells.filter((b) => b.kind === 'rail').length })}
        </p>
      )}
      <div className="cm-canvas" data-testid="map-structure" data-violations={s.violations} data-bands={s.bands.length}>
        {s.bands.map((band) => (
          <section key={band.id} className="cm-band" data-testid="map-band" data-id={band.id}>
            <p className={muted}>
              {band.name !== band.id ? `${band.name} · ${band.id}` : band.id} {band.files}
            </p>
            <div className="cm-cells">{band.blocks.map((id) => cell(byId.get(id)!))}</div>
          </section>
        ))}
        {!!rails.length && <div className="cm-rails">{rails.map(cell)}</div>}
        {!mobile && <Arrows cells={cells} s={s} />}
      </div>
      <p className="text-xs" data-testid="map-foot">
        <span className={s.violations ? 'cm-bad' : ''}>{t('spec.map.violations', { count: s.violations })}</span>
        {' · '}
        {two.length ? (
          <>
            {t('spec.map.twoWay', { a: cellName(byId.get(two[0].a)!), b: cellName(byId.get(two[0].b)!), ab: two[0].ab, ba: two[0].ba })}
            {two.length > 1 && ` ${t('spec.map.twoWayMore', { count: two.length - 1 })}`}
          </>
        ) : (
          t('spec.map.noTwoWay')
        )}
      </p>
      {!!s.violationFiles.length && (
        <details className="text-xs">
          <summary className="cm-bad pointer-coarse:min-h-44">{t('spec.map.violationFiles')}</summary>
          <ul className="font-mono break-all">
            {s.violationFiles.map(([a, b]) => (
              <li key={`${a}>${b}`}>
                {a} → {b}
              </li>
            ))}
          </ul>
        </details>
      )}
      <p className={muted} data-testid="map-measured">
        {!mobile && `${t('spec.map.arrowHint', { min: SPEC_MAP_ARROW_MIN })} · `}
        {t('spec.map.measured', { files: s.files, imports: s.imports, ms: s.ms })}
        {s.partial && ` · ${t(`spec.map.partial.${s.partial}`)}`}
        {!!s.big && ` · ${t('spec.map.big', { count: s.big })}`}
      </p>
    </div>
  );
}

/** The right column for a cell: its counts, what it trades with, what is in it, [한 단계 들어가기]. */
function BlockPanel({ project, chain, s, id, onIn, onFeature }: { project: string; chain: readonly string[]; s: MapStructure; id: string; onIn: (id: string) => void; onFeature: (key: string) => void }) {
  const { data } = useTrace<TraceMap>(project, mapPath(chain, undefined, id));
  const d = data?.block?.id === id ? data.block : null;
  const b = s.blocks.find((x) => x.id === id);
  if (!b) return null;
  const byId = new Map(s.blocks.map((x) => [x.id, x]));
  const pairs = s.pairs.filter((p) => p.a === id || p.b === id);
  return (
    <div className="space-y-8 text-xs" data-testid="map-block" data-id={id}>
      <h3 className="break-words">{cellName(b)}</h3>
      <p className="cm-muted font-mono break-all">{b.kind === 'rail' ? '' : b.id}</p>
      <div className="grid grid-cols-4 gap-4">
        <HudCounter label={t('spec.map.block.files')} value={b.files} />
        <HudCounter label={t('spec.map.block.inN')} value={b.in} />
        <HudCounter label={t('spec.map.block.outN')} value={b.out} />
        <HudCounter label={t('spec.map.block.week')} value={b.week} testId="map-block-week" />
      </div>
      {d && (
        <>
          <p className={muted}>{t('spec.map.block.features', { count: d.features.length })}</p>
          {d.features.length ? (
            <div className="cm-chips" data-testid="map-block-features">
              {d.features.map((f) => (
                <button key={f.key} type="button" className="cm-chip pointer-coarse:min-h-44" onClick={() => onFeature(f.key)} title={f.name} data-key={f.key}>
                  {f.short} {f.reqs}
                </button>
              ))}
            </div>
          ) : (
            <p className={muted}>{t('spec.map.block.noFeatures')}</p>
          )}
          <p className={muted}>{t('spec.map.block.recent')}</p>
          <ul data-testid="map-block-recent">
            {d.recent.map((c) => (
              <li key={c.sha} className="flex gap-8 border-b border-border py-2 min-w-0">
                <span className="font-mono shrink-0 cm-muted">{c.at.slice(5, 10)}</span>
                <span className="flex-1 min-w-0 break-words">{c.subject}</span>
              </li>
            ))}
          </ul>
          {!!d.tags.length && <p className="cm-muted break-words">{t('spec.map.block.tags', { list: d.tags.map((x) => `${x.tag} ${x.files}`).join(' · ') })}</p>}
          <p className="cm-muted" data-testid="map-block-tag-only" data-n={d.tagOnly}>
            {t('spec.map.tagOnly', { count: d.tagOnly })}
          </p>
        </>
      )}
      {!!pairs.length && (
        <>
          <p className={muted}>{t('spec.map.block.pairs')}</p>
          <ul>
            {pairs.map((p) => {
              const mine = p.a === id;
              const other = byId.get(mine ? p.b : p.a)!;
              return (
                <li key={other.id} className="flex gap-8 border-b border-border py-2">
                  <span className="flex-1 min-w-0 break-words">{cellName(other)}</span>
                  <span className="font-mono">
                    → {mine ? p.ab : p.ba} · ← {mine ? p.ba : p.ab}
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {!!b.inside.length && (
        <>
          <p className={muted}>{t('spec.map.block.inside')}</p>
          <ul className="font-mono break-all">
            {b.inside.map((x) => (
              <li key={x.name}>
                {x.name || t('spec.map.direct')} {x.n}
              </li>
            ))}
          </ul>
        </>
      )}
      {b.deeper && (
        <>
          <Button size="sm" variant="active" onClick={() => onIn(b.id)} data-testid="map-into">
            {t('spec.map.into')}
          </Button>
          <p className={muted}>{t('spec.map.block.intoHint')}</p>
        </>
      )}
    </div>
  );
}

/** [요구→작업→근거 펼치기]: per requirement its tasks and its files by each path (a path off by default is dimmed). */
function ChainTable({ f, on }: { f: MapFeatureDetail; on: ReadonlySet<MapLinkPath> }) {
  return (
    <div className="overflow-x-auto" data-testid="map-chain-table">
      <table className="cm-table">
        <thead>
          <tr>
            <th>{t('spec.map.feature.reqs')}</th>
            <th>{t('spec.map.chain.tasks')}</th>
            {PATHS.map((p) => (
              <th key={p} data-off={!on.has(p) || undefined} title={on.has(p) ? undefined : t('spec.map.path.off')}>
                {t(`spec.map.path.${p}`)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {f.reqs.map((r) => (
            <tr key={r.uid} data-uid={r.uid}>
              <td className="font-mono">{r.label}</td>
              <td title={r.tasks?.join(' ')}>{r.tasks?.length ?? '–'}</td>
              {PATHS.map((p) => {
                const x = r.paths?.[p];
                return (
                  <td key={p} data-off={!on.has(p) || undefined} title={x?.files.join('\n')}>
                    {x ? x.n : '–'}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {PATHS.some((p) => !on.has(p)) && <p className={muted}>{t('spec.map.path.offNote', { list: PATHS.filter((p) => !on.has(p)).map((p) => t(`spec.map.path.${p}`)).join(', ') })}</p>}
    </div>
  );
}

/** The picked feature's chain (요구 → 작업 → 커밋 → 파일), its requirements (a row opens the detail), its tasks, its recent work, [펼치기]. */
function FeaturePanel({
  project,
  chain,
  feature,
  onReq,
  mobile,
  s,
  onStructure,
}: {
  project: string;
  chain: readonly string[];
  feature: string;
  onReq: (uid: string) => void;
  mobile?: boolean;
  s?: MapStructure | null;
  onStructure?: () => void;
}) {
  const { data, error } = useTrace<TraceMap>(project, mapPath(chain, feature));
  const [open, setOpen] = useState(false);
  const f = data?.feature;
  const on = new Set(data?.pathsOn ?? []);
  const changed = f ? f.reqs.filter((r) => r.changed).length : 0;
  // Phone: the cells it reaches, band by band (화면 → 데몬 → core), then the rails.
  const reached = s ? [...s.bands.flatMap((band) => band.blocks), ...s.blocks.filter((b) => b.kind === 'rail').map((b) => b.id)].map((id) => s.blocks.find((b) => b.id === id)!).filter((b) => b.features.some((x) => x.key === feature)) : [];
  const n = (b: MapBlock) => b.features.find((x) => x.key === feature)?.reqs ?? 0;
  return (
    <div className="space-y-8 text-xs min-w-0" data-testid="map-feature-panel" data-key={feature}>
      {error && (
        <p className="text-red-400" role="alert">
          {error}
        </p>
      )}
      {!f && !error && <p className={muted}>{t('spec.wizard.loading')}</p>}
      {f && (
        <>
          <h3 className="break-words">
            <span className="cm-short font-mono">{feature.split('-').pop()}</span> {f.name}
          </h3>
          {f.source && <p className="cm-muted break-all">{t('spec.map.feature.source', { path: f.source.path, count: f.reqs.length + f.more })}</p>}
          <div className="cm-chain" data-testid="map-chain" data-reqs={f.chain.reqs} data-tasks={f.chain.tasks} data-commits={f.chain.commits} data-files={f.chain.files}>
            <HudCounter label={t('spec.map.chain.reqs')} value={f.chain.reqs} />
            <span aria-hidden="true">→</span>
            <HudCounter label={t('spec.map.chain.tasks')} value={f.chain.tasks} />
            <span aria-hidden="true">→</span>
            <HudCounter label={t('spec.map.chain.commits')} value={f.chain.commits} />
            <span aria-hidden="true">→</span>
            {mobile ? <HudCounter label={t('spec.map.chain.week')} value={f.week} /> : <HudCounter label={t('spec.map.chain.files')} value={f.chain.files} />}
          </div>
          <p className={muted}>{t('spec.map.chain.hint', { count: on.size })}</p>
          {mobile && s && (
            <>
              <p className={muted}>{t('spec.map.chain.cells', { count: reached.length })}</p>
              <ul className="space-y-4" data-testid="map-feature-cells">
                {reached.map((b) => (
                  <li key={b.id} className="cm-cell" data-kind={b.kind} data-id={b.id}>
                    <span className="flex items-center gap-8">
                      <span className="flex-1 min-w-0 break-words">{cellName(b)}</span>
                      <span className="cm-badge">{t('spec.map.badge', { count: n(b) })}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          <p className={muted}>{t('spec.map.feature.reqs')}</p>
          <Folded
            items={f.reqs}
            more={f.more}
            row={(r) => (
              <li key={r.uid}>
                <button type="button" className="cm-row pointer-coarse:min-h-44" onClick={() => onReq(r.uid)} data-testid="map-feature-req" data-uid={r.uid} data-changed={r.changed || undefined}>
                  <span className="cm-led" data-k="progress" data-on={PATHS.some((p) => on.has(p) && r.paths?.[p]) || undefined} title={t('spec.map.feature.linkedLed')} />
                  <span className="font-mono shrink-0">{r.label}</span>
                  <span className="flex-1 min-w-0 truncate cm-muted">{r.title}</span>
                  {r.changed && <span className="cm-led" data-k="changed" data-on title={t('spec.map.feature.changed')} />}
                </button>
              </li>
            )}
          />
          <p className={muted}>{t('spec.map.chain.tasks')}</p>
          {f.tasks.length ? (
            <Folded
              items={f.tasks}
              more={f.tasksMore}
              row={(x) => (
                <li key={x.id} className="flex gap-8 py-2 min-w-0" data-testid="map-feature-task">
                  <span className="font-mono shrink-0">{x.id}</span>
                  <span className="flex-1 min-w-0 truncate">{x.title}</span>
                  <span className="cm-chip shrink-0">{x.reqs}</span>
                </li>
              )}
            />
          ) : (
            <p className={muted}>{t('spec.map.chain.noTasks')}</p>
          )}
          <p className={muted}>{t('spec.map.chain.recent')}</p>
          <p data-testid="map-feature-recent">{t('spec.map.chain.recentLine', { week: f.week, changed })}</p>
          <div className="flex flex-wrap gap-4">
            <Button size="sm" variant={open ? 'active' : 'default'} aria-expanded={open} onClick={() => setOpen((x) => !x)} data-testid="map-chain-open" className="pointer-coarse:min-h-44">
              {t('spec.map.chain.open')}
            </Button>
            {mobile && onStructure && (
              <Button size="sm" onClick={onStructure} data-testid="map-to-structure" className="pointer-coarse:min-h-44">
                {t('spec.map.chain.toStructure')}
              </Button>
            )}
          </div>
          {open && <ChainTable f={f} on={on} />}
        </>
      )}
    </div>
  );
}

export function MapTab({ project, mobile }: { project: string; mobile: boolean }) {
  const [chain, setChain] = useState<string[]>([]);
  const [pick, setPick] = useState<Pick>(null);
  const [req, setReq] = useState<string | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [phoneView, setPhoneView] = useState<'features' | 'structure'>('features');
  const { data, error } = useTrace<TraceMap>(project, mapPath(chain));
  const s = data?.structure ?? null;
  const shortOf = useMemo(() => new Map((data?.features ?? []).map((f) => [f.key, f.short])), [data]);
  const picked = pick?.t === 'block' ? s?.blocks.find((b) => b.id === pick.id) : undefined;
  const lit = useMemo(() => (picked ? new Map(picked.features.map((f) => [f.key, f.reqs])) : null), [picked]);
  const featureReqs = data ? data.features.reduce((n, f) => n + f.reqs, 0) : 0;
  const go = (next: string[]) => {
    setChain(next);
    setPick(null);
  };
  const onFeature = (key: string) => setPick((p) => (p?.t === 'feature' && p.key === key && mobile ? null : { t: 'feature', key }));
  const onBlock = (id: string) => setPick((p) => (p?.t === 'block' && p.id === id ? null : { t: 'block', id }));
  const pickFeature = (key: string) => setPick({ t: 'feature', key });
  const onIn = (id: string) => go([...chain, id]);
  const onUp = () => go(chain.slice(0, -1));

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

  const crumbs = (
    <nav aria-label={t('spec.map.crumbs')} className="flex flex-wrap items-center gap-4 min-w-0" data-testid="map-crumbs">
      <Button size="sm" variant={chain.length ? 'default' : 'active'} onClick={() => go([])}>
        {t('spec.map.structure')}
      </Button>
      {s?.crumbs.map((c, i) => (
        <span key={c.id} className="flex items-center gap-4 min-w-0">
          <span className="text-text-muted">›</span>
          <Button size="sm" variant={i === s.crumbs.length - 1 ? 'active' : 'default'} onClick={() => go(chain.slice(0, i + 1))} data-id={c.id}>
            {c.name}
          </Button>
        </span>
      ))}
    </nav>
  );
  const structure = !s ? (
    <p className={muted} data-testid="map-no-scan">
      {t('spec.map.noScan')}
    </p>
  ) : s.blocks.length ? (
    <>
      <Structure s={s} mobile={mobile} pick={pick} onBlock={onBlock} onIn={onIn} onUp={onUp} shortOf={shortOf} />
      <p className={muted} data-testid="map-tag-only" data-n={data.tagOnly} data-commits={data.commits}>
        {t('spec.map.commitsRead', { count: data.commits })}
        {data.commitsCapped && ` · ${t('spec.map.commitsCapped')}`} · {t('spec.map.tagOnly', { count: data.tagOnly })}
      </p>
    </>
  ) : (
    <p className={muted} data-testid="map-no-code">
      {t('spec.map.noCode')}
    </p>
  );
  const right = req ? (
    <ReqDetail project={project} uid={req} mobile={mobile} onClose={() => setReq(null)} />
  ) : pick?.t === 'feature' ? (
    <FeaturePanel project={project} chain={chain} feature={pick.key} onReq={setReq} />
  ) : pick?.t === 'block' && s ? (
    <BlockPanel project={project} chain={chain} s={s} id={pick.id} onIn={onIn} onFeature={pickFeature} />
  ) : (
    <p className={muted}>{t('spec.map.pickHint')}</p>
  );
  const counters = (
    <div className="flex flex-wrap gap-4">
      <HudCounter label={t('spec.map.count.features')} value={data.features.length} testId="map-n-features" />
      <HudCounter label={t('spec.map.count.modules')} value={s ? s.blocks.filter((b) => b.kind !== 'rail').length : undefined} testId="map-n-modules" />
      <HudCounter label={t('spec.map.count.linked', { total: featureReqs })} value={data.linked} testId="map-n-linked" />
      <HudCounter label={t('spec.map.count.changed')} value={data.changed} testId="map-n-changed" />
    </div>
  );

  if (mobile)
    return (
      <div className="space-y-8 text-xs min-w-0" data-testid="map-tab" data-mobile="">
        <div className="cm-toggle" role="group" aria-label={t('spec.map.phone.view')}>
          {(['features', 'structure'] as const).map((v) => (
            <Button key={v} size="sm" variant={phoneView === v ? 'active' : 'default'} aria-pressed={phoneView === v} onClick={() => setPhoneView(v)} data-view={v} className="pointer-coarse:min-h-44">
              {v === 'features' ? t('spec.map.count.features') : t('spec.map.structure')}
            </Button>
          ))}
        </div>
        <p className={muted}>
          {t('spec.map.phone.linked', { linked: data.linked, total: featureReqs })} · {t('spec.map.phone.changed', { count: data.changed })}
        </p>
        {phoneView === 'features' ? (
          <div className="cm-pane">
            <FeatureList
              data={data}
              pick={pick}
              onFeature={onFeature}
              expanded={(key) =>
                pick?.t === 'feature' && pick.key === key ? (
                  <div className="cm-pane my-4">
                    <FeaturePanel project={project} chain={chain} feature={key} onReq={setReq} mobile s={s} onStructure={() => setPhoneView('structure')} />
                  </div>
                ) : null
              }
            />
          </div>
        ) : (
          <div className="cm-pane space-y-8">
            {chain.length > 0 && crumbs}
            {structure}
            {pick?.t === 'block' && s && (
              <div className="cm-pane">
                <BlockPanel project={project} chain={chain} s={s} id={pick.id} onIn={onIn} onFeature={(key) => (pickFeature(key), setPhoneView('features'))} />
              </div>
            )}
          </div>
        )}
        {req && <ReqDetail project={project} uid={req} mobile onClose={() => setReq(null)} />}
      </div>
    );

  return (
    <div className="space-y-8 text-xs min-w-0" data-testid="map-tab">
      <div className="pixel-panel p-8 flex flex-wrap items-center gap-8 min-w-0">
        <h2>{t('spec.map.title')}</h2>
        <LedLegendLine />
        <span className="flex-1" />
        {counters}
      </div>
      {drawing ? (
        <Suspense fallback={<p className={muted}>{t('spec.wizard.loading')}</p>}>
          <ArchGraph
            project={project}
            mobile={false}
            head={
              <Button size="sm" onClick={() => setDrawing(false)} data-testid="map-back">
                {t('spec.map.back')}
              </Button>
            }
          />
        </Suspense>
      ) : (
        <div className="flex gap-8 items-start min-w-0">
          <aside className="cm-pane w-[340px] shrink-0" aria-label={t('spec.map.count.features')}>
            <FeatureList data={data} pick={pick} onFeature={onFeature} lit={lit} />
          </aside>
          <section className="cm-pane flex-1 min-w-0 space-y-4" aria-label={t('spec.map.structure')}>
            <div className="flex flex-wrap items-center gap-8">
              {crumbs}
              <span className="flex-1" />
              <Button size="sm" onClick={() => setDrawing(true)} data-testid="map-design">
                {t('spec.map.design')}
              </Button>
            </div>
            {structure}
          </section>
          {req ? right : <aside className="cm-pane w-[300px] shrink-0 self-start">{right}</aside>}
        </div>
      )}
    </div>
  );
}
