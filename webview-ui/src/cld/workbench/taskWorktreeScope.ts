import { createContext } from 'react';

import type { RepoWorktree } from '../../../../core/src/messages.js';

/** W2: what the Task tab gives its cards (TaskWorktree.tsx); null outside the 작업실. */
export interface TaskWorktreeScopeValue {
  project: string;
  /** The project's agents (its Lead first). */
  names: string[];
  worktrees: RepoWorktree[] | undefined;
  canAct: boolean;
  /** A repository write of this project is running. */
  busy: boolean;
}

export const TaskWorktreeScope = createContext<TaskWorktreeScopeValue | null>(null);
