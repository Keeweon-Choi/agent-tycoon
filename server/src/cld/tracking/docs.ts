/**
 * U-48 phase 2a, pure: what a project's own planning documents say, as entries.
 * Three Markdown shapes (design-doc-tracking §4/§5) and Taskmaster's tasks.json:
 *  - checkboxes `- [ ]` / `- [x]` / `* [ ]` (`[~]`, `[-]` = unknown + the raw mark),
 *    each under the nearest heading (that heading is its parent);
 *  - table rows: a row is an entry when its first cell defines an id, or (no id) when
 *    the table has a status column; the status is that column's cell, else the first
 *    cell whose whole text is a status word;
 *  - front-matter `id:` / `title:` / `status:` for the whole file.
 * A checkbox or a front-matter status is the writer's claim (reported); a table cell
 * is free text matched through STATUS_WORDS (inferred). Fenced code is skipped.
 * Ids are defined only at the start of a heading, in a table's first cell, by the file
 * name (`T-0015-x.md`) or front-matter `id:`; anywhere else an id is a mention, which
 * only links and never makes an entry.
 */
import type { TrackedStatus } from '../../../../core/src/messages.js';


/** Entries kept per file; the rest are only counted. */
export const ITEMS_MAX = 500;
/**
 * Titles and status words stay unmasked in memory (they are the file's own text, never
 * sent like this): the tracker masks only the ones it sends (titleOf/rawOf, 200/40
 * characters). Kept this long so masking still sees a whole secret near the cut.
 */
export const TEXT_MAX = 1_000;
const keep = (s: string, max = TEXT_MAX) => (s.length > max ? s.slice(0, max) : s);

type Word = Exclude<TrackedStatus, 'unknown'>;

/** The status word table (Korean and English). Matched after folding case, markup and spaces. */
export const STATUS_WORDS: Record<Word, readonly string[]> = {
  done: [
    'done', 'complete', 'completed', 'finished', 'closed', 'resolved', 'fixed', 'shipped', 'deployed',
    'merged', 'released', 'accepted', '완료', '완료됨', '끝', '끝남', '배포', '배포됨', '병합', '병합됨',
    '머지됨', '해결', '✅', '✔',
  ],
  doing: [
    'doing', 'in progress', 'in-progress', 'in_progress', 'wip', 'started', 'active', 'ongoing',
    'implementing', '진행', '진행 중', '진행중', '구현 중', '구현중', '작업 중', '작업중', '하는 중',
  ],
  review: [
    'review', 'in review', 'reviewing', 'needs review', 'testing', 'verifying', '검토', '검토 중',
    '검증', '검증 중', '검증중', '리뷰', '리뷰 중',
  ],
  blocked: ['blocked', 'on hold', 'waiting', 'paused', 'deferred', 'stuck', '막힘', '보류', '대기', '대기 중', '멈춤'],
  todo: [
    'todo', 'to do', 'to-do', 'pending', 'planned', 'open', 'not started', 'backlog', 'proposed', 'draft',
    '할 일', '예정', '계획', '계획됨', '미착수', '제안', '초안',
  ],
  cancelled: [
    'cancelled', 'canceled', 'dropped', 'abandoned', 'rejected', 'wontfix', "won't fix", 'superseded',
    'deprecated', 'obsolete', '취소', '취소됨', '버림', '폐기', '안 함',
  ],
};

/** A table column whose header is one of these holds the status. */
export const STATUS_HEADERS = ['상태', 'status', 'state', '진행', '진행 상태', '진척'];

const WORDS = new Map<string, Word>(
  (Object.entries(STATUS_WORDS) as Array<[Word, readonly string[]]>).flatMap(([s, ws]) => ws.map((w) => [w, s] as const)),
);
/** By first character, longest first, so `진행 중` wins over `진행`. */
const BY_FIRST = new Map<string, string[]>();
for (const w of [...WORDS.keys()].sort((a, b) => b.length - a.length)) BY_FIRST.set(w[0], [...(BY_FIRST.get(w[0]) ?? []), w]);

/** Markup out: emphasis, code ticks, strike, links to their text; spaces folded. */
const MARKUP = /[[*_~`\uFE0F]|\s\s|[\t\r\n]|^\s|\s$/;
export const clean = (s: string): string =>
  !MARKUP.test(s)
    ? s
    : s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|__|~~|`/g, '')
    .replace(/️/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const fold = (s: string) => clean(s).toLowerCase().replace(/[.:!。]+$/, '').trim();

/**
 * A status word to a board status. `strict` (a cell that is not the status column) needs
 * the whole text to be a word (a trailing `(…)` aside). Otherwise a word may start the text
 * when what follows it is only punctuation, a date or a `(…)` ("배포됨(10-24)", "완료 10-24"),
 * or the same status again ("✅ 완료"). Anything else after it changes its meaning
 * ("완료 예정", "완료 안 됨", "배포 대기", "done soon"): no status, the raw word stays.
 */
export function statusWord(text: string, strict = false): Word | null {
  const s = fold(text);
  if (!s) return null;
  const exact = WORDS.get(s) ?? WORDS.get(s.replace(/\s*[(（].*[)）]$/, ''));
  if (exact || strict) return exact ?? null;
  for (const w of BY_FIRST.get(s[0]) ?? []) {
    if (!s.startsWith(w)) continue;
    const next = s.slice(w.length, w.length + 1);
    if (next && /[\p{L}\p{N}]/u.test(next)) continue;
    const word = WORDS.get(w)!;
    const rest = s.slice(w.length).trim();
    if (!rest || /^[(（].*[)）]$/.test(rest) || /^[\p{P}\p{S}\p{N}\s]*$/u.test(rest)) return word;
    return statusWord(rest) === word ? word : null;
  }
  return null;
}

/** A status claim: the board status, or unknown with the source's own word. */
export interface StatusClaim {
  status: TrackedStatus;
  raw?: string;
}
export const claimOf = (text: string, strict = false): StatusClaim | null => {
  const cleaned = clean(text);
  if (!cleaned) return null;
  const s = statusWord(cleaned, strict);
  if (s) return { status: s, raw: keep(cleaned, 200) };
  return strict ? null : { status: 'unknown', raw: keep(cleaned, 200) };
};

/** The id shapes: `ABC-123` and Spec Kit's `T001` always; short ones (`D5`, `C3a`) only when the project turns them on. */
const ID_LONG = '[A-Z]{1,6}-\\d{1,5}|T\\d{3}';
const ID_SHORT = '[A-Z]\\d{1,2}[a-z]?';
const idSource = (shortIds: boolean) => (shortIds ? `${ID_LONG}|${ID_SHORT}` : ID_LONG);
export const idPattern = (shortIds: boolean) => new RegExp(`(?<![A-Za-z0-9_-])(?:${idSource(shortIds)})(?![A-Za-z0-9_])`, 'g');
const idAtStartPattern = (shortIds: boolean) => new RegExp(`^(?:${idSource(shortIds)})(?![A-Za-z0-9_])`);

export interface Ids {
  /** Every id the text names. */
  all(text: string): string[];
  /** The id the (cleaned) text starts with (a definition), or undefined. */
  atStart(text: string): string | undefined;
}
export function idsOf(shortIds: boolean): Ids {
  const any = idPattern(shortIds);
  const start = idAtStartPattern(shortIds);
  return {
    all: (text) => (/\d/.test(text) ? [...new Set(text.match(any) ?? [])] : []),
    atStart: (text) => start.exec(text)?.[0],
  };
}

export type DocEntryKind = 'heading' | 'check' | 'row' | 'task';
export interface DocEntry {
  /** Stable within the file: the id it defines, else `h:<hash>` of its text (a repeat gets `~n`). */
  key: string;
  kind: DocEntryKind;
  /** The id this entry defines. */
  id?: string;
  refs: string[];
  title: string;
  status: TrackedStatus;
  raw?: string;
  /** reported (a checkbox, a structured status), inferred (a table cell), unknown (no status at all). */
  source: 'reported' | 'inferred' | 'unknown';
  line: number;
  /** The heading entry this one sits under (its key). */
  parent?: string;
}
export interface DocParse {
  /** The id the whole file defines (front-matter `id:`, else its name). */
  id?: string;
  title?: string;
  status?: StatusClaim;
  entries: DocEntry[];
  /** Entries past ITEMS_MAX, counted only. */
  more: number;
  /** Ids named in prose outside every entry (they only link). */
  mentions: string[];
}

/** A short stable key for a text (cyrb53: cheap, and a clash only adds `~2` to a key). */
const hash = (text: string) => {
  const s = text.toLowerCase();
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0').slice(0, 10);
};

const CHECKBOX = /^\s*[-*+]\s+\[([ xX~-])\]\s+(.*)$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** A table row's cells (the outer pipes off, `\|` kept inside a cell). */
const cellsOf = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.replace(/\\\|/g, '|').trim());

function frontMatter(lines: string[]): { fields: Map<string, string>; end: number } {
  const fields = new Map<string, string>();
  if (lines[0]?.trim() !== '---') return { fields, end: 0 };
  for (let i = 1; i < Math.min(lines.length, 200); i++) {
    if (lines[i].trim() === '---') return { fields, end: i + 1 };
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(lines[i]);
    if (m) fields.set(m[1].toLowerCase(), m[2].trim().replace(/^(['"])(.*)\1$/, '$2'));
  }
  return { fields: new Map(), end: 0 }; // never closed: not front-matter
}

/** One Markdown document. `fileName` is its base name (an id may be defined by it). */
export function parseDoc(text: string, fileName: string, shortIds: boolean): DocParse | 'unreadable' {
  if (text.includes('\0')) return 'unreadable';
  const ids = idsOf(shortIds);
  const lines = text.split(/\r?\n/);
  const { fields, end } = frontMatter(lines);
  const out: DocParse = { entries: [], more: 0, mentions: [] };
  const fmId = fields.get('id');
  out.id = fmId && ids.atStart(clean(fmId)) === clean(fmId) ? clean(fmId) : (fileIdOf(fileName, ids) ?? undefined);
  if (fields.get('title')) out.title = keep(clean(fields.get('title')!));
  const fmStatus = fields.get('status');
  if (fmStatus) out.status = claimOf(fmStatus) ?? undefined;

  const used = new Map<string, number>();
  const keyOf = (base: string) => {
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    return n === 1 ? base : `${base}~${n}`;
  };
  const mentions = new Set<string>();
  const add = (e: Omit<DocEntry, 'key'> & { base: string }): DocEntry | null => {
    if (out.entries.length >= ITEMS_MAX) {
      out.more++;
      return null;
    }
    const { base, ...rest } = e;
    const entry: DocEntry = { key: keyOf(base), ...rest };
    out.entries.push(entry);
    return entry;
  };

  let fenced = false;
  let heading: { entry?: DocEntry | null; pending: Omit<DocEntry, 'key'> & { base: string } } | null = null;
  /** A heading becomes an entry when it defines an id, or once a checkbox sits under it. */
  const headingKey = (): string | undefined => {
    if (!heading) return undefined;
    if (heading.entry === undefined) heading.entry = add(heading.pending);
    return heading.entry?.key;
  };
  for (let i = end; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const h = HEADING.exec(line);
    if (h) {
      const title = clean(h[2]);
      const id = ids.atStart(title);
      const pending = {
        base: id ?? `h:${hash(title)}`,
        kind: 'heading' as const,
        ...(id && { id }),
        refs: ids.all(title),
        title: keep(title),
        status: 'unknown' as const,
        source: 'unknown' as const,
        line: i + 1,
      };
      heading = { pending };
      if (id) headingKey();
      else for (const r of pending.refs) mentions.add(r);
      continue;
    }
    const c = CHECKBOX.exec(line);
    if (c) {
      const mark = c[1];
      const title = clean(c[2]);
      add({
        base: `h:${hash(title)}`,
        kind: 'check',
        refs: ids.all(title),
        title: keep(title),
        status: mark === ' ' ? 'todo' : mark === 'x' || mark === 'X' ? 'done' : 'unknown',
        raw: `[${mark}]`,
        source: 'reported',
        line: i + 1,
        parent: headingKey(),
      });
      continue;
    }
    if (TABLE_ROW.test(line) && TABLE_SEP.test(lines[i + 1] ?? '')) {
      i = table(lines, i, ids, add, mentions);
      continue;
    }
    for (const r of ids.all(line)) mentions.add(r);
  }
  out.mentions = [...mentions];
  return out;
}

/** The id a file name defines: `T-0015-something.md` → T-0015. */
export function fileIdOf(fileName: string, ids: Ids): string | null {
  const id = ids.atStart(fileName);
  if (!id) return null;
  const next = fileName.slice(id.length, id.length + 1);
  return next === '-' || next === '_' || next === '.' ? id : null;
}

/** One table from its header line; returns the index of its last line. */
function table(
  lines: string[],
  start: number,
  ids: Ids,
  add: (e: Omit<DocEntry, 'key'> & { base: string }) => DocEntry | null,
  mentions: Set<string>,
): number {
  const header = cellsOf(lines[start]).map((h) => fold(h).replace(/\s*[(（].*[)）]$/, ''));
  const statusCol = header.findIndex((h, n) => n > 0 && STATUS_HEADERS.includes(h));
  let i = start + 2;
  for (; i < lines.length && TABLE_ROW.test(lines[i]); i++) {
    const cells = cellsOf(lines[i]);
    const first = clean(cells[0] ?? '');
    const id = ids.atStart(first);
    const refs = [...new Set(cells.flatMap((c) => ids.all(c)))];
    if (!id && statusCol < 0) {
      for (const r of refs) mentions.add(r);
      continue;
    }
    if (!id && !first) continue;
    let claim: StatusClaim | null = null;
    let at = statusCol;
    if (statusCol > 0) claim = claimOf(cells[statusCol] ?? '');
    else
      for (let n = 1; n < cells.length && !claim; n++) {
        claim = claimOf(cells[n], true);
        if (claim) at = n;
      }
    const rest = id ? first.slice(id.length).replace(/^[\s:.)\-—–]+/, '') : first;
    const title =
      rest || cells.slice(1).map(clean).find((c, n) => c && n + 1 !== at) || id || first;
    add({
      base: id ?? `h:${hash(first)}`,
      kind: 'row',
      ...(id && { id }),
      refs,
      title: keep(title),
      status: claim?.status ?? 'unknown',
      ...(claim?.raw && { raw: claim.raw }),
      source: claim ? 'inferred' : 'unknown',
      line: i + 1,
    });
  }
  return i - 1;
}

/**
 * Taskmaster's `.taskmaster/tasks/tasks.json`: `{tasks: [...]}` or tagged
 * `{<tag>: {tasks: [...]}}`, each `{id, title, status, subtasks?}`. Its status is a
 * structured field (reported); its numeric ids key the entries but are not ids to link.
 */
export function parseTaskmaster(text: string): DocParse | 'unreadable' {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return 'unreadable';
  }
  if (!json || typeof json !== 'object') return 'unreadable';
  const root = json as Record<string, unknown>;
  const lists = Array.isArray(root.tasks)
    ? [root.tasks]
    : Object.values(root).flatMap((v) =>
        v && typeof v === 'object' && Array.isArray((v as { tasks?: unknown }).tasks) ? [(v as { tasks: unknown[] }).tasks] : [],
      );
  if (!lists.length) return 'unreadable';
  const out: DocParse = { entries: [], more: 0, mentions: [] };
  const seen = new Set<string>();
  const put = (t: unknown, parent?: string, prefix = '') => {
    if (!t || typeof t !== 'object') return;
    const f = t as Record<string, unknown>;
    const tid = typeof f.id === 'number' || typeof f.id === 'string' ? `${prefix}${String(f.id)}` : '';
    if (!/^[\w.-]{1,40}$/.test(tid) || typeof f.title !== 'string' || seen.has(tid)) return;
    seen.add(tid);
    if (out.entries.length >= ITEMS_MAX) {
      out.more++;
      return;
    }
    const claim = typeof f.status === 'string' ? claimOf(f.status) : null;
    out.entries.push({
      key: `tm:${tid}`,
      kind: 'task',
      refs: [],
      title: keep(clean(f.title)),
      status: claim?.status ?? 'unknown',
      ...(claim?.raw && { raw: claim.raw }),
      source: claim ? 'reported' : 'unknown',
      line: 0,
      ...(parent && { parent }),
    });
    if (Array.isArray(f.subtasks)) for (const s of f.subtasks) put(s, `tm:${tid}`, `${tid}.`);
  };
  for (const list of lists) for (const t of list) put(t);
  return out;
}
