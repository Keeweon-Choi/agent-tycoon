import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentStateStore } from '../src/agentStateStore.js';
import { HOOK_EVENT_BUFFER_MS } from '../src/constants.js';
import { HookEventHandler } from '../src/hookEventHandler.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { SessionRouter } from '../src/sessionRouter.js';
import { processTranscriptLine } from '../src/transcriptParser.js';
import type { AgentState } from '../src/types.js';

/** Minimal AgentState for testing. */
function createTestAgent(overrides: Partial<AgentState> = {}): AgentState {
  return {
    id: 1,
    sessionId: '',
    isExternal: true,
    projectDir: '/test',
    jsonlFile: '/test/session.jsonl',
    fileOffset: 0,
    lineBuffer: '',
    activeToolIds: new Set(),
    activeToolStatuses: new Map(),
    activeToolNames: new Map(),
    activeToolDescs: new Map(),
    subagentTools: new Map(),
    activeSubagentToolIds: new Map(),
    activeSubagentToolNames: new Map(),
    backgroundAgentToolIds: new Set(),
    isWaiting: false,
    permissionSent: false,
    hadToolsInTurn: false,
    lastDataAt: 0,
    linesProcessed: 0,
    hookDelivered: false,
    ...overrides,
  } as AgentState;
}

function createMockWebview() {
  const messages: Array<Record<string, unknown>> = [];
  return {
    postMessage: vi.fn((msg: Record<string, unknown>) => {
      messages.push(msg);
      return Promise.resolve(true);
    }),
    messages,
  };
}

describe('HookEventHandler', () => {
  let agents: AgentStateStore;
  let waitingTimers: Map<number, ReturnType<typeof setTimeout>>;
  let permissionTimers: Map<number, ReturnType<typeof setTimeout>>;
  let mockWebview: ReturnType<typeof createMockWebview>;
  let handler: HookEventHandler;

  beforeEach(() => {
    agents = new AgentStateStore();
    waitingTimers = new Map();
    permissionTimers = new Map();
    mockWebview = createMockWebview();
    // Wire broadcast subscriber so mockWebview captures store broadcasts
    agents.on('broadcast', (msg) => {
      mockWebview.postMessage(msg);
    });
    handler = new HookEventHandler(
      agents,
      waitingTimers,
      permissionTimers,
      claudeProvider,
      new SessionRouter(),
    );
  });

  // ── PermissionRequest ───────────────────────────────────────

  it('PermissionRequest sends agentToolPermission', () => {
    const agent = createTestAgent({ id: 1 });
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'PermissionRequest',
      session_id: 'sess-1',
    });

    const msg = mockWebview.messages.find((m) => m.type === 'agentToolPermission');
    expect(msg).toBeTruthy();
    expect(msg?.id).toBe(1);
  });

  it('PermissionRequest cancels permission timer', () => {
    const agent = createTestAgent({ id: 1 });
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    const timer = setTimeout(() => {}, 10000);
    permissionTimers.set(1, timer);

    handler.handleEvent('claude', {
      hook_event_name: 'PermissionRequest',
      session_id: 'sess-1',
    });

    expect(permissionTimers.has(1)).toBe(false);
  });

  it('PermissionRequest notifies sub-agents', () => {
    const agent = createTestAgent({ id: 1 });
    agent.activeSubagentToolNames.set('tool-parent', new Map([['sub-1', 'Read']]));
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'PermissionRequest',
      session_id: 'sess-1',
    });

    const subMsg = mockWebview.messages.find((m) => m.type === 'subagentToolPermission');
    expect(subMsg).toBeTruthy();
    expect(subMsg?.parentToolId).toBe('tool-parent');
  });

  // ── Notification ────────────────────────────────────────────

  it('Notification permission_prompt sends agentToolPermission', () => {
    const agent = createTestAgent({ id: 1 });
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'Notification',
      session_id: 'sess-1',
      notification_type: 'permission_prompt',
    });

    const msg = mockWebview.messages.find((m) => m.type === 'agentToolPermission');
    expect(msg).toBeTruthy();
    expect(agent.permissionSent).toBe(true);
  });

  it('Notification idle_prompt marks agent waiting', () => {
    const agent = createTestAgent({ id: 1 });
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'Notification',
      session_id: 'sess-1',
      notification_type: 'idle_prompt',
    });

    expect(agent.isWaiting).toBe(true);
    const msg = mockWebview.messages.find(
      (m) => m.type === 'agentStatus' && m.status === 'waiting',
    );
    expect(msg).toBeTruthy();
    // idle_prompt = waiting on the user -> awaitingInput true ("Waiting for input")
    expect(msg?.awaitingInput).toBe(true);
  });

  // ── Stop ────────────────────────────────────────────────────

  it('Stop marks agent waiting without awaitingInput (Done)', () => {
    const agent = createTestAgent({ id: 1 });
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'Stop',
      session_id: 'sess-1',
    });

    expect(agent.isWaiting).toBe(true);
    const waitMsg = mockWebview.messages.find(
      (m) => m.type === 'agentStatus' && m.status === 'waiting',
    );
    expect(waitMsg).toBeTruthy();
    // Stop = finished its turn -> awaitingInput falsy ("Done")
    expect(waitMsg?.awaitingInput).toBeFalsy();
  });

  it('Stop clears foreground tools but preserves background agents', () => {
    const agent = createTestAgent({ id: 1 });
    agent.activeToolIds.add('fg-tool');
    agent.activeToolStatuses.set('fg-tool', 'Running');
    agent.activeToolNames.set('fg-tool', 'Bash');
    agent.activeToolIds.add('bg-tool');
    agent.activeToolStatuses.set('bg-tool', 'Background task');
    agent.activeToolNames.set('bg-tool', 'Agent');
    agent.backgroundAgentToolIds.add('bg-tool');
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'Stop',
      session_id: 'sess-1',
    });

    expect(agent.activeToolIds.has('fg-tool')).toBe(false);
    expect(agent.activeToolIds.has('bg-tool')).toBe(true);
    const clearMsg = mockWebview.messages.find((m) => m.type === 'agentToolsClear');
    expect(clearMsg).toBeTruthy();
    const reSent = mockWebview.messages.find(
      (m) => m.type === 'agentToolStart' && m.toolId === 'bg-tool',
    );
    expect(reSent).toBeTruthy();
  });

  // ── hookDelivered ───────────────────────────────────────────

  it('sets hookDelivered flag on agent', () => {
    const agent = createTestAgent({ id: 1, hookDelivered: false } as Partial<AgentState>);
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'Stop',
      session_id: 'sess-1',
    });

    expect(agent.hookDelivered).toBe(true);
  });

  // ── Buffering ───────────────────────────────────────────────

  it('silently drops events for untracked sessions', () => {
    // No agents, no pending sessions, no prior buffered events
    handler.handleEvent('claude', {
      hook_event_name: 'Stop',
      session_id: 'unknown-sess',
    });

    // No messages sent, no crash
    expect(mockWebview.messages).toHaveLength(0);
  });

  it('buffers events when unregistered agents exist (internal agent race)', () => {
    // Agent exists in map but not yet registered for hooks
    const agent = createTestAgent({ id: 1, sessionId: 'sess-1' } as Partial<AgentState>);
    agents.set(1, agent);
    // Don't call registerAgent yet (simulates race)

    handler.handleEvent('claude', {
      hook_event_name: 'Stop',
      session_id: 'sess-1',
    });

    // Event should be buffered (auto-discovery finds agent by sessionId and delivers)
    expect(agent.isWaiting).toBe(true);
  });

  it('flushes buffered events on registerAgent', () => {
    // Agent exists with sessionId but not registered
    const agent = createTestAgent({ id: 1, sessionId: 'sess-1' } as Partial<AgentState>);
    agents.set(1, agent);

    // Send event (auto-discovery will find it immediately in this case)
    handler.handleEvent('claude', {
      hook_event_name: 'Stop',
      session_id: 'sess-1',
    });

    // Auto-discovery handles it directly
    const waitMsg = mockWebview.messages.find(
      (m) => m.type === 'agentStatus' && m.status === 'waiting',
    );
    expect(waitMsg).toBeTruthy();
  });

  it('prunes expired buffered events', () => {
    // Fake time: the prune interval is HOOK_EVENT_BUFFER_MS and keeps events strictly newer than
    // the cutoff, so an event lives 5-10 s. Real time made this flaky under load (an event still
    // buffered at 7 s when the first tick came a millisecond early, or late).
    vi.useFakeTimers();
    try {
      // Create agent so events get buffered (unregistered agent exists)
      const agent = createTestAgent({ id: 1, sessionId: 'other-sess' } as Partial<AgentState>);
      agents.set(1, agent);

      handler.handleEvent('claude', {
        hook_event_name: 'Stop',
        session_id: 'expired-sess',
      });

      // Two prune ticks: past any boundary of the 5-10 s window
      vi.advanceTimersByTime(HOOK_EVENT_BUFFER_MS * 2 + 1);

      // Now register -- event should have been pruned
      const agent2 = createTestAgent({ id: 2 });
      agents.set(2, agent2);
      handler.registerAgent('expired-sess', 2);

      // No messages (event was pruned)
      expect(mockWebview.messages).toHaveLength(0);
    } finally {
      handler.dispose();
      vi.useRealTimers();
    }
  });

  // ── Auto-discovery ──────────────────────────────────────────

  it('auto-discovers agent by sessionId field', () => {
    const agent = createTestAgent({ id: 1, sessionId: 'auto-sess' } as Partial<AgentState>);
    agents.set(1, agent);

    handler.handleEvent('claude', {
      hook_event_name: 'Stop',
      session_id: 'auto-sess',
    });

    expect(agent.isWaiting).toBe(true);
  });

  // ── Dispose ─────────────────────────────────────────────────

  it('dispose cleans up timers and maps', () => {
    handler.registerAgent('sess-1', 1);
    handler.dispose();
    expect(() => handler.dispose()).not.toThrow();
  });

  // ── SessionStart ────────────────────────────────────────────

  it('SessionStart for known agent sets hookDelivered', () => {
    const agent = createTestAgent({ id: 1, hookDelivered: false } as Partial<AgentState>);
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'sess-1',
      source: 'startup',
    });

    expect(agent.hookDelivered).toBe(true);
  });

  it('SessionStart auto-discovers agent by sessionId', () => {
    const agent = createTestAgent({
      id: 1,
      sessionId: 'auto-sess',
      hookDelivered: false,
    } as Partial<AgentState>);
    agents.set(1, agent);

    handler.handleEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'auto-sess',
      source: 'startup',
    });

    expect(agent.hookDelivered).toBe(true);
  });

  it('SessionStart(source=clear) reassigns agent with pendingClear', () => {
    const agent = createTestAgent({
      id: 1,
      projectDir: '/projects/test',
      pendingClear: true,
    } as Partial<AgentState>);
    agents.set(1, agent);
    handler.registerAgent('old-sess', 1);

    const onSessionClear = vi.fn();
    handler.setLifecycleCallbacks({ onSessionClear });

    handler.handleEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'new-sess',
      source: 'clear',
      transcript_path: '/projects/test/new-sess.jsonl',
    });

    expect(onSessionClear).toHaveBeenCalledWith(
      1,
      'new-sess',
      '/projects/test/new-sess.jsonl',
      false,
    );
    expect(agent.pendingClear).toBe(false);
  });

  it('SessionStart for unknown session stores as pending', () => {
    handler.handleEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'ext-sess',
      source: 'startup',
      transcript_path: '/projects/test/ext-sess.jsonl',
      cwd: '/projects/test',
    });

    // No agent created (pending, awaiting confirmation)
    expect(mockWebview.messages).toHaveLength(0);
  });

  // ── SessionEnd ──────────────────────────────────────────────

  it('SessionEnd(reason=clear) sets pendingClear and marks waiting', () => {
    const agent = createTestAgent({ id: 1 });
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'SessionEnd',
      session_id: 'sess-1',
      reason: 'clear',
    });

    expect(agent.pendingClear).toBe(true);
    expect(agent.isWaiting).toBe(true);
  });

  // /clear and /resume run no turn: their waiting is restored, so no turn-end notice, toast or sound.
  it.each(['clear', 'resume'])('SessionEnd(reason=%s) broadcasts only restored waiting', (reason) => {
    const agent = createTestAgent({ id: 1 });
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', { hook_event_name: 'SessionEnd', session_id: 'sess-1', reason });

    const waits = mockWebview.messages.filter((m) => m.type === 'agentStatus' && m.status === 'waiting');
    expect(waits).toHaveLength(1);
    expect(waits[0].restored).toBe(true);
  });

  it('SessionEnd(reason=exit) calls onSessionEnd immediately', () => {
    const agent = createTestAgent({ id: 1 });
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    const onSessionEnd = vi.fn();
    handler.setLifecycleCallbacks({ onSessionEnd });

    handler.handleEvent('claude', {
      hook_event_name: 'SessionEnd',
      session_id: 'sess-1',
      reason: 'exit',
    });

    // Exit is immediate, no pendingClear delay
    expect(agent.isWaiting).toBe(true);
    expect(onSessionEnd).toHaveBeenCalledWith(1, 'exit');
  });

  it('SessionEnd(reason=resume) delays onSessionEnd for SESSION_END_GRACE_MS', async () => {
    const agent = createTestAgent({ id: 1 });
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    const onSessionEnd = vi.fn();
    handler.setLifecycleCallbacks({ onSessionEnd });

    handler.handleEvent('claude', {
      hook_event_name: 'SessionEnd',
      session_id: 'sess-1',
      reason: 'resume',
    });

    // pendingClear set, onSessionEnd delayed
    expect(agent.pendingClear).toBe(true);
    expect(agent.isWaiting).toBe(true);
    expect(onSessionEnd).not.toHaveBeenCalled();

    // Wait for grace period (2000ms + margin)
    await new Promise((r) => setTimeout(r, 2500));
    expect(onSessionEnd).toHaveBeenCalledWith(1, 'resume');
    expect(agent.pendingClear).toBe(false);
  });

  // B4.5: the first /clear's safety timer must not end the agent mid second /clear.
  it('two /clear within the grace period: the first safety timer does not end the agent', () => {
    vi.useFakeTimers();
    try {
      const agent = createTestAgent({ id: 1, projectDir: '/projects/test' });
      agents.set(1, agent);
      handler.registerAgent('s1', 1);
      const onSessionEnd = vi.fn();
      const onSessionClear = vi.fn();
      handler.setLifecycleCallbacks({ onSessionEnd, onSessionClear });
      const clear = (from: string, to: string) => {
        handler.handleEvent('claude', {
          hook_event_name: 'SessionEnd',
          session_id: from,
          reason: 'clear',
        });
        return () =>
          handler.handleEvent('claude', {
            hook_event_name: 'SessionStart',
            session_id: to,
            source: 'clear',
            transcript_path: `/projects/test/${to}.jsonl`,
          });
      };
      clear('s1', 's2')();
      vi.advanceTimersByTime(1_900);
      const start = clear('s2', 's3');
      vi.advanceTimersByTime(200);
      expect(onSessionEnd).not.toHaveBeenCalled();
      start();
      expect(onSessionClear).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(5_000);
      expect(onSessionEnd).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('SessionEnd discards pending external session (transient filtering)', () => {
    // Store pending session via SessionStart
    handler.handleEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'transient-sess',
      source: 'startup',
      transcript_path: '/projects/test/transient.jsonl',
      cwd: '/projects/test',
    });

    // SessionEnd arrives before confirmation -> discard
    handler.handleEvent('claude', {
      hook_event_name: 'SessionEnd',
      session_id: 'transient-sess',
      reason: 'other',
    });

    // No agent created, no messages
    expect(mockWebview.messages).toHaveLength(0);
  });

  // ── PreToolUse / PostToolUse ─────────────────────────────────

  it('PreToolUse sends agentToolStart with formatted status', () => {
    const agent = createTestAgent({ id: 1, isWaiting: true });
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'PreToolUse',
      session_id: 'sess-1',
      tool_name: 'Read',
      tool_input: { file_path: '/src/server.ts' },
    });

    const toolMsg = mockWebview.messages.find((m) => m.type === 'agentToolStart');
    expect(toolMsg).toBeTruthy();
    expect(toolMsg?.toolName).toBe('Read');
    expect(toolMsg?.status).toBe('Reading server.ts');
    expect(agent.hookToolIds).toEqual([toolMsg?.toolId]);
  });

  it("PreToolUse carries the tool call's own description as desc, and omits it when there is none", () => {
    const agent = createTestAgent({ id: 1 });
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);
    const pre = (tool_input: Record<string, unknown>) =>
      handler.handleEvent('claude', {
        hook_event_name: 'PreToolUse',
        session_id: 'sess-1',
        tool_name: 'Bash',
        tool_input,
      });
    pre({ command: 'cd /x && npm test', description: ' Run the tests ' });
    pre({ command: 'ls' });
    const starts = mockWebview.messages.filter((m) => m.type === 'agentToolStart');
    expect(starts[0]?.desc).toBe('Run the tests');
    expect(starts[1]).toBeTruthy();
    expect('desc' in starts[1]! && starts[1]!.desc !== undefined).toBe(false);
  });

  it('PreToolUse marks agent active and cancels waiting', () => {
    const agent = createTestAgent({ id: 1, isWaiting: true });
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'PreToolUse',
      session_id: 'sess-1',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
    });

    expect(agent.isWaiting).toBe(false);
    expect(agent.hadToolsInTurn).toBe(true);
    const activeMsg = mockWebview.messages.find(
      (m) => m.type === 'agentStatus' && m.status === 'active',
    );
    expect(activeMsg).toBeTruthy();
  });

  it('PostToolUse sends agentToolDone and clears the open hook tool', () => {
    const agent = createTestAgent({ id: 1 });
    agent.hookToolIds = ['hook-123'];
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'PostToolUse',
      session_id: 'sess-1',
    });

    const doneMsg = mockWebview.messages.find((m) => m.type === 'agentToolDone');
    expect(doneMsg).toBeTruthy();
    expect(doneMsg?.toolId).toBe('hook-123');
    expect(agent.hookToolIds).toEqual([]);
  });

  it('PostToolUseFailure sends agentToolDone', () => {
    const agent = createTestAgent({ id: 1 });
    agent.hookToolIds = ['hook-456'];
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'PostToolUseFailure',
      session_id: 'sess-1',
    });

    const doneMsg = mockWebview.messages.find((m) => m.type === 'agentToolDone');
    expect(doneMsg).toBeTruthy();
    expect(doneMsg?.toolId).toBe('hook-456');
    expect(agent.hookToolIds).toEqual([]);
  });

  // B4.6: parallel tool calls each end their own row.
  it('parallel PreToolUse/PostToolUse pairs end each tool by its tool_use_id', () => {
    const agent = createTestAgent({ id: 1 });
    agents.set(1, agent);
    handler.registerAgent('sess-1', 1);
    const fire = (hook_event_name: string, tool_use_id: string, tool_name: string) =>
      handler.handleEvent('claude', {
        hook_event_name,
        session_id: 'sess-1',
        tool_name,
        tool_input: {},
        tool_use_id,
      });
    fire('PreToolUse', 'toolu_a', 'Read');
    fire('PreToolUse', 'toolu_b', 'Grep');
    fire('PostToolUse', 'toolu_b', 'Grep');
    fire('PostToolUse', 'toolu_a', 'Read');
    const starts = mockWebview.messages.filter((m) => m.type === 'agentToolStart');
    const dones = mockWebview.messages.filter((m) => m.type === 'agentToolDone');
    expect(new Set(starts.map((m) => m.toolId)).size).toBe(2);
    expect(dones.map((m) => m.toolId)).toEqual([starts[1].toolId, starts[0].toolId]);
  });

  it('parallel tool calls without a tool_use_id in the same millisecond still get one row each', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      const agent = createTestAgent({ id: 1 });
      agents.set(1, agent);
      handler.registerAgent('sess-1', 1);
      for (const e of ['PreToolUse', 'PreToolUse', 'PostToolUse', 'PostToolUse'])
        handler.handleEvent('claude', {
          hook_event_name: e,
          session_id: 'sess-1',
          tool_name: 'Read',
        });
      const starts = mockWebview.messages.filter((m) => m.type === 'agentToolStart');
      const dones = mockWebview.messages.filter((m) => m.type === 'agentToolDone');
      expect(new Set(starts.map((m) => m.toolId)).size).toBe(2);
      expect(dones.map((m) => m.toolId)).toEqual(starts.map((m) => m.toolId));
    } finally {
      vi.restoreAllMocks();
    }
  });

  // B4.2: an approved, finished tool takes its permission bubble with it.
  describe('permission bubble after the approved tool ends', () => {
    const fire = (hook_event_name: string, tool_use_id?: string) =>
      handler.handleEvent('claude', {
        hook_event_name,
        session_id: 'sess-1',
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        ...(tool_use_id && { tool_use_id }),
      });
    const line = (r: object) => JSON.stringify(r);
    const toolUse = (id: string) =>
      line({
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'npm test' } }],
        },
      });
    const toolResult = (id: string) =>
      line({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
      });
    const clears = () => mockWebview.messages.filter((m) => m.type === 'agentToolPermissionClear');

    it('PostToolUse clears it once; the later tool_result sends nothing more', () => {
      const agent = createTestAgent({ id: 1 });
      agents.set(1, agent);
      handler.registerAgent('sess-1', 1);
      processTranscriptLine(1, toolUse('toolu_a'), agents, waitingTimers, permissionTimers);
      fire('PreToolUse', 'toolu_a');
      fire('PermissionRequest');
      expect(agent.permissionSent).toBe(true);
      fire('PostToolUse', 'toolu_a');
      processTranscriptLine(1, toolResult('toolu_a'), agents, waitingTimers, permissionTimers);
      expect(agent.permissionSent).toBe(false);
      expect(clears()).toHaveLength(1);
    });

    it('a tool_result clears it when no hook ends the call (an inline teammate)', () => {
      const agent = createTestAgent({ id: 1, hookDelivered: true, leadAgentId: 9 });
      agents.set(1, agent);
      processTranscriptLine(1, toolUse('toolu_a'), agents, waitingTimers, permissionTimers);
      agent.permissionSent = true;
      processTranscriptLine(1, toolResult('toolu_a'), agents, waitingTimers, permissionTimers);
      expect(agent.permissionSent).toBe(false);
      expect(clears()).toHaveLength(1);
    });

    it('stays while another parallel call (the one asking) is still open', () => {
      const agent = createTestAgent({ id: 1 });
      agents.set(1, agent);
      handler.registerAgent('sess-1', 1);
      fire('PreToolUse', 'toolu_a');
      fire('PreToolUse', 'toolu_b');
      fire('PermissionRequest');
      fire('PostToolUse', 'toolu_a');
      expect(agent.permissionSent).toBe(true);
      expect(clears()).toHaveLength(0);
      fire('PostToolUse', 'toolu_b');
      expect(agent.permissionSent).toBe(false);
      expect(clears()).toHaveLength(1);
    });

    it("stays when the poll reads an earlier call's result after the hooks moved on", () => {
      const agent = createTestAgent({ id: 1 });
      agents.set(1, agent);
      handler.registerAgent('sess-1', 1);
      fire('PreToolUse', 'toolu_a');
      fire('PostToolUse', 'toolu_a');
      fire('PreToolUse', 'toolu_b');
      fire('PermissionRequest');
      // The 500 ms poll catches up: A's lines come before B's tool_use in the file.
      processTranscriptLine(1, toolUse('toolu_a'), agents, waitingTimers, permissionTimers);
      processTranscriptLine(1, toolResult('toolu_a'), agents, waitingTimers, permissionTimers);
      expect(agent.permissionSent).toBe(true);
      expect(clears()).toHaveLength(0);
    });

    it("a call interrupted without PostToolUse does not hold the next turn's bubble", () => {
      const agent = createTestAgent({ id: 1 });
      agents.set(1, agent);
      handler.registerAgent('sess-1', 1);
      fire('PreToolUse', 'toolu_x'); // Esc: no PostToolUse, no Stop
      const prompt = line({ type: 'user', message: { content: 'try again' } });
      processTranscriptLine(1, prompt, agents, waitingTimers, permissionTimers);
      fire('PreToolUse', 'toolu_y');
      fire('PermissionRequest');
      fire('PostToolUse', 'toolu_y');
      expect(agent.permissionSent).toBe(false);
      expect(clears()).toHaveLength(1);
    });

    it('goes when the poll reads the prompt after the call already started', () => {
      const agent = createTestAgent({ id: 1 });
      agents.set(1, agent);
      handler.registerAgent('sess-1', 1);
      fire('PreToolUse', 'toolu_y'); // the hook runs ahead of the 500 ms poll
      const prompt = line({ type: 'user', message: { content: 'run the tests' } });
      processTranscriptLine(1, prompt, agents, waitingTimers, permissionTimers); // drops y too
      fire('PermissionRequest');
      fire('PostToolUse', 'toolu_y');
      expect(agent.permissionSent).toBe(false);
      expect(clears()).toHaveLength(1);
    });
  });

  // ── Pending external session confirmation ────────────────────

  it('confirmation event creates pending external session and delivers event', () => {
    const onExternalSessionDetected = vi.fn();
    handler.setLifecycleCallbacks({ onExternalSessionDetected });

    // SessionStart stores as pending
    handler.handleEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'ext-sess',
      source: 'startup',
      transcript_path: '/projects/test/ext-sess.jsonl',
      cwd: '/projects/test',
    });

    expect(onExternalSessionDetected).not.toHaveBeenCalled();

    // Simulate the provider creating the agent (callback side effect)
    onExternalSessionDetected.mockImplementation((sessionId: string) => {
      const agent = createTestAgent({
        id: 2,
        sessionId,
        projectDir: '/projects/test',
      } as Partial<AgentState>);
      agents.set(2, agent);
      handler.registerAgent(sessionId, 2);
    });

    // Stop confirms the session -> creates agent -> re-processes Stop
    handler.handleEvent('claude', {
      hook_event_name: 'Stop',
      session_id: 'ext-sess',
    });

    expect(onExternalSessionDetected).toHaveBeenCalledWith(
      'ext-sess',
      '/projects/test/ext-sess.jsonl',
      '/projects/test',
    );
    // Stop was re-processed after agent creation
    const agent = agents.get(2);
    expect(agent?.isWaiting).toBe(true);
  });

  // ── Resume ──────────────────────────────────────────────────

  it('SessionStart(source=resume) calls onSessionResume', () => {
    const onSessionResume = vi.fn();
    handler.setLifecycleCallbacks({ onSessionResume });

    handler.handleEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'resume-sess',
      source: 'resume',
      transcript_path: '/projects/test/resume-sess.jsonl',
      cwd: '/projects/test',
    });

    expect(onSessionResume).toHaveBeenCalledWith('/projects/test/resume-sess.jsonl');
  });

  it('SessionEnd(resume) + SessionStart(resume) reassigns agent within grace period', async () => {
    const agent = createTestAgent({
      id: 1,
      sessionId: 'old-sess',
      projectDir: '/projects/test',
    });
    agents.set(1, agent);
    handler.registerAgent('old-sess', 1);

    const onSessionClear = vi.fn();
    const onSessionEnd = vi.fn();
    handler.setLifecycleCallbacks({ onSessionClear, onSessionEnd });

    // SessionEnd(reason=resume) sets pendingClear, starts grace timer
    handler.handleEvent('claude', {
      hook_event_name: 'SessionEnd',
      session_id: 'old-sess',
      reason: 'resume',
    });
    expect(agent.pendingClear).toBe(true);

    // SessionStart(source=resume) arrives within grace period -> reassigns
    handler.handleEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'new-resume-sess',
      source: 'resume',
      transcript_path: '/projects/test/new-resume-sess.jsonl',
      cwd: '/projects/test',
    });
    expect(agent.pendingClear).toBe(false);
    expect(onSessionClear).toHaveBeenCalledWith(
      1,
      'new-resume-sess',
      '/projects/test/new-resume-sess.jsonl',
      true,
    );

    // Grace timer fires but pendingClear is already false -> no-op
    await new Promise((r) => setTimeout(r, 2500));
    expect(onSessionEnd).not.toHaveBeenCalled();
  });

  it('SessionStart(source=resume) reassigns agent with pendingClear, not other agents in same projectDir', () => {
    const onSessionClear = vi.fn();
    handler.setLifecycleCallbacks({ onSessionClear });

    // Agent 1: the one that did /resume (has pendingClear from SessionEnd)
    const resumingAgent = createTestAgent({
      id: 1,
      sessionId: 'old-sess-1',
      projectDir: '/projects/test',
      pendingClear: true,
    });
    agents.set(1, resumingAgent);
    handler.registerAgent('old-sess-1', 1);

    // Agent 2: external agent in same projectDir (no pendingClear)
    const externalAgent = createTestAgent({
      id: 2,
      sessionId: 'ext-sess-2',
      projectDir: '/projects/test',
      pendingClear: false,
    });
    agents.set(2, externalAgent);
    handler.registerAgent('ext-sess-2', 2);

    // SessionStart(source=resume) should reassign Agent 1 (pendingClear), NOT Agent 2
    handler.handleEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'new-resume-sess',
      source: 'resume',
      transcript_path: '/projects/test/new-resume-sess.jsonl',
      cwd: '/projects/test',
    });

    expect(onSessionClear).toHaveBeenCalledWith(
      1,
      'new-resume-sess',
      '/projects/test/new-resume-sess.jsonl',
      true,
    );
    expect(resumingAgent.pendingClear).toBe(false);
    // Agent 2 should be untouched
    expect(externalAgent.pendingClear).toBe(false);
    expect(externalAgent.sessionId).toBe('ext-sess-2');
  });

  // ── Provider-agnostic (optional transcript_path) ────────────

  it('SessionStart stores pending with cwd only (no transcript_path)', () => {
    const onExternalSessionDetected = vi.fn();
    handler.setLifecycleCallbacks({ onExternalSessionDetected });

    handler.handleEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'no-transcript-sess',
      source: 'startup',
      cwd: '/projects/test',
    });

    // Pending, no agent yet
    expect(onExternalSessionDetected).not.toHaveBeenCalled();

    // Simulate agent creation on confirmation
    onExternalSessionDetected.mockImplementation((sessionId: string) => {
      const agent = createTestAgent({
        id: 2,
        sessionId,
        projectDir: '/projects/test',
      } as Partial<AgentState>);
      agents.set(2, agent);
      handler.registerAgent(sessionId, 2);
    });

    // Confirmation event creates agent
    handler.handleEvent('claude', {
      hook_event_name: 'Stop',
      session_id: 'no-transcript-sess',
    });

    expect(onExternalSessionDetected).toHaveBeenCalledWith(
      'no-transcript-sess',
      undefined,
      '/projects/test',
    );
  });

  it('SessionStart(source=resume) uses cwd for matching when no transcript_path', () => {
    const onSessionClear = vi.fn();
    handler.setLifecycleCallbacks({ onSessionClear });

    const agent = createTestAgent({
      id: 1,
      sessionId: 'old-sess',
      projectDir: '/projects/test',
      pendingClear: true,
    });
    agents.set(1, agent);
    handler.registerAgent('old-sess', 1);

    handler.handleEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'resumed-sess',
      source: 'resume',
      cwd: '/projects/test',
    });

    expect(onSessionClear).toHaveBeenCalledWith(1, 'resumed-sess', undefined, true);
    expect(agent.pendingClear).toBe(false);
  });

  it('SessionStart(source=resume) without transcript_path does not call onSessionResume', () => {
    const onSessionResume = vi.fn();
    handler.setLifecycleCallbacks({ onSessionResume });

    handler.handleEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: 'resume-no-path',
      source: 'resume',
      cwd: '/projects/test',
    });

    // onSessionResume requires transcript_path to clear dismissals
    expect(onSessionResume).not.toHaveBeenCalled();
  });

  // ── Basic subagent regression (Agent Teams feature OFF) ─────────────
  // These tests pin down the behavior that must NOT change for basic subagents.
  // Basic subagents use Agent or Task tool WITHOUT run_in_background=true.

  // PreToolUse(Agent) sets currentHookIsTeammateSpawn iff run_in_background === true.
  describe.each([
    { label: 'run_in_background=true', toolInput: { run_in_background: true }, expected: true },
    { label: 'run_in_background=false', toolInput: { run_in_background: false }, expected: false },
  ])('PreToolUse(Agent, $label)', ({ toolInput, expected }) => {
    it(`sets currentHookIsTeammateSpawn=${expected}`, () => {
      const agent = createTestAgent({ id: 1 });
      agents.set(1, agent);
      handler.registerAgent('sess-1', 1);

      handler.handleEvent('claude', {
        hook_event_name: 'PreToolUse',
        session_id: 'sess-1',
        tool_name: 'Agent',
        tool_input: { description: 'Code review', ...toolInput },
      });

      expect(agent.currentHookIsTeammateSpawn).toBe(expected);
    });
  });

  // SubagentStart routes to teammate discovery ONLY when both conditions hold:
  // currentHookIsTeammateSpawn === true AND agent.teamName is set (JSONL-confirmed lead).
  // Basic subagents (no spawn flag) or the external-session false-positive case
  // (spawn flag set but no teamName) fall through to the basic subagent path.
  describe.each([
    {
      label: 'teammate (spawn flag + teamName)',
      spawn: true,
      teamName: 'research',
      seedActiveTool: false,
      expectTeammateDetected: true,
    },
    {
      label: 'false-positive guard (spawn flag, no teamName)',
      spawn: true,
      teamName: undefined,
      seedActiveTool: true,
      expectTeammateDetected: false,
    },
    {
      label: 'basic subagent from hook before JSONL (no activeToolNames parent)',
      spawn: false,
      teamName: undefined,
      seedActiveTool: false,
      expectTeammateDetected: false,
    },
  ])('SubagentStart: $label', ({ spawn, teamName, seedActiveTool, expectTeammateDetected }) => {
    it(`onTeammateDetected called=${expectTeammateDetected}`, () => {
      const agent = createTestAgent({
        id: 1,
        currentHookIsTeammateSpawn: spawn,
        ...(teamName ? { teamName } : {}),
      });
      if (seedActiveTool) {
        agent.activeToolNames.set('toolu_real', 'Agent');
      } else if (!spawn) {
        agent.hookToolIds = ['hook-XXX'];
        agent.currentHookToolName = 'Agent';
      }
      agents.set(1, agent);
      handler.registerAgent('sess-1', 1);

      const onTeammateDetected = vi.fn();
      handler.setLifecycleCallbacks({ onTeammateDetected });

      handler.handleEvent('claude', {
        hook_event_name: 'SubagentStart',
        session_id: 'sess-1',
        agent_type: expectTeammateDetected ? 'web-researcher' : 'general-purpose',
      });

      if (expectTeammateDetected) {
        expect(onTeammateDetected).toHaveBeenCalledWith(1, 'sess-1', 'web-researcher');
        // Teammate path skips subagentToolStart (no ghost sub-agent character).
        expect(mockWebview.messages.find((m) => m.type === 'subagentToolStart')).toBeUndefined();
      } else {
        expect(onTeammateDetected).not.toHaveBeenCalled();
        const msg = mockWebview.messages.find((m) => m.type === 'subagentToolStart');
        if (seedActiveTool) {
          // Basic path with real tool id available.
          expect(msg).toBeTruthy();
          expect(msg?.parentToolId).toBe('toolu_real');
        } else {
          // No real tool id yet -- JSONL will create the sub-agent character.
          expect(msg).toBeUndefined();
        }
      }
    });
  });
});
