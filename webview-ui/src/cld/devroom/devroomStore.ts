/**
 * P4 개발실 (dev room): its own memory. The project filter is kept per device in localStorage;
 * the selection, the right area's tab, the open `…` menu and the phone's sub-page live for this
 * visit. `openDevRoom` is how any button (메신저, 작업실) brings it up on a project or a worktree.
 */
import { useSyncExternalStore } from 'react';

import { loopbackUrl } from '../../../../core/src/cld/devUrl.js';
import type { DevroomStats, RepoAction, RepoActionResult } from '../../../../core/src/messages.js';
import { t } from '../../i18n/index.js';
import { openWindow } from '../hud/hudStore.js';
import { resultToast } from '../repo/repoText.js';
import { parseFilter } from './devroomState.js';
import { canPreviewHere } from './previewHost.js';

export const DEVROOM_KEY = 'cld.devroom.v1';

export const PREVIEW_KEY = 'cld.devroom.preview.v1';

/** The right area: S2's terminal, S3's 변경, S4's 병합, S6's 미리보기 and S4's 작업 폴더 정리 view. */
export type DevroomTab = 'terminal' | 'changes' | 'merge' | 'preview' | 'cleanup';

export interface Picked {
  project: string;
  /** A task worktree's folder name; null = the trunk (the project's Lead). */
  task: string | null;
}

export interface DevroomSnapshot {
  /** One project, or every one (null). */
  filter: string | null;
  picked: Picked | null;
  tab: DevroomTab;
  /** The card whose `…` menu is open (pickKey). */
  menu: string | null;
  /** Project groups folded shut in the 모든 프로젝트 view. */
  folded: Readonly<Record<string, true>>;
  /** Phone: the card showing its three buttons, and the full-screen sub-page open over the list. */
  expanded: string | null;
  page: DevroomTab | null;
  /** 미리보기: the dev server address of each worktree (pickKey -> a loopback URL), kept per device. */
  previews: Readonly<Record<string, string>>;
  /** The footer's `터미널 N개 · 데몬 메모리 약 X MB` (the daemon sends it while the dev room is viewed). */
  stats: DevroomStats | null;
}

export const pickKey = (project: string, task: string | null): string => `${project}\0${task ?? ''}`;

function readFilter(): string | null {
  try {
    return parseFilter(localStorage.getItem(DEVROOM_KEY));
  } catch {
    return null; // storage blocked: every project for this visit
  }
}

function readPreviews(): Record<string, string> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(PREVIEW_KEY) ?? '{}');
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};
    // Whatever the storage holds goes through the loopback rule again (the iframe loads it).
    return Object.fromEntries(
      Object.entries(raw).flatMap(([k, v]) => (typeof v === 'string' && loopbackUrl(v) ? [[k, v]] : [])),
    );
  } catch {
    return {}; // storage blocked or not JSON: none for this visit
  }
}

let snapshot: DevroomSnapshot = {
  filter: readFilter(),
  picked: null,
  tab: 'terminal',
  menu: null,
  folded: {},
  expanded: null,
  page: null,
  previews: readPreviews(),
  stats: null,
};
const listeners = new Set<() => void>();

function set(next: Partial<DevroomSnapshot>): void {
  snapshot = { ...snapshot, ...next };
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
export const devroomGetSnapshot = () => snapshot;
export const useDevroom = () => useSyncExternalStore(subscribe, devroomGetSnapshot);

export function setDevroomFilter(project: string | null): void {
  try {
    localStorage.setItem(DEVROOM_KEY, JSON.stringify({ project }));
  } catch {
    // Private mode: this visit still keeps it.
  }
  set({ filter: project, menu: null });
}

/** A card or the trunk. The trunk has no 변경 or 병합: its tab falls back to the terminal. */
export function pickWorktree(project: string, task: string | null): void {
  const tab = task === null && snapshot.tab !== 'terminal' ? 'terminal' : snapshot.tab;
  set({ picked: { project, task }, tab, menu: null });
}
export const setDevroomTab = (tab: DevroomTab) => set({ tab, menu: null });
export const toggleMenu = (key: string | null) =>
  set({ menu: key !== null && snapshot.menu === key ? null : key });
export const toggleGroup = (project: string) => {
  const folded = { ...snapshot.folded };
  if (folded[project]) delete folded[project];
  else folded[project] = true;
  set({ folded });
};

/** Remember (or with '' forget) worktree `task`'s dev server address; the caller passed it through loopbackUrl. */
export function setPreviewUrl(project: string, task: string, url: string): void {
  const previews = { ...snapshot.previews };
  if (url) previews[pickKey(project, task)] = url;
  else delete previews[pickKey(project, task)];
  try {
    localStorage.setItem(PREVIEW_KEY, JSON.stringify(previews));
  } catch {
    // Private mode: this visit still keeps it.
  }
  set({ previews });
}

export const devroomSetStats = (stats: DevroomStats) => set({ stats });

/** Phone: a tap on a card shows (or folds) its three buttons. */
export const expandCard = (key: string) =>
  set({ expanded: snapshot.expanded === key ? null : key });
export const openDevroomPage = (project: string, task: string | null, page: DevroomTab) =>
  set({ picked: { project, task }, page, tab: page, menu: null });
/** Back on the phone: the sub-page closes first (true when there was one). */
export function closeDevroomPage(): boolean {
  if (snapshot.page === null) return false;
  set({ page: null });
  return true;
}

/**
 * Open the 개발실 on `project` (its Lead's trunk, or worktree `task`): the 메신저's header and the
 * 작업실's task card. A filter on another project gives way so the pick is in sight.
 */
export function openDevRoom(project: string, task: string | null = null): void {
  if (snapshot.filter !== null && snapshot.filter !== project) setDevroomFilter(project);
  const key = pickKey(project, task);
  set({ picked: { project, task }, tab: 'terminal', menu: null, expanded: key, page: null });
  openWindow('devroom');
}

/** 미리보기 asked for (a notice): the dev room on worktree `task`'s 미리보기, at `url` when given (a phone gets its sub-page). */
export function openPreview(project: string, task: string, url?: string): void {
  if (url) setPreviewUrl(project, task, url);
  if (snapshot.filter !== null && snapshot.filter !== project) setDevroomFilter(project);
  set({
    picked: { project, task },
    tab: 'preview',
    menu: null,
    expanded: pickKey(project, task),
    page: canPreviewHere() ? null : 'preview',
  });
  openWindow('devroom');
}

// ── 기준 브랜치 따라잡기 (repoAction sync) ────────────────────────

let seq = 0;
/** Our own sync writes in flight: requestId -> project (repoStore keeps the confirmed writes). */
const syncing = new Map<string, string>();

/** Bring the base's new commits into worktree `task` (refused by the daemon while its agent works). */
export function syncWorktree(
  project: string,
  task: string,
  send: (msg: RepoAction) => void,
  connected: boolean,
): void {
  if (!connected) return;
  const requestId = `dr-${Date.now().toString(36)}-${++seq}`;
  syncing.set(requestId, project);
  const msg: RepoAction = { type: 'repoAction', requestId, action: 'sync', project, task };
  send(msg);
}

/** Our sync's answer, as a toast like the other repository writes. */
export function devroomHandleResult(
  msg: RepoActionResult,
  toast: (name: string, text: string, tone: 'ok' | 'info' | 'error') => void,
): void {
  const project = syncing.get(msg.requestId);
  if (project === undefined) return;
  syncing.delete(msg.requestId);
  const { text, tone } = resultToast(msg);
  toast(project, text || t('devroom.menu.sync'), tone);
}
