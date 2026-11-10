/**
 * SPT §2.4, pure: a tracked document's items, the units its requirement UIDs follow. The shapes
 * come from tracking/docs.ts `parseDoc` (ID rows, ID headings, checkboxes, status rows), plus
 * OpenSpec/Kiro `Requirement` headings, a front-matter `id:`, and, only when the document's mode
 * is `headings`, its ID-less headings down to `depth` (deeper ones fold into their parent).
 * The body is masked (secrets out before anything can keep it), cleaned of markup and hashed
 * here: the hash goes to the Registry, the cleaned body only to the match cache (SPT §4.1).
 * Titles and sections are the file's own text, unmasked: the caller masks what it sends.
 */
import * as crypto from 'crypto';

import { maskText } from '../mask.js';
import { cellsOf, clean, FENCE, frontMatter, headerOf, HEADING, idsOf, parseDoc, statusColumn, statusWord, TABLE_ROW, TABLE_SEP } from '../tracking/docs.js';
import type { DocKind } from './discover.js';
import { kiroId, kiroReq, kiroTaskRefs, openspecName, readKiroTasks, type Shape } from './shapes.js';
import { kitId, readSpec, taskFromTitle } from './speckit.js';
import type { DocMode } from './store.js';

export const ITEM_SHAPES = ['row', 'heading', 'reqhead', 'check', 'fm', 'bullet'] as const;
export type ItemShape = (typeof ITEM_SHAPES)[number];

export interface Extracted {
  shape: ItemShape;
  displayId?: string;
  title: string;
  /** The heading this item sits under (its text), '' at the top. */
  section: string;
  line: number;
  /** Its place among the document's items. */
  ordinal: number;
  /** A hash of `section` (a heading is content too: SPT §4.2). */
  parent: string;
  /** The body, masked and cleaned of markup (what the match cache may keep). */
  body: string;
  /** sha256 of the normalised body (its own display ID, markup, spaces and punctuation out). */
  textHash: string;
  /** SPT-P2 §4.4: the display IDs its own text names besides its own (a row's cells, a heading's lines up to the next heading). */
  refs: string[];
}

export interface ExtractOptions {
  kind: DocKind;
  mode: DocMode;
  /** ID-less headings in `headings` mode: levels down to this one (SPT §7.1, 2 by default). */
  depth: number;
  shortIds: boolean;
  idPatterns: readonly string[];
  /** K9: the Spec Kit feature folder the document sits in (`002-checkout`): its stories, FR/SC lines and tasks get `<folder>/<number>` display IDs. */
  speckit?: string;
  /** RQ5: the Kiro / OpenSpec folder the document sits in (shapes.ts): `<feature>/R3` display IDs, `_Requirements:` references, requirement names as titles. */
  shape?: Shape;
}

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
/** A short hash of a heading's text; '' for none. */
export const parentHash = (title: string): string => (title ? sha(clean(title).toLowerCase()).slice(0, 12) : '');

/** R2's normalisation: markup, case, the item's own display ID, spaces and punctuation out. */
export function norm(s: string, ownId?: string): string {
  let t = clean(s).toLowerCase();
  if (ownId) t = t.split(ownId.toLowerCase()).join(' ');
  return t.replace(/[\s|#>*_`~[\]()\-:.,;!?'"“”‘’·…/\\]+/g, '');
}

/** Checkboxes are items only in plans and task specs (a design's "done when" list is not work to track). */
const CHECK_KINDS: readonly DocKind[] = ['plan', 'task'];
const REQUIREMENT = /^requirement\b/i;
const withoutId = (title: string, id?: string) =>
  (id && title.startsWith(id) ? title.slice(id.length).replace(/^[\s:.)\-—–]+/, '') : title) || title;

/** The front matter's `id:`, if any (D2's evidence). */
export const fmIdOf = (text: string): string | undefined => clean(frontMatter(text.split(/\r?\n/)).fields.get('id') ?? '') || undefined;

/** The text an item is matched by: masked line by line, then markup out. */
export const bodyText = (raw: string): string => clean(maskText(raw));
/** The hash of a body (from bodyText) as T1 compares it. */
export const textHashOf = (body: string, ownId?: string): string => sha(norm(body, ownId));

export function extract(text: string, fileName: string, o: ExtractOptions): Extracted[] {
  // refs: a table that only repeats IDs defined elsewhere (traceability): references, not items (Phase 2 observes them).
  if (o.mode === 'off' || o.mode === 'refs') return [];
  const parsed = parseDoc(text, fileName, o.shortIds, o.idPatterns);
  if (parsed === 'unreadable') return [];
  const ids = idsOf(o.shortIds, o.idPatterns);
  const lines = text.split(/\r?\n/);
  const { fields, end } = frontMatter(lines);
  // One pass for what parseDoc does not keep: heading levels, each line's parent heading, row cells.
  const level: number[] = new Array(lines.length).fill(0);
  const parentOf: string[] = new Array(lines.length).fill('');
  const rowBody = new Map<number, string>();
  const stack: Array<{ level: number; title: string }> = [];
  let fenced = false;
  for (let i = end; i < lines.length; i++) {
    if (FENCE.test(lines[i])) fenced = !fenced;
    if (fenced || FENCE.test(lines[i])) {
      parentOf[i] = stack.at(-1)?.title ?? '';
      continue;
    }
    const h = HEADING.exec(lines[i]);
    if (h) {
      level[i] = h[1].length;
      while (stack.length && stack.at(-1)!.level >= level[i]) stack.pop();
      parentOf[i] = stack.at(-1)?.title ?? '';
      stack.push({ level: level[i], title: clean(h[2]) });
      continue;
    }
    parentOf[i] = stack.at(-1)?.title ?? '';
    if (TABLE_ROW.test(lines[i]) && TABLE_SEP.test(lines[i + 1] ?? '')) {
      const statusCol = statusColumn(headerOf(lines[i]));
      for (i += 2; i < lines.length && TABLE_ROW.test(lines[i]); i++) {
        parentOf[i] = stack.at(-1)?.title ?? '';
        // A status is not the item's text: ticking it off keeps the same item.
        const cells = cellsOf(lines[i]).map(clean).filter((c, n) => n !== statusCol && !statusWord(c, true));
        rowBody.set(i + 1, cells.join(' '));
      }
      i--;
    }
  }
  const section = (i: number) => {
    const out = [clean(HEADING.exec(lines[i])![2])];
    for (let j = i + 1; j < lines.length && !(level[j] && level[j] <= level[i]); j++) out.push(lines[j]);
    return out.join('\n');
  };

  /** The IDs a heading's own lines name (up to the next heading of any level: a nested item names its own). */
  const ownRefs = (i: number) => {
    const out = [lines[i]];
    for (let j = i + 1; j < lines.length && !level[j]; j++) out.push(lines[j]);
    return ids.all(out.join('\n'));
  };
  const sh = o.shape;
  /** RQ5: a Kiro task's `_Requirements: 1.1, 2.3_` lines, as `<feature>/R1` references by the task's line. */
  const kiroRefs = new Map(sh?.tool === 'kiro' && sh.file === 'tasks' ? readKiroTasks(text).map((t) => [t.line, kiroTaskRefs(sh.feature, t)] as const) : []);
  const raw: Array<Omit<Extracted, 'ordinal' | 'parent' | 'textHash' | 'section'> & { body: string }> = [];
  const taken = new Set<number>();
  for (const e of parsed.entries) {
    const i = e.line - 1;
    if (e.kind === 'row') raw.push({ shape: 'row', displayId: e.id, title: e.title, line: e.line, body: rowBody.get(e.line) ?? e.title, refs: e.refs });
    else if (e.kind === 'heading' && e.id) raw.push({ shape: 'heading', displayId: e.id, title: withoutId(e.title, e.id), line: e.line, body: section(i), refs: ownRefs(i) });
    else if (e.kind === 'check' && CHECK_KINDS.includes(o.kind)) {
      const kt = o.speckit && fileName.toLowerCase() === 'tasks.md' ? taskFromTitle(e.title) : null;
      if (!kt) raw.push({ shape: 'check', title: e.title, line: e.line, body: e.title, refs: [...e.refs, ...(kiroRefs.get(e.line) ?? [])] });
      // K9: `T001 [P] [US1] text` is task 001 of this feature; the story and FR numbers it names are its refs.
      else {
        const refs = [...(kt.story !== undefined ? [kitId(o.speckit!, `US${kt.story}`)] : []), ...kt.frs.map((f) => kitId(o.speckit!, f))];
        raw.push({ shape: 'check', displayId: kitId(o.speckit!, kt.id), title: kt.text, line: e.line, body: e.title, refs });
      }
    } else continue;
    taken.add(e.line);
  }
  // K9: a Spec Kit spec.md's user stories (a heading), FR and SC lines (a bullet).
  if (o.speckit && o.kind === 'requirements' && fileName.toLowerCase() === 'spec.md') {
    const spec = readSpec(text);
    const own = (shape: ItemShape, num: string, title: string, line: number, body: string) => {
      if (taken.has(line)) return;
      taken.add(line);
      raw.push({ shape, displayId: kitId(o.speckit!, num), title, line, body, refs: [] });
    };
    for (const st of spec.stories) own('heading', `US${st.n}`, st.title, st.line, section(st.line - 1));
    for (const r of [...spec.frs, ...spec.scs]) own('bullet', r.id, r.text, r.line, lines[r.line - 1]);
  }
  const h1s = level.filter((l) => l === 1).length;
  for (let i = end; i < lines.length; i++) {
    if (!level[i] || taken.has(i + 1)) continue;
    const title = clean(HEADING.exec(lines[i])![2]);
    if (ids.atStart(title)) continue; // an ID heading parseDoc capped
    if (REQUIREMENT.test(title)) {
      // RQ5: in a Kiro requirements.md `### Requirement 3[: name]` is requirement 3 of the feature; in an OpenSpec spec the name is the title.
      const kiro = sh?.tool === 'kiro' && sh.file === 'requirements' && level[i] === 3 ? kiroReq(title) : null;
      const named = sh?.tool === 'openspec' ? openspecName(title) : null;
      raw.push({
        shape: 'reqhead',
        ...(kiro && sh?.tool === 'kiro' && { displayId: kiroId(sh.feature, kiro.n) }),
        title: kiro?.name || named || title,
        line: i + 1,
        body: section(i),
        refs: ownRefs(i),
      });
    }
    // A single `#` is the document's title, not a section.
    else if (o.mode === 'headings' && level[i] <= o.depth && (level[i] > 1 || h1s > 1))
      raw.push({ shape: 'heading', title, line: i + 1, body: section(i), refs: ownRefs(i) });
  }
  // Front matter `id:`: the whole document is one item (a decision), unless an item in it already defines that ID.
  const fmId = clean(fields.get('id') ?? '');
  if (fmId && ids.atStart(fmId) === fmId && !raw.some((r) => r.displayId === fmId))
    raw.push({ shape: 'fm', displayId: fmId, title: clean(fields.get('title') ?? '') || fmId, line: 1, body: lines.slice(end).join('\n'), refs: [] });

  raw.sort((a, b) => a.line - b.line);
  return raw.map(({ body: rawBody, refs, ...r }, ordinal) => {
    const section = r.shape === 'fm' ? '' : parentOf[r.line - 1];
    const body = bodyText(rawBody);
    return { ...r, section, ordinal, parent: parentHash(section), body, textHash: textHashOf(body, r.displayId), refs: refs.filter((x) => x !== r.displayId) };
  });
}

/** SPT-P2 §4.4: a 참조만 하는 표 (`refs` mode) has no items; each of its rows that starts with an ID names the IDs beside it. */
export function refRows(text: string, fileName: string, o: Pick<ExtractOptions, 'shortIds' | 'idPatterns'>): Array<{ id: string; refs: string[]; line: number }> {
  const parsed = parseDoc(text, fileName, o.shortIds, o.idPatterns);
  if (parsed === 'unreadable') return [];
  return parsed.entries.flatMap((e) => (e.kind === 'row' && e.id ? [{ id: e.id, refs: e.refs.filter((x) => x !== e.id), line: e.line }] : []));
}

// ── SPT-P3-ACCEPT §6.4: an item's text and its 인수 기준, read from the document now (never stored) ──

/** The table header line above row `i` (0-based), or -1. */
function tableHead(lines: string[], i: number): number {
  for (let k = i - 1; k >= 1 && TABLE_ROW.test(lines[k]); k--) if (TABLE_SEP.test(lines[k]) && TABLE_ROW.test(lines[k - 1])) return k - 1;
  return -1;
}
/** The line after heading `i`'s section: the next heading of the same or a higher level outside a fence. */
function sectionEnd(lines: string[], i: number, any = false): number {
  const level = HEADING.exec(lines[i])?.[1].length ?? 0;
  let fenced = false;
  for (let j = i + 1; j < lines.length; j++) {
    if (FENCE.test(lines[j])) fenced = !fenced;
    const h = !fenced && HEADING.exec(lines[j]);
    if (h && (any || h[1].length <= level)) return j;
  }
  return lines.length;
}

/** The item's own source text, unmasked (the caller masks and cuts it): a row with its table header, a heading's section, a checkbox line, a front-matter document's body. */
export function itemSource(text: string, line: number, shape: ItemShape): string {
  const lines = text.split(/\r?\n/);
  const i = line - 1;
  if (i < 0 || i >= lines.length) return '';
  if (shape === 'row') {
    const h = tableHead(lines, i);
    return h < 0 ? lines[i] : [lines[h], lines[h + 1], lines[i]].join('\n');
  }
  if (shape === 'check' || shape === 'bullet') return lines[i];
  if (shape === 'fm') return lines.slice(frontMatter(lines).end).join('\n');
  return lines.slice(i, sectionEnd(lines, i)).join('\n');
}

const CRITERIA_COLUMN = /^(인수\s*기준|acceptance(\s+criteria)?|완료\s*조건)$/;
/** RQ5: our SRS's `검증` column says how to check the requirement (확인 방법), which is not an acceptance criterion. */
const VERIFY_COLUMN = /^(검증|검증\s*방법|확인\s*방법|verification|how\s+to\s+verify)$/i;
const CRITERIA_HEADING = /^(done when|tests?|검증|인수\s*기준|완료\s*조건|acceptance(\s+criteria)?)$/i;
const SCENARIO = /^scenario\b/i;

/** A row block's (itemSource: header, separator, row) cell under the first header the pattern names, one entry per `<br>`; a row without its header has no column to read. */
function columnOf(lines: string[], column: RegExp): string[] {
  if (lines.length < 3) return [];
  const col = headerOf(lines[0]).findIndex((c) => column.test(c));
  return (col < 0 ? '' : (cellsOf(lines[2])[col] ?? ''))
    .split(/<br\s*\/?>/i)
    .map(clean)
    .filter(Boolean);
}
/** RQ5: how to check the requirement (확인 방법), from a row's `검증` column; other shapes name none. */
export const verifyOf = (block: string, shape: ItemShape): string[] => (shape === 'row' ? columnOf(block.split(/\r?\n/), VERIFY_COLUMN) : []);
/** K9: Spec Kit's `**Acceptance Scenarios**:` label over a numbered `Given … When … Then …` list. */
const SCENARIO_LABEL = /^\s*\*{0,2}Acceptance Scenarios\*{0,2}\s*:?\*{0,2}\s*$/i;
const NUMBERED = /^\s*\d{1,3}[.)]\s+(.*)$/;
const LIST_ITEM = /^\s*(?:[-*+]|\d{1,3}[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/;

/**
 * The item's 인수 기준 (SPT §2.4), from its block as itemSource gives it (the caller masks the block
 * first, whole: masking criteria one by one would miss what only a run of lines shows, an env dump):
 * the cell of a `인수 기준` / `검증` / `Acceptance` / `완료 조건` column of its row; in a heading's
 * section, each list line under a `Done when` / `Tests` / `검증` heading (its lines when it has no
 * list), and each OpenSpec `Scenario` as one line.
 */
export function criteriaOf(block: string, shape: ItemShape): string[] {
  const lines = block.split(/\r?\n/);
  if (shape === 'check' || shape === 'bullet' || !lines.length) return [];
  if (shape === 'row') return columnOf(lines, CRITERIA_COLUMN);
  const out: string[] = [];
  // A heading's block starts with its own heading (skipped); a front-matter document's is its body.
  for (let j = shape === 'fm' ? 0 : 1; j < lines.length; j++) {
    if (SCENARIO_LABEL.test(lines[j])) {
      for (let k = j + 1; k < lines.length && !HEADING.test(lines[k]) && !/^\s*(\*\*|---)/.test(lines[k]); k++) {
        const item = NUMBERED.exec(lines[k]);
        if (item) out.push(clean(item[1]));
      }
      continue;
    }
    const h = HEADING.exec(lines[j]);
    const title = h ? clean(h[2]) : '';
    if (!h || !(CRITERIA_HEADING.test(title) || SCENARIO.test(title))) continue;
    const body = lines.slice(j + 1, sectionEnd(lines, j, true)).filter((l) => l.trim() && !FENCE.test(l));
    if (SCENARIO.test(title)) out.push(clean([title.replace(SCENARIO, '').replace(/^[\s:]+/, '') || title, ...body].join(' ')));
    else {
      const items = body.flatMap((l) => LIST_ITEM.exec(l)?.[1] ?? []);
      out.push(...(items.length ? items : body).map(clean).filter(Boolean));
    }
  }
  return out;
}
