/**
 * The 실행 tab's project filter (RunsPanel.tsx), kept while the window is open and reset by whoever
 * opens the tab on one run (game/openJobs.ts). Apart from the panel so a notice can set it without
 * loading the job cards.
 */
import { useMemo, useSyncExternalStore } from 'react';

import { useEngineStore } from '../engineStore.js';
import { useAgtyStore } from '../officeStore.js';
import { scopeToProject, teamOf, workbenchProjects } from '../workbench/workbenchState.js';

let picked: string | null = null;
const listeners = new Set<() => void>();
export function setRunsProject(project: string | null): void {
  picked = project;
  listeners.forEach((l) => l());
}
export const runsProject = () => picked;
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
export const useRunsProject = () => useSyncExternalStore(subscribe, runsProject);

/** The 실행 tab's project pick and the snapshot narrowed to it; the 타임라인 follows the same pick (T-185). */
export function useRunsScope() {
  const { officeSnapshot } = useAgtyStore();
  const engine = useEngineStore().state?.projects;
  const project = useRunsProject();
  const projects = useMemo(() => workbenchProjects(officeSnapshot, engine), [officeSnapshot, engine]);
  const shown = project !== null && projects.includes(project) ? project : null;
  const names = shown ? teamOf(shown, officeSnapshot, engine).map((m) => m.name).join('\n') : '';
  const list = useMemo(() => (shown ? names.split('\n') : null), [shown, names]);
  const scope = useMemo(() => (list ? scopeToProject(list) : null), [list]);
  return { projects, shown, names: list, scope };
}
