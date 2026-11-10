/**
 * W1: the 작업실's own memory (UI-DASH: the 작업실 is the 현황판's 개발 tab now). The project and the tab it was left on are
 * kept per device in localStorage (never on the server); the window's open
 * flag is the HUD's (hudStore). `openWorkbench` is how any button asks for it:
 * App listens for the event and opens the 현황판 on its 개발 tab (window or Dock page).
 */
import { useEffect, useState, useSyncExternalStore } from 'react';

import { t } from '../../i18n/index.js';
import { engineGetSnapshot } from '../engineStore.js';
import { useCldStore } from '../officeStore.js';
import { parseSaved, projectOfAgent, type WorkbenchSaved, type WorkbenchTab } from './workbenchState.js';

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
export const useWorkbench = () => useSyncExternalStore(subscribe, workbenchGetSnapshot, workbenchGetSnapshot);

// SPT-P3-OVERVIEW: a tab opened on a filter (a 개요 number). Not remembered: a filter is a visit,
// read by the tab when it mounts and gone with the next plain tab or project switch.
export interface TabFocus {
  tab: WorkbenchTab;
  /** reqs: `show:<filter>`, `item:<uid>` or `all`; tasks: `status:<status>`; graph: a requirement UID. */
  key: string;
  label?: string;
}
let focus: TabFocus | null = null;
export const tabFocus = (tab: WorkbenchTab): TabFocus | null => (focus?.tab === tab ? focus : null);
/** The one way to open a tab with a filter. */
export function openTab(tab: WorkbenchTab, key: string, label?: string): void {
  focus = { tab, key, ...(label && { label }) };
  set({ tab });
}
const ISSUE_KEY = 'task:';
/** T-73: the issue board on `project`, the Task `id`'s card open. */
export function openIssue(project: string, id: string): void {
  openWorkbench(project);
  openTab('tasks', `${ISSUE_KEY}${id}`);
}
/** The Task the board was last asked to open (a new object per ask, so a repeat ask is seen), else null. */
export const issueFocus = (): { id: string; ask: TabFocus } | null => {
  const ask = tabFocus('tasks');
  return ask?.key.startsWith(ISSUE_KEY) ? { id: ask.key.slice(ISSUE_KEY.length), ask } : null;
};

export const setWorkbenchProject = (project: string) => {
  focus = null;
  set({ project });
};
export const setWorkbenchTab = (tab: WorkbenchTab) => {
  focus = null;
  set({ tab });
};

/** Open the 현황판's 개발 tab, on `project` when given (the 현황판 card's button; a Worker's card means its project), else where it was left. */
export function openWorkbench(project?: string): void {
  if (project) set({ project: projectOfAgent(project, engineGetSnapshot().state?.projects) });
  window.dispatchEvent(new Event(OPEN_WORKBENCH_EVENT));
}

// ── 검토: a task worktree's review shown in the 개발 tab (title `현황판 / <project> · 검토`) ──
export interface ReviewOpen {
  project: string;
  task: string;
}
/** Not remembered across reloads: a review page is a visit, not a place. */
let review: ReviewOpen | null = null;
const reviewListeners = new Set<() => void>();
const reviewSubscribe = (l: () => void) => {
  reviewListeners.add(l);
  return () => void reviewListeners.delete(l);
};
const setReview = (next: ReviewOpen | null) => {
  review = next;
  reviewListeners.forEach((l) => l());
};
export const useWorkbenchReview = () => useSyncExternalStore(reviewSubscribe, () => review);
export const closeReview = () => setReview(null);
/** The task card's 검토: the 개발 tab opens on that worktree's review. */
export function openReview(project: string, task: string): void {
  setReview({ project, task });
  openWorkbench(project);
}
/** The 현황판's title while a review is open on its 개발 tab: `현황판 / <project> · 검토`. */
export function useReviewTitle(): string | null {
  const open = useWorkbenchReview();
  return open ? t('dash.reviewTitle', { project: open.project }) : null;
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
