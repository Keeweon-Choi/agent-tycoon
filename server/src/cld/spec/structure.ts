/**
 * SPT C1 (§8.1-8.3), pure: code files and their relative imports become bands, at most
 * SPEC_MAP_CELLS cells and two rails, with import counts per cell pair, the band order and the
 * layer violations; requirements become features and 공통 기준. Rules only (no LLM, no file, no git):
 * the child process (mapWorker.ts) lists the files and resolves their imports, the service hands over what it holds.
 * The rules' first version is R4's measure.mjs (ui-mock-1104/cockpit), made general (M1's workspaces).
 */
import * as path from 'path';

import type { MapBand, MapBlock, MapCommon, MapFeature, MapPair, MapStructure } from '../../../../core/src/cld/spec/trace.js';
import { SPEC_MAP_ARROW_MIN, SPEC_MAP_CELLS, SPEC_MAP_INSIDE_MAX, SPEC_MAP_VIOLATION_PAIRS_MAX } from '../../constants.js';
import { isTestFileOutsideJs, languageOf } from './languages.js';
import type { CodeScan } from './mapWorker.js';
import { shapeOf } from './shapes.js';
import { SPEC_KIT_DIR } from './speckit.js';
import { prefixOf } from './trace.js';

/** The test rail: a file under a folder named so. */
export const TEST_DIR = /(^|\/)(e2e|test|tests|__tests__)\//;
/** The rail's files: under a test folder, or (K7a) named as a test in a language whose tests do not sit beside the code (`test_x.py`, `x_test.go`). TS and JS test files stay in their layer, as before. */
const onRail = (f: string) => TEST_DIR.test(f) || isTestFileOutsideJs(f);
export const RAIL_TESTS = 'tests';
export const RAIL_TOOLS = 'tools';

const under = (dir: string) => (dir ? `${dir}/` : '');
const top = (f: string) => f.split('/')[0];
const uniq = (xs: Iterable<string>) => [...new Set(xs)];

/**
 * M1: the layers. With workspaces: the workspaces, and the top folders they import from at least
 * SPEC_MAP_ARROW_MIN times; without: every top folder with code. One layer only: its children (past
 * `src/`) are the layers. Test folders and the rest are rails, never layers.
 */
export function layersOf(files: readonly string[], edges: ArrayLike<number>, workspaces: readonly string[], min = SPEC_MAP_ARROW_MIN): string[] {
  const src = files.filter((f) => !onRail(f) && f.includes('/'));
  const tops = uniq(src.map(top)).sort();
  let layers = tops;
  if (workspaces.length) {
    const ws = workspaces.filter((w) => src.some((f) => f.startsWith(`${w}/`)));
    const inWs = (f: string) => ws.some((w) => f.startsWith(`${w}/`));
    const n = new Map<string, number>();
    for (let i = 0; i + 1 < edges.length; i += 2) {
      const a = files[edges[i]];
      const b = files[edges[i + 1]];
      if (inWs(a) && !inWs(b) && !onRail(b) && b.includes('/')) n.set(top(b), (n.get(top(b)) ?? 0) + 1);
    }
    layers = [...ws, ...tops.filter((t) => !ws.some((w) => w === t || w.startsWith(`${t}/`)) && (n.get(t) ?? 0) >= min)];
  }
  if (layers.length === 1) {
    let base = layers[0];
    if (src.some((f) => f.startsWith(`${base}/src/`))) base += '/src';
    const kids = uniq(src.filter((f) => f.startsWith(`${base}/`) && f.slice(base.length + 1).includes('/')).map((f) => `${base}/${f.slice(base.length + 1).split('/')[0]}`)).sort();
    if (kids.length > 1) layers = kids;
  }
  return layers;
}

interface Unit {
  dir: string;
  n: number;
  layer: string;
}
/** M2: a layer's units. `src/` and a folder holding more than half of its parent's files are opened; their children are units, their siblings too. Files right in a folder stay. */
function unitsOf(layer: string, base: string, files: readonly string[]): Unit[] {
  const units: Unit[] = [];
  const open = (dir: string, inside: readonly string[]) => {
    const kids = new Map<string, number>();
    for (const f of inside) {
      const rel = f.slice(under(dir).length);
      const i = rel.indexOf('/');
      if (i > 0) kids.set(rel.slice(0, i), (kids.get(rel.slice(0, i)) ?? 0) + 1);
    }
    for (const [k, n] of [...kids].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const d = `${under(dir)}${k}`;
      if (k === 'src' || n / inside.length > 0.5) open(d, inside.filter((f) => f.startsWith(`${d}/`)));
      else units.push({ dir: d, n, layer });
    }
  };
  open(base, files);
  return units;
}

/** A fold: its cells and which cell each file (by index into the scan) is in (-1: not in this view). */
interface Fold {
  blocks: MapBlock[];
  bands: MapBand[];
  owner: Int32Array;
  units: Unit[];
}

/**
 * M3: one cell per layer (its rest) first, the other cells to the biggest units of all layers. A
 * layer's rest with no file left is dropped. The top fold also has the two rails (tests, tools).
 * `layers` are `{id, base}`: the top's are folders; a view inside a rail has the whole path ('').
 */
function fold(scan: CodeScan, idx: readonly number[], layers: ReadonlyArray<{ id: string; base: string }>, rails: boolean, labels: ReadonlyMap<string, string>, cells = SPEC_MAP_CELLS): Fold {
  const f = scan.files;
  const test = (i: number) => rails && onRail(f[i]);
  const layerOf = (i: number) => layers.find((l) => !l.base || f[i].startsWith(`${l.base}/`));
  const inLayer = new Map(layers.map((l) => [l.id, [] as string[]]));
  for (const i of idx) if (!test(i)) inLayer.get(layerOf(i)?.id ?? '')?.push(f[i]);
  const units = layers.flatMap((l) => unitsOf(l.id, l.base, inLayer.get(l.id)!)).sort((a, b) => b.n - a.n || (a.dir < b.dir ? -1 : 1));
  const own = units.slice(0, Math.max(0, cells - layers.length));
  const ownDirs = [...own].sort((a, b) => b.dir.length - a.dir.length);
  const ids: string[] = [...layers.map((l) => l.id), ...own.map((u) => u.dir), ...(rails ? [RAIL_TESTS, RAIL_TOOLS] : [])];
  const at = new Map(ids.map((id, k) => [id, k]));
  const owner = new Int32Array(f.length).fill(-1);
  for (const i of idx) {
    const id = test(i) ? RAIL_TESTS : (ownDirs.find((u) => f[i].startsWith(`${u.dir}/`))?.dir ?? layerOf(i)?.id ?? RAIL_TOOLS);
    owner[i] = at.get(id) ?? -1;
  }
  const count = new Array<number>(ids.length).fill(0);
  for (const i of idx) if (owner[i] >= 0) count[owner[i]]++;
  const name = (dir: string) => labels.get(dir) ?? path.posix.basename(dir);
  const leftover = units.filter((u) => !own.includes(u)).sort((a, b) => b.dir.length - a.dir.length);
  const inside = (k: number) => {
    const id = ids[k];
    const c = new Map<string, number>();
    for (const i of idx) {
      if (owner[i] !== k) continue;
      let head: string;
      if (id === RAIL_TESTS || id === RAIL_TOOLS) head = f[i].includes('/') ? f[i].split('/').slice(0, 2).join('/') : '*';
      else if (k >= layers.length) {
        const rel = f[i].slice(id.length + 1);
        head = rel.includes('/') ? `${rel.split('/')[0]}/` : '';
      } else {
        const u = leftover.find((x) => f[i].startsWith(`${x.dir}/`));
        head = u ? `${path.posix.basename(u.dir)}/` : f[i].includes('/') ? `${path.posix.basename(path.posix.dirname(f[i]))}/*` : '*';
      }
      c.set(head, (c.get(head) ?? 0) + 1);
    }
    return [...c].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([n, x]) => ({ name: n, n: x }));
  };
  const blocks: MapBlock[] = [];
  ids.forEach((id, k) => {
    if (!count[k]) return;
    const rail = id === RAIL_TESTS || id === RAIL_TOOLS;
    const layer = rail ? undefined : k < layers.length ? id : own[k - layers.length].layer;
    const parts = inside(k);
    const base = k < layers.length ? layers[k].base : id;
    blocks.push({
      id,
      name: rail ? '' : name(base || id),
      kind: rail ? 'rail' : k < layers.length ? 'layer' : 'unit',
      ...(k < layers.length && own.some((u) => u.layer === id) && { rest: true as const }),
      ...(layer !== undefined && { layer }),
      files: count[k],
      inside: parts.slice(0, SPEC_MAP_INSIDE_MAX),
      in: 0,
      out: 0,
      deeper: parts.length > 1 || !!parts[0]?.name.endsWith('/'),
      features: [],
      week: 0,
    });
  });
  const bands: MapBand[] = layers.flatMap((l) => {
    const bs = blocks.filter((b) => b.layer === l.id);
    // The rest first, then the units, the biggest first.
    bs.sort((a, b) => Number(b.kind === 'layer') - Number(a.kind === 'layer') || b.files - a.files || (a.id < b.id ? -1 : 1));
    return bs.length ? [{ id: l.id, name: name(l.base || l.id), files: bs.reduce((s, b) => s + b.files, 0), blocks: bs.map((b) => b.id) }] : [];
  });
  return { blocks, bands, owner: remap(owner, ids, blocks), units };
}
/** The owner table by index into `blocks` (an empty cell dropped). */
function remap(owner: Int32Array, ids: readonly string[], blocks: readonly MapBlock[]): Int32Array {
  const to = ids.map((id) => blocks.findIndex((b) => b.id === id));
  return owner.map((k) => (k >= 0 ? to[k] : -1));
}

/** K7a: the languages of the files in this view, the biggest first, and how many of them have no import lines read (TS and JS only). */
function languagesOf(files: readonly string[], owner: Int32Array): Pick<MapStructure, 'langs' | 'noImports'> {
  const n = new Map<string, number>();
  let noImports = 0;
  files.forEach((f, i) => {
    const l = owner[i] >= 0 ? languageOf(f) : undefined;
    if (!l) return;
    n.set(l.name, (n.get(l.name) ?? 0) + 1);
    if (!l.imports) noImports++;
  });
  return { langs: [...n].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([name, files]) => ({ name, files })), noImports };
}

/**
 * The structure shown: the top fold, or `chain`'s cells entered one after the other ([한 단계
 * 들어가기]: the cell's files folded again as one layer). null when the chain names no cell.
 * `labels`: the owner's names by folder (arch.json's renamed folders).
 */
export function structureView(scan: CodeScan, chain: readonly string[] = [], labels: ReadonlyMap<string, string> = new Map(), cells = SPEC_MAP_CELLS, min = SPEC_MAP_ARROW_MIN): MapStructure | null {
  return structureOwned(scan, chain, labels, cells, min)?.s ?? null;
}
/** structureView with which of its cells (index into `blocks`, -1: none) each scanned file is in (SPT C2's links reach the cells by it). */
export function structureOwned(
  scan: CodeScan,
  chain: readonly string[] = [],
  labels: ReadonlyMap<string, string> = new Map(),
  cells = SPEC_MAP_CELLS,
  min = SPEC_MAP_ARROW_MIN,
): { s: MapStructure; owner: Int32Array } | null {
  let idx = scan.files.map((_, i) => i);
  const layers = layersOf(scan.files, scan.edges, scan.workspaces, min).map((l) => ({ id: l, base: l }));
  let at = fold(scan, idx, layers, true, labels, cells);
  const crumbs: MapStructure['crumbs'] = [];
  for (const id of chain) {
    const k = at.blocks.findIndex((b) => b.id === id);
    if (k < 0) return null;
    const b = at.blocks[k];
    crumbs.push({ id, name: b.name });
    idx = idx.filter((i) => at.owner[i] === k);
    const base = b.kind === 'rail' ? '' : b.kind === 'layer' ? (layers.find((l) => l.id === b.id)?.base ?? b.id) : b.id;
    at = fold(scan, idx, [{ id: b.id, base }], false, labels, cells);
  }
  const { blocks, bands, owner } = at;
  // Imports between the cells of this view; band order and violations from them.
  const n = new Map<string, number>();
  let imports = 0;
  for (let i = 0; i + 1 < scan.edges.length; i += 2) {
    const a = owner[scan.edges[i]];
    const b = owner[scan.edges[i + 1]];
    if (a < 0 || b < 0) continue;
    imports++;
    if (a === b) continue;
    blocks[a].out++;
    blocks[b].in++;
    n.set(`${a}>${b}`, (n.get(`${a}>${b}`) ?? 0) + 1);
  }
  const bandOf = (k: number) => blocks[k].layer;
  const between = (x: string, y: string) => {
    let s = 0;
    for (const [key, c] of n) {
      const [a, b] = key.split('>').map(Number);
      if (bandOf(a) === x && bandOf(b) === y) s += c;
    }
    return s;
  };
  // Who imports more sits higher; a tie: the bigger band (SPT §8.3).
  bands.sort((x, y) => between(y.id, x.id) - between(x.id, y.id) || y.files - x.files || (x.id < y.id ? -1 : 1));
  const rank = new Map(bands.map((b, i) => [b.id, i]));
  let violations = 0;
  const violationFiles: Array<[string, string]> = [];
  for (let i = 0; i + 1 < scan.edges.length; i += 2) {
    const a = owner[scan.edges[i]];
    const b = owner[scan.edges[i + 1]];
    if (a < 0 || b < 0) continue;
    const ra = rank.get(bandOf(a) ?? '');
    const rb = rank.get(bandOf(b) ?? '');
    if (ra === undefined || rb === undefined || ra <= rb) continue;
    violations++;
    if (violationFiles.length < SPEC_MAP_VIOLATION_PAIRS_MAX) violationFiles.push([scan.files[scan.edges[i]], scan.files[scan.edges[i + 1]]]);
  }
  const pairs: MapPair[] = [];
  for (let a = 0; a < blocks.length; a++)
    for (let b = a + 1; b < blocks.length; b++) {
      if (blocks[a].kind === 'rail' || blocks[b].kind === 'rail') continue;
      const ab = n.get(`${a}>${b}`) ?? 0;
      const ba = n.get(`${b}>${a}`) ?? 0;
      if (ab || ba) pairs.push({ a: blocks[a].id, b: blocks[b].id, ab, ba });
    }
  pairs.sort((x, y) => y.ab + y.ba - (x.ab + x.ba));
  const s: MapStructure = {
    crumbs,
    bands,
    blocks,
    pairs,
    violations,
    violationFiles,
    files: blocks.reduce((s, b) => s + b.files, 0),
    imports,
    unresolved: scan.unresolved,
    ...(scan.partial && { partial: scan.partial }),
    ...languagesOf(scan.files, owner),
    ...(scan.other && { other: scan.other }),
    big: scan.big,
    at: scan.at,
    ms: scan.ms,
    rssKb: scan.rssKb,
  };
  return { s, owner };
}

// ── features (SPT §8.1) ──

/** A requirement as the service knows it (live, in a requirements document). */
export interface FeatureReq {
  uid: string;
  /** Its display ID ('' when it has none). */
  id: string;
  doc: string;
  path: string;
  fmId?: string;
  section: string;
  line: number;
  changed: boolean;
  progress: boolean;
  blocked: boolean;
}
export type Feature = MapFeature & { uids: string[]; source?: { path: string; line: number } };
const COMMON = new Set(['NFR', 'IR', 'CON']);
/** `3.19 내장 엔진(ENG)` → [내장 엔진, ENG]. */
const AREA = /^(?:\d+(?:\.\d+)*\.?\s+)?(.+?)\s*\(([A-Z][A-Z0-9]*)\)\s*$/;

/**
 * The first rule that fits, per requirement: a Spec Kit feature folder, a document's front-matter
 * id when all its requirement numbers share one prefix, the number's prefix (named by the section
 * that ends in `(<area>)`), the document's folder. NFR-, IR-, CON- go to 공통 기준. A display ID in
 * several documents (an SRS and a table that repeats it) counts once; any copy may name it. Ordered 볼 것 먼저:
 * blocked, then changed, then in progress, then the documents' order.
 */
export function featuresOf(reqs: readonly FeatureReq[]): { features: Feature[]; common: Array<MapCommon & { uids: string[] }> } {
  const docPrefixes = new Map<string, Set<string>>();
  for (const r of reqs) if (r.id) (docPrefixes.get(r.doc) ?? docPrefixes.set(r.doc, new Set()).get(r.doc)!).add(prefixOf(r.id));
  const feats = new Map<string, Feature & { first: number }>();
  const common = new Map<string, MapCommon & { uids: string[] }>();
  const seen = new Set<string>();
  reqs.forEach((r, i) => {
    // RQ5: a Kiro / OpenSpec folder is the feature (its `<feature>/R3` IDs are not a prefix family).
    const shape = shapeOf(r.path);
    const prefix = r.id && !shape ? prefixOf(r.id) : '';
    const again = !!r.id && seen.has(r.id);
    if (r.id) seen.add(r.id);
    if (prefix && COMMON.has(prefix.split('-')[0])) {
      if (again) return;
      const c = common.get(prefix) ?? { key: prefix, reqs: 0, changed: 0, uids: [] };
      c.reqs++;
      c.changed += Number(r.changed);
      c.uids.push(r.uid);
      common.set(prefix, c);
      return;
    }
    const kit = SPEC_KIT_DIR.exec(r.path)?.[1];
    const one = r.fmId && docPrefixes.get(r.doc)?.size === 1;
    const [key, short, rule]: [string, string, MapFeature['rule']] = shape
      ? shape.tool === 'kiro'
        ? [`kiro:${shape.feature}`, shape.feature, 'kiro']
        : shape.file === 'spec' && shape.change
          ? [`osc:${shape.change}`, shape.change, 'openspec']
          : [`os:${shape.file === 'spec' ? shape.cap : shape.change}`, shape.file === 'spec' ? shape.cap : shape.change, 'openspec']
      : kit
      ? [`sk:${kit}`, kit, 'speckit']
      : one
        ? [`fm:${r.doc}`, r.fmId!, 'fm']
        : prefix
          ? [prefix, prefix.split('-').pop()!, 'prefix']
          : [`dir:${path.posix.dirname(r.path)}`, path.posix.basename(path.posix.dirname(r.path)), 'folder'];
    let f = feats.get(key);
    if (!f && again) return;
    if (!f) feats.set(key, (f = { key, short, name: short, rule, ...(key.startsWith('osc:') && { changing: true as const }), reqs: 0, progress: false, blocked: false, changed: 0, linked: 0, uids: [], first: i }));
    const m = rule === 'prefix' && !f.source ? AREA.exec(r.section) : null;
    if (m && m[2] === short) {
      f.name = m[1];
      f.source = { path: r.path, line: r.line };
    }
    if (again) return;
    f.reqs++;
    f.uids.push(r.uid);
    f.progress ||= r.progress;
    f.blocked ||= r.blocked;
    f.changed += Number(r.changed);
  });
  const features = [...feats.values()]
    .sort((a, b) => Number(b.blocked) - Number(a.blocked) || Number(b.changed > 0) - Number(a.changed > 0) || Number(b.progress) - Number(a.progress) || a.first - b.first)
    .map(({ first: _f, ...f }) => f);
  return { features, common: [...common.values()] };
}
