/**
 * Engine action parsing and result helpers extracted from engine.ts (E1).
 */
import type { EngineAction, EngineActionKind } from '../../../../core/src/messages.js';
import type { WorkerRole } from './registry.js';
import { WORKER_ROLES } from './registry.js';

/** compactionNudge's upper bound (0 = off). */
export const NUDGE_MAX = 99;
export const ACTIONS: EngineActionKind[] = ['add', 'edit', 'remove', 'start', 'stop', 'restart', 'promote'];
export const TEXT_FIELDS = ['room', 'rulesFile', 'model', 'permissionMode', 'effort', 'title'] as const;
export const LAUNCH_FIELDS = [
  'rulesFile',
  'model',
  'permissionMode',
  'effort',
  'title',
  'remoteControl',
] as const;
export const REQUEST_ID_MAX = 128;
/** D5: what only a Claude session takes; a Codex Worker refuses them (nothing saved quietly). */
export const CLAUDE_ONLY = ['permissionMode', 'rulesFile', 'remoteControl', 'alwaysOn', 'title', 'compactionNudge'] as const;

export function parseEngineAction(msg: Record<string, unknown>): EngineAction | null {
  const { requestId, action, name } = msg;
  if (typeof requestId !== 'string' || !requestId || requestId.length > REQUEST_ID_MAX) return null;
  if (typeof action !== 'string' || !(ACTIONS as string[]).includes(action)) return null;
  if (typeof name !== 'string' || name.length > 64) return null;
  const out: EngineAction = {
    type: 'engineAction',
    requestId,
    action: action as EngineActionKind,
    name,
  };
  // D3: a Worker of a project (add).
  const { role, project } = msg;
  if (role !== undefined) {
    if (!(WORKER_ROLES as unknown[]).includes(role)) return null;
    out.role = role as WorkerRole;
  }
  if (project !== undefined) {
    if (typeof project !== 'string' || project.length > 64) return null;
    out.project = project;
  }
  for (const k of ['folder', ...TEXT_FIELDS] as const) {
    const v = msg[k];
    if (v === undefined) continue;
    if (typeof v !== 'string' || v.length > 4096) return null;
    out[k] = v;
  }
  for (const k of ['remoteControl', 'alwaysOn', 'mkdir', 'purge'] as const) {
    const v = msg[k];
    if (v === undefined) continue;
    if (typeof v !== 'boolean') return null;
    out[k] = v;
  }
  // D5: a new Worker's provider.
  const { provider } = msg;
  if (provider !== undefined) {
    if (typeof provider !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(provider)) return null;
    out.provider = provider;
  }
  // INHERIT: add's removed agent to take over (its gone name; the engine checks the rest).
  const { inheritFrom } = msg;
  if (inheritFrom !== undefined) {
    if (typeof inheritFrom !== 'string' || inheritFrom.length > 64 || action !== 'add') return null;
    out.inheritFrom = inheritFrom;
  }
  // DEVROOM-PROJECT: a Lead added from a fresh clone (its folder's trust is the person's to give).
  if (msg.cloned !== undefined) {
    if (msg.cloned !== true || action !== 'add') return null;
    out.cloned = true;
  }
  // D3b: what the old Lead becomes on promote.
  const { oldLead } = msg;
  if (oldLead !== undefined) {
    if (oldLead !== 'worker' && oldLead !== 'stop') return null;
    out.oldLead = oldLead;
  }
  // T-0019: compactions before the renew nudge; 0 turns it off.
  const nudge = msg.compactionNudge;
  if (nudge !== undefined) {
    if (!Number.isInteger(nudge) || (nudge as number) < 0 || (nudge as number) > NUDGE_MAX)
      return null;
    out.compactionNudge = nudge as number;
  }
  return out;
}

export interface Outcome {
  ok: boolean;
  bgId?: string;
  note?: string;
  error?: string;
  /** Claude's own words, for the client only (never logged). */
  detail?: string;
  folderMissing?: boolean;
  /** T-0019: a machine-readable reason (renew). */
  code?: string;
}
export const fail = (error: string, detail?: string): Outcome => ({ ok: false, error, detail });
/** TERM-P3: moveToPty's refusals the move-all queue reacts to (wait, or report as rolled back). */
export const MOVE_BUSY = 'move_busy';
export const MOVE_ROLLED_BACK = 'move_rolled_back';
/** What the user should know although it worked (a slow folder, T-0032). */
export const warned = (notes: string[]): Pick<Outcome, 'note'> =>
  notes.length ? { note: notes.join(' · ') } : {};
