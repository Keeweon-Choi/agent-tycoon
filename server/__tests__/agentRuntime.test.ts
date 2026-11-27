import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { AgentRuntime } from '../src/agentRuntime.js';
import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { useQuestionStore } from '../src/question.js';

/**
 * D5 gate (tier-3 multi-server hook fan-out plan): the hook script now
 * broadcasts every event to every live server (server/src/providers/hook/
 * claude/hooks/claude-hook.ts), so a server must never adopt a session it
 * doesn't own just because it received the event. HookEventHandler's own
 * isTrackedSession only gates debug logging (hookEventHandler.ts:173-174);
 * the actual gate is one hop downstream, in AgentRuntime's
 * onExternalSessionDetected callback (agentRuntime.ts:96-101), which drops
 * the session unless its project dir was scanned by this instance
 * (isTrackedProjectDir) or watchAllSessions is on. These tests exercise
 * that real callback end-to-end via handleHookEvent, not a mock.
 */
describe('AgentRuntime -- D5 foreign-session gate', () => {
  let runtime: AgentRuntime;
  let store: AgentStateStore;

  afterEach(() => {
    // Clears the project-scan interval and any polling timer from adoption.
    runtime?.dispose();
  });

  /** A directory guaranteed untracked by any other test in this file or
   *  process (isTrackedProjectDir's backing Set is module-level and only
   *  ever grows -- see fileWatcher.ts -- so uniqueness is what keeps tests
   *  from leaking into each other). */
  function untrackedDir(): string {
    return path.join(os.tmpdir(), `pxl-d5-test-${crypto.randomUUID()}`);
  }

  function fireSessionStartThenStop(sessionId: string, cwd: string): void {
    runtime.handleHookEvent('claude', {
      hook_event_name: 'SessionStart',
      session_id: sessionId,
      source: 'startup',
      cwd,
    });
    runtime.handleHookEvent('claude', {
      hook_event_name: 'Stop',
      session_id: sessionId,
    });
  }

  it('drops a foreign session (unowned dir, watchAllSessions off): no agent created', () => {
    store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider);
    // watchAllSessions defaults to false; this dir was never scanned/owned
    // by this instance -- exactly the "other server's session" scenario
    // fan-out introduces.
    fireSessionStartThenStop('d5-foreign-off', untrackedDir());
    expect(store.size).toBe(0);
  });

  it('adopts a foreign session when watchAllSessions is on', () => {
    store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider);
    runtime.watchAllSessions.current = true;
    fireSessionStartThenStop('d5-foreign-on', untrackedDir());
    expect(store.size).toBe(1);
  });

  it('adopts a session under a project dir this instance has scanned, even with watchAllSessions off', () => {
    store = new AgentStateStore();
    runtime = new AgentRuntime(store, claudeProvider);
    const dir = untrackedDir();
    runtime.startProjectScan(dir); // marks `dir` as owned/tracked
    fireSessionStartThenStop('d5-tracked-dir', dir);
    expect(store.size).toBe(1);
  });
});

/**
 * B4.1: /resume hands the agent a transcript that already holds the whole
 * conversation. Replaying it from byte 0 re-sent every old turn live: old
 * questions came back as `question: true` (bubble, sound, push).
 */
describe('AgentRuntime -- /resume follows the resumed transcript from its end', () => {
  it('does not replay the resumed history as live turns', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agty-resume-'));
    const line = (r: object) => JSON.stringify(r) + '\n';
    const asked = (text: string) =>
      line({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) +
      line({ type: 'system', subtype: 'turn_duration', durationMs: 900 });
    const old = path.join(dir, 'sess-old.jsonl');
    const resumed = path.join(dir, 'sess-new.jsonl');
    fs.writeFileSync(old, '');
    fs.writeFileSync(resumed, asked('Shall I run the tests?') + asked('Merge it now?'));
    const store = new AgentStateStore();
    const runtime = new AgentRuntime(store, claudeProvider);
    const sent: Array<Record<string, unknown>> = [];
    store.on('broadcast', (m) => sent.push(m));
    store.set(
      1,
      createAgentState({
        id: 1,
        sessionId: 'sess-old',
        isExternal: false,
        projectDir: dir,
        jsonlFile: old,
      }),
    );
    store.get(1)!.hookDelivered = true;
    runtime.registerAgent('sess-old', 1);
    try {
      runtime.handleHookEvent('claude', {
        hook_event_name: 'SessionEnd',
        session_id: 'sess-old',
        reason: 'resume',
      });
      runtime.handleHookEvent('claude', {
        hook_event_name: 'SessionStart',
        session_id: 'sess-new',
        source: 'resume',
        transcript_path: resumed,
      });
      const agent = store.get(1)!;
      expect(agent.jsonlFile).toBe(resumed);
      expect(agent.fileOffset).toBe(fs.statSync(resumed).size);
      expect(sent.filter((m) => m.type === 'agentStatus' && m.question === true)).toEqual([]);
      // No waiting on /resume is a turn end: each carries restored (push.ts raises no notice).
      const waits = sent.filter((m) => m.type === 'agentStatus' && m.status === 'waiting');
      expect(waits.length).toBeGreaterThan(0);
      expect(waits.filter((m) => m.restored !== true)).toEqual([]);
      // Claude sits at the prompt after /resume: the character waits, for a later browser too.
      // ...shown, but no turn ran: restored, so no notice, sound or push.
      expect(sent.filter((m) => m.type === 'agentStatus').at(-1)).toEqual({
        type: 'agentStatus',
        id: 1,
        status: 'waiting',
        restored: true,
      });
      expect(agent.isWaiting).toBe(true);
    } finally {
      runtime.dispose();
    }
  });

  it("brings back the resumed session's open question, as a fresh bind does", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agty-resume-q-'));
    const line = (r: object) => JSON.stringify(r) + '\n';
    const old = path.join(dir, 'sess-old.jsonl');
    const resumed = path.join(dir, 'sess-q.jsonl');
    fs.writeFileSync(old, '');
    fs.writeFileSync(
      resumed,
      line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Merge it now?' }] } }) +
        line({ type: 'system', subtype: 'turn_duration', durationMs: 900 }),
    );
    // The question was saved when that session's turn ended (questions.json, WAITING-PERSIST).
    const questions = path.join(dir, 'questions.json');
    fs.writeFileSync(questions, JSON.stringify({ [resumed]: fs.statSync(resumed).size }));
    useQuestionStore(questions);
    const store = new AgentStateStore();
    const runtime = new AgentRuntime(store, claudeProvider);
    const sent: Array<Record<string, unknown>> = [];
    store.on('broadcast', (m) => sent.push(m));
    store.set(
      1,
      createAgentState({
        id: 1,
        sessionId: 'sess-old',
        isExternal: false,
        projectDir: dir,
        jsonlFile: old,
      }),
    );
    store.get(1)!.hookDelivered = true;
    runtime.registerAgent('sess-old', 1);
    try {
      runtime.handleHookEvent('claude', {
        hook_event_name: 'SessionEnd',
        session_id: 'sess-old',
        reason: 'resume',
      });
      runtime.handleHookEvent('claude', {
        hook_event_name: 'SessionStart',
        session_id: 'sess-q',
        source: 'resume',
        transcript_path: resumed,
      });
      expect(store.get(1)!.questionOffset).toBe(fs.statSync(resumed).size);
      expect(
        sent.filter((m) => m.type === 'agentStatus' && m.status === 'waiting' && m.restored !== true),
      ).toEqual([]);
      expect(sent.filter((m) => m.type === 'agentStatus').at(-1)).toEqual({
        type: 'agentStatus',
        id: 1,
        status: 'waiting',
        question: true,
        restored: true,
      });
    } finally {
      runtime.dispose();
      useQuestionStore(path.join(dir, 'unused.json'));
    }
  });
});
