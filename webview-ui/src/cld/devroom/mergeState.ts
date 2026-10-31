/**
 * P4 개발실 병합 tab, its pure rules: the pre-check list (K), what the owner picked per conflict
 * block (W2) and the choices `resolve` sends, the cleanup table's numbers (W3). mergeStore.ts keeps
 * the daemon's answers, MergeTab / ConflictView / CleanupView draw them.
 */
import type {
  RepoCleanupRow,
  RepoConflictBlock,
  RepoConflictChoice,
  RepoConflictFile,
  RepoMergeCheckResult,
} from '../../../../core/src/messages.js';
import { MERGE_CONTEXT_LINES, MERGE_KIB, MERGE_SIZE_DECIMALS } from '../../constants.js';
import { t } from '../../i18n/index.js';

// ── pre-check (A4) ───────────────────────────────────────────

export interface PreCheck {
  id: 'behind' | 'dirty' | 'fixing' | 'tests';
  ok: boolean;
  /** The line, already in this language. */
  text: string;
  /** `behind` offers 따라잡기. */
  fix?: 'sync';
}

/** The merge's locks: notes sent to the Worker that it is still fixing (R2: while its Task is `doing`). */
export const fixingLock = (check: Pick<RepoMergeCheckResult, 'notesFixing'>, taskStatus?: string): boolean =>
  (check.notesFixing ?? 0) > 0 && taskStatus === 'doing';

/** The list under 「병합하기 전에」: behind the base, uncommitted changes, notes being fixed, tests. */
export function preChecks(check: RepoMergeCheckResult, testsPassed: boolean): PreCheck[] {
  const base = check.target ?? '';
  const behind = check.behind ?? 0;
  const dirty = check.dirty ?? 0;
  const fixing = check.notesFixing ?? 0;
  const list: PreCheck[] = [
    behind > 0
      ? { id: 'behind', ok: false, text: t('merge.check.behind', { base, count: behind }), fix: 'sync' }
      : { id: 'behind', ok: true, text: t('merge.check.behindOk', { base }) },
    dirty > 0
      ? { id: 'dirty', ok: false, text: t('merge.check.dirty', { count: dirty }) }
      : { id: 'dirty', ok: true, text: t('merge.check.dirtyOk') },
    fixing > 0
      ? { id: 'fixing', ok: false, text: t('merge.check.fixing', { count: fixing }) }
      : { id: 'fixing', ok: true, text: t('merge.check.fixingOk') },
  ];
  if (testsPassed) list.push({ id: 'tests', ok: true, text: t('devroom.tests') });
  return list;
}

// ── conflict blocks (W2) ─────────────────────────────────────

/** The owner's pick per block of each file (path -> one slot per block, undefined = not yet). */
export type Picks = Readonly<Record<string, readonly (RepoConflictChoice | undefined)[]>>;

export const picksOf = (picks: Picks, file: RepoConflictFile): readonly (RepoConflictChoice | undefined)[] =>
  file.blocks.map((_, i) => picks[file.path]?.[i]);

/** Blocks of `file` the owner has chosen for. */
export const doneBlocks = (picks: Picks, file: RepoConflictFile): number =>
  picksOf(picks, file).filter((c) => c !== undefined).length;

/** One choice per block, exactly as the daemon listed them; null while one is missing (or none to pick). */
export function choicesFor(picks: Picks, file: RepoConflictFile): RepoConflictChoice[] | null {
  const own = picksOf(picks, file);
  if (!own.length || own.some((c) => c === undefined)) return null;
  return own as RepoConflictChoice[];
}

/** `해결됨으로 표시`: every file has blocks to pick from and every block has its pick. */
export const canMark = (picks: Picks, files: readonly RepoConflictFile[]): boolean =>
  files.every((f) => choicesFor(picks, f) !== null);

export const setPick = (picks: Picks, path: string, index: number, count: number, choice: RepoConflictChoice | undefined): Picks => {
  const own = Array.from({ length: count }, (_, i) => picks[path]?.[i]);
  own[index] = choice;
  return { ...picks, [path]: own };
};

/** A file's text cut into what is drawn: a few lines around each block, and the block itself. */
export type Segment =
  | { kind: 'ctx'; lines: { no: number; text: string }[]; gap?: boolean }
  | { kind: 'block'; index: number; block: RepoConflictBlock };

export function segments(text: string, blocks: readonly RepoConflictBlock[], around = MERGE_CONTEXT_LINES): Segment[] {
  const lines = text.split('\n');
  const slice = (from: number, to: number) =>
    Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => ({ no: from + i, text: lines[from + i - 1] ?? '' }));
  const out: Segment[] = [];
  let prevEnd = 0;
  blocks.forEach((block, index) => {
    const free = block.startLine - 1 - prevEnd;
    if (free <= around * 2) {
      if (free > 0) out.push({ kind: 'ctx', lines: slice(prevEnd + 1, block.startLine - 1) });
    } else {
      // The lines far from both blocks are left out (the first block: only what precedes it).
      if (prevEnd > 0) out.push({ kind: 'ctx', lines: slice(prevEnd + 1, prevEnd + around), gap: true });
      out.push({ kind: 'ctx', lines: slice(block.startLine - around, block.startLine - 1), gap: prevEnd > 0 || block.startLine - around > 1 });
    }
    out.push({ kind: 'block', index, block });
    prevEnd = block.endLine;
  });
  const last = blocks.at(-1);
  if (last) {
    const rest = lines.length - last.endLine;
    if (rest > 0) out.push({ kind: 'ctx', lines: slice(last.endLine + 1, Math.min(lines.length, last.endLine + around)) });
  }
  return out;
}

// ── 작업 폴더 정리 (W3) ──────────────────────────────────────

/** Merged ones come checked, the unmerged ones do not (their work stays only on the branch). */
export const defaultChecked = (rows: readonly RepoCleanupRow[]): Set<string> =>
  new Set(rows.filter((r) => r.merged).map((r) => r.task));

export const totalBytes = (rows: readonly Pick<RepoCleanupRow, 'sizeBytes'>[]): number =>
  rows.reduce((sum, r) => sum + r.sizeBytes, 0);

/** `480 MB`, `1.8 GB`. */
export function sizeText(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let i = 0;
  while (value >= MERGE_KIB && i < units.length - 1) {
    value /= MERGE_KIB;
    i++;
  }
  return `${i >= units.length - 1 ? value.toFixed(MERGE_SIZE_DECIMALS) : Math.round(value)} ${units[i]}`;
}

const two = (n: number) => String(n).padStart(2, '0');

/** `오늘 09:40`, `어제 18:05`, `10월 30일`; `—` when unknown. */
export function dayLabel(iso: string | undefined, now = new Date()): string {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return '—';
  const days = (a: Date) => Math.floor(new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime() / 86_400_000);
  const diff = days(now) - days(d);
  const time = `${two(d.getHours())}:${two(d.getMinutes())}`;
  if (diff === 0) return t('merge.today', { time });
  if (diff === 1) return t('merge.yesterday', { time });
  return t('merge.monthDay', { month: d.getMonth() + 1, day: d.getDate() });
}
