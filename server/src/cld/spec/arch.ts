/**
 * SPT-P4A (SPT §8), pure: a document's architecture (its Mermaid blocks and component tables), the
 * components' `c_` UIDs across rescans, and the architecture query built from both. No git, no
 * file, no LLM. What a document says is masked and capped here, before anything keeps it.
 *
 * Blocks are numbered in document order (every Mermaid fence, drawn or not, and every component
 * table). A component's place is (document UID, block, node ID or `#row`), its fingerprint its label.
 * A sequence participant whose label is that of exactly one flowchart node or table row of the same
 * document is that component.
 */
import * as crypto from 'crypto';

import type { ArchDiagram, ArchEdge, ArchGroup, ArchKind, ArchLayer, ArchNode, ArchSource, ArchUnsupported, TraceArch } from '../../../../core/src/cld/spec/trace.js';
import {
  SPEC_ARCH_DEP_NAMES_MAX,
  SPEC_ARCH_DOC_COMPS_MAX,
  SPEC_ARCH_DOC_LINKS_MAX,
  SPEC_ARCH_EDGES_MAX,
  SPEC_ARCH_LINE_MAX,
  SPEC_ARCH_NODES_MAX,
  SPEC_ARCH_RETIRED_PER_DOC,
  SPEC_ARCH_SOURCE_MAX,
  SPEC_ARCH_TREE_LINES_MAX,
  SPEC_ARCH_UNSUPPORTED_MAX,
  SPEC_ITEM_TITLE_MAX,
} from '../../constants.js';
import { maskText } from '../mask.js';
import { cellsOf, clean, FENCE, headerOf, TABLE_ROW, TABLE_SEP } from '../tracking/docs.js';
import { pathsOf } from './compLinks.js';
import { norm } from './extract.js';
import { languageOf } from './languages.js';
import { type MSeq, parseMermaid } from './mermaid.js';
import type { SpecRegistry } from './store.js';

export interface ArchComp {
  block: number;
  /** nodeKey of its node or participant ID, or of `#<row>`. */
  node: string;
  label: string;
  kind: ArchKind;
  line: number;
  /** Its subgraph's key (`<block>:<index in the block>`). */
  group?: string;
  /** The lines of the participants that are this component. */
  also: number[];
  /** BRN K8: its planned path as written (masked): a tree line, a table's path cell, a label that is one path. */
  path?: string;
  /** BRN K8: a folder tree line: a design module only (never drawn in the architecture, never a link candidate). */
  tree?: true;
}
export interface ArchGroupIn {
  key: string;
  label: string;
  parent?: string;
  line: number;
}
/** An end is a component (its index in `comps`) or a subgraph (its key). */
export interface ArchLink {
  from: number | string;
  to: number | string;
  layer: ArchLayer;
  label: string;
  line: number;
  ends?: 'none' | 'both';
}
/** What one document says, masked: the in-memory read the query is built from. */
export interface DocArch {
  /** Refused whole (too big, or past the project's cap): what the Registry holds for it is left as it is. */
  whole?: true;
  /** Blocks refused (another type, a line outside the subset, too big): their components' records are left as they are. */
  refused?: number[];
  comps: ArchComp[];
  groups: ArchGroupIn[];
  links: ArchLink[];
  unsupported: Array<Omit<ArchUnsupported, 'doc'>>;
  /** SPT-P4B: the blocks drawn (flowcharts, sequences, component tables) with a hash of their source: what an approval records. */
  blocks?: Array<{ block: number; type: ArchDiagram['type']; line: number; hash: string }>;
}

const shown = (s: string) => maskText(s).slice(0, SPEC_ITEM_TITLE_MAX);
const capBytes = (s: string, max: number) => {
  const b = Buffer.from(s, 'utf-8');
  return b.length <= max ? s : b.subarray(0, max).toString('utf-8').replace(/�+$/, '');
};
const MERMAID = /^\s*(```|~~~)\s*mermaid\b/i;
/** A component table's name column and its dependency column (headerOf folds case and a trailing `(…)`). */
const COMP_COL = /^(구성\s*요소|컴포넌트|components?|모듈)$/;
const DEP_COL = /^(의존(성)?|연결|depends(\s+on)?)$/;
/** BRN K8: a component table's path column (`자리(제안)` reads as `자리`). */
const PATH_COL = /^(경로|자리|위치|폴더|파일|paths?|location|folder|directory|files?)$/;
/** The one path a label is, or undefined (`server/src/cld/engine`, in quotes or backticks or not). */
const labelPath = (label: string): string | undefined => {
  const ps = pathsOf(label);
  return ps.length === 1 && ps[0] === label.trim().replace(/^[`'"]+|[`'"]+$/g, '').replace(/^\.\//, '') ? ps[0] : undefined;
};

// ── BRN K8: folder trees (project-brain §7.1) ──
/** A fence a folder tree may be in: no language, or a text one. */
const PLAIN_FENCE = /^\s*(```|~~~)\s*(text|txt|plain|plaintext|tree)?\s*$/i;
/** The heading of a section a tree is in (`Directory map`, `Project Structure`, `폴더 구조`). */
const TREE_HEAD = /structure|layout|director(y|ies)|\btree\b|\bmap\b|구조|트리|폴더|디렉[터토]리/i;
/** A tree drawn with lines (`├── models/`): Spec Kit's plan.md, `tree`'s output. */
const TREE_GLYPH = /^[\s│|]*[├└]──/;
const TREE_PART = /^[\w.@~+-]+(?:\/[\w.@~+-]+)*\/?$/;
const HAS_EXT = /\.[A-Za-z0-9]+$/;
const HEADING = /^#{1,6}\s+(.+?)\s*#*\s*$/;
const treePart = (s: string) => TREE_PART.test(s) && (s.includes('/') || HAS_EXT.test(s)) && !s.split('/').some((x) => x === '..' || x === '.');

/**
 * A folder tree's entries (`line`: 1-based within the block): each line's leading path, or every path
 * of a line made only of paths (`src/hooks/ components/   React side`, `a.ts, b.ts`: the ones after
 * the first in its folder, `src/components/`), under the folder line above it at a smaller indent
 * (`├──`, `│` count as indent). A description after two spaces is left out. A file in no code language
 * (`asyncapi.yaml`) is no module. Paths only: never `..`, never absolute.
 */
// ponytail: indentation decides the parent; a tree that indents children less than their folder, or a tab-indented one mixed with spaces, reads flat.
export function treeEntries(lines: readonly string[]): Array<{ path: string; line: number }> {
  const out: Array<{ path: string; line: number }> = [];
  const stack: Array<{ col: number; path: string }> = [];
  lines.forEach((raw, k) => {
    if (raw.length > SPEC_ARCH_LINE_MAX) return;
    const m = /^([\s│├└─|]*)(\S.*)?$/.exec(raw);
    if (!m?.[2]) return;
    const parts = m[2].split(/\s{2,}|\t/)[0].split(' ').map((x) => x.replace(/^\.\//, '').replace(/,$/, ''));
    if (!treePart(parts[0])) return;
    const all = parts.every(treePart) ? parts : [parts[0]];
    const col = m[1].length;
    while (stack.length && stack.at(-1)!.col >= col) stack.pop();
    const parent = stack.at(-1)?.path ?? '';
    const first = all[0].replace(/\/$/, '');
    const beside = first.includes('/') ? first.slice(0, first.lastIndexOf('/') + 1) : '';
    for (const [n, x] of all.entries()) {
      const full = parent + (n ? beside : '') + x;
      if (x.endsWith('/') || languageOf(full)) out.push({ path: full, line: k + 1 });
    }
    if (all.length === 1 && all[0].endsWith('/')) stack.push({ col, path: parent + all[0] });
  });
  return out;
}
const sha16 = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
/** A label's fingerprint. */
export const fpOf = (label: string): string => sha16(norm(label));
/** A node or participant ID as the Registry keeps it: a hash (it is document text: a token, a sentence), compared for equality only. */
export const nodeKey = (id: string): string => sha16(`node:${id}`);

/** Past a document cap: its architecture is refused whole, at the line that crossed it. */
class TooBig {
  constructor(readonly line: number) {}
}

/** A document whose architecture is not read: past its own caps (the line that crossed one) or the project's. */
export const tooBigArch = (line: number): DocArch => ({ whole: true, comps: [], groups: [], links: [], unsupported: [{ line: 1, type: 'document', firstBlockedLine: line, text: '', source: '', big: true }] });

export function readArch(text: string): DocArch {
  try {
    // Kept for as long as the document is not read again: flattened once, so no label is a slice
    // that holds the document's text alive.
    return JSON.parse(JSON.stringify(readAll(text))) as DocArch;
  } catch (err) {
    if (!(err instanceof TooBig)) throw err;
    return tooBigArch(err.line);
  }
}

function readAll(text: string): DocArch {
  const lines = text.split(/\r?\n/);
  const out: DocArch = { comps: [], groups: [], links: [], unsupported: [] };
  const seqs: Array<{ block: number; fence: number; seq: MSeq }> = [];
  let rows = 0; // components and the rows and participants that repeat one
  let work = 0; // what refused blocks built
  const grow = (line: number, comps = 1, refused = 0) => {
    rows += comps;
    work += refused;
    if (rows > SPEC_ARCH_DOC_COMPS_MAX || out.links.length > SPEC_ARCH_DOC_LINKS_MAX || work > SPEC_ARCH_DOC_COMPS_MAX + SPEC_ARCH_DOC_LINKS_MAX) throw new TooBig(line);
  };
  let block = 0;
  let heading = '';
  const trees: Array<{ fence: number; lines: string[] }> = [];
  for (let i = 0; i < lines.length; i++) {
    if (FENCE.test(lines[i])) {
      let j = i + 1;
      while (j < lines.length && !FENCE.test(lines[j])) j++;
      if (PLAIN_FENCE.test(lines[i])) {
        const body = lines.slice(i + 1, j);
        if (TREE_HEAD.test(heading) || body.some((l) => TREE_GLYPH.test(l))) trees.push({ fence: i + 1, lines: body });
      } else if (MERMAID.test(lines[i])) {
        const src = lines.slice(i + 1, j).join('\n');
        const b = block++;
        const fence = i + 1; // 1-based; the block's line k is the document's fence + k
        const r = parseMermaid(src);
        if ('unsupported' in r) {
          const u = r.unsupported;
          (out.refused ??= []).push(b);
          grow(fence + u.line, 0, u.cost ?? 0); // what it built before it was refused counts too
          if (out.unsupported.length < SPEC_ARCH_UNSUPPORTED_MAX)
            out.unsupported.push({ line: fence, type: shown(r.type), firstBlockedLine: fence + u.line, text: shown(u.text), source: capBytes(maskText(src), SPEC_ARCH_SOURCE_MAX), ...(u.big && { big: true }) });
        } else if ('flow' in r) {
          (out.blocks ??= []).push({ block: b, type: 'flowchart', line: fence, hash: sha16(src) });
          const f = r.flow;
          // Groups by their place in the block, never by their text.
          const subOf = new Map(f.subgraphs.map((s) => [s.id, s.index]));
          const key = (index: number) => `${b}:${index}`;
          for (const s of f.subgraphs) out.groups.push({ key: key(s.index), label: shown(s.title), ...(s.parent !== null && { parent: key(subOf.get(s.parent)!) }), line: fence + s.line });
          const at = new Map<string, number>();
          for (const n of f.nodes.values()) {
            if (subOf.has(n.id)) continue; // an edge to a subgraph names the group
            const sg = f.groupOf.get(n.id);
            at.set(n.id, out.comps.length);
            const label = shown(n.label);
            const p = labelPath(label);
            out.comps.push({ block: b, node: nodeKey(n.id), label, kind: n.shape === 'cylinder' ? 'store' : 'component', line: fence + n.line, ...(sg !== undefined && { group: key(sg) }), also: [], ...(p && { path: p }) });
            grow(fence + n.line);
          }
          const end = (id: string) => (subOf.has(id) ? key(subOf.get(id)!) : at.get(id)!);
          for (const e of f.edges)
            if (e.kind !== 'invisible') {
              out.links.push({ from: end(e.from), to: end(e.to), layer: 'composition', label: shown(e.label), line: fence + e.line, ...(!e.arrow ? { ends: 'none' as const } : e.bidir && { ends: 'both' as const }) });
              grow(fence + e.line, 0);
            }
        } else {
          (out.blocks ??= []).push({ block: b, type: 'sequence', line: fence, hash: sha16(src) });
          seqs.push({ block: b, fence, seq: r.seq });
        }
      }
      i = j;
      continue;
    }
    const hd = HEADING.exec(lines[i]);
    if (hd) heading = hd[1];
    if (TABLE_ROW.test(lines[i]) && TABLE_SEP.test(lines[i + 1] ?? '')) {
      const head = headerOf(lines[i]);
      const c = head.findIndex((h) => COMP_COL.test(h));
      const d = head.findIndex((h) => DEP_COL.test(h));
      const pc = head.findIndex((h) => PATH_COL.test(h));
      let end = i + 2;
      while (end < lines.length && TABLE_ROW.test(lines[end])) end++;
      if (c >= 0) {
        const b = block++;
        (out.blocks ??= []).push({ block: b, type: 'table', line: i + 1, hash: sha16(lines.slice(i, end).join('\n')) });
        const deps: Array<{ index: number; deps: string; line: number }> = [];
        const byLabel = new Map<string, number>();
        for (let k = i + 2; k < end; k++) {
          const cells = cellsOf(lines[k]);
          const label = shown(clean((cells[c] ?? '').slice(0, SPEC_ARCH_LINE_MAX)));
          if (!label) continue;
          grow(k + 1);
          // A row that repeats a label in the same table is that component again (one more source line).
          let index = byLabel.get(norm(label));
          if (index === undefined) {
            index = out.comps.length;
            byLabel.set(norm(label), index);
            const cell = pc >= 0 ? (cells[pc] ?? '') : '';
            const p = (cell.length <= SPEC_ARCH_LINE_MAX ? pathsOf(cell)[0] : undefined) ?? labelPath(label);
            out.comps.push({ block: b, node: nodeKey(`#${k - i - 1}`), label, kind: 'component', line: k + 1, also: [], ...(p && { path: p }) });
          } else out.comps[index].also.push(k + 1);
          // A cell longer than a line is not read as names (one 2 MB cell cost a second on every read).
          if (d >= 0 && (cells[d] ?? '').length <= SPEC_ARCH_LINE_MAX) deps.push({ index, deps: cells[d] ?? '', line: k + 1 });
        }
        for (const r of deps)
          for (const name of r.deps.split(/[,·]/, SPEC_ARCH_DEP_NAMES_MAX)) {
            const to = byLabel.get(norm(shown(clean(name))));
            if (to === undefined || to === r.index) continue;
            out.links.push({ from: r.index, to, layer: 'composition', label: '', line: r.line });
            grow(r.line, 0);
          }
      }
      i = end - 1;
    }
  }
  // Participants last: a flowchart or a table later in the document names the same component.
  const byLabel = new Map<string, number>();
  for (const [i, c] of out.comps.entries()) {
    const k = norm(c.label);
    byLabel.set(k, byLabel.has(k) ? -1 : i); // -1: two of them, not sure which
  }
  const own = new Map<string, number>();
  for (const { block: b, fence, seq } of seqs) {
    const at = new Map<string, number>();
    for (const p of seq.participants.values()) {
      const label = shown(p.label);
      const k = norm(label);
      const hit = byLabel.get(k) ?? -1;
      const line = fence + p.line;
      grow(line);
      if (hit >= 0) {
        out.comps[hit].also.push(line);
        at.set(p.id, hit);
      } else if (own.has(k)) at.set(p.id, own.get(k)!);
      else {
        own.set(k, out.comps.length);
        at.set(p.id, out.comps.length);
        out.comps.push({ block: b, node: nodeKey(p.id), label, kind: 'component', line, also: [] });
      }
    }
    for (const m of seq.messages) {
      out.links.push({ from: at.get(m.from)!, to: at.get(m.to)!, layer: 'interaction', label: shown(m.text), line: fence + m.line });
      grow(fence + m.line, 0);
    }
  }
  // BRN K8: the trees last, numbered after every other block (a document's diagrams and tables keep
  // their numbers); a tree line's node is its path, so moving it keeps its UID. Their own cap: past
  // SPEC_ARCH_TREE_LINES_MAX the rest is not read, and the document's diagrams are never refused for them.
  let treeLines = 0;
  for (const t of trees) {
    const b = block++;
    const seen = new Map<string, number>();
    for (const e of treeEntries(t.lines)) {
      if (++treeLines > SPEC_ARCH_TREE_LINES_MAX) break;
      const line = t.fence + e.line;
      const label = shown(e.path);
      const hit = seen.get(label);
      if (hit !== undefined) {
        out.comps[hit].also.push(line);
        continue;
      }
      seen.set(label, out.comps.length);
      out.comps.push({ block: b, node: nodeKey(`tree:${e.path}`), label, kind: 'component', line, also: [], path: label, tree: true });
    }
  }
  return out;
}

const live = (reg: SpecRegistry, doc: string) => {
  const d = reg.docs[doc];
  return !!d && d.tracked && d.state !== 'retired';
};

/**
 * The components of the documents read in a scan get their UIDs (doc UID → one per `comps`, in
 * order). The candidates are the components of those documents, every retired one and those of a
 * document that is gone; the rest are not touched. Passes from the most exact key to the least, each
 * a map lookup (linear): the same document and label at the same block and node, at the same node,
 * at the same block, anywhere in it; then the same label in another document (a block that moved,
 * or one that comes back) at the same node, then anywhere; then the same document, block and node
 * with another label. Anything else is new. A candidate left over retires; past
 * SPEC_ARCH_RETIRED_PER_DOC retired records of one document, the oldest go.
 */
// ponytail: a block moved to B in one scan and taken out of A in a later one gets new UIDs in B (A's are still there when B is read); a question queue for components comes with 4b.
export function matchComponents(reg: SpecRegistry, given: ReadonlyMap<string, DocArch>, rev: string, newUid: () => string, at = ''): Map<string, string[]> {
  const comps = reg.components;
  // A document refused whole is not read: its records stay as they are (a cap crossed for a moment loses nothing).
  const read = new Map([...given].filter(([, a]) => !a.whole));
  const refused = new Map([...read].map(([doc, a]) => [doc, new Set(a.refused ?? [])]));
  const held = (u: string) => !!refused.get(comps[u].doc)?.has(comps[u].block) && comps[u].state === 'active'; // in a block refused now (a typo): kept as it is
  const free = new Set(Object.keys(comps).filter((u) => (read.has(comps[u].doc) && !held(u)) || comps[u].state === 'retired' || !live(reg, comps[u].doc)));
  type In = { doc: string; c: ArchComp; fp: string; block: number; uid?: string };
  const all: In[] = [...read].flatMap(([doc, a]) => a.comps.map((c) => ({ doc, c, fp: fpOf(c.label), block: c.block })));
  // A block keeps its old number when its content (its labels) is an old block's: a block inserted
  // above two equal nodes does not swap them. Equal blocks pair up in document order.
  const sig = (fps: string[]) => [...fps].sort().join(',');
  const add = <K, V>(m: Map<K, V[]>, k: K, v: V) => {
    const list = m.get(k);
    if (list) list.push(v);
    else m.set(k, [v]);
  };
  const oldBlocks = new Map<string, Map<number, string[]>>();
  for (const u of free) {
    const r = comps[u];
    if (r.state !== 'active' || !read.has(r.doc)) continue;
    if (!oldBlocks.has(r.doc)) oldBlocks.set(r.doc, new Map());
    add(oldBlocks.get(r.doc)!, r.block, r.fp);
  }
  const newBlocks = new Map<string, Map<number, In[]>>();
  for (const x of all) {
    if (!newBlocks.has(x.doc)) newBlocks.set(x.doc, new Map());
    add(newBlocks.get(x.doc)!, x.c.block, x);
  }
  for (const [doc, m] of oldBlocks) {
    const bySig = new Map<string, number[]>();
    for (const [b, fps] of [...m].sort((x, y) => x[0] - y[0])) add(bySig, sig(fps), b);
    for (const [, xs] of [...(newBlocks.get(doc) ?? [])].sort((x, y) => x[0] - y[0])) {
      const old = bySig.get(sig(xs.map((x) => x.fp)))?.shift();
      if (old !== undefined) for (const x of xs) x.block = old;
    }
  }
  const order = [...free].sort((a, b) => comps[a].block - comps[b].block);
  const pass = (keyOf: (doc: string, fp: string, block: number, node: string) => string) => {
    const by = new Map<string, { list: string[]; next: number }>();
    for (const u of order) {
      if (!free.has(u)) continue;
      const r = comps[u];
      const k = keyOf(r.doc, r.fp, r.block, r.node);
      const e = by.get(k);
      if (e) e.list.push(u);
      else by.set(k, { list: [u], next: 0 });
    }
    for (const x of all) {
      if (x.uid) continue;
      const e = by.get(keyOf(x.doc, x.fp, x.block, x.c.node));
      while (e && e.next < e.list.length) {
        const u = e.list[e.next++];
        if (!free.has(u)) continue;
        x.uid = u;
        free.delete(u);
        break;
      }
    }
  };
  const k = (...parts: Array<string | number>) => parts.join('|');
  pass((doc, fp, block, node) => k(doc, fp, block, node));
  pass((doc, fp, _b, node) => k(doc, fp, node));
  pass((doc, fp, block) => k(doc, fp, block));
  pass((doc, fp) => k(doc, fp));
  pass((_d, fp, _b, node) => k(fp, node));
  pass((_d, fp) => k(fp));
  pass((doc, _f, block, node) => k(doc, block, node));
  const out = new Map<string, string[]>([...given.keys()].map((d) => [d, []]));
  for (const x of all) {
    const uid = x.uid ?? newUid();
    const old = comps[uid];
    comps[uid] = { doc: x.doc, block: x.c.block, node: x.c.node, fp: x.fp, state: 'active', firstRev: old?.firstRev ?? rev };
    out.get(x.doc)!.push(uid);
  }
  const retiredOf = new Map<string, string[]>();
  for (const u of Object.keys(comps)) {
    if (free.has(u) && comps[u].state !== 'retired') comps[u] = { ...comps[u], state: 'retired', retired: at };
    if (comps[u].state !== 'retired') continue;
    const list = retiredOf.get(comps[u].doc);
    if (list) list.push(u);
    else retiredOf.set(comps[u].doc, [u]);
  }
  for (const all of retiredOf.values()) {
    // Only what retired in an earlier scan goes: never one retired by this scan (it may come back next time).
    const list = all.filter((u) => (comps[u].retired ?? '') < at);
    if (list.length <= SPEC_ARCH_RETIRED_PER_DOC) continue;
    // Oldest first (the key order breaks ties: the order they were made).
    const old = list.map((u, i) => ({ u, i })).sort((a, b) => ((comps[a.u].retired ?? '') < (comps[b.u].retired ?? '') ? -1 : (comps[a.u].retired ?? '') > (comps[b.u].retired ?? '') ? 1 : a.i - b.i));
    for (const { u } of old.slice(0, list.length - SPEC_ARCH_RETIRED_PER_DOC)) delete comps[u];
  }
  return out;
}

/** The architecture of the live documents read (doc UID → its read and the UIDs matchComponents gave it), for one layer. */
export function archGraph(reg: SpecRegistry, docs: ReadonlyMap<string, { arch: DocArch; uids: string[] }>, layer: ArchLayer = 'interaction'): TraceArch {
  const nodes = new Map<string, ArchNode>();
  const groups: ArchGroup[] = [];
  const merged = new Map<string, ArchEdge>();
  const unsupported: ArchUnsupported[] = [];
  const diagrams: ArchDiagram[] = [];
  const order = [...docs].filter(([doc]) => live(reg, doc)).sort(([a], [b]) => (reg.docs[a].path < reg.docs[b].path ? -1 : 1));
  for (const [doc, { arch, uids }] of order) {
    const path = reg.docs[doc].path;
    const src = (line: number): ArchSource => ({ path, line });
    const gid = (key: string) => `g:${doc}:${key}`;
    for (const g of arch.groups) groups.push({ id: gid(g.key), label: g.label, ...(g.parent && { parent: gid(g.parent) }), source: src(g.line) });
    arch.comps.forEach((c, i) => {
      const id = uids[i];
      if (!id || c.tree || nodes.has(id) || reg.components[id]?.state !== 'active') return;
      nodes.set(id, { id, label: c.label, kind: c.kind, from: 'doc', standing: 'doc', diagram: `${doc}:${c.block}`, ...(c.group && { group: gid(c.group) }), sources: [src(c.line), ...c.also.map(src)] });
    });
    const end = (e: number | string) => (typeof e === 'number' ? uids[e] : gid(e));
    arch.links.forEach((l, k) => {
      if (layer === 'composition' && l.layer !== 'composition') return;
      const from = end(l.from);
      const to = end(l.to);
      if (!from || !to || from === to) return;
      // Parallel edges of one layer merge: their labels joined.
      const key = `${l.layer}|${from}|${to}`;
      const old = merged.get(key);
      if (old) {
        if (l.label && old.label !== undefined && old.label.length < SPEC_ITEM_TITLE_MAX && !old.label.split(' · ').includes(l.label)) old.label = `${old.label} · ${l.label}`.slice(0, SPEC_ITEM_TITLE_MAX);
        else if (l.label && old.label === undefined) old.label = l.label;
        return;
      }
      merged.set(key, { id: `e:${doc}:${k}`, from, to, layer: l.layer, ...(l.label && { label: l.label }), ...(l.ends && { ends: l.ends }), source: src(l.line) });
    });
    for (const u of arch.unsupported) unsupported.push({ doc: path, ...u });
    for (const b of arch.blocks ?? []) diagrams.push({ id: `${doc}:${b.block}`, doc, block: b.block, path, line: b.line, type: b.type, version: b.hash, standing: 'doc' });
  }
  const all = [...nodes.values()];
  const kept = all.slice(0, SPEC_ARCH_NODES_MAX);
  const ids = new Set(kept.map((n) => n.id));
  // A group stays while something is drawn in it.
  const used = new Set<string>();
  const byId = new Map(groups.map((g) => [g.id, g]));
  for (const n of kept) for (let g = n.group; g && !used.has(g); g = byId.get(g)?.parent) used.add(g);
  const shownGroups = groups.filter((g) => used.has(g.id));
  const there = (id: string) => ids.has(id) || used.has(id);
  // Each layer at most SPEC_ARCH_EDGES_MAX edges; the rest counted.
  const perLayer = new Map<ArchLayer, number>();
  let hiddenEdges = 0;
  const edges = [...merged.values()].filter((e) => {
    if (!there(e.from) || !there(e.to)) return false;
    const n = (perLayer.get(e.layer) ?? 0) + 1;
    perLayer.set(e.layer, n);
    if (n <= SPEC_ARCH_EDGES_MAX) return true;
    hiddenEdges++;
    return false;
  });
  return {
    layer,
    nodes: kept,
    groups: shownGroups,
    edges,
    unsupported: unsupported.slice(0, SPEC_ARCH_UNSUPPORTED_MAX),
    counts: { approved: 0, proposed: 0, fromDocs: all.length },
    diagrams: diagrams.slice(0, SPEC_ARCH_NODES_MAX),
    ...(all.length > kept.length && { hidden: all.length - kept.length }),
    ...(hiddenEdges && { hiddenEdges }),
  };
}
