/**
 * The 실행 tab's project filter (RunsPanel.tsx), kept while the window is open and reset by whoever
 * opens the tab on one run (game/openJobs.ts). Apart from the panel so a notice can set it without
 * loading the job cards.
 */
import { useSyncExternalStore } from 'react';

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
