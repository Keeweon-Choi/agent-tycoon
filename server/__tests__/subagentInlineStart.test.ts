import { beforeEach, describe, expect, it } from 'vitest';

import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { processTranscriptLine, setHookProvider } from '../src/transcriptParser.js';

const line = (rec: unknown) => JSON.stringify(rec);
const spawn = line({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id: 'task-1', name: 'Task', input: {} }] },
});
const subCall = (model: string, input: Record<string, unknown>) =>
  line({
    type: 'progress',
    parentToolUseID: 'task-1',
    data: {
      type: 'agent_progress',
      message: {
        type: 'assistant',
        message: { model, content: [{ type: 'tool_use', id: 'sub-1', name: 'Bash', input }] },
      },
    },
  });

describe('an inline sub-agent tool start', () => {
  let messages: Array<Record<string, unknown>>;
  beforeEach(() => {
    setHookProvider(claudeProvider);
    const agents = new AgentStateStore();
    agents.set(
      1,
      createAgentState({ id: 1, sessionId: 's', projectDir: '/t', jsonlFile: '/t/s.jsonl', isExternal: true }),
    );
    messages = [];
    agents.on('broadcast', (m) => messages.push(m as Record<string, unknown>));
    const timers = new Map<number, ReturnType<typeof setTimeout>>();
    for (const l of [spawn, subCall('claude-opus-5-5', { command: 'ls', description: 'List files' })])
      processTranscriptLine(1, l, agents, timers, new Map());
    for (const t of timers.values()) clearTimeout(t);
  });

  it("carries the tool's own description and the sub-agent's real model", () => {
    const start = messages.find((m) => m.type === 'subagentToolStart');
    expect(start?.desc).toBe('List files');
    expect(start?.model).toBe('claude-opus-5-5');
  });
});
