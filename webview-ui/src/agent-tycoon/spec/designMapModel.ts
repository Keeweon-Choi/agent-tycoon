/**
 * BRN K8: the 지도's design views, pure. 코드 (today's cards), 설계 (the cards of the design's own
 * fold) and 겹쳐 보기 (the code cards, each marked where the design agrees or differs, plus ghost
 * cards for what only the design plans), and the number row of the four drifts with its examples.
 * Nothing here touches the DOM (DesignMap.tsx draws it).
 */
import type {
  MapBlock,
  MapDesign,
  MapDrift,
  MapDriftItem,
  MapDriftKind,
} from '../../../../core/src/agent-tycoon/spec/trace.js';

export const MAP_VIEWS = ['code', 'design', 'overlay'] as const;
export type MapView = (typeof MAP_VIEWS)[number];
/** Only 설계 and 겹쳐 보기 ask the server for the design (nobody pays for it otherwise). */
export const wantsDesign = (v: MapView) => v !== 'code';

/** The mark on a code card: the design agrees (a pair counted), only a name guess pairs it, the design never names it. */
export type CellMark = 'agree' | 'guess' | 'none';

/**
 * The marks of the code cards. No mark at all when the design says nothing about the code (the
 * server counts 설계에 없음 only where some module is paired by a path or by the owner).
 * ponytail: a counted module whose paths meet no cell is not told apart here; the server's
 * `codeOnly` count joins in, so the mark still shows when the module list was cut.
 */
export function cellMarks(
  design: MapDesign,
  drift: MapDrift,
  blocks: readonly MapBlock[],
): Map<string, CellMark> {
  const counted = design.modules.some((m) => m.by && m.by !== 'guess');
  const agree = new Set(
    design.modules.filter((m) => m.by && m.by !== 'guess').flatMap((m) => m.cells ?? []),
  );
  const guess = new Set(
    design.modules.filter((m) => m.by === 'guess').flatMap((m) => m.cells ?? []),
  );
  const saysSomething = counted || drift.counts.codeOnly > 0;
  const out = new Map<string, CellMark>();
  for (const b of blocks) {
    if (b.kind === 'rail') continue;
    if (agree.has(b.id)) out.set(b.id, 'agree');
    else if (guess.has(b.id)) out.set(b.id, 'guess');
    else if (saysSomething) out.set(b.id, 'none');
  }
  return out;
}

export interface Ghost {
  /** The design module's id. */
  id: string;
  label: string;
  /** Its planned paths that have no code. */
  paths: string[];
}
/** The design-only modules, one ghost each (a module with several missing paths is one card). */
export function ghosts(design: MapDesign, drift: MapDrift): Ghost[] {
  const label = new Map(design.modules.map((m) => [m.id, m.label]));
  const by = new Map<string, Ghost>();
  for (const it of drift.items) {
    if (it.kind !== 'designOnly' || !it.module || !it.path) continue;
    const g = by.get(it.module) ?? {
      id: it.module,
      label: label.get(it.module) ?? it.path,
      paths: [],
    };
    g.paths.push(it.path);
    by.set(it.module, g);
  }
  return [...by.values()];
}

/** The number row: the four drifts in the owner's order. */
export const DRIFT_ROW: readonly MapDriftKind[] = [
  'designOnly',
  'codeOnly',
  'undesigned',
  'reversed',
];
export const driftRow = (drift: MapDrift) =>
  DRIFT_ROW.map((kind) => ({ kind, n: drift.counts[kind] }));

export interface DriftExample {
  key: string;
  item: MapDriftItem;
  /** The card it opens in 겹쳐 보기 (a ghost's module id, a code cell), absent: none to open. */
  target?: string;
}
/** A number's examples (the server cut the list at a cap, so these may be fewer than the number). */
export function driftExamples(drift: MapDrift, kind: MapDriftKind): DriftExample[] {
  return drift.items
    .filter((it) => it.kind === kind)
    .map((item, i) => ({
      key: `${kind}${i}`,
      item,
      target: kind === 'designOnly' ? item.module : kind === 'codeOnly' ? item.cell : item.from,
    }));
}
