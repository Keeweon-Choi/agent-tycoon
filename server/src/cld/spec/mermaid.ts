/**
 * SPT-P4A (SPT §8), pure: the strict Mermaid subset the architecture graph reads. The flowchart
 * reader is the R3 spike's (webview-ui/src/cld/graphSpike/mermaidFlow.ts, commit 4dc2e7c5, checked
 * against mermaid 12.2.0: cld/docs/research/spec-tracking-graph-2026-11-03.md §3), made strict: one
 * line outside the supported list and the whole block is refused with that line, never a partial
 * graph. A small sequence reader beside it. Every other diagram type is refused with its name.
 *
 * Supported: `graph|flowchart [TD|TB|BT|LR|RL]`, the twelve node shapes and quoted labels, `-->`
 * `---` `-.->` `-.-` `==>` `===` `--o` `--x` `<-->` `o--o` `~~~` and longer ones, edge labels
 * (`|x|`, `-- x -->`), chains, `&`, nested `subgraph … end`, `%%` comments, `;`. Ignored: `classDef`,
 * `class`, `:::`, `style`, `linkStyle`, `click`, `direction`, `%%{init}%%`, front matter.
 * `sequenceDiagram`: `participant`/`actor` (`as`), the eight message arrows and their text; ignored:
 * `activate`, `deactivate`, `note`, `autonumber`, the block lines (loop/alt/opt/par/rect/critical/
 * break, their else/and/option and `end`; the messages inside are read).
 * Not read (the block is refused): markdown labels, `A@{ … }`, edge ids, `title`, `box`, a subgraph
 * ID opened twice, anything else. A block past SPEC_ARCH_BLOCK_* nodes, edges or subgraphs is refused
 * as too big (`big`), so one line of `&` groups cannot multiply into millions of edges.
 */
import { SPEC_ARCH_BLOCK_EDGES_MAX, SPEC_ARCH_BLOCK_GROUPS_MAX, SPEC_ARCH_BLOCK_NODES_MAX, SPEC_ARCH_LINE_MAX } from '../../constants.js';

export type Dir = 'TD' | 'LR' | 'BT' | 'RL';
export type LineKind = 'solid' | 'dotted' | 'thick' | 'invisible';
/** `line`: 1-based within the block (the fence's next line is 1). */
export interface MNode {
  id: string;
  label: string;
  shape: string;
  line: number;
}
export interface MEdge {
  from: string;
  to: string;
  label: string;
  kind: LineKind;
  arrow: boolean;
  bidir: boolean;
  line: number;
}
export interface MSub {
  /** Its place among the block's subgraphs (what the graph keys it by: never its text). */
  index: number;
  id: string;
  title: string;
  parent: string | null;
  nodes: string[];
  line: number;
}
export interface MFlow {
  dir: Dir;
  nodes: Map<string, MNode>;
  edges: MEdge[];
  subgraphs: MSub[];
  /** Node ID → the index of the first subgraph that lists it. */
  groupOf: Map<string, number>;
}
export interface MParticipant {
  id: string;
  label: string;
  line: number;
}
export interface MMessage {
  from: string;
  to: string;
  text: string;
  arrow: string;
  line: number;
}
export interface MSeq {
  participants: Map<string, MParticipant>;
  messages: MMessage[];
}
/** The first line the subset does not hold (1-based within the block) and its text; `big`: refused for its size. */
export interface Blocked {
  line: number;
  text: string;
  big?: true;
  /** The nodes and edges (participants and messages) built before it was refused: the document's budget counts them. */
  cost?: number;
}
export type MBlock = { type: 'flowchart'; flow: MFlow } | { type: 'sequenceDiagram'; seq: MSeq } | { type: string; unsupported: Blocked };

// Sticky (`y`): matched at lastIndex, so no token copies the rest of its line.
const ID = /(?:[\p{L}\p{N}_$]|[-.](?=[\p{L}\p{N}_$]))+/uy;
// opener -> [shape, closers]
const SHAPES: Array<[string, string, string[]]> = [
  ['(((', 'doublecircle', [')))']],
  ['((', 'circle', ['))']],
  ['([', 'stadium', ['])']],
  ['(', 'round', [')']],
  ['[[', 'subroutine', [']]']],
  ['[(', 'cylinder', [')]']],
  ['[/', 'trapezoid', ['/]', '\\]']],
  ['[\\', 'trapezoid', ['\\]', '/]']],
  ['[', 'rect', [']']],
  ['{{', 'hexagon', ['}}']],
  ['{', 'rhombus', ['}']],
  ['>', 'asymmetric', [']']],
];
const SKIP = /^(classDef|class|style|linkStyle|click|direction)(\s|$)/;
// `-- text -->`, `-. text .->`, `== text ==>` (spaces optional: `-.text.->`)
const TEXT_EDGE = /([<ox])?(--|==|-\.)(?:\s+|(?=[^\s>\-=.ox]))("[^"]*"|.+?)\s*(-{2,}[>ox]?|={2,}>?|\.+-[>ox]?)(?![-=])/y;
// `-->` `---` `--o` `<-->` `o--o` `==>` `===` `-.->` `-.-` `~~~`
const PLAIN_EDGE = /([<ox])?(?:(-{2,})([>ox])?|(={2,})(>)?|(-\.+-)(>)?|(~{3,}))/y;
/** The statements of a line: split at each `;` outside double quotes, in one pass. */
export function statements(line: string): string[] {
  const out: string[] = [];
  let quoted = false;
  let start = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    else if (line[i] === ';' && !quoted) {
      out.push(line.slice(start, i));
      start = i + 1;
    }
  }
  out.push(line.slice(start));
  return out;
}

/** Quotes off, `<br>` to a line break. */
export const cleanLabel = (s: string): string =>
  s
    .trim()
    .replace(/^"(.*)"$/s, '$1')
    .replace(/<br\s*\/?>/gi, '\n');

type Read = { n: MNode; end: number; explicit: boolean };

/** A node at `i`: null when no ID starts there; 'bad' for a markdown label (`"\`…\`"`). */
const at = (re: RegExp, s: string, i: number) => {
  re.lastIndex = i;
  return re.exec(s);
};

function readNode(s: string, i: number, line: number): Read | null | 'bad' {
  const m = at(ID, s, i);
  if (!m) return null;
  let j = i + m[0].length;
  const id = m[0];
  let label = id;
  let shape = 'rect';
  let explicit = false;
  for (const [open, name, closers] of SHAPES) {
    if (!s.startsWith(open, j)) continue;
    let k = j + open.length;
    if (s[k] === '"') {
      // A quoted label may hold closers.
      const q = s.indexOf('"', k + 1);
      if (q < 0) break;
      if (s[k + 1] === '`') return 'bad';
      label = s.slice(k + 1, q);
      k = q + 1;
      const c = closers.find((cl) => s.startsWith(cl, k));
      if (!c) break;
      j = k + c.length;
      shape = name;
      explicit = true;
      break;
    }
    const hits = closers
      .map((c) => [s.indexOf(c, k), c] as const)
      .filter(([p]) => p >= 0)
      .sort((a, b) => a[0] - b[0]);
    if (!hits.length) break;
    label = s.slice(k, hits[0][0]);
    j = hits[0][0] + hits[0][1].length;
    shape = name;
    explicit = true;
    break;
  }
  if (s.startsWith(':::', j)) j += 3 + (at(ID, s, j + 3)?.[0].length ?? 0);
  return { n: { id, label: cleanLabel(label), shape, line }, end: j, explicit };
}

function readEdge(s: string, i: number): { e: Omit<MEdge, 'from' | 'to' | 'line'>; end: number } | null {
  let m = at(TEXT_EDGE, s, i);
  let kind: LineKind;
  let arrow: boolean;
  let bidir: boolean;
  let label = '';
  let len: number;
  if (m) {
    kind = m[2] === '==' ? 'thick' : m[2] === '-.' ? 'dotted' : 'solid';
    arrow = /[>ox]$/.test(m[4]);
    bidir = !!m[1];
    label = m[3];
    len = m[0].length;
  } else if ((m = at(PLAIN_EDGE, s, i))) {
    kind = m[8] ? 'invisible' : m[4] ? 'thick' : m[6] ? 'dotted' : 'solid';
    arrow = !!(m[3] || m[5] || m[7]);
    bidir = !!m[1];
    len = m[0].length;
  } else return null;
  let end = i + len;
  while (s[end] === ' ') end++;
  if (s[end] === '|') {
    // |label| (possibly quoted)
    const q = s.indexOf('|', end + 1);
    if (q > 0) {
      label = s.slice(end + 1, q);
      end = q + 1;
    }
  }
  return { e: { label: cleanLabel(label), kind, arrow, bidir }, end };
}

/** A block's lines that count: front matter, `%%{…}%%` directives and `%%` comments out; `raw` is the line as written. */
function significant(src: string): { lines: Array<{ n: number; text: string; raw: string }>; bad?: Blocked } {
  const raw = src.split(/\r?\n/);
  let i = 0;
  while (i < raw.length && !raw[i].trim()) i++;
  if (raw[i]?.trim() === '---') {
    const close = raw.findIndex((l, k) => k > i && l.trim() === '---');
    if (close < 0) return { lines: [], bad: { line: i + 1, text: raw[i].trim() } };
    i = close + 1;
  }
  const lines: Array<{ n: number; text: string; raw: string }> = [];
  let directive = false;
  for (; i < raw.length; i++) {
    const t = raw[i].trim();
    if (directive) {
      if (t.includes('}%%')) directive = false;
      continue;
    }
    if (t.startsWith('%%{')) {
      directive = !t.slice(3).includes('}%%');
      continue;
    }
    if (t.length > SPEC_ARCH_LINE_MAX) return { lines, bad: { line: i + 1, text: t.slice(0, SPEC_ARCH_LINE_MAX) } };
    const text = t.replace(/%%.*$/, '').trim();
    if (text) lines.push({ n: i + 1, text, raw: t });
  }
  return { lines };
}

type Flow = { f: MFlow; stack: MSub[]; members: Set<string>[]; ids: Set<string> };
/** One statement of a flowchart: 'ok' when the subset reads all of it; 'big' past a cap. */
function flowStatement(st: Flow, s: string, line: number): 'ok' | 'bad' | 'big' {
  const { f, stack } = st;
  const sg = /^subgraph(?:\s+(.*))?$/.exec(s);
  if (sg) {
    const arg = (sg[1] ?? '').trim();
    if (!arg) return 'bad';
    const withId = /^([^\s[\]"]+)\s*\[(.*)\]$/.exec(arg);
    const id = cleanLabel(withId ? withId[1] : arg);
    if (st.ids.has(id)) return 'bad'; // opened again: mermaid's own merge rules are not read (and a parent cycle is not made)
    if (f.subgraphs.length >= SPEC_ARCH_BLOCK_GROUPS_MAX) return 'big';
    st.ids.add(id);
    const sub: MSub = { index: f.subgraphs.length, id, title: cleanLabel(withId ? withId[2] : arg), parent: stack.at(-1)?.id ?? null, nodes: [], line };
    f.subgraphs.push(sub);
    st.members.push(new Set());
    stack.push(sub);
    return 'ok';
  }
  if (s === 'end') return stack.pop() !== undefined ? 'ok' : 'bad';
  if (SKIP.test(s)) return 'ok';
  const touch = (r: Read) => {
    const old = f.nodes.get(r.n.id);
    if (!old) f.nodes.set(r.n.id, r.n);
    else if (r.explicit) Object.assign(old, { label: r.n.label, shape: r.n.shape, ...(old.label === old.id && old.shape === 'rect' && { line }) });
    const cur = stack.at(-1);
    if (cur && !st.members[cur.index].has(r.n.id)) {
      st.members[cur.index].add(r.n.id);
      cur.nodes.push(r.n.id);
      if (!f.groupOf.has(r.n.id)) f.groupOf.set(r.n.id, cur.index);
    }
  };
  // statement: group (edge group)*   where group = node (& node)*
  let i = 0;
  let prev: string[] | null = null;
  let pending: Omit<MEdge, 'from' | 'to' | 'line'> | null = null;
  for (;;) {
    while (s[i] === ' ') i++;
    const group: string[] = [];
    for (;;) {
      const r = readNode(s, i, line);
      if (r === 'bad') return 'bad';
      if (!r) break;
      touch(r);
      if (f.nodes.size > SPEC_ARCH_BLOCK_NODES_MAX) return 'big';
      group.push(r.n.id);
      i = r.end;
      while (s[i] === ' ') i++;
      if (s[i] !== '&') break;
      i++;
      while (s[i] === ' ') i++;
    }
    if (!group.length) return 'bad'; // a node expected: an edge with no end, or something else
    if (prev && pending) {
      // `a & b & … --> c & d & …` multiplies: counted before any is made.
      if (f.edges.length + prev.length * group.length > SPEC_ARCH_BLOCK_EDGES_MAX) return 'big';
      for (const a of prev) for (const b of group) f.edges.push({ from: a, to: b, line, ...pending });
    }
    prev = group;
    while (s[i] === ' ') i++;
    if (i >= s.length) return 'ok';
    const e = readEdge(s, i);
    if (!e) return 'bad'; // `A@{…}`, an edge id, text after a node
    pending = e.e;
    i = e.end;
  }
}

function parseFlow(lines: Array<{ n: number; text: string; raw: string }>): MBlock {
  const head = /^(?:graph|flowchart(?:-elk)?)(?:\s+(TD|TB|BT|LR|RL))?\s*(?:;(.*))?$/i.exec(lines[0].text);
  if (!head) return { type: 'flowchart', unsupported: { line: lines[0].n, text: lines[0].raw } };
  const f: MFlow = { dir: (head[1] ?? 'TD').toUpperCase().replace('TB', 'TD') as Dir, nodes: new Map(), edges: [], subgraphs: [], groupOf: new Map() };
  const st: Flow = { f, stack: [], members: [], ids: new Set() };
  const stack = st.stack;
  const rest = [{ ...lines[0], text: head[2] ?? '' }, ...lines.slice(1)];
  for (const l of rest)
    for (const part of statements(l.text)) {
      const s = part.trim();
      const r = s ? flowStatement(st, s, l.n) : 'ok';
      if (r !== 'ok') return { type: 'flowchart', unsupported: { line: l.n, text: l.raw, ...(r === 'big' && { big: true as const }), cost: f.nodes.size + f.edges.length } };
    }
  // An open subgraph: mermaid refuses the block too.
  if (stack.length) return { type: 'flowchart', unsupported: { line: stack[0].line, text: lines.find((l) => l.n === stack[0].line)?.raw ?? '' } };
  return { type: 'flowchart', flow: f };
}

const PARTICIPANT = /^(participant|actor)\s+([^:;,<>+@{}"]+?)(?:\s+as\s+(.+))?$/;
const MESSAGE = /^([^:;,<>+@{}"]+?)\s*(-->>|->>|--x|--\)|-->|-x|-\)|->)([+-]?)\s*([^:;,<>+@{}"]+?)\s*:(.*)$/;
const SEQ_IGNORED = /^(activate|deactivate)\s+\S|^note\s+(left of|right of|over)\s+[^:]+:|^autonumber(\s|$)/i;
const SEQ_OPEN = /^(loop|alt|opt|par|rect|critical|break)(\s|$)/;
const SEQ_MID = /^(else|and|option)(\s|$)/;

function parseSequence(lines: Array<{ n: number; text: string; raw: string }>): MBlock {
  const seq: MSeq = { participants: new Map(), messages: [] };
  const cost = () => seq.participants.size + seq.messages.length;
  const no = (l: { n: number; raw: string }): MBlock => ({ type: 'sequenceDiagram', unsupported: { line: l.n, text: l.raw, cost: cost() } });
  const big = (l: { n: number; raw: string }): MBlock => ({ type: 'sequenceDiagram', unsupported: { line: l.n, text: l.raw, big: true, cost: cost() } });
  const meet = (id: string, label: string, line: number) => {
    if (!seq.participants.has(id)) seq.participants.set(id, { id, label, line });
  };
  if (lines[0].text !== 'sequenceDiagram') return no(lines[0]);
  let depth = 0;
  for (const l of lines.slice(1)) {
    const s = l.text;
    const p = PARTICIPANT.exec(s);
    if (p) {
      const id = p[2].trim();
      if (seq.participants.has(id)) return no(l); // declared twice: mermaid's own rules (create/destroy) are not read
      meet(id, cleanLabel(p[3] ?? id), l.n);
      if (seq.participants.size > SPEC_ARCH_BLOCK_NODES_MAX) return big(l);
      continue;
    }
    const m = MESSAGE.exec(s);
    if (m) {
      const [from, to] = [m[1].trim(), m[4].trim()];
      meet(from, from, l.n);
      meet(to, to, l.n);
      seq.messages.push({ from, to, text: cleanLabel(m[5]), arrow: m[2], line: l.n });
      if (seq.participants.size > SPEC_ARCH_BLOCK_NODES_MAX || seq.messages.length > SPEC_ARCH_BLOCK_EDGES_MAX) return big(l);
      continue;
    }
    if (SEQ_OPEN.test(s)) depth++;
    else if (s === 'end') {
      if (!depth--) return no(l);
    } else if (!(SEQ_MID.test(s) && depth) && !SEQ_IGNORED.test(s)) return no(l);
  }
  return { type: 'sequenceDiagram', seq };
}

/** One Mermaid block (the text between the fences): a flowchart, a sequence, or refused with its type and first blocked line. */
export function parseMermaid(src: string): MBlock {
  const { lines, bad } = significant(src);
  if (bad) return { type: lines[0]?.text.split(/[\s;]/)[0] || 'unknown', unsupported: bad };
  if (!lines.length) return { type: 'unknown', unsupported: { line: 1, text: '' } };
  const word = lines[0].text.split(/[\s;]/)[0];
  if (/^(graph|flowchart(-elk)?)$/i.test(word)) return parseFlow(lines);
  if (word === 'sequenceDiagram') return parseSequence(lines);
  return { type: word, unsupported: { line: lines[0].n, text: lines[0].raw } };
}
