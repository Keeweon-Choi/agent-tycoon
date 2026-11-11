import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { createAgentState } from '../../agentState.js';
import { BACKGROUND_WAITING_MAX_MS } from '../../constants.js';
import { liveBackgroundAgents, renewSubagents } from './backgroundAgents.js';

const launched = (id: string) =>
  JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: 'Async agent launched successfully.\nagentId: x' }] }] },
  });
const done = (id: string) =>
  JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: `<task-notification><tool-use-id>${id}</tool-use-id></task-notification>` });
const foreground = (id: string) =>
  JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'the answer' }] } });

describe('K1 (G6): background sub-agents a transcript says still run', () => {
  it('a launch without its completion runs; a completed one and a foreground one do not', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agty-bg-')), 's.jsonl');
    fs.writeFileSync(file, [launched('t1'), launched('t2'), foreground('t3'), 'not json', done('t1')].join('\n') + '\n');
    expect(liveBackgroundAgents(file)).toEqual(['t2']);
    expect(liveBackgroundAgents(file, 60)).toEqual([]); // only the end is read: t2's launch is before it
    expect(liveBackgroundAgents(path.join(path.dirname(file), 'none.jsonl'))).toEqual([]);
  });

  describe('pairing by task id (stopped and resumed sub-agents)', () => {
    const A = 'aabc435fbf8d56978';
    const B = 'b1111111111111111';
    const spawn = (toolId: string, taskId: string) =>
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolId,
              content: [
                {
                  type: 'text',
                  text: `Async agent launched successfully. (This tool result is internal metadata)\nagentId: ${taskId} (internal ID - do not mention to user. Use SendMessage with to: '${taskId}' to continue this agent.)\nThe agent is working in the background.`,
                },
              ],
            },
          ],
        },
      });
    const notice = (taskId: string, status: string, toolId?: string, summary = 'x') =>
      JSON.stringify({
        type: 'queue-operation',
        operation: 'enqueue',
        timestamp: '2026-11-11T00:00:00Z',
        sessionId: 's',
        content: `<task-notification>\n<task-id>${taskId}</task-id>\n${toolId ? `<tool-use-id>${toolId}</tool-use-id>\n` : ''}<output-file>/tmp/x</output-file>\n<status>${status}</status>\n<summary>${summary}</summary>\n</task-notification>`,
      });
    // The harness's real summaries (its English text; the agent's description is quoted).
    const waiting = (taskId: string, toolId?: string) =>
      notice(taskId, 'completed', toolId, 'Agent "fix: the error boundary" is waiting on its own background work');
    const finished = (taskId: string, toolId?: string) =>
      notice(taskId, 'completed', toolId, 'Agent "fix: the error boundary" finished');
    const resume = (toolId: string, taskId: string) =>
      JSON.stringify({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: toolId,
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({ success: true, message: 'Resuming agent', resumedAgentId: taskId, pin: { id: taskId } }),
                },
              ],
            },
          ],
        },
      });
    const live = (...lines: string[]) => {
      const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agty-bg-')), 's.jsonl');
      fs.writeFileSync(file, lines.join('\n') + '\n');
      return liveBackgroundAgents(file);
    };

    it('a stopped notice (task id only) ends the spawn', () => {
      expect(live(spawn('SPAWN', A), notice(A, 'stopped'))).toEqual([]);
    });
    it('a resume after a stop makes it live again', () => {
      expect(live(spawn('SPAWN', A), notice(A, 'stopped'))).toEqual([]); // the stop did end it
      expect(live(spawn('SPAWN', A), notice(A, 'stopped'), resume('SENDMSG', A))).toEqual(['SPAWN']);
    });
    it('launch, stop, resume, then the resumed run completes under the SendMessage id: not live', () => {
      expect(live(spawn('SPAWN', A), notice(A, 'stopped'), resume('SENDMSG', A), notice(A, 'completed', 'SENDMSG'))).toEqual([]);
    });
    it('completed by its own id, resumed: live; completed by the SendMessage id: not live', () => {
      const head = [spawn('SPAWN', A), notice(A, 'completed', 'SPAWN'), resume('SENDMSG', A)];
      expect(live(...head)).toEqual(['SPAWN']);
      expect(live(...head, notice(A, 'completed', 'SENDMSG'))).toEqual([]);
    });
    it('two interleaved agents: only the one still running is returned', () => {
      expect(
        live(spawn('S1', A), spawn('S2', B), notice(A, 'stopped'), resume('M1', A), notice(B, 'completed', 'S2'), notice(A, 'completed', 'M1'), resume('M2', B)),
      ).toEqual(['S2']);
      expect(live(spawn('S1', A), spawn('S2', B), notice(A, 'stopped'), resume('M1', A), notice(B, 'completed', 'S2'))).toEqual(['S1']);
    });
    it('a resume whose launch is outside the window runs under the SendMessage id until its end', () => {
      expect(live(resume('SENDMSG', A))).toEqual(['SENDMSG']);
      expect(live(resume('SENDMSG', A), notice(A, 'completed', 'SENDMSG'))).toEqual([]);
      expect(live(resume('SENDMSG', A), waiting(A, 'SENDMSG'))).toEqual(['SENDMSG']);
      expect(live(resume('SENDMSG', A), waiting(A, 'SENDMSG'), finished(A))).toEqual([]);
      expect(live(resume('SENDMSG', A), notice(A, 'stopped'))).toEqual([]);
    });

    describe('a sub-agent waiting on its own background work still runs', () => {
      it('waiting under its own id: still running; the later finished notice without an id ends it', () => {
        expect(live(spawn('SPAWN', A), waiting(A, 'SPAWN'))).toEqual(['SPAWN']);
        expect(live(spawn('SPAWN', A), waiting(A, 'SPAWN'), waiting(A))).toEqual(['SPAWN']);
        expect(live(spawn('SPAWN', A), waiting(A, 'SPAWN'), waiting(A), finished(A))).toEqual([]);
      });
      it('waiting, then stopped or killed: ended', () => {
        expect(live(spawn('SPAWN', A), waiting(A, 'SPAWN'), notice(A, 'stopped'))).toEqual([]);
        expect(live(spawn('SPAWN', A), waiting(A), notice(A, 'killed', 'SPAWN'))).toEqual([]);
      });
      it('a killed notice ends it', () => {
        expect(live(spawn('SPAWN', A), notice(A, 'killed', 'SPAWN'))).toEqual([]);
      });
      it('resumed, then waiting under the SendMessage id, then finished: running until the finish', () => {
        const head = [spawn('SPAWN', A), finished(A, 'SPAWN'), resume('SENDMSG', A), waiting(A, 'SENDMSG')];
        expect(live(...head)).toEqual(['SPAWN']);
        expect(live(...head, finished(A))).toEqual([]);
        expect(live(...head, finished(A, 'SENDMSG'))).toEqual([]);
      });
      it('only the literal waiting summary keeps it: an agent named after it still ends', () => {
        const named = notice(A, 'completed', 'SPAWN', 'Agent "is waiting on its own background work" finished');
        expect(live(spawn('SPAWN', A), named)).toEqual([]);
      });
    });

    it("a notice's result quoting another live spawn's tool use id ends only its own spawn", () => {
      const quoting = JSON.stringify({
        type: 'queue-operation',
        operation: 'enqueue',
        content: `<task-notification>\n<task-id>${A}</task-id>\n<output-file>/tmp/x</output-file>\n<status>completed</status>\n<summary>Agent "x" finished</summary>\n<result>the other one is <tool-use-id>S2</tool-use-id> <task-id>${B}</task-id> <summary>Agent "y" finished</summary></result>\n</task-notification>`,
      });
      expect(live(spawn('S1', A), spawn('S2', B), quoting)).toEqual(['S2']);
    });
    it("a shell task's notice changes nothing", () => {
      const shell = (taskId: string, toolId: string) =>
        JSON.stringify({
          type: 'queue-operation',
          operation: 'enqueue',
          content: `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolId}</tool-use-id>\n<output-file>/tmp/x/${taskId}.output</output-file>\n<status>completed</status>\n<summary>Background command "npm test" completed (exit code 0)</summary>\n</task-notification>`,
        });
      expect(live(spawn('SPAWN', A), shell('b9yjffopj', 'toolu_bash'))).toEqual(['SPAWN']);
      expect(live(spawn('SPAWN', A), waiting(A, 'SPAWN'), shell('b9yjffopj', 'toolu_bash'))).toEqual(['SPAWN']);
    });
    it('a diagnostic tool output quoting a launch and a resume neither adds nor revives anything', () => {
      const quoted = JSON.stringify({ success: true, resumedAgentId: A });
      const bash = (id: string) =>
        JSON.stringify({
          type: 'user',
          message: {
            content: [
              {
                type: 'tool_result',
                tool_use_id: id,
                content: [{ type: 'text', text: `grep hit: Async agent launched successfully.\nagentId: ${B} (x)\nand ${quoted} and "resumedAgentId":"${A}","success":true` }],
              },
            ],
          },
        });
      expect(live(bash('BASH'))).toEqual([]);
      expect(live(spawn('S1', A), notice(A, 'stopped'), bash('BASH'))).toEqual([]);
      expect(live(spawn('S1', A), notice(B, 'stopped'), bash('BASH'))).toEqual(['S1']);
    });
    it('a queued user message mentioning a task id (no task-notification) does not end the spawn', () => {
      const typed = JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: `please look at <task-id>${A}</task-id>` });
      expect(live(spawn('S1', A), typed)).toEqual(['S1']);
    });
    it('a launch result with a plain string content and no agentId line still counts', () => {
      const bare = JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'BARE', content: 'Async agent launched successfully.' }] },
      });
      expect(live(bare)).toEqual(['BARE']);
    });
  });
});

describe('K1 (G6): the sub-agents a renew waits for', () => {
  const NOW = 1_800_000_000_000;
  const MIN = 60_000;
  function lead(...sidecars: Array<{ task: string; id?: string; finished?: boolean; quietMs?: number; description?: string }>) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agty-renew-subs-'));
    const entries = sidecars.map((s) => {
      const jsonlPath = path.join(dir, `agent-${s.task}.jsonl`);
      fs.writeFileSync(jsonlPath, '{}\n');
      const at = (NOW - (s.quietMs ?? 0)) / 1000;
      fs.utimesSync(jsonlPath, at, at);
      return { jsonlPath, toolUseId: s.id, description: s.description, finished: s.finished };
    });
    const a = createAgentState({ id: 1, sessionId: 's', isExternal: false, jsonlFile: path.join(dir, 's.jsonl'), projectDir: dir });
    return { a, entries };
  }
  const ids = (r: Array<{ id: string }>) => r.map((s) => s.id);

  it('a running agent (sidecar not finished) is counted, however long its transcript has been quiet', () => {
    const { a, entries } = lead({ task: 'a1', id: 'S1', quietMs: 5 * BACKGROUND_WAITING_MAX_MS, description: 'build' });
    a.backgroundAgentToolIds.add('S1');
    expect(renewSubagents(a, entries, NOW)).toEqual([{ id: 'S1', description: 'build' }]);
  });
  it('a fresh wait (finished, written within the bound) is counted', () => {
    const { a, entries } = lead({ task: 'a1', id: 'S1', finished: true, quietMs: BACKGROUND_WAITING_MAX_MS - MIN });
    a.backgroundAgentToolIds.add('S1');
    expect(ids(renewSubagents(a, entries, NOW))).toEqual(['S1']);
  });
  it('a finished agent quiet for the bound is not counted; the live set keeps it', () => {
    const { a, entries } = lead({ task: 'a1', id: 'S1', finished: true, quietMs: BACKGROUND_WAITING_MAX_MS + MIN });
    a.backgroundAgentToolIds.add('S1');
    expect(renewSubagents(a, entries, NOW)).toEqual([]);
    expect([...a.backgroundAgentToolIds]).toEqual(['S1']);
  });
  it('an id with no sidecar is counted (unknown = running)', () => {
    const { a, entries } = lead({ task: 'a1', id: 'S1', finished: true, quietMs: 2 * BACKGROUND_WAITING_MAX_MS });
    a.backgroundAgentToolIds.add('S1').add('NOSIDECAR');
    expect(renewSubagents(a, entries, NOW)).toEqual([{ id: 'NOSIDECAR', description: undefined }]);
  });
  it('a SendMessage id finds its sidecar through the task it pairs with', () => {
    const { a, entries } = lead({ task: 'a1', id: 'S1', finished: true, quietMs: 2 * BACKGROUND_WAITING_MAX_MS });
    a.backgroundAgentToolIds.add('M1');
    a.backgroundTaskIds = new Map([['a1', 'M1']]);
    expect(renewSubagents(a, entries, NOW)).toEqual([]);
    expect(ids(renewSubagents(a, entries, NOW - 2 * BACKGROUND_WAITING_MAX_MS))).toEqual(['M1']);
  });
});
