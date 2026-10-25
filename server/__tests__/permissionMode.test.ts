import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { PERMISSION_TIMER_DELAY_MS } from '../src/constants.js';
import { seedPermissionMode } from '../src/permissionMode.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { SubagentWatch } from '../src/subagentWatch.js';
import { processTranscriptLine, setHookProvider } from '../src/transcriptParser.js';

const modeRecord = (mode: string) =>
  JSON.stringify({ type: 'permission-mode', permissionMode: mode, sessionId: 's' });

const taskStart = JSON.stringify({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', id: 'task-1', name: 'Task', input: {} }] },
});

// A sub-agent's Bash call, as the parent transcript reports it.
const subBashStart = JSON.stringify({
  type: 'progress',
  parentToolUseID: 'task-1',
  data: {
    type: 'agent_progress',
    message: {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'sub-1', name: 'Bash', input: {} }] },
    },
  },
});

describe('permission-mode: no permission guess for bypass sessions', () => {
  let agents: AgentStateStore;
  let messages: Array<Record<string, unknown>>;
  const waitingTimers = new Map<number, ReturnType<typeof setTimeout>>();
  const permissionTimers = new Map<number, ReturnType<typeof setTimeout>>();

  const feed = (...lines: string[]) => {
    for (const line of lines) {
      processTranscriptLine(1, line, agents, waitingTimers, permissionTimers);
    }
  };
  const permissionMessages = () => messages.filter((m) => String(m.type).includes('Permission'));

  beforeEach(() => {
    setHookProvider(claudeProvider);
    agents = new AgentStateStore();
    agents.set(
      1,
      createAgentState({
        id: 1,
        sessionId: 's',
        projectDir: '/test',
        jsonlFile: '/test/s.jsonl',
        isExternal: true,
      }),
    );
    messages = [];
    agents.on('broadcast', (m) => messages.push(m as Record<string, unknown>));
    vi.useFakeTimers();
  });

  afterEach(() => {
    for (const t of permissionTimers.values()) clearTimeout(t);
    permissionTimers.clear();
    vi.useRealTimers();
  });

  it('default mode: a quiet sub-agent Bash still triggers the guess', () => {
    feed(modeRecord('default'), taskStart, subBashStart);
    vi.advanceTimersByTime(8000);
    expect(permissionMessages().map((m) => m.type)).toEqual([
      'agentToolPermission',
      'subagentToolPermission',
    ]);
  });

  it('bypass mode: no permission broadcast for the parent or the sub-agent', () => {
    feed(modeRecord('bypassPermissions'), taskStart, subBashStart);
    vi.advanceTimersByTime(8000);
    expect(permissionMessages()).toEqual([]);
    expect(agents.get(1)?.permissionSent).toBe(false);
  });

  it('bypass mode: a quiet parent Bash gets no guess either', () => {
    feed(
      modeRecord('bypassPermissions'),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
      }),
    );
    vi.advanceTimersByTime(8000);
    expect(permissionMessages()).toEqual([]);
  });

  it('switch default -> bypass mid-wait cancels the pending guess', () => {
    feed(modeRecord('default'), taskStart, subBashStart);
    vi.advanceTimersByTime(PERMISSION_TIMER_DELAY_MS - 1000);
    feed(modeRecord('bypassPermissions'));
    vi.advanceTimersByTime(8000);
    expect(permissionMessages()).toEqual([]);
  });

  it('switch default -> bypass after the guess fired clears the shown state', () => {
    feed(modeRecord('default'), taskStart, subBashStart);
    vi.advanceTimersByTime(8000);
    expect(agents.get(1)?.permissionSent).toBe(true);
    messages.length = 0;
    feed(modeRecord('bypassPermissions'));
    expect(agents.get(1)?.permissionSent).toBe(false);
    // The webview clears the agent's sub-agent bubbles on this one message.
    expect(messages).toEqual([{ type: 'agentToolPermissionClear', id: 1 }]);
  });

  it('the newest record wins: bypass -> default resumes the guess', () => {
    feed(modeRecord('bypassPermissions'), modeRecord('default'), taskStart, subBashStart);
    vi.advanceTimersByTime(8000);
    expect(permissionMessages().length).toBe(2);
  });
});

describe('permission-mode: seeding from the transcript tail', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-mode-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  function agentWith(lines: string[]) {
    const file = path.join(dir, 's.jsonl');
    fs.writeFileSync(file, lines.join('\n') + '\n');
    const agents = new AgentStateStore();
    agents.set(
      1,
      createAgentState({
        id: 1,
        sessionId: 's',
        projectDir: dir,
        jsonlFile: file,
        isExternal: true,
      }),
    );
    return agents;
  }

  it('an adopted agent whose tail holds bypass gets no guess', () => {
    vi.useFakeTimers();
    try {
      setHookProvider(claudeProvider);
      const agents = agentWith([
        modeRecord('default'),
        modeRecord('bypassPermissions'),
        '{"type":"x"}',
      ]);
      seedPermissionMode(1, agents);
      expect(agents.get(1)?.permissionMode).toBe('bypassPermissions');

      const messages: Array<Record<string, unknown>> = [];
      agents.on('broadcast', (m) => messages.push(m as Record<string, unknown>));
      const timers = new Map<number, ReturnType<typeof setTimeout>>();
      processTranscriptLine(1, taskStart, agents, new Map(), timers);
      processTranscriptLine(1, subBashStart, agents, new Map(), timers);
      vi.advanceTimersByTime(8000);
      expect(messages.filter((m) => String(m.type).includes('Permission'))).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('takes the newest record, and leaves the mode unset when there is none', () => {
    const a = agentWith([modeRecord('bypassPermissions'), modeRecord('plan')]);
    seedPermissionMode(1, a);
    expect(a.get(1)?.permissionMode).toBe('plan');

    const b = agentWith(['{"type":"user"}']);
    seedPermissionMode(1, b);
    expect(b.get(1)?.permissionMode).toBeUndefined();
  });
});

describe('permission-mode: shadow-watched sub-agents inherit the lead mode', () => {
  it('SubagentWatch copies permissionMode from the lead', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perm-mode-'));
    const file = path.join(dir, 'sub.jsonl');
    fs.writeFileSync(file, '');
    const main = new AgentStateStore();
    const lead = createAgentState({
      id: 1,
      sessionId: 's',
      projectDir: dir,
      jsonlFile: path.join(dir, 'lead.jsonl'),
      isExternal: true,
      permissionMode: 'bypassPermissions',
    });
    const watch = new SubagentWatch(main);
    try {
      setHookProvider(claudeProvider);
      watch.watch(lead, 1, { jsonlPath: file, toolUseId: 'tu-1' } as never);
      const shadow = [...watch.store.values()][0];
      expect(shadow.permissionMode).toBe('bypassPermissions');
    } finally {
      watch.dispose();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
