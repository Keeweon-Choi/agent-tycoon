/**
 * 아키텍처 그래프 (the 지도's first view), pure: the structure scan (`GET …/map`, MapStructure) as
 * cards on a grid, band by band in the server's import order (who imports more sits higher), and
 * the lines between them: only the pairs with many imports, plus every pair of the picked card.
 * React Flow draws them (ArchCards.tsx); nothing here touches the DOM.
 */
import type { MapBlock, MapPair, MapStructure } from '../../../../core/src/cld/spec/trace.js';
import { t } from '../../i18n/index.js';

/** A cell's shown name: the rail's page name, `<layer> 나머지`, or the folder's (owner's) name. */
export const cellName = (b: MapBlock) =>
  b.kind === 'rail'
    ? t(`spec.map.rail.${b.id === 'tests' ? 'tests' : 'tools'}`)
    : b.rest
      ? t('spec.map.rest', { name: b.name })
      : b.name;

export interface CardFilter {
  /** Bands shown (empty: all). */
  layers: ReadonlySet<string>;
  /** Requirement links shown (empty: both). */
  links: ReadonlySet<'linked' | 'unlinked'>;
  /** The test and tool rails too. */
  rails: boolean;
  /** Part of the name or the folder, any case. */
  query: string;
}
export const NO_FILTER: CardFilter = {
  layers: new Set(),
  links: new Set(),
  rails: false,
  query: '',
};

export const linkedOf = (b: MapBlock): 'linked' | 'unlinked' =>
  b.features.length ? 'linked' : 'unlinked';

/** The cards shown, band by band, then the rails. */
export function cardOrder(s: MapStructure, f: CardFilter): MapBlock[] {
  const byId = new Map(s.blocks.map((b) => [b.id, b]));
  const q = f.query.trim().toLowerCase();
  const ordered = [
    ...s.bands.flatMap((band) => band.blocks.map((id) => byId.get(id)!).filter(Boolean)),
    ...(f.rails ? s.blocks.filter((b) => b.kind === 'rail') : []),
  ];
  return ordered.filter(
    (b) =>
      (b.kind === 'rail' || !f.layers.size || f.layers.has(b.layer ?? '')) &&
      (!f.links.size || f.links.has(linkedOf(b))) &&
      (!q || b.name.toLowerCase().includes(q) || b.id.toLowerCase().includes(q)),
  );
}

/** Row and column of each card, `cols` to a row. */
export function gridCells(
  ids: readonly string[],
  cols: number,
): Map<string, { row: number; col: number }> {
  return new Map(ids.map((id, i) => [id, { row: Math.floor(i / cols), col: i % cols }]));
}

export type Side = 't' | 'r' | 'b' | 'l';
/** Which sides a line leaves and enters by: side by side in a row, else bottom to top (or up). */
export function sides(
  a: { row: number; col: number },
  b: { row: number; col: number },
): [Side, Side] {
  if (a.row === b.row) return a.col < b.col ? ['r', 'l'] : ['l', 'r'];
  return a.row < b.row ? ['b', 't'] : ['t', 'b'];
}

export interface CardLine {
  id: string;
  /** The importer (the one that imports more, for a two-way pair) and the imported. */
  from: string;
  to: string;
  two: boolean;
  /** Imports both ways. */
  n: number;
  /** At or over the bold minimum. */
  bold: boolean;
}
/** The lines among `shown`: the pairs with `min` imports or more one way, and every pair of `picked`. */
export function cardLines(
  pairs: readonly MapPair[],
  shown: ReadonlySet<string>,
  min: number,
  picked: string | null,
): CardLine[] {
  return pairs.flatMap((p) => {
    if (!shown.has(p.a) || !shown.has(p.b)) return [];
    const bold = Math.max(p.ab, p.ba) >= min;
    if (!bold && p.a !== picked && p.b !== picked) return [];
    const [from, to] = p.ab >= p.ba ? [p.a, p.b] : [p.b, p.a];
    return [{ id: `${p.a}|${p.b}`, from, to, two: p.ab > 0 && p.ba > 0, n: p.ab + p.ba, bold }];
  });
}

export interface Relations {
  /** The cells it imports from, those that import it, the two-way ones (each with its imports that way). */
  uses: Array<{ id: string; n: number }>;
  usedBy: Array<{ id: string; n: number }>;
  both: Array<{ id: string; n: number }>;
  /** Distinct cells it trades with. */
  partners: number;
}
export function relationsOf(pairs: readonly MapPair[], id: string): Relations {
  const r: Relations = { uses: [], usedBy: [], both: [], partners: 0 };
  for (const p of pairs) {
    if (p.a !== id && p.b !== id) continue;
    const mine = p.a === id;
    const other = mine ? p.b : p.a;
    const out = mine ? p.ab : p.ba;
    const into = mine ? p.ba : p.ab;
    r.partners++;
    if (out) r.uses.push({ id: other, n: out });
    if (into) r.usedBy.push({ id: other, n: into });
    if (out && into) r.both.push({ id: other, n: out + into });
  }
  for (const list of [r.uses, r.usedBy, r.both]) list.sort((x, y) => y.n - x.n);
  return r;
}
