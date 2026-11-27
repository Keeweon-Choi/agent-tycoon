import path from 'path';

export interface HookEventPayload {
  session_id: string;
  hook_event_name: string;
  [key: string]: unknown;
}

/** A file in the daemon's office folder (configPath.cjs officeDirectory; a test HOME is always a fresh one). */
export function officeFile(tmpHome: string, ...parts: string[]): string {
  return path.join(tmpHome, '.config', 'agent-tycoon', 'office', ...parts);
}

/** In an engine scenario (`onPrompt`) the session runs its own --settings hook with this call. */
export function permissionRequest(
  sessionId: string,
  toolName?: string,
  toolInput?: Record<string, unknown>,
): HookEventPayload {
  return {
    session_id: sessionId,
    hook_event_name: 'PermissionRequest',
    ...(toolName && { tool_name: toolName }),
    ...(toolInput && { tool_input: toolInput }),
  };
}
