/** Transcript record builders for `claudeScenario(...).appendJsonl(...)`: a test body never writes a transcript itself. */

export function buildTeamMetadataRecord(
  teamName: string,
  agentName?: string,
): Record<string, unknown> {
  const record: Record<string, unknown> = {
    type: 'system',
    teamName,
  };
  if (agentName) {
    record['agentName'] = agentName;
  }
  return record;
}

export function buildAssistantToolUseRecord(
  toolId: string,
  toolName: string,
  input: Record<string, unknown> = {},
): Record<string, unknown> {
  return buildAssistantToolUseBatchRecord([{ toolId, toolName, input }]);
}

export function buildAssistantToolUseBatchRecord(
  tools: Array<{
    toolId: string;
    toolName: string;
    input?: Record<string, unknown>;
  }>,
): Record<string, unknown> {
  return {
    type: 'assistant',
    message: {
      content: tools.map(({ toolId, toolName, input }) => ({
        type: 'tool_use',
        id: toolId,
        name: toolName,
        input: input ?? {},
      })),
    },
  };
}

export function buildUserToolResultRecord(
  toolUseId: string,
  content: unknown = 'ok',
): Record<string, unknown> {
  return buildUserToolResultBatchRecord([{ toolUseId, content }]);
}

export function buildUserToolResultBatchRecord(
  results: Array<{
    toolUseId: string;
    content?: unknown;
  }>,
): Record<string, unknown> {
  return {
    type: 'user',
    message: {
      content: results.map(({ toolUseId, content }) => ({
        type: 'tool_result',
        tool_use_id: toolUseId,
        content: content ?? 'ok',
      })),
    },
  };
}

/** Agent tool_result as newer harnesses write it: the spawn resolves in seconds
 *  with the spawned agent's identity (`agent_id: <name>@<team>`) while the agent
 *  runs on as an independent top-level session. This result line is the only
 *  lead-side team signal — the lead's own records carry no team tags. */
export function buildTeammateSpawnResultRecord(
  toolUseId: string,
  teammateName: string,
  teamName: string,
): Record<string, unknown> {
  return buildUserToolResultRecord(toolUseId, [
    {
      type: 'text',
      text: `Spawned successfully.\nagent_id: ${teammateName}@${teamName}\nname: ${teammateName}`,
    },
  ]);
}

/** Setting record that opens new-harness teammate transcripts. Carries no team
 *  tags — those appear only on later user/assistant records. */
export function buildAgentSettingRecord(agentType = 'general-purpose'): Record<string, unknown> {
  return { type: 'agent-setting', agentSetting: agentType };
}

export function buildAsyncAgentLaunchResultRecord(toolUseId: string): Record<string, unknown> {
  return buildUserToolResultRecord(toolUseId, [
    {
      type: 'text',
      text: 'Async agent launched successfully.',
    },
  ]);
}

export function buildBackgroundAgentDoneRecord(toolUseId: string): Record<string, unknown> {
  return {
    type: 'queue-operation',
    operation: 'enqueue',
    content: `<tool-use-id>${toolUseId}</tool-use-id>`,
  };
}

/**
 * Assistant record that carries only token usage — the signal behind the
 * context gauge. Real turns put almost the whole context in the cache
 * counters (`input_tokens` is single digits once caching kicks in), so the
 * cache read alone is the context size, which keeps expected percentages exact.
 */
export function buildAssistantUsageRecord(cacheReadTokens: number): Record<string, unknown> {
  return {
    type: 'assistant',
    message: {
      model: 'claude-opus-5',
      content: [{ type: 'text', text: 'still working' }],
      usage: {
        input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: cacheReadTokens,
        output_tokens: 0,
      },
    },
  };
}

export function buildAssistantTextRecord(text: string): Record<string, unknown> {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } };
}

export function buildTurnDurationRecord(): Record<string, unknown> {
  return {
    type: 'system',
    subtype: 'turn_duration',
  };
}

export function buildClearCommandRecord(): Record<string, unknown> {
  return {
    type: 'user',
    content: '/clear</command-name>',
  };
}

export function buildTeamConfig(members: string[]): { members: Array<{ name: string }> } {
  return {
    members: members.map((name) => ({ name })),
  };
}
