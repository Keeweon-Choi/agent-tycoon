/**
 * WAITING-PERSIST (owner 11-03 12:18): THE one rule for "this agent waits for the person", a
 * permission or a question, read by every surface (the terminal dot and badge, the 전광판, the
 * 현황판, the messenger, the dev room). A question is the question tool open, or a main turn that
 * ended asking (the server's `question`: its last text ends with '?'; it survives reloads and
 * daemon restarts). Claude's idle_prompt is NOT one (it follows every turn after 60 s). The
 * terminal drawer computes the map from the activity messages and publishes it here.
 */
import { useSyncExternalStore } from 'react';

import type { ToolActivity } from '../office/types.js';

export type WaitReason = 'permission' | 'question';

/** The question tool: the agent stopped mid-turn on a question (also floors.ts, ez rules). */
const QUESTION_TOOL = 'AskUserQuestion';

/** Why one agent waits for the person, or null. */
export function waitReason(
  tools: readonly ToolActivity[] | undefined,
  question: boolean | undefined,
): WaitReason | null {
  const open = tools?.filter((x) => !x.done) ?? [];
  if (open.some((x) => x.toolName === QUESTION_TOOL)) return 'question';
  if (open.some((x) => x.permissionWait)) return 'permission';
  return question ? 'question' : null;
}

/** Every agent that waits, by id. */
export function waitReasons(
  tools: Readonly<Record<number, ToolActivity[]>>,
  questions: Readonly<Record<number, boolean>>,
): Record<number, WaitReason> {
  const out: Record<number, WaitReason> = {};
  for (const id of new Set([...Object.keys(tools), ...Object.keys(questions)].map(Number))) {
    const why = waitReason(tools[id], questions[id]);
    if (why) out[id] = why;
  }
  return out;
}

/** The ids among `ids` that wait, in their order. */
export const waitingIds = (ids: readonly number[], reasons: Readonly<Record<number, WaitReason>>): number[] =>
  ids.filter((id) => reasons[id] !== undefined);

// ── The published map ─────────────────────────────────────────

let current: Record<number, WaitReason> = {};
const listeners = new Set<() => void>();

/** The terminal drawer's new map (same contents: nothing changes). */
export function publishWaiting(next: Record<number, WaitReason>): void {
  const a = Object.entries(current).join();
  if (a === Object.entries(next).join()) return;
  current = next;
  listeners.forEach((l) => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
};
export const getWaitReasons = () => current;
export const useWaitReasons = () => useSyncExternalStore(subscribe, getWaitReasons);
