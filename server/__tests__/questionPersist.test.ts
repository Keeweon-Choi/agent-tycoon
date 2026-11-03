import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resendAgentActivity } from '../src/agentActivityResend.js';
import { AgentRuntime } from '../src/agentRuntime.js';
import { createAgentState } from '../src/agentState.js';
import { AgentStateStore } from '../src/agentStateStore.js';
import { CharacterBinder } from '../src/cld/characters.js';
import { HookEventHandler } from '../src/hookEventHandler.js';
import { claudeProvider } from '../src/providers/hook/claude/claude.js';
import { answeredSince, endsWithQuestion, useQuestionStore } from '../src/question.js';
import { SessionRouter } from '../src/sessionRouter.js';
import { processTranscriptLine } from '../src/transcriptParser.js';

const line = (record: object) => JSON.stringify(record) + '\n';
const said = (text: string) => line({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const turnEnd = line({ type: 'system', subtype: 'turn_duration', durationMs: 900 });

describe('a question is a turn that ends asking', () => {
  it("'?' or '？' once trailing space, markdown, quotes and brackets are gone", () => {
    for (const t of ['A or B?', 'A or B？', '**A or B?**  \n', 'Run `npm test`?', '"Ship it?")', '어느 쪽으로 할까요?_'])
      expect(endsWithQuestion(t), t).toBe(true);
    for (const t of ['Done.', 'Is it? No.', '', undefined, 'what?!'])
      expect(endsWithQuestion(t), String(t)).toBe(false);
    // Code is no question: inline code, a closing fence, or a text that stops inside a fence.
    for (const t of ['Check `isReady?`', 'Run:\n```ts\nif (ok?) go()\nready?\n```', 'Run:\n```\nready?'])
      expect(endsWithQuestion(t), t).toBe(false);
  });
});

describe('WAITING-PERSIST: the question state, its store and a restart', () => {
  let dir: string;
  let jsonl: string;
  let store: AgentStateStore;
  let sent: Array<Record<string, unknown>>;
  const runtimes: AgentRuntime[] = [];
  const saved = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, 'questions.json'), 'utf8')) as Record<string, number>;
    } catch {
      return {};
    }
  };

  beforeEach(() => {
    vi.useFakeTimers();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-question-'));
    jsonl = path.join(dir, 'sess-q.jsonl');
    fs.writeFileSync(jsonl, '');
    useQuestionStore(path.join(dir, 'questions.json'));
    store = new AgentStateStore();
    sent = [];
    store.on('broadcast', (m) => sent.push(m));
    store.set(1, createAgentState({ id: 1, sessionId: 'sess-q', isExternal: false, projectDir: dir, jsonlFile: jsonl }));
  });
  afterEach(() => {
    for (const r of runtimes.splice(0)) r.dispose();
    vi.useRealTimers();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** The transcript as our PTY agents give it (no hooks): records, read as the watcher does. */
  const write = (text: string) => {
    fs.appendFileSync(jsonl, text);
    for (const l of text.split('\n').filter(Boolean)) processTranscriptLine(1, l, store, new Map(), new Map());
  };
  const hooks = () => {
    const h = new HookEventHandler(store, new Map(), new Map(), claudeProvider, new SessionRouter());
    h.registerAgent('sess-q', 1);
    return h;
  };
  const idlePrompt = () => hooks().handleEvent('claude', { hook_event_name: 'Notification', session_id: 'sess-q', notification_type: 'idle_prompt' });

  it('a turn ending with a statement, then idle_prompt: no question, nothing saved', () => {
    write(line({ type: 'user', message: { content: 'fix it' } }) + said('Fixed the totals.') + turnEnd);
    idlePrompt();
    expect(store.get(1)!.questionOffset).toBeUndefined();
    expect(saved()).toEqual({});
    expect(sent.filter((m) => m.question)).toEqual([]);
    // idle_prompt keeps its own meaning (the "Waiting for input" label), untouched.
    expect(sent.at(-1)).toMatchObject({ type: 'agentStatus', status: 'waiting', awaitingInput: true });
  });

  it('a turn ending with "?": question, saved, survives idle_prompt, resent; cleared by the answer', () => {
    write(line({ type: 'user', message: { content: 'pay page' } }) + said('Card first, or bank transfer first?') + turnEnd);
    const agent = store.get(1)!;
    expect(agent.questionOffset).toBe(fs.statSync(jsonl).size);
    expect(saved()).toEqual({ [jsonl]: agent.questionOffset });
    expect(sent.at(-1)).toMatchObject({ type: 'agentStatus', status: 'waiting', question: true });
    idlePrompt();
    expect(agent.questionOffset).toBeDefined();
    expect(sent.at(-1)).toMatchObject({ awaitingInput: true, question: true });
    const replay: Array<Record<string, unknown>> = [];
    resendAgentActivity((m) => replay.push(m), store);
    expect(replay).toContainEqual({ type: 'agentStatus', id: 1, status: 'waiting', question: true });

    write(line({ type: 'user', message: { content: 'card first' } }));
    expect(agent.questionOffset).toBeUndefined();
    expect(saved()).toEqual({});
  });

  it('a text-only turn (no turn_duration) asks through the text-idle timer', () => {
    write(line({ type: 'user', message: { content: 'hi' } }) + said('Which branch?'));
    vi.runOnlyPendingTimers();
    expect(store.get(1)!.questionOffset).toBeDefined();
    expect(sent.at(-1)).toMatchObject({ type: 'agentStatus', status: 'waiting', question: true });
  });

  it('a Stop that arrives before the poll read the last text still sees the question', () => {
    const agent = store.get(1)!;
    agent.hookDelivered = true; // hooks: no text-idle timer, and a text-only turn has no turn_duration
    fs.appendFileSync(jsonl, line({ type: 'user', message: { content: 'go' } }) + said('Which branch?'));
    expect(agent.fileOffset).toBe(0); // the 500 ms poll has not run
    hooks().handleEvent('claude', { hook_event_name: 'Stop', session_id: 'sess-q' });
    expect(agent.questionOffset).toBe(fs.statSync(jsonl).size);
    expect(sent.filter((m) => m.type === 'agentStatus' && m.question)).toHaveLength(1);
  });

  it("a teammate's or a sub-agent's question to its Lead is not the person's", () => {
    for (const over of [{ leadAgentId: 9 }, { agentName: 'researcher' }, { spawnToolUseId: 'tu-1' }]) {
      Object.assign(store.get(1)!, { leadAgentId: undefined, agentName: undefined, spawnToolUseId: undefined }, over);
      write(line({ type: 'user', message: { content: 'go' } }) + said('Lead, which file?') + turnEnd);
      expect(store.get(1)!.questionOffset, JSON.stringify(over)).toBeUndefined();
    }
    expect(saved()).toEqual({});
  });

  it('a Stop hook decides from the same text', () => {
    store.get(1)!.lastAssistantText = 'Merge now?';
    hooks().handleEvent('claude', { hook_event_name: 'Stop', session_id: 'sess-q' });
    expect(store.get(1)!.questionOffset).toBeDefined();
    store.get(1)!.lastAssistantText = 'Merged.';
    hooks().handleEvent('claude', { hook_event_name: 'Stop', session_id: 'sess-q' });
    expect(store.get(1)!.questionOffset).toBeUndefined();
  });

  /** A new daemon on the same office folder: the office's character binds the transcript again. */
  function restart(): AgentStateStore {
    return restartWatching([]);
  }
  function restartWatching(out: Array<Record<string, unknown>>): AgentStateStore {
    useQuestionStore(path.join(dir, 'questions.json')); // what cli.ts does at start
    const next = new AgentStateStore();
    next.on('broadcast', (m) => out.push(m));
    const runtime = new AgentRuntime(next, claudeProvider);
    runtimes.push(runtime);
    new CharacterBinder(runtime, next).reconcile([{ key: 'engine:shop', label: 'shop', transcript: jsonl }]);
    return next;
  }

  it('restored after a restart, with nothing sent to the agent: only a silent status to the browsers', () => {
    write(said('Card or transfer?') + turnEnd);
    // No PTY or engine write (the PTY host and the engine's control socket are sockets).
    const socketWrite = vi.spyOn(net.Socket.prototype, 'write');
    const out: Array<Record<string, unknown>> = [];
    const next = restartWatching(out);
    const agent = [...next.values()][0];
    expect(agent).toMatchObject({ isWaiting: true, questionOffset: fs.statSync(jsonl).size });
    expect(socketWrite).not.toHaveBeenCalled();
    // The one message: shown in browsers already connected, marked restored, so no push or notice
    // (push.test.ts: a restored status is never pushed).
    expect(out).toEqual([{ type: 'agentStatus', id: agent.id, status: 'waiting', question: true, restored: true }]);
    socketWrite.mockRestore();
    const replay: Array<Record<string, unknown>> = [];
    resendAgentActivity((m) => replay.push(m), next);
    expect(replay).toContainEqual({ type: 'agentStatus', id: agent.id, status: 'waiting', question: true });
  });

  it('answered while the daemon was down: not restored, and dropped from the store', () => {
    write(said('Card or transfer?') + turnEnd);
    fs.appendFileSync(jsonl, line({ type: 'user', message: { content: 'card' } }));
    const agent = [...restart().values()][0];
    expect(agent.questionOffset).toBeUndefined();
    expect(saved()).toEqual({});
  });
});

describe('answeredSince', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-answered-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('only a user or assistant record after the offset counts; a shrunk or missing file does too', () => {
    const file = path.join(dir, 't.jsonl');
    fs.writeFileSync(file, said('A or B?') + turnEnd);
    const at = fs.statSync(file).size;
    expect(answeredSince(file, at)).toBe(false);
    fs.appendFileSync(file, line({ type: 'file-history-snapshot' }) + '{"half');
    expect(answeredSince(file, at)).toBe(false);
    fs.appendFileSync(file, '\n' + line({ type: 'assistant', message: { content: [] } }));
    expect(answeredSince(file, at)).toBe(true);
    expect(answeredSince(file, at * 100)).toBe(true);
    expect(answeredSince(path.join(dir, 'gone.jsonl'), 0)).toBe(true);
  });
});
