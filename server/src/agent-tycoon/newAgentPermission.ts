/**
 * O4 (F-11): the permission mode NEW agents start with, chosen once in the first-run Intro and
 * changeable in Settings. It is a default for records made after the answer (a project, a
 * Worker, an import): the record gets its own `permissionMode`, which per-agent settings change
 * afterwards. Existing records are never touched (ADR-0016 decision 13), and there is no
 * host-wide switch: the upstream `setBypassPermissions` stays off.
 */
import * as path from 'path';

import { PERMISSION_MODE_BYPASS } from '../constants.js';
import { configDirectory } from './configPath.js';
import type { SocketStepUp, WsSend } from './hooks.js';
import { readJson, writeJsonAtomic } from './jsonFile.js';
import { STEPUP_REQUIRED } from './shell/gate.js';

export type NewAgentMode = 'ask' | 'bypass';

/** The UI highlights this answer first, but `readNewAgentMode` remains unanswered until the owner presses it. */
export const NEW_AGENT_PERMISSION_RECOMMENDED_MODE: NewAgentMode = 'bypass';

const file = (home: string): string => path.join(configDirectory(home), 'new-agent-permission.json');

/** The stored choice; '' while unanswered (or unreadable: asking again is the safe side). */
export function readNewAgentMode(home: string): NewAgentMode | '' {
  try {
    const mode = (readJson(file(home)) as { mode?: unknown } | null)?.mode;
    return mode === 'ask' || mode === 'bypass' ? mode : '';
  } catch {
    return '';
  }
}

/** What a new Claude record starts with: spread it BEFORE the request's own fields. */
export function seededPermission(home: string): { permissionMode?: string } {
  return readNewAgentMode(home) === NEW_AGENT_PERMISSION_RECOMMENDED_MODE
    ? { permissionMode: PERMISSION_MODE_BYPASS }
    : {};
}

export function newAgentPermissionMessage(home: string, error?: string) {
  return { type: 'newAgentPermission', mode: readNewAgentMode(home), ...(error ? { error } : {}) };
}

/** A `newAgentPermissionRequest`: save when allowed, answer the sender with the truth, tell the others on success. */
export function handleNewAgentPermission(
  msg: Record<string, unknown>,
  send: WsSend,
  ctx: {
    home: string;
    privileged: boolean;
    readOnly: boolean;
    stepUp?: SocketStepUp;
    broadcast: (message: Record<string, unknown>) => void;
    log?: (line: string) => void;
  },
): void {
  const mode = msg.mode;
  let error: string | undefined;
  if (mode !== 'ask' && mode !== 'bypass') return;
  if (!ctx.privileged || ctx.readOnly) error = 'read_only';
  // Choosing bypass from another device needs the step-up (as an agent's permission mode does); ask never.
  else if (mode === 'bypass' && ctx.stepUp?.remote && !ctx.stepUp.fresh()) error = STEPUP_REQUIRED;
  else {
    try {
      writeJsonAtomic(file(ctx.home), { mode });
    } catch (err) {
      ctx.log?.(`new agent permission: ${err instanceof Error ? err.message : String(err)}`);
      error = 'write_failed';
    }
  }
  if (error) send(newAgentPermissionMessage(ctx.home, error));
  else ctx.broadcast(newAgentPermissionMessage(ctx.home));
}
