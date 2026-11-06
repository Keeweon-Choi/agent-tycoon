/**
 * BRN K8 (project-brain §7), pure: the design's structure beside the code's. The design modules
 * (arch.ts reads them from the documents: folder tree lines, component tables, Mermaid flowcharts;
 * arch.json adds and pairs) are folded by the code map's own rules (structure.ts) and met with the
 * code cells; then the four drifts. A pair counts only when its path is written in a document or the
 * owner made it (기본값 4): a name alone is shown as a guess, never counted (no false alarm). Nothing
 * stored, nothing read here: `exists` is the caller's (a planned path that is there but holds no code
 * is no code module, so it is no drift either).
 * K9: Spec Kit tasks.md's planned files join `modules` as written ones.
 */
import * as path from 'path';

import type { ArchSource, MapDesign, MapDesignModule, MapDrift, MapDriftItem, MapDriftKind, MapStructure } from '../../../../core/src/cld/spec/trace.js';
import { SPEC_MAP_DESIGN_EDGES_MAX, SPEC_MAP_DESIGN_MODULES_MAX, SPEC_MAP_DRIFT_ITEMS_MAX } from '../../constants.js';
import type { CodeScan } from './mapWorker.js';
import { structureOwned } from './structure.js';

export interface DesignModuleIn {
  id: string;
  label: string;
  paths: string[];
  /** What its paths are: written in a document, or the owner's (arch.json); null: it has none. */
  by: 'written' | 'confirmed' | null;
  source?: ArchSource;
}
export interface DesignEdgeIn {
  from: string;
  to: string;
  ends?: 'none' | 'both';
}

const DRIFT_KINDS: readonly MapDriftKind[] = ['reversed', 'undesigned', 'designOnly', 'codeOnly'];
/** A folder in the design fold: one planned file in it. */
const PLANNED = '·';
const bare = (p: string) => p.replace(/^\.\//, '').replace(/\/+$/, '');
const isDir = (p: string) => p.endsWith('/') || !/\.[A-Za-z0-9]+$/.test(path.posix.basename(p));

/** The cell a path is in: the longest cell folder that is it or holds it (rails never: they hold no design). */
export function cellFinder(code: MapStructure): (p: string) => string | undefined {
  const cells = code.blocks.filter((b) => b.kind !== 'rail').sort((a, b) => b.id.length - a.id.length);
  return (p) => cells.find((b) => p === b.id || p.startsWith(`${b.id}/`))?.id;
}

/**
 * The design (its modules met with the cells of `code`, its arrows, its own fold) and the drifts.
 * `code` is the top fold of `scan`; both null: no code yet (the design's own fold is the map).
 */
export function designMap(mods: readonly DesignModuleIn[], edges: readonly DesignEdgeIn[], scan: CodeScan | null, code: MapStructure | null, exists: (p: string) => boolean): { design: MapDesign; drift: MapDrift } {
  const files = new Set(scan?.files ?? []);
  const dirs = new Set<string>();
  for (const f of files) for (let i = f.indexOf('/'); i > 0; i = f.indexOf('/', i + 1)) dirs.add(f.slice(0, i));
  const hasCode = (p: string) => files.has(p) || dirs.has(p);
  const cellOf = code ? cellFinder(code) : () => undefined;
  const byName = new Map((code?.blocks ?? []).filter((b) => b.kind !== 'rail' && b.name).map((b) => [b.name.trim().toLowerCase(), b.id] as const));

  const out: MapDesignModule[] = [];
  const counted = new Map<string, string[]>(); // module → the cells it meets by a counted pair
  const items: MapDriftItem[] = [];
  for (const m of mods) {
    const ps = [...new Set(m.paths.map(bare).filter(Boolean))];
    let cells: string[] = [];
    let by: MapDesignModule['by'];
    if (m.by && ps.length) {
      cells = [...new Set(ps.flatMap((p) => cellOf(p) ?? []))];
      if (cells.length) by = m.by;
      counted.set(m.id, cells);
      for (const p of ps) if (!hasCode(p) && !exists(p)) items.push({ kind: 'designOnly', module: m.id, path: p });
    } else if (!ps.length) {
      const g = byName.get(m.label.trim().toLowerCase());
      if (g) [cells, by] = [[g], 'guess'];
    }
    out.push({ id: m.id, label: m.label, paths: ps, ...(cells.length && { cells }), ...(by && { by }), ...(m.source && { source: m.source }) });
  }
  // 설계에 없음: only where the design says anything at all.
  const met = new Set([...counted.values()].flat());
  if (counted.size && code) for (const b of code.blocks) if (b.kind !== 'rail' && !met.has(b.id)) items.push({ kind: 'codeOnly', cell: b.id });

  // The design's arrows between the cells their modules meet (counted pairs only).
  const directed = new Set<string>();
  const plain = new Set<string>();
  const talked = new Set<string>();
  const key = (a: string, b: string) => `${a}>${b}`;
  for (const e of edges)
    for (const a of counted.get(e.from) ?? [])
      for (const b of counted.get(e.to) ?? []) {
        if (a === b) continue;
        talked.add(a).add(b);
        if (e.ends === 'none') plain.add(key(a, b)).add(key(b, a));
        else directed.add(key(a, b));
        if (e.ends === 'both') directed.add(key(b, a));
      }
  // 반대 방향: the design says b → a, the code imports a → b (and the design never says a → b).
  // 설계에 없는 의존: neither way in the design, both cells in its arrows (a tree alone says no dependency).
  for (const pr of code?.pairs ?? [])
    for (const [x, y, n] of [
      [pr.a, pr.b, pr.ab],
      [pr.b, pr.a, pr.ba],
    ] as const) {
      if (!n || directed.has(key(x, y)) || plain.has(key(x, y))) continue;
      if (directed.has(key(y, x))) items.push({ kind: 'reversed', from: x, to: y, imports: n });
      else if (talked.has(x) && talked.has(y)) items.push({ kind: 'undesigned', from: x, to: y, imports: n });
    }
  const counts = Object.fromEntries(DRIFT_KINDS.map((k) => [k, 0])) as Record<MapDriftKind, number>;
  for (const it of items) counts[it.kind]++;
  items.sort((a, b) => DRIFT_KINDS.indexOf(a.kind) - DRIFT_KINDS.indexOf(b.kind) || (b.imports ?? 0) - (a.imports ?? 0));

  // The design's own fold: every counted path one planned file, the arrows between them; the code's
  // layers as its workspaces, so the same folders are the same layers (no code: the folder rule alone).
  const fakeOf = (p: string) => (isDir(p) && !files.has(p) ? `${p}/${PLANNED}` : p);
  const pathsOf = new Map(out.map((m) => [m.id, m.paths.map(fakeOf)]));
  const planned = [...new Set([...counted.keys()].flatMap((id) => pathsOf.get(id)!))].sort();
  const at = new Map(planned.map((f, i) => [f, i]));
  const fakeEdges: number[] = [];
  for (const e of edges) for (const a of (counted.has(e.from) && pathsOf.get(e.from)) || []) for (const b of (counted.has(e.to) && pathsOf.get(e.to)) || []) if (a !== b) fakeEdges.push(at.get(a)!, at.get(b)!);
  const fold = planned.length
    ? (structureOwned({ files: planned, edges: fakeEdges, unresolved: 0, workspaces: code ? code.bands.map((b) => b.id) : (scan?.workspaces ?? []), big: 0, at: '', ms: 0, rssKb: 0 })?.s ?? null)
    : null;
  const shownEdges = edges.filter((e) => pathsOf.has(e.from) && pathsOf.has(e.to));
  return {
    design: {
      modules: out.slice(0, SPEC_MAP_DESIGN_MODULES_MAX),
      more: Math.max(0, out.length - SPEC_MAP_DESIGN_MODULES_MAX),
      edges: shownEdges.slice(0, SPEC_MAP_DESIGN_EDGES_MAX).map((e) => ({ from: e.from, to: e.to, ...(e.ends && { ends: e.ends }) })),
      structure: fold,
    },
    drift: { counts, items: items.slice(0, SPEC_MAP_DRIFT_ITEMS_MAX), more: Math.max(0, items.length - SPEC_MAP_DRIFT_ITEMS_MAX) },
  };
}
