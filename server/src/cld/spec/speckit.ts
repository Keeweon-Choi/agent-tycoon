/**
 * K9 (Project Brain §8), pure: what a GitHub Spec Kit feature folder (`specs/NNN-name/`) says,
 * read by rules only (no model). Spec Kit ships no parser or schema, only the Markdown templates
 * (github/spec-kit `templates/spec-template.md`, `plan-template.md`, `tasks-template.md`), so these
 * readers match the template's shapes and ignore every section they do not know (a preset may
 * rename them). Each reader takes one file's text and returns what the file says with its lines;
 * nothing here reads a disk, masks or stores: the caller masks what it sends.
 *
 *   spec.md      `### User Story N - Title (Priority: Pn)`, the `**Acceptance Scenarios**:` list under
 *                it, `- **FR-001**: …`, `- **SC-001**: …`, `### Key Entities` bullets
 *   tasks.md     `## Phase N: …`, `- [ ] T001 [P] [USn] text with src/path.ts`
 *   plan.md      `**Language/Version**: …` under Technical Context, the code blocks under Project Structure
 *   research.md  `Decision:`, `Rationale:`, `Alternatives considered:`
 *
 * A number (`FR-001`, `T001`, `US1`) means something only inside its folder, so the display ID a
 * document item gets is `<folder>/<number>` (`kitId`).
 */
import { clean, FENCE, HEADING } from '../tracking/docs.js';

/** Any file under a feature folder (`specs/002-checkout/…`); `.kiro/specs/` is Kiro's (shapes.ts), not Spec Kit's. */
export const SPEC_KIT_DIR = /(?:^|\/)(?<!\.kiro\/)specs\/(\d{3}-[^/]+)\//;
/** `specs/002-checkout/spec.md` → folder `002-checkout`, file `spec.md`. */
export const SPEC_KIT_PATH = /(?:^|\/)(?<!\.kiro\/)specs\/(\d{3}-[^/]+)\/([^/]+)$/;
export const kitOf = (path: string): { dir: string; file: string } | null => {
  const m = SPEC_KIT_PATH.exec(path);
  return m ? { dir: m[1], file: m[2].toLowerCase() } : null;
};
/** The extract option for a document: its feature folder when it sits in one. */
export const kitOpt = (path: string): { speckit?: string } => {
  const k = kitOf(path);
  return k ? { speckit: k.dir } : {};
};
/** The display ID a number gets inside its feature folder (`002-checkout/FR-001`). */
export const kitId = (dir: string, num: string): string => `${dir}/${num}`;
/** `002-checkout/US2` → [folder, 2]. */
export const STORY_ID = /^(\d{3}-[^/]+)\/US(\d+)$/;

// ── shared line walk: outside fenced code and `<!-- -->` ──

/** Lines (1-based) that are prose: not in a code fence, not in an HTML comment. */
function proseLines(text: string): Array<{ n: number; s: string }> {
  const out: Array<{ n: number; s: string }> = [];
  let fenced = false;
  let comment = false;
  text.split(/\r?\n/).forEach((s, i) => {
    if (comment) {
      if (s.includes('-->')) comment = false;
      return;
    }
    if (FENCE.test(s)) return void (fenced = !fenced);
    if (fenced) return;
    if (/^\s*<!--/.test(s) && !s.includes('-->')) return void (comment = true);
    if (/^\s*<!--.*-->\s*$/.test(s)) return;
    out.push({ n: i + 1, s });
  });
  return out;
}

// ── spec.md ──

export interface KitStory {
  /** 1 for `User Story 1`. */
  n: number;
  title: string;
  /** `P1`, or '' when the heading names none. */
  priority: string;
  line: number;
  scenarios: string[];
}
export interface KitReq {
  /** `FR-001` / `SC-001`. */
  id: string;
  text: string;
  line: number;
  /** The text carries a `[NEEDS CLARIFICATION: …]`. */
  clarify: boolean;
}
export interface KitSpec {
  title: string;
  stories: KitStory[];
  frs: KitReq[];
  scs: KitReq[];
  entities: string[];
}

const STORY = /^###\s+User Story\s+(\d+)\s*[-–—:]\s*(.*?)\s*(?:\(\s*Priority:\s*(P\d+)\s*\))?\s*$/i;
const FR_LINE = /^\s*[-*]\s+\*\*(FR-\d{3,})\*\*\s*[:：]\s*(.+)$/;
const SC_LINE = /^\s*[-*]\s+\*\*(SC-\d{3,})\*\*\s*[:：]\s*(.+)$/;
const ENTITY = /^\s*[-*]\s+\*\*([^*]+)\*\*\s*[:：]/;
const SCENARIO_LABEL = /^\s*\*{0,2}Acceptance Scenarios\*{0,2}\s*:?\*{0,2}\s*$/i;
const NUMBERED = /^\s*\d{1,3}[.)]\s+(.*)$/;
const CLARIFY = /\[NEEDS CLARIFICATION[^\]]*\]/i;
const cleanReq = (m: RegExpExecArray, line: number): KitReq => ({ id: m[1], text: clean(m[2].replace(CLARIFY, '')), line, clarify: CLARIFY.test(m[2]) });

export function readSpec(text: string): KitSpec {
  const out: KitSpec = { title: '', stories: [], frs: [], scs: [], entities: [] };
  let story: KitStory | null = null;
  let scenarios = false;
  let entities = false;
  for (const { n, s } of proseLines(text)) {
    const h = HEADING.exec(s);
    if (h) {
      scenarios = false;
      const level = h[1].length;
      const st = STORY.exec(s);
      if (st) out.stories.push((story = { n: Number(st[1]), title: clean(st[2]), priority: st[3] ?? '', line: n, scenarios: [] }));
      else if (level <= 3) story = null;
      entities = /^key entities\b/i.test(h[2]);
      if (level === 1) out.title ||= /^Feature Specification:\s*(.+)$/i.exec(h[2])?.[1].trim() ?? '';
      continue;
    }
    if (story) {
      if (SCENARIO_LABEL.test(s)) scenarios = true;
      else if (scenarios) {
        const item = NUMBERED.exec(s);
        if (item) story.scenarios.push(clean(item[1]));
        else if (/^\s*(\*\*|---)/.test(s)) scenarios = false;
      }
    }
    const fr = FR_LINE.exec(s);
    if (fr) out.frs.push(cleanReq(fr, n));
    const sc = SC_LINE.exec(s);
    if (sc) out.scs.push(cleanReq(sc, n));
    const en = entities ? ENTITY.exec(s) : null;
    if (en) out.entities.push(clean(en[1]));
  }
  return out;
}

// ── tasks.md ──

export interface KitTask {
  /** `T001`. */
  id: string;
  done: boolean;
  /** `[P]`: can run in parallel. */
  parallel: boolean;
  /** `[US2]` → 2. */
  story?: number;
  /** The text after the tags. */
  text: string;
  /** Repository paths the line names, in order. */
  files: string[];
  /** The `FR-###` numbers the line names. */
  frs: string[];
  /** The phase heading it sits under (its position in `phases`), -1 before any. */
  phase: number;
  line: number;
}
export interface KitPhase {
  /** `Phase 3: …` → `3`; the template's last one is `Phase N`. */
  label: string;
  title: string;
  line: number;
}
export interface KitTasks {
  tasks: KitTask[];
  phases: KitPhase[];
  /** A `Dependencies & Execution Order` section is there: prose this reader does not read. */
  dependenciesProse: boolean;
}

const PHASE = /^##\s+Phase\s+([A-Za-z0-9]+)\s*[:：-]\s*(.*)$/i;
const TASK_LINE = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/;
const TASK_HEAD = /^(T\d{3,4})\b\s*(.*)$/;
/** A repository path in a line: segments with at least one `/`, a file extension, not a URL or an absolute route. */
const PATH_IN_TEXT = /(?<![\w/:.@~-])((?:[\w.@-]+\/)+[\w.@-]+\.\w{1,8})(?![\w/])/g;
const FR_MENTION = /\bFR-\d{3,}\b/g;

/** `T001 [P] [US1] text` (a checkbox line's text without the box): null when it does not start with a task number. */
export function taskFromTitle(title: string, tags = true): Omit<KitTask, 'done' | 'phase' | 'line'> | null {
  const head = TASK_HEAD.exec(clean(title));
  if (!head) return null;
  let rest = head[2];
  let parallel = false;
  let story: number | undefined;
  // `tags` false: the tag rule off, the negative control of the tests.
  for (let t = tags ? /^\[([^\]]*)\]\s*/.exec(rest) : null; t; t = /^\[([^\]]*)\]\s*/.exec(rest)) {
    rest = rest.slice(t[0].length);
    if (t[1].trim().toUpperCase() === 'P') parallel = true;
    const us = /^US(\d+)$/i.exec(t[1].trim());
    if (us) story = Number(us[1]);
  }
  return {
    id: head[1],
    parallel,
    ...(story !== undefined && { story }),
    text: rest,
    files: [...new Set([...rest.matchAll(PATH_IN_TEXT)].map((m) => m[1]))],
    frs: [...new Set(rest.match(FR_MENTION) ?? [])],
  };
}

export function readTasks(text: string, tags = true): KitTasks {
  const out: KitTasks = { tasks: [], phases: [], dependenciesProse: false };
  for (const { n, s } of proseLines(text)) {
    const ph = PHASE.exec(s);
    if (ph) {
      out.phases.push({ label: ph[1], title: clean(ph[2]), line: n });
      continue;
    }
    if (/^#{2,3}\s+Dependencies\b/i.test(s)) out.dependenciesProse = true;
    const box = TASK_LINE.exec(s);
    const t = box ? taskFromTitle(box[2], tags) : null;
    if (box && t) out.tasks.push({ ...t, done: box[1] !== ' ', phase: out.phases.length - 1, line: n });
  }
  return out;
}

// ── plan.md ──

export interface KitPlanPath {
  /** `src/api/loans/` (a folder ends with `/`). */
  path: string;
  note?: string;
  line: number;
}
export interface KitPlan {
  /** The Technical Context's `**Label**: value` lines as written (`Language/Version`, `Testing`, …); unfilled template values left out. */
  context: Record<string, string>;
  paths: KitPlanPath[];
}

/** `**Label**: value`, several to a line when a dot or bar separates them (`**Language/Version**: TS 5.9 · **Testing**: vitest`). */
const CONTEXT_FIELD = /\*\*([^*]+?)\*\*\s*[:：]\s*(.*?)(?=\s+[·•|]\s+\*\*|$)/g;
/** A value the template still holds: `[e.g., …]`, `NEEDS CLARIFICATION`, `N/A`. */
const UNFILLED = /^(\[.*\]|NEEDS CLARIFICATION.*|)$/i;
const TREE_LINE = /^([│├└─┬┼|`+\\\s-]*?)([A-Za-z0-9_.@][\w.@/-]*)(?:\s+(?:#\s*)?(.*))?$/;
/** Columns one level of `├── ` / `│   ` indent takes. */
const TREE_INDENT = 4;

export function readPlan(text: string): KitPlan {
  const out: KitPlan = { context: {}, paths: [] };
  const raw = text.split(/\r?\n/);
  let section = ''; // the `##` heading we are under
  let sub = ''; // the `###` heading
  let fenced = false;
  let comment = false;
  const stack: string[] = [];
  raw.forEach((s, i) => {
    if (comment) {
      if (s.includes('-->')) comment = false;
      return;
    }
    if (!fenced && /^\s*<!--/.test(s)) {
      if (!s.includes('-->')) comment = true;
      return;
    }
    if (FENCE.test(s)) {
      fenced = !fenced;
      stack.length = 0;
      return;
    }
    if (!fenced) {
      const h = HEADING.exec(s);
      if (h) {
        if (h[1].length <= 2) (section = clean(h[2])), (sub = '');
        else sub = clean(h[2]);
        return;
      }
      if (/^technical context\b/i.test(section)) {
        for (const c of s.trim().matchAll(CONTEXT_FIELD)) {
          const value = clean(c[2]);
          if (!UNFILLED.test(value)) out.context[clean(c[1])] = value;
        }
      }
      return;
    }
    // inside a code block under Project Structure, except the documentation tree
    if (!/^project structure\b/i.test(section) || /documentation/i.test(sub)) return;
    const m = TREE_LINE.exec(s.trimEnd());
    if (!m || /^[#[.]/.test(m[2])) return;
    const depth = Math.floor(m[1].length / TREE_INDENT);
    stack.length = Math.min(stack.length, depth);
    const parts = [...stack, m[2]];
    const path = parts.join('');
    const dir = m[2].endsWith('/');
    if (dir) {
      while (stack.length < depth) stack.push('');
      stack[depth] = m[2];
    }
    const note = m[3] ? clean(m[3]) : '';
    out.paths.push({ path, ...(note && { note }), line: i + 1 });
  });
  return out;
}

// ── research.md ──

export interface KitDecision {
  /** The nearest heading above it. */
  topic: string;
  decision: string;
  rationale?: string;
  alternatives?: string;
  line: number;
}

const FIELD = /^\s*(?:[-*]\s+)?(?:\*\*)?(Decision|Rationale|Alternatives considered)(?:\*\*)?\s*[:：](?:\*\*)?\s*(.*)$/i;

export function readResearch(text: string): KitDecision[] {
  const out: KitDecision[] = [];
  let topic = '';
  let cur: KitDecision | null = null;
  for (const { n, s } of proseLines(text)) {
    const h = HEADING.exec(s);
    if (h) {
      topic = clean(h[2]).replace(/^decision\s*\d*\s*[:.-]\s*/i, '');
      cur = null;
      continue;
    }
    const f = FIELD.exec(s);
    if (!f) continue;
    const key = f[1].toLowerCase();
    const value = clean(f[2]);
    if (key === 'decision') {
      out.push((cur = { topic, decision: value, line: n }));
    } else if (cur) {
      if (key === 'rationale') cur.rationale = value;
      else cur.alternatives = value;
    }
  }
  return out;
}
