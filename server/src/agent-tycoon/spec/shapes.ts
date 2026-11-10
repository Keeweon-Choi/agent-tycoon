/**
 * RQ5 (requirements-workflow.md §3.2), pure: the known document shapes besides Spec Kit (speckit.ts),
 * read by rules only, nothing guessed. A shape is known by where the file sits, never by a heading in
 * a random document (`### Requirement 3` outside the folder rule stays what it is today).
 *
 *   OpenSpec (Fission-AI, MIT)  `openspec/specs/<capability>/spec.md`: `### Requirement: name` +
 *       `#### Scenario:` with WHEN/THEN; `openspec/changes/<name>/` holds the changes in progress:
 *       `tasks.md` checkboxes, `specs/<capability>/spec.md` deltas under `## ADDED|MODIFIED|REMOVED
 *       Requirements`; `openspec/changes/archive/` is a record. Source: docs/concepts.md and
 *       openspec/specs/cli-init/spec.md of github.com/Fission-AI/OpenSpec.
 *   Kiro (AWS)  `.kiro/specs/<feature>/requirements.md`: `### Requirement N[: name]`, `**User Story:**`,
 *       `#### Acceptance Criteria` with numbered EARS lines; `tasks.md`: `- [ ] 2.1 text` with a
 *       `_Requirements: 1.1, 2.3_` line below. Source: real generated specs (crawlab-team/artipub and
 *       jbest84/NUglify, `.kiro/specs/*`); kiro.dev's own pages show neither (see the RQ5 report).
 *   ADR  the one-word status of a decision record.
 *
 * Each reader takes one file's text and returns what it says with its lines. Nothing here reads a
 * disk, masks or stores: the caller masks what it sends.
 */
import { clean, FENCE, frontMatter, HEADING } from '../tracking/docs.js';

export type Shape =
  | { tool: 'kiro'; feature: string; file: 'requirements' | 'design' | 'tasks' }
  | { tool: 'openspec'; file: 'spec'; cap: string; change?: string }
  | { tool: 'openspec'; file: 'tasks'; change: string };

const KIRO_PATH = /(?:^|\/)\.kiro\/specs\/([^/]+)\/(requirements|design|tasks)\.md$/i;
const OPENSPEC_SPEC = /(?:^|\/)openspec\/specs\/(.+)\/spec\.md$/i;
const OPENSPEC_DELTA = /(?:^|\/)openspec\/changes\/(?!archive\/)([^/]+)\/specs\/(.+)\/spec\.md$/i;
const OPENSPEC_TASKS = /(?:^|\/)openspec\/changes\/(?!archive\/)([^/]+)\/tasks\.md$/i;
/** A change that was archived: a record, not a requirement in force. */
export const OPENSPEC_ARCHIVE = /(?:^|\/)openspec\/changes\/archive\//i;

/** The known shape a path sits in, or null (Spec Kit has its own: `kitOf`). */
export function shapeOf(rel: string): Shape | null {
  const k = KIRO_PATH.exec(rel);
  if (k) return { tool: 'kiro', feature: k[1], file: k[2].toLowerCase() as 'requirements' | 'design' | 'tasks' };
  const s = OPENSPEC_SPEC.exec(rel);
  if (s && !OPENSPEC_ARCHIVE.test(rel) && !/(?:^|\/)openspec\/changes\//i.test(rel)) return { tool: 'openspec', file: 'spec', cap: s[1] };
  const d = OPENSPEC_DELTA.exec(rel);
  if (d) return { tool: 'openspec', file: 'spec', cap: d[2], change: d[1] };
  const t = OPENSPEC_TASKS.exec(rel);
  return t ? { tool: 'openspec', file: 'tasks', change: t[1] } : null;
}
/** The extract option for a document: its known shape when it sits in one. */
export const shapeOpt = (rel: string): { shape?: Shape } => {
  const s = shapeOf(rel);
  return s ? { shape: s } : {};
};

// ── Kiro ──

/** `Requirement 3` / `Requirement 3: Tokenize the selector` → [3, name]. */
const KIRO_REQ = /^Requirements?\s+(\d+)\s*(?:[:.\-–—]\s*(.*))?$/i;
export const kiroReq = (title: string): { n: number; name: string } | null => {
  const m = KIRO_REQ.exec(title);
  return m ? { n: Number(m[1]), name: clean(m[2] ?? '') } : null;
};
/** The display ID of a Kiro requirement: `<feature>/R3`. */
export const kiroId = (feature: string, n: number | string): string => `${feature}/R${n}`;

export interface KiroTask {
  line: number;
  done: boolean;
  /** `2.1` for `- [ ] 2.1 text`; undefined when the line has no number. */
  id?: string;
  text: string;
  /** The `_Requirements: 1.1, 2.3_` numbers written under it (requirement, criterion). */
  reqs: Array<{ req: number; criterion?: number; text: string }>;
}
/** A checkbox, `[ ]*` (an optional task) too. */
const KIRO_TASK = /^(\s*)[-*+]\s+\[([ xX~-])\]\*?\s+(?:(\d+(?:\.\d+)*)\.?\s+)?(.*)$/;
/** The only form seen in real Kiro files: `_Requirements: 1.1, 2.3_` (numbers only), as a list item or alone. */
const KIRO_REFS = /^(\s*)(?:[-*+]\s+)?_Requirements:\s*(\d+(?:\.\d+)?(?:\s*,\s*\d+(?:\.\d+)?)*)\s*_\s*$/;

/**
 * tasks.md: its checklist and, under each task, the requirements it names. A `_Requirements:` line
 * belongs to the nearest checkbox above it only when it is indented deeper than that checkbox; a
 * heading ends the claim. Anything else on the line (other words, other tags) is not read.
 */
export function readKiroTasks(text: string): KiroTask[] {
  const out: KiroTask[] = [];
  let last: { task: KiroTask; indent: number } | null = null;
  let fenced = false;
  text.split(/\r?\n/).forEach((s, i) => {
    if (FENCE.test(s)) return void (fenced = !fenced);
    if (fenced) return;
    if (HEADING.test(s)) return void (last = null);
    const box = KIRO_TASK.exec(s);
    if (box) {
      const task: KiroTask = { line: i + 1, done: box[2] !== ' ', ...(box[3] && { id: box[3] }), text: clean(box[4]), reqs: [] };
      out.push(task);
      last = { task, indent: box[1].length };
      return;
    }
    const ref = KIRO_REFS.exec(s);
    if (!ref || !last || ref[1].length <= last.indent) return;
    for (const n of ref[2].split(',')) {
      const [req, criterion] = n.trim().split('.');
      last.task.reqs.push({ req: Number(req), ...(criterion !== undefined && { criterion: Number(criterion) }), text: n.trim() });
    }
  });
  return out;
}
/** The requirement display IDs a task names (`1.1` and `1.3` are both `<feature>/R1`). */
export const kiroTaskRefs = (feature: string, t: KiroTask): string[] => [...new Set(t.reqs.map((r) => kiroId(feature, r.req)))];

// ── OpenSpec ──

/** `Requirement: User login` → `User login`. */
export const openspecName = (title: string): string | null => /^Requirement\s*:\s*(.+)$/i.exec(title)?.[1].trim() ?? null;

export const OPENSPEC_OPS = ['added', 'modified', 'removed'] as const;
export type OpenSpecOp = (typeof OPENSPEC_OPS)[number];
const OPENSPEC_OP = /^(ADDED|MODIFIED|REMOVED)\s+Requirements\s*$/i;

/**
 * A change's delta spec: the line of each `### Requirement:` heading under a `## ADDED|MODIFIED|REMOVED
 * Requirements` section, with which one. A requirement under any other `##` (RENAMED, a stray one) has none.
 */
export function openspecOps(text: string): Map<number, OpenSpecOp> {
  const out = new Map<number, OpenSpecOp>();
  let op: OpenSpecOp | null = null;
  let fenced = false;
  text.split(/\r?\n/).forEach((s, i) => {
    if (FENCE.test(s)) return void (fenced = !fenced);
    const h = fenced ? null : HEADING.exec(s);
    if (!h) return;
    if (h[1].length === 2) op = (OPENSPEC_OP.exec(clean(h[2]))?.[1].toLowerCase() as OpenSpecOp | undefined) ?? null;
    else if (op && h[1].length === 3 && openspecName(clean(h[2]))) out.set(i + 1, op);
  });
  return out;
}

// ── ADR ──

export const ADR_STATUSES = ['proposed', 'accepted', 'deprecated', 'superseded'] as const;
export type AdrStatus = (typeof ADR_STATUSES)[number];
const ADR_WORDS: Readonly<Record<string, AdrStatus>> = {
  proposed: 'proposed',
  제안: 'proposed',
  제안됨: 'proposed',
  accepted: 'accepted',
  채택: 'accepted',
  채택됨: 'accepted',
  deprecated: 'deprecated',
  폐기: 'deprecated',
  폐기됨: 'deprecated',
  superseded: 'superseded',
  대체: 'superseded',
  대체됨: 'superseded',
};
/** A status word: its first word, lower case, when it is one of the four. A template's `{proposed | accepted}` is none. */
function adrWord(value: string): AdrStatus | undefined {
  const v = clean(value);
  if (/[{|]/.test(v)) return undefined;
  const first = v.toLowerCase().match(/^[^\s,.;:(\[]+/)?.[0];
  return first ? ADR_WORDS[first] : undefined;
}
const STATUS_LINE = /^\s*(?:[-*]\s+)?\**Status\**\s*:\s*(.+)$/i;

/**
 * An ADR's status (proposed / accepted / deprecated / superseded): the front matter's `status:`,
 * else a `## Status` section's first line (Nygard, MADR), else a `Status: …` line in the first 40
 * lines (MADR 2). A word it does not know (`rejected`, `draft`, a template placeholder) stays unread.
 */
export function adrStatus(text: string): AdrStatus | undefined {
  const lines = text.split(/\r?\n/);
  const { fields, end } = frontMatter(lines);
  const fm = fields.get('status');
  if (fm !== undefined) return adrWord(fm);
  let fenced = false;
  for (let i = end; i < lines.length; i++) {
    if (FENCE.test(lines[i])) fenced = !fenced;
    if (fenced) continue;
    const h = HEADING.exec(lines[i]);
    if (h && /^status$/i.test(clean(h[2]))) {
      for (let j = i + 1; j < lines.length && !HEADING.test(lines[j]); j++) {
        const l = lines[j].trim().replace(/^[-*]\s+/, '');
        if (l && !l.startsWith('<!--')) return adrWord(l);
      }
      return undefined;
    }
    const m = i - end < 40 ? STATUS_LINE.exec(lines[i]) : null;
    if (m) return adrWord(m[1]);
  }
  return undefined;
}
