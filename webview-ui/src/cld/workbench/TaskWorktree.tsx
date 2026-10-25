/**
 * W2: a Task's worktree on its card in the 작업실's Task tab. The tab provides the project, its
 * agents and its repository's worktrees (TaskWorktreeScope); outside it the card shows nothing
 * new. A card with a worktree shows its folder, branch and assignee; one without, on a screen
 * that may act, has "worktree 만들기": pick who gets it (and a base branch), then the same
 * confirmation as every repository write (repoAsk), one `repoAction` worktreeNew.
 */
import { useContext, useState } from 'react';

import type { BoardTask } from '../../../../core/src/messages.js';
import { t } from '../../i18n/index.js';
import { repoAsk } from '../repo/repoStore.js';
import { worktreeOfTask } from '../repo/repoText.js';
import { TaskWorktreeScope } from './taskWorktreeScope.js';

const control = 'bg-bg border border-border px-4 py-2 text-xs min-w-0 max-w-full';
const button = 'border border-border px-8 py-4 text-xs pointer-coarse:min-h-44 disabled:opacity-50';

/** The closed card's chip: which worktree and who has it. */
export function TaskWorktreeChip({ task }: { task: BoardTask | undefined }) {
  const scope = useContext(TaskWorktreeScope);
  const wt = scope && task?.project === scope.project ? worktreeOfTask(scope.worktrees, task.id) : undefined;
  if (!wt) return null;
  return (
    <span className="border border-border px-4 text-xs min-w-0 max-w-full break-all" data-testid="task-worktree" data-worktree={wt.task}>
      {t('tasks.worktree.chip', { folder: wt.task, name: wt.assignee ?? t('tasks.worktree.nobody') })}
    </span>
  );
}

/** The open card's part: the worktree (path, branch, assignee), or "worktree 만들기". */
export function TaskWorktreeDetail({ task }: { task: BoardTask }) {
  const scope = useContext(TaskWorktreeScope);
  const [open, setOpen] = useState(false);
  const preset = task.assignee && scope?.names.includes(task.assignee.name) ? task.assignee.name : '';
  const [assignee, setAssignee] = useState(preset);
  const [base, setBase] = useState('');
  if (!scope || task.project !== scope.project) return null;
  const wt = worktreeOfTask(scope.worktrees, task.id);
  if (wt)
    return (
      <div className="min-w-0 break-all" data-testid="task-worktree-detail">
        <p className="text-text-muted">{t('tasks.worktree.title')}</p>
        <p>{wt.path}</p>
        <p className="text-text-muted">{t('tasks.worktree.branch', { branch: wt.branch, base: wt.base })}</p>
        <p>{wt.assignee ? t('repo.worktreeAssignee', { name: wt.assignee }) : t('repo.worktreeNobody')}</p>
      </div>
    );
  if (!scope.canAct || task.status === 'done' || scope.worktrees === undefined) return null;
  if (!open)
    return (
      <button type="button" className={`${button} border-accent text-accent-text`} onClick={() => setOpen(true)}>
        {t('tasks.worktree.make')}
      </button>
    );
  return (
    <form
      className="flex flex-wrap gap-8 items-end min-w-0"
      aria-label={t('tasks.worktree.make')}
      data-testid="task-worktree-form"
      onSubmit={(e) => {
        e.preventDefault();
        repoAsk({
          kind: 'worktreeNew',
          project: scope.project,
          taskId: task.id,
          ...(assignee && { assignee }),
          ...(base.trim() && { base: base.trim() }),
        });
        setOpen(false);
      }}
    >
      <label className="flex flex-col gap-2 text-xs min-w-0">
        {t('tasks.worktree.assignee')}
        <select aria-label={t('tasks.worktree.assignee')} className={control} value={assignee} onChange={(e) => setAssignee(e.target.value)}>
          <option value="">{t('tasks.worktree.nobody')}</option>
          {scope.names.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-2 text-xs min-w-0 flex-1">
        {t('tasks.worktree.base')}
        <input
          aria-label={t('tasks.worktree.base')}
          className={control}
          value={base}
          placeholder={t('tasks.worktree.basePlaceholder')}
          onChange={(e) => setBase(e.target.value)}
        />
      </label>
      <button type="submit" className={`${button} border-accent text-accent-text`} disabled={scope.busy}>
        {t('tasks.worktree.make')}
      </button>
      <button type="button" className={button} onClick={() => setOpen(false)}>
        {t('tasks.cancel')}
      </button>
    </form>
  );
}
