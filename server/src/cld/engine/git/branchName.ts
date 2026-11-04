/**
 * The one place that names a worktree branch and its folder (pure, no git, no clock): a branch is
 * `<type>/<scope>-<what>` like a Conventional Commit subject, lower case ASCII and hyphens only,
 * and its folder is the branch with `/` turned into `-` (`feat/iso-billboard` ->
 * `.worktrees/feat-iso-billboard`). No date or time in a name.
 */
import { createHash } from 'node:crypto';

export const BRANCH_TYPES = ['feat', 'fix', 'perf', 'refactor', 'docs', 'test', 'chore'] as const;
export type BranchType = (typeof BRANCH_TYPES)[number];

/** The longest branch (and so folder) name; the `-2` of a repeat still fits under it. */
export const MAX_BRANCH_NAME = 60;
/** How many English words a name made from a title keeps. */
export const MAX_NAME_WORDS = 5;
/** The longest Task slug (the part after the Task number). */
export const MAX_TASK_SLUG = 30;
const SHORT_ID_LENGTH = 6;

const TYPES = BRANCH_TYPES.join('|');
const BRANCH_RE = new RegExp(`^(?:${TYPES})/[a-z0-9]+(?:-[a-z0-9]+)*$`);
/** `feat(iso): draw the billboard`, `fix: x`, `feat(iso)!: x`. */
const CONVENTIONAL_RE = new RegExp(`^(${TYPES})(?:\\(([^)]*)\\))?!?:\\s*(.*)$`, 'i');

/** Why `name` is not a worktree branch name (Korean, for the refusal), or null when it is one. */
export function checkBranchName(name: string): string | null {
  if (name.length > MAX_BRANCH_NAME)
    return `브랜치 이름은 ${MAX_BRANCH_NAME}자 이하여야 해요`;
  if (!BRANCH_RE.test(name))
    return `브랜치 이름은 <종류>/<범위>-<무엇> 꼴이에요(종류: ${BRANCH_TYPES.join(', ')}; 영어 소문자·숫자·하이픈만): 예) feat/iso-outdoor-billboard`;
  return null;
}

/** The worktree folder of a branch: its `/` become `-`. */
export const folderOfBranch = (branch: string): string => branch.replace(/\//g, '-');

/** The ASCII words of `text` (lower case letters and digits; Hangul and the rest drop out). */
export const wordsOf = (text: string): string[] => text.toLowerCase().match(/[a-z0-9]+/g) ?? [];

/** A short stable id of `text` (6 hex characters), for a name that has no English in it. */
export const shortId = (text: string): string =>
  createHash('sha1').update(text).digest('hex').slice(0, SHORT_ID_LENGTH);

/** `type/rest` with `rest` cut at a hyphen so the whole stays within `max`. */
function join(type: string, parts: string[], max = MAX_BRANCH_NAME): string {
  let name = `${type}/`;
  let first = true;
  for (const p of parts) {
    const next = `${name}${first ? '' : '-'}${p}`;
    if (next.length > max) break;
    name = next;
    first = false;
  }
  // A first word longer than the room: cut it rather than leave no name.
  return first ? `${name}${parts[0]?.slice(0, max - name.length) ?? 'task'}` : name;
}

export interface ParsedTitle {
  /** The Conventional type when the title starts like a commit subject, else null. */
  type: BranchType | null;
  scope: string[];
  /** The English words after the colon (or all of a plain title). */
  words: string[];
}

/** A title's Conventional type, scope words and English words. */
export function parseTitle(title: string): ParsedTitle {
  const line = title.split('\n')[0].trim().replace(/^#+\s*/, '');
  const m = CONVENTIONAL_RE.exec(line);
  if (!m) return { type: null, scope: [], words: wordsOf(line) };
  return { type: m[1].toLowerCase() as BranchType, scope: wordsOf(m[2] ?? ''), words: wordsOf(m[3]) };
}

/**
 * A Codex task's branch from its title: `feat(iso): draw the billboard` -> `feat/iso-draw-the-billboard`;
 * a plain title with English words -> `chore/codex-<words>`; no English at all ->
 * `chore/codex-task-<short id of the title>`.
 */
export function branchFromTitle(title: string): string {
  const t = parseTitle(title);
  const id = shortId(title);
  if (t.type) {
    const scope = t.scope.join('-');
    if (t.words.length) return join(t.type, [...(scope ? [scope] : []), ...t.words.slice(0, MAX_NAME_WORDS)]);
    return join(t.type, [scope || 'codex', 'task', id]);
  }
  if (t.words.length) return join('chore', ['codex', ...t.words.slice(0, MAX_NAME_WORDS)]);
  return join('chore', ['codex', 'task', id]);
}

/** A name a person typed, as a slug: lower case, letters and digits, single hyphens, cut at `max`. */
export function tidySlug(text: string | undefined, max = MAX_TASK_SLUG): string {
  return wordsOf(text ?? '').join('-').slice(0, max).replace(/-+$/, '');
}

/**
 * A Task's worktree branch: `<type>/<task number>-<slug>`. The Task has no kind, so the type is the
 * one its title says (`fix: ...`) else `feat`; the number (`T-0042` -> `t0042`) stays so the branch
 * finds its Task. A title with no English gets the slug `task`.
 */
export function taskBranch(taskId: string, title: string | undefined, slug?: string): string {
  const t = parseTitle(title ?? '');
  const id = wordsOf(taskId).join('') || 'task';
  const rest = tidySlug(slug) || tidySlug(t.words.join('-')) || 'task';
  return join(t.type ?? 'feat', [id, rest]);
}

/** `branch` itself when nothing `taken` has it (or its folder), else `branch-2`, `-3`, ... within the limit. */
export async function uniqueBranch(
  branch: string,
  taken: (branch: string) => boolean | Promise<boolean>,
): Promise<string> {
  if (!(await taken(branch))) return branch;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const next = `${branch.slice(0, MAX_BRANCH_NAME - suffix.length).replace(/-+$/, '')}${suffix}`;
    if (!(await taken(next))) return next;
  }
}
