/**
 * DEVROOM-SIDEBAR: what each sub-agent's calls touched (sidebarTree.ts Trace), kept as the
 * subagentTool* messages arrive (officeStore.cldHandleMessage), never by reading a transcript again.
 * Lives for the visit: a reload starts from the calls still running (the daemon resends those).
 */
import { useSyncExternalStore } from 'react';

import type { ServerMessage } from '../../../../core/src/messages.js';
import { DEVROOM_TRACE_PATHS_MAX, DEVROOM_TRACES_MAX } from '../../constants.js';
import { EMPTY_TRACE, noteTrace, type Trace } from './sidebarTree.js';

const traces = new Map<string, Trace>();
let version = 0;
let calls = 0;
const listeners = new Set<() => void>();

const keyOf = (id: number, parent: string) => `${id}:${parent}`;

function put(key: string, next: Trace): void {
  const had = traces.get(key);
  if (had === next) return;
  if (!had && traces.size >= DEVROOM_TRACES_MAX) traces.delete(traces.keys().next().value as string);
  traces.set(key, next);
  version++;
  listeners.forEach((l) => l());
}

export function subWhereHandle(msg: ServerMessage): void {
  switch (msg.type) {
    case 'subagentToolStart': {
      const key = keyOf(msg.id, msg.parentToolId);
      const was = traces.get(key) ?? EMPTY_TRACE;
      put(key, msg.path ? noteTrace(was, msg.path, ++calls, DEVROOM_TRACE_PATHS_MAX) : was.perm ? { ...was, perm: false } : was);
      break;
    }
    case 'subagentToolDone': {
      const key = keyOf(msg.id, msg.parentToolId);
      const was = traces.get(key);
      if (was?.perm) put(key, { ...was, perm: false });
      break;
    }
    case 'subagentToolPermission': {
      const key = keyOf(msg.id, msg.parentToolId);
      put(key, { ...(traces.get(key) ?? EMPTY_TRACE), perm: true });
      break;
    }
    case 'agentToolPermissionClear':
      for (const [key, t] of traces) if (t.perm && key.startsWith(`${msg.id}:`)) put(key, { ...t, perm: false });
      break;
    default:
      break;
  }
}

export const traceOf = (key: string): Trace | undefined => traces.get(key);

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
/** Re-renders when any trace changed; read them with traceOf. */
export const useSubWhere = (): number => useSyncExternalStore(subscribe, () => version);
