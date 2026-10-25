/**
 * W1: the 작업실's own memory. The project and the tab it was left on are
 * kept per device in localStorage (never on the server); the window's open
 * flag is the HUD's (hudStore). `openWorkbench` is how any button asks for it:
 * App listens for the event and opens the window, or the phone's Dock page.
 */
import { useEffect, useState, useSyncExternalStore } from 'react';

import { engineGetSnapshot } from '../engineStore.js';
import { useCldStore } from '../officeStore.js';
import { parseSaved, projectOfAgent, type WorkbenchSaved, type WorkbenchTab } from './workbench.js';

export const WORKBENCH_KEY = 'cld.workbench.v1';
export const OPEN_WORKBENCH_EVENT = 'cld-open-workbench';

function read(): WorkbenchSaved {
  try {
    return parseSaved(localStorage.getItem(WORKBENCH_KEY));
  } catch {
    return parseSaved(null); // storage blocked: defaults for this visit
  }
}

let snapshot: WorkbenchSaved = read();
const listeners = new Set<() => void>();

function set(next: Partial<WorkbenchSaved>): void {
  snapshot = { ...snapshot, ...next };
  try {
    localStorage.setItem(WORKBENCH_KEY, JSON.stringify(snapshot));
  } catch {
    // Private mode: this visit still keeps it.
  }
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
export const workbenchGetSnapshot = () => snapshot;
export const useWorkbench = () => useSyncExternalStore(subscribe, workbenchGetSnapshot);

export const setWorkbenchProject = (project: string) => set({ project });
export const setWorkbenchTab = (tab: WorkbenchTab) => set({ tab });

/** Open the 작업실, on `project` when given (the 현황판 card's button; a Worker's card means its project), else where it was left. */
export function openWorkbench(project?: string): void {
  if (project) set({ project: projectOfAgent(project, engineGetSnapshot().state?.projects) });
  window.dispatchEvent(new Event(OPEN_WORKBENCH_EVENT));
}

/** D3b: only a connection that may act sees the 에이전트 tab's actions (the server refuses
 *  the rest anyway). */
export function useCanAct(): boolean {
  const { officeSnapshot, officeReadOnly } = useCldStore();
  return officeSnapshot?.readOnly === false && !officeReadOnly;
}

/** The clock a card's times are read against, ticking every 30 s. */
export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}
