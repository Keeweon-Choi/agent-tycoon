/**
 * The terminal workspace's state for this page (T-0078): the pure model of
 * workspace.ts, kept in `localStorage` per device (versioned key, every
 * access in a try) and shared by whoever asks to open a terminal -- the
 * workspace itself, and 터미널로 보기 in the messenger.
 */
import { useSyncExternalStore } from 'react';

import {
  agentTab,
  closePane,
  closeTab,
  emptyWorkspace,
  focusPane,
  openTab,
  restore,
  serialize,
  showInPane,
  showTab,
  splitDown,
  splitRight,
  type Tab,
  type Workspace,
  WORKSPACE_STORAGE_KEY,
} from './workspace.js';

function load(): Workspace {
  try {
    return restore(localStorage.getItem(WORKSPACE_STORAGE_KEY));
  } catch {
    return emptyWorkspace(); // no storage (a private window, a blocked page)
  }
}

let state: Workspace = load();
/** Tab keys the open workspace shows right now (nothing while the terminal is closed). */
let visible: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};

function set(next: Workspace): void {
  if (next === state) return;
  state = next;
  try {
    localStorage.setItem(WORKSPACE_STORAGE_KEY, serialize(state));
  } catch {
    /* kept for this page only */
  }
  emit();
}

export const getWorkspace = (): Workspace => state;
export const useWorkspace = (): Workspace => useSyncExternalStore(subscribe, () => state);

export const workspaceActions = {
  open: (tab: Tab) => set(openTab(state, tab)),
  show: (key: string) => set(showTab(state, key)),
  showInPane: (row: number, col: number, key: string | null) =>
    set(showInPane(state, row, col, key)),
  focus: (row: number, col: number) => set(focusPane(state, row, col)),
  splitRight: () => set(splitRight(state)),
  splitDown: () => set(splitDown(state)),
  closePane: (row: number, col: number) => set(closePane(state, row, col)),
  /** Detach: the tab goes, what ran in it does not. */
  close: (key: string) => set(closeTab(state, key)),
};

/** Tests: a fresh page. */
export function resetWorkspaceForTests(next: Workspace = emptyWorkspace()): void {
  state = next;
  visible = new Set();
  emit();
}

// ── 터미널로 보기 ─────────────────────────────────────────────────────────

/** Fired when something wants the terminal on screen; App opens the 터미널 panel. */
export const OPEN_TERMINAL_EVENT = 'cld-open-terminal-tab';

/** Open (or focus) an agent's terminal as a tab and bring the terminal forward. */
export function openAgentTerminal(bgId: string, title: string, agentId?: number): void {
  workspaceActions.open(agentTab(bgId, title, agentId));
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(OPEN_TERMINAL_EVENT));
}

/** The workspace reports the tabs it shows (empty when it unmounts). */
export function reportVisibleTabs(keys: readonly string[]): void {
  visible = new Set(keys);
}

/** Is character `agentId`'s terminal on screen: an agent tab a pane shows. */
export function agentTerminalVisible(agentId: number): boolean {
  return state.tabs.some((t) => t.kind === 'agent' && t.agentId === agentId && visible.has(t.key));
}
