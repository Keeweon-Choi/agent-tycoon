/**
 * SPT-P4C (SPT §8, §4.4), pure: the computed requirement → component links. Suggested: a
 * requirement's text names a component's label (whole words, case folded, a stop list, short and
 * long labels skipped). Observed: a trace table's module column (`구현 모듈`, `UI 컴포넌트`, `Module`,
 * `Component`) names a path, and the path belongs to a component: under an approved skeleton
 * folder (4b's `folder`), else the component whose label is the path's first folder. Never
 * stored; every loop is capped (labels, requirements, words, paths, rows), and the label match is a
 * map lookup per word run, never requirements × components.
 */
import type { TraceSource } from '../../../../core/src/cld/spec/trace.js';
import {
  SPEC_ARCH_LINE_MAX,
  SPEC_ITEM_TITLE_MAX,
  SPEC_LINK_LABEL_COMPS_MAX,
  SPEC_LINK_LABEL_MIN,
  SPEC_LINK_LABEL_WORDS_MAX,
  SPEC_LINK_LABELS_MAX,
  SPEC_LINK_MODULE_PATHS_MAX,
  SPEC_LINK_PARTICLES,
  SPEC_LINK_STOP_WORDS,
  SPEC_LINK_TEXT_MAX,
  SPEC_PATH_MAX,
} from '../../constants.js';
import { maskText } from '../mask.js';
import { cellsOf, FENCE, headerOf, parseDoc, TABLE_ROW, TABLE_SEP } from '../tracking/docs.js';

/** A live component a requirement may name: its label (masked), where it is written; `folder`: an approved skeleton folder, or one merged into it (4b). */
export interface TraceComp {
  uid: string;
  label: string;
  source?: TraceSource;
  folder?: string;
}
/** A trace table row's module cell: the row's display ID and the paths it names (masked); `refs`: a 참조만 하는 표 (its rows are no items). */
export interface ModRow {
  path: string;
  id: string;
  paths: string[];
  line: number;
  refs?: true;
}

// Latin letters and digits are one word, any other letters another: 'Scheduler가' is 'scheduler' + '가'.
const WORD = /[a-z0-9_]+|[^\sa-z0-9_\p{P}\p{S}]+/gu;
/** The words of a text (its first SPEC_LINK_TEXT_MAX characters), lower case, at most `max`; a word longer than any label is dropped. */
export const wordsOf = (s: string, max: number): string[] => {
  const out: string[] = [];
  for (const m of s.slice(0, SPEC_LINK_TEXT_MAX).replace(/<br\s*\/?>/gi, ' ').toLowerCase().matchAll(WORD)) {
    if (out.length >= max) break;
    if (m[0].length <= SPEC_ITEM_TITLE_MAX) out.push(m[0]);
  }
  return out;
};
const PARTICLES = new Set(SPEC_LINK_PARTICLES);
const PARTICLE_LENGTHS = [...new Set(SPEC_LINK_PARTICLES.map((x) => x.length))].sort((x, y) => y - x);
const HANGUL = /[\uac00-\ud7a3]$/;
/** A word without the one Korean particle it ends with ('스케줄러가' → '스케줄러'), or null; a few set lookups, only for a word ending in Hangul. */
const bare = (w: string): string | null => {
  if (!HANGUL.test(w)) return null;
  const n = PARTICLE_LENGTHS.find((k) => w.length > k && PARTICLES.has(w.slice(-k)));
  return n ? w.slice(0, -n) : null;
};

/** The labels a requirement may name: words joined by one space → the components with it (doc order, capped). */
export function labelIndex(comps: readonly TraceComp[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const c of comps) {
    const w = wordsOf(c.label, SPEC_LINK_LABEL_WORDS_MAX + 1);
    if (!w.length || w.length > SPEC_LINK_LABEL_WORDS_MAX || [...w.join('')].length < SPEC_LINK_LABEL_MIN || w.every((x) => SPEC_LINK_STOP_WORDS.has(x))) continue;
    const key = w.join(' ');
    const list = out.get(key);
    if (list) {
      if (list.length < SPEC_LINK_LABEL_COMPS_MAX && !list.includes(c.uid)) list.push(c.uid);
    } else if (out.size < SPEC_LINK_LABELS_MAX) out.set(key, [c.uid]);
  }
  return out;
}

/**
 * The labels `words` (a text's words joined by one space) names: each run of up to
 * SPEC_LINK_LABEL_WORDS_MAX words looked up once as it is and once with its last word's particle off.
 */
export function namedLabels(words: string, labels: ReadonlyMap<string, string[]>, max = Infinity): string[] {
  const w = words ? words.split(' ') : [];
  const plain = w.map(bare);
  const out = new Set<string>();
  // Stops once `max` labels are found (the caller keeps SPEC_LINK_PER_REQ_MAX per requirement anyway).
  for (let i = 0; i < w.length && out.size < max; i++) {
    let key = '';
    for (let n = 0; n < SPEC_LINK_LABEL_WORDS_MAX && i + n < w.length; n++) {
      const head = key;
      key = n ? `${key} ${w[i + n]}` : w[i];
      if (labels.has(key)) out.add(key);
      const b = plain[i + n];
      const alt = b && (n ? `${head} ${b}` : b);
      if (alt && labels.has(alt)) out.add(alt);
    }
  }
  return [...out];
}

const MODULE_COL = /^(구현\s*모듈|ui\s*컴포넌트|modules?|components?)$/;
/** A relative path with at least one folder (`server/queue.ts`, `server/`); no `..`, not absolute. Each part starts at its `/`: linear. */
const PATH = /^[\w.@~+-]+(?:\/[\w.@~+-]*)+$/;
const LEAD = new Set(['`', "'", '"', '(', '[']);
const TRAIL = new Set(['`', "'", '"', ')', ']', ':']);
/** A token without the quotes and brackets around it (character loops: no regex backtracks over a long run). */
const trim = (t: string) => {
  let a = 0;
  let b = t.length;
  while (a < b && LEAD.has(t[a])) a++;
  while (b > a && TRAIL.has(t[b - 1])) b--;
  return t.slice(a, b);
};
/** The paths a module cell names, masked, at most SPEC_LINK_MODULE_PATHS_MAX; a token longer than SPEC_PATH_MAX is no path. */
export function pathsOf(cell: string): string[] {
  const out: string[] = [];
  for (const raw of cell.split(/<br\s*\/?>|[\s,;·]+/i)) {
    if (raw.length > SPEC_PATH_MAX) continue;
    let p = trim(raw);
    if (p.startsWith('./')) p = p.slice(2);
    if (!PATH.test(p) || p.split('/').includes('..') || out.includes(p)) continue;
    out.push(maskText(p).slice(0, SPEC_ITEM_TITLE_MAX));
    if (out.length >= SPEC_LINK_MODULE_PATHS_MAX) break;
  }
  return out;
}

/** A document's module rows: each row of a table with a module column whose row parseDoc reads as an ID row. */
export function moduleRows(text: string, fileName: string, o: { shortIds: boolean; idPatterns: readonly string[] }): Array<Omit<ModRow, 'path'>> {
  const lines = text.split(/\r?\n/);
  const out: Array<Omit<ModRow, 'path'>> = [];
  let idAt: Map<number, string> | null = null;
  let fenced = false;
  // Rows are bounded by parseDoc's item cap: only an ID row it read is kept.
  for (let i = 0; i < lines.length; i++) {
    if (FENCE.test(lines[i])) fenced = !fenced;
    if (fenced || !TABLE_ROW.test(lines[i]) || !TABLE_SEP.test(lines[i + 1] ?? '')) continue;
    const col = headerOf(lines[i]).findIndex((h, n) => n > 0 && MODULE_COL.test(h));
    let k = i + 2;
    for (; k < lines.length && TABLE_ROW.test(lines[k]); k++) {
      if (col < 0) continue;
      if (!idAt) {
        // Parsed once, only for a document that has a module column.
        const parsed = parseDoc(text, fileName, o.shortIds, o.idPatterns);
        idAt = new Map(parsed === 'unreadable' ? [] : parsed.entries.flatMap((e) => (e.kind === 'row' && e.id ? [[e.line, e.id] as const] : [])));
      }
      const id = idAt.get(k + 1);
      const cell = cellsOf(lines[k])[col] ?? '';
      if (!id || cell.length > SPEC_ARCH_LINE_MAX) continue;
      const paths = pathsOf(cell);
      if (paths.length) out.push({ id, paths, line: k + 1 });
    }
    i = k - 1;
  }
  return out;
}

/** Where module paths belong: approved skeleton folders (the longest wins), else the components whose label is the path's first folder. */
export function pathOwners(comps: readonly TraceComp[]): (p: string) => string[] {
  // folder → its component: a path looks up its own prefixes, longest first (depth lookups, never a scan of the folders).
  const folders = new Map<string, string>();
  for (const c of comps) {
    const dir = c.folder?.replace(/\/+$/, '');
    if (dir && !folders.has(dir)) folders.set(dir, c.uid);
  }
  const byLabel = new Map<string, string[]>();
  for (const c of comps) {
    const k = c.label.trim().toLowerCase();
    const list = byLabel.get(k);
    if (!list) byLabel.set(k, [c.uid]);
    else if (list.length < SPEC_LINK_LABEL_COMPS_MAX && !list.includes(c.uid)) list.push(c.uid);
  }
  return (p) => {
    for (let q = p.replace(/\/+$/, ''); folders.size && q; ) {
      const uid = folders.get(q);
      if (uid) return [uid];
      const i = q.lastIndexOf('/');
      if (i < 0) break;
      q = q.slice(0, i);
    }
    return byLabel.get(p.split('/')[0].toLowerCase()) ?? [];
  };
}
