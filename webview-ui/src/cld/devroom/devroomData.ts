/**
 * P4 개발실: what the rail, the window and the phone list read. The groups of task worktrees per
 * project (with each card's chip), the pick in effect, the window's title.
 */
import { createContext, useContext, useEffect, useMemo, useState } from 'react';

import type { BoardTask, RepoState, RepoWorktree } from '../../../../core/src/messages.js';
import type { AgentAppearance, TabStatus } from '../../components/AgentCard.js';
import { t } from '../../i18n/index.js';
import { transport } from '../../transport/index.js';
import { useEngineStore } from '../engineStore.js';
import { useCldStore } from '../officeStore.js';
import { useRepoStore } from '../repo/repoStore.js';
import { reviewKey, useReviewStore } from '../repo/reviewStore.js';
import { workbenchProjects } from '../workbench/workbenchState.js';
import { type Chip, chipOf, railOrder, shownProject, shownProjects, titleOf } from './devroomState.js';
import { type Picked, pickKey, pickWorktree, useDevroom } from './devroomStore.js';

/** What the shells hand in: an agent's look and its card's status dot. */
export const DevroomLooks = createContext<{
  getAppearance: (agentId: number) => AgentAppearance;
  statusFor: (agentId: number) => TabStatus | null;
} | null>(null);

/** The app's own sizes (the mock-ups' 11–14 px Galmuri reads too small beside FS Pixel Sans' Latin). */
export const SMALL = 'text-2xs';
export const TINY = 'text-2xs';
export const BODY = 'text-xs';
export const BIG = 'text-xs';

export interface Row {
  wt: RepoWorktree;
  task?: BoardTask;
  title: string;
  chip: Chip;
  agentId: number | null;
}
export interface Group {
  project: string;
  repo: RepoState | undefined;
  rows: Row[];
}

/** Every Lead's project (the 작업실's list), and the groups the filter shows. */
export function useDevroomGroups(): { projects: string[]; groups: Group[] } {
  const { officeSnapshot, taskBoard } = useCldStore();
  const engine = useEngineStore().state?.projects;
  const { states } = useRepoStore();
  const { notes } = useReviewStore();
  const { filter } = useDevroom();
  const looks = useContext(DevroomLooks);
  const projects = useMemo(() => workbenchProjects(officeSnapshot, engine), [officeSnapshot, engine]);
  const tasks = taskBoard?.tasks ?? [];
  const orchs = officeSnapshot?.orchestrators ?? [];
  const groups = shownProjects(projects, filter).map((project): Group => {
    const repo = states[project];
    const rows = (repo?.ok ? (repo.worktrees ?? []) : []).map((wt): Row => {
      const task = wt.taskId ? tasks.find((x) => x.id === wt.taskId) : undefined;
      const orch = wt.assignee ? orchs.find((o) => o.name === wt.assignee) : undefined;
      const agentId = orch?.agentId ?? null;
      const chip = chipOf({
        wt,
        task,
        attention: agentId !== null && looks?.statusFor(agentId) === 'attention',
        busy: orch?.busy === true,
        notesSent: !!notes[reviewKey(project, wt.task)]?.notes.some((n) => n.sentAt),
      });
      return { wt, task, title: titleOf(wt, tasks), chip, agentId };
    });
    return { project, repo, rows: railOrder(rows) };
  });
  return { projects, groups };
}

/** The window's title: `⌘ 개발실 / <project or 모든 프로젝트>` (`· 작업 폴더 정리` while that view is open). */
export function useDevroomTitle(): string {
  const { filter, tab } = useDevroom();
  const { projects } = useDevroomGroups();
  const name = shownProject(projects, filter) ?? t('devroom.allProjects');
  const title = t('devroom.titleWith', { name });
  return tab === 'cleanup' ? `${title} · ${t('devroom.tab.cleanup')}` : title;
}

/** The pick, or (none yet, or it left) the first open worktree, else the first trunk. */
export function currentPick(picked: Picked | null, groups: readonly Group[]): Picked | null {
  const exists = (p: Picked) =>
    groups.some((g) => g.project === p.project && (p.task === null || g.rows.some((r) => r.wt.task === p.task)));
  if (picked && exists(picked)) return picked;
  // Choose only once the repositories are read: the trunk alone would stick before the cards come.
  if (groups.some((g) => !g.repo)) return null;
  for (const g of groups) {
    const open = g.rows.find((r) => r.chip !== 'merged');
    if (open) return { project: g.project, task: open.wt.task };
  }
  return groups[0] ? { project: groups[0].project, task: null } : null;
}


/** The pick in effect (currentPick), kept in the store so every card and the phone agree on it. */
export function useCurrentPick(groups: readonly Group[]): Picked | null {
  const { picked } = useDevroom();
  const pick = currentPick(picked, groups);
  const key = pick && pickKey(pick.project, pick.task);
  const stored = picked && pickKey(picked.project, picked.task);
  useEffect(() => {
    if (pick && key !== stored) pickWorktree(pick.project, pick.task);
  }, [pick, key, stored]);
  return pick;
}

/** Counts the times the socket (re)connected: the server forgets who looks when it drops. */
function useReconnects(): number {
  const [count, setCount] = useState(0);
  useEffect(
    () =>
      transport.onStateChange((state) => {
        if (state === 'connected') setCount((n) => n + 1);
      }),
    [],
  );
  return count;
}

/** While the dev room is on screen the daemon watches every git project (and sends its stats). */
export function useDevroomView(on: boolean): void {
  const reconnects = useReconnects();
  useEffect(() => {
    if (!on) return;
    transport.send({ type: 'devroomView', on: true });
    return () => transport.send({ type: 'devroomView', on: false });
  }, [on, reconnects]);
}
