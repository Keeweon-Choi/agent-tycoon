/**
 * The repository panel's pure rules (T-0020): how `git status` entries are
 * grouped, the Korean texts of the confirmation and the result toast, and how
 * a unified diff is cut into coloured runs. The store (repoStore.ts) keeps the
 * flow state and RepoPanel.tsx draws it.
 */
import type {
  RepoActionKind,
  RepoActionResult,
  RepoFile,
  RepoWorktree,
} from '../../../../core/src/messages.js';
import { getLanguage, t } from '../../i18n/index.js';
import { objectParticle } from '../actionText.js';
import { serverLine, serverText } from '../serverText.js';

/** W2: the worktree made for Task `taskId` (its record says so), if there is one. */
export const worktreeOfTask = (worktrees: readonly RepoWorktree[] | undefined, taskId: string | undefined) =>
  taskId ? worktrees?.find((w) => w.taskId === taskId) : undefined;

/** A merge conflict: porcelain's unmerged codes. */
const CONFLICTS = ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'];
export const isConflict = (f: RepoFile): boolean => CONFLICTS.includes(f.index + f.worktree);
/** The index differs from HEAD. */
export const isStaged = (f: RepoFile): boolean =>
  f.index !== '.' && f.index !== '?' && !isConflict(f);

export interface FileGroups {
  conflicts: RepoFile[];
  staged: RepoFile[];
  /** Tracked files changed in the work tree (also the work-tree half of `MM`). */
  changed: RepoFile[];
  untracked: RepoFile[];
}

/** A file with both a staged and an unstaged change (`MM`) is in `staged` and in `changed`. */
export function groupFiles(files: RepoFile[]): FileGroups {
  const g: FileGroups = { conflicts: [], staged: [], changed: [], untracked: [] };
  for (const f of files) {
    if (isConflict(f)) g.conflicts.push(f);
    else {
      if (isStaged(f)) g.staged.push(f);
      if (f.worktree === '?') g.untracked.push(f);
      else if (f.worktree !== '.') g.changed.push(f);
    }
  }
  return g;
}

const LETTER: Record<string, 'repo.file.M' | 'repo.file.A' | 'repo.file.D' | 'repo.file.R' | 'repo.file.C' | 'repo.file.T' | 'repo.file.U' | 'repo.file.?'> = {
  M: 'repo.file.M', A: 'repo.file.A', D: 'repo.file.D', R: 'repo.file.R',
  C: 'repo.file.C', T: 'repo.file.T', U: 'repo.file.U', '?': 'repo.file.?',
};

/** The change letter shown for a file in a group, and its Korean name. */
export function fileLetter(
  f: RepoFile,
  side: 'staged' | 'worktree',
): { letter: string; label: string } {
  const letter = side === 'staged' ? f.index : f.worktree;
  return { letter, label: LETTER[letter] ? t(LETTER[letter]) : letter };
}

/** `main → origin/main`, or what to say instead. */
export function branchLine(s: {
  branch?: string | null;
  head?: string | null;
  upstream?: string | null;
}): string {
  const name = s.branch ?? (s.head ? t('repo.detachedHead', { head: s.head }) : t('repo.noCommits'));
  return s.upstream ? `${name} → ${s.upstream}` : `${name}${t('repo.noUpstreamSuffix')}`;
}

/** Why push is not offered, or null when it is. */
export function pushBlocked(s: {
  branch?: string | null;
  upstream?: string | null;
  ahead?: number | null;
}): string | null {
  if (!s.branch) return t('repo.notBranch');
  if (!s.upstream) return t('repo.noUpstream');
  if (s.ahead == null) return t('repo.upstreamMissing');
  if (s.ahead === 0) return t('repo.nothingToPush');
  return null;
}

export type RepoConfirm =
  | { kind: 'stage' | 'unstage'; project: string; paths?: string[]; count: number }
  | { kind: 'commit'; project: string; message: string; count: number }
  | { kind: 'push'; project: string; upstream: string; ahead: number }
  | { kind: 'worktreeRemove'; project: string; worktree: RepoWorktree }
  /** W2: Task `taskId`'s worktree, given to `assignee` (a name) when there is one. */
  | { kind: 'worktreeNew'; project: string; taskId: string; assignee?: string; base?: string }
  /** W3: the worktree's branch into its base. */
  | { kind: 'merge'; project: string; worktree: RepoWorktree };

export interface RepoConfirmText {
  question: string;
  note?: string;
  /** Text shown as quoted (the commit message). */
  quote?: string;
  /** The confirm button, and whether it is the dangerous kind. */
  button: string;
  danger: boolean;
}

/** What a worktree removal would lose: nothing, or a Korean list. */
export function worktreeLoss(w: RepoWorktree): string | null {
  if (!w.exists) return null;
  const parts: string[] = [];
  if (w.ahead > 0) parts.push(t('repo.unmergedCommits', { count: w.ahead }));
  else if (!w.merged) parts.push(t('repo.mergeUnknown'));
  if (w.dirty > 0) parts.push(t('repo.uncommittedChanges', { count: w.dirty }));
  return parts.length ? parts.join(', ') : null;
}

const QUOTE_MAX = 300;

export function confirmText(c: RepoConfirm): RepoConfirmText {
  switch (c.kind) {
    case 'stage':
      return c.paths
        ? {
            question: t('repo.confirm.stageSelected', { count: c.count }),
            button: t('repo.stage'),
            danger: false,
          }
        : {
            question: t('repo.confirm.stageAll', { count: c.count }),
            note: t('repo.confirm.stageNote'),
            button: t('repo.stage'),
            danger: false,
          };
    case 'unstage':
      return c.paths
        ? {
            question: t('repo.confirm.unstageSelected', { count: c.count }),
            button: t('repo.unstage'),
            danger: false,
          }
        : {
            question: t('repo.confirm.unstageAll', { count: c.count }),
            note: t('repo.confirm.unstageNote'),
            button: t('repo.unstage'),
            danger: false,
          };
    case 'commit':
      return {
        question: t('repo.confirm.commit', { count: c.count }),
        note: t('repo.confirm.hooksRun'),
        quote: c.message.length > QUOTE_MAX ? `${c.message.slice(0, QUOTE_MAX)}…` : c.message,
        button: t('repo.commit'),
        danger: false,
      };
    case 'push':
      return {
        question: t('repo.confirm.push', { upstream: c.upstream }),
        note: `${t('repo.confirm.pushNote', { count: c.ahead })} ${t('repo.confirm.hooksRun')}`,
        button: 'push',
        danger: false,
      };
    case 'worktreeNew':
      return {
        question: t('repo.confirm.worktreeNew', { id: c.taskId }),
        note: [
          t('repo.confirm.worktreeNewNote', { base: c.base || t('repo.mainBranch') }),
          c.assignee && t('repo.confirm.worktreeNewAssign', { name: c.assignee }),
        ]
          .filter(Boolean)
          .join(' '),
        button: t('repo.worktreeNew'),
        danger: false,
      };
    case 'merge':
      return {
        question: t('repo.confirm.merge', { branch: c.worktree.branch, base: c.worktree.base }),
        note: t('repo.confirm.mergeNote'),
        button: t('repo.merge'),
        danger: false,
      };
    case 'worktreeRemove': {
      const w = c.worktree;
      const task = getLanguage() === 'ko' ? `${w.task}${objectParticle(w.task)}` : w.task;
      const question = t('repo.confirm.removeWorktree', { task });
      const loss = worktreeLoss(w);
      if (loss) {
        return {
          question,
          note: t('repo.confirm.removeDanger', { loss, branch: w.branch }),
          button: t('repo.discardRemove'),
          danger: true,
        };
      }
      return {
        question,
        note: w.exists
          ? t('repo.confirm.removeMerged', { branch: w.branch })
          : t('repo.confirm.removeMissing'),
        button: t('repo.remove'),
        danger: false,
      };
    }
  }
}

/** The `repoAction` a confirmed dialog sends (without requestId and type). */
export function confirmAction(c: RepoConfirm): {
  action: RepoActionKind;
  project: string;
  paths?: string[];
  message?: string;
  task?: string;
  force?: boolean;
  taskId?: string;
  assignee?: string;
  base?: string;
} {
  switch (c.kind) {
    case 'stage':
    case 'unstage':
      return { action: c.kind, project: c.project, ...(c.paths ? { paths: c.paths } : {}) };
    case 'commit':
      return { action: 'commit', project: c.project, message: c.message };
    case 'push':
      return { action: 'push', project: c.project };
    case 'worktreeNew':
      return {
        action: 'worktreeNew',
        project: c.project,
        taskId: c.taskId,
        ...(c.assignee ? { assignee: c.assignee } : {}),
        ...(c.base ? { base: c.base } : {}),
      };
    case 'merge':
      return { action: 'merge', project: c.project, task: c.worktree.task };
    case 'worktreeRemove':
      return {
        action: 'worktreeRemove',
        project: c.project,
        task: c.worktree.task,
        // The dialog showed what would be lost, and the user said yes.
        ...(worktreeLoss(c.worktree) ? { force: true } : {}),
      };
  }
}

const DONE: Record<RepoActionKind, 'repo.done.stage' | 'repo.done.unstage' | 'repo.done.commit' | 'repo.done.push' | 'repo.done.worktreeRemove' | 'repo.done.worktreeNew' | 'repo.done.merge'> = {
  stage: 'repo.done.stage', unstage: 'repo.done.unstage', commit: 'repo.done.commit',
  push: 'repo.done.push', worktreeRemove: 'repo.done.worktreeRemove', worktreeNew: 'repo.done.worktreeNew',
  merge: 'repo.done.merge',
};

/** W3: a worktree's last merge, in a line (a conflict's files are in its error). */
export function mergeLine(m: NonNullable<RepoWorktree['merge']>): string {
  const who = m.auto ? t('repo.mergeAuto') : '';
  if (!m.ok) return `${who}${t('repo.mergeFailed', { base: m.target })}: ${serverText(m)}`;
  const how = m.kind === 'already' ? t('repo.mergeAlready') : m.kind === 'ff' ? 'fast-forward' : t('repo.mergeCommit');
  return `${who}${t('repo.mergeDone', { base: m.target })} (${how}${m.sha ? ` ${m.sha.slice(0, 7)}` : ''})`;
}

/** W4: a merge history entry: when, which worktree, and what happened. */
export function mergeHistoryLine(m: NonNullable<RepoWorktree['merge']>): string {
  const d = new Date(m.at);
  const two = (n: number) => String(n).padStart(2, '0');
  const when = Number.isNaN(d.getTime()) ? '' : `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())} `;
  return `${when}${m.task ?? m.branch ?? ''} · ${mergeLine(m)}`;
}

export function resultToast(r: RepoActionResult): {
  text: string;
  tone: 'ok' | 'info' | 'error';
} {
  if (!r.ok) return { text: serverText(r, t('repo.failed')), tone: 'error' };
  const done = t(DONE[r.action]);
  return { text: r.detail ? `${done} · ${serverLine(r.detail)}` : done, tone: 'ok' };
}

export type DiffKind = 'add' | 'del' | 'hunk' | 'meta' | 'ctx';
export interface DiffRun {
  kind: DiffKind;
  text: string;
}

/**
 * A unified diff as runs of consecutive lines of one kind (a few big nodes,
 * not one per line). Before a file's first `@@` every line is header; inside a
 * hunk only its first character counts, so a removed `-- x` is not a `---`.
 */
export function diffRuns(text: string): DiffRun[] {
  const runs: DiffRun[] = [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  let inHunk = false;
  for (const line of lines) {
    if (line.startsWith('diff ')) inHunk = false;
    let kind: DiffKind;
    if (line.startsWith('@@')) {
      inHunk = true;
      kind = 'hunk';
    } else if (!inHunk || line.startsWith('\\')) kind = 'meta';
    else if (line.startsWith('+')) kind = 'add';
    else if (line.startsWith('-')) kind = 'del';
    else kind = 'ctx';
    const last = runs.at(-1);
    if (last?.kind === kind) last.text += `\n${line}`;
    else runs.push({ kind, text: line });
  }
  return runs;
}
