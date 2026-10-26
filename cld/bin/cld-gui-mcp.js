#!/usr/bin/env node
// cld-gui-mcp: the MCP adapter of the cld-gui engine (C5a, onboarding-security
// B §9). The engine attaches it to each Claude session it starts with
// `--mcp-config ~/.config/agent-tycoon/mcp-config.json`; Claude Code runs it with the
// daemon's Node and the session's own environment, so CLD_AGENT_TOKEN is the
// session's identity. It holds no state and decides nothing: every tool call
// goes to the daemon's control socket as `mcp` (the CLI's own client), and the
// daemon checks identity, scope, duplicates and rate (engine/mcpTools.ts), and
// for delegate_task the rest of B §9.4 (engine/delegation.ts).
//
// The MCP stdio protocol: newline-delimited JSON-RPC 2.0 on stdin/stdout.
'use strict';
const { request } = require('./cld-gui');

// Not 2025-03-26: that one has JSON-RPC batches, which this server refuses.
const VERSIONS = ['2025-11-25', '2025-06-18', '2024-11-05'];
/** The longest line (characters) taken; a longer one is answered with an error and dropped. */
const LINE_MAX = 1024 * 1024;
const key = { idempotencyKey: { type: 'string', description: 'Optional. The same key again within 24 h returns the first result with status "duplicate" instead of doing it twice.' } };
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const TOOLS = [
  {
    name: 'list_agents',
    description:
      'The managed agents of your project (not your own internal subagents). Check it before delegate_task: an idle Worker of the right kind is reused before a new one is made. Shows you (id, role, depth, canDelegate and canCreateWorker under the current mode and limits), the project delegation mode (auto, reuse, off), each agent with state idle/busy/down/limit/stopped, queue length and open tasks, and the project limits with today\'s counts ([used, limit]).',
    inputSchema: object({ state: { type: 'string', enum: ['idle', 'busy', 'all'], description: 'Only agents in this state (default all).' } }),
  },
  {
    name: 'create_task',
    description:
      "Create a task on your project's board. A Lead's task is a to-do; a Worker's task is a proposal (status proposed) addressed to its Lead, who decides.",
    inputSchema: object(
      {
        title: { type: 'string' },
        detail: { type: 'string' },
        parentTaskId: { type: 'string', description: 'A task of your project to put this under.' },
        ...key,
      },
      ['title'],
    ),
  },
  {
    name: 'update_task',
    description:
      "Report a task's status or add a note. Only the task's assignee and the project's Lead may; it is stored as reported, not observed.",
    inputSchema: object(
      {
        taskId: { type: 'string' },
        status: { type: 'string', enum: ['proposed', 'todo', 'doing', 'review', 'blocked', 'done'] },
        note: { type: 'string' },
        ...key,
      },
      ['taskId'],
    ),
  },
  {
    name: 'get_task_status',
    description:
      "Tasks of your project with their executions and every fact with its source (observed, reported, inferred). No progress is made up. Give taskId for one task, mine for yours, or neither for all (pages: pass back cursor).",
    inputSchema: object({ taskId: { type: 'string' }, mine: { type: 'boolean' }, cursor: { type: 'string' } }),
  },
  {
    name: 'send_message',
    description:
      'Send a message to another agent of your project (its id from list_agents, or its name). It arrives in that agent\'s session with your name as the sender. At most 6 messages/tasks a minute between two agents.',
    inputSchema: object({ to: { type: 'string' }, text: { type: 'string' }, ...key }, ['to', 'text']),
  },
  {
    name: 'post_to_group',
    description:
      'Post in a room you are a member of, as yourself. Only members named with an exact @name are woken; a post without a mention wakes nobody.',
    inputSchema: object({ room: { type: 'string' }, text: { type: 'string' }, ...key }, ['room', 'text']),
  },
  {
    name: 'get_group_context',
    description: 'The latest posts of a room you are a member of (n per page, older pages with cursor).',
    inputSchema: object({
      room: { type: 'string' },
      n: { type: 'integer', minimum: 1, maximum: 100 },
      cursor: { type: 'string' },
    }),
  },
  {
    name: 'delegate_task',
    description:
      "Give a task to a managed agent of your project. You choose how work runs; the daemon only checks your choice and never reclassifies it: a short lookup, read or one-off check needs no new session (do it yourself or with your own internal subagent); follow-up work an idle Worker of the right kind fits goes to that Worker (target.agentId); a new managed Worker only for long or separate changes, parallel work, or another provider. Never ask the user to create Workers. Targets: an existing Worker or Reviewer (target.agentId, from list_agents) or a new managed Worker (target.newWorker; provider claude, or codex when it is installed here: a Codex Worker runs one Codex exec per message and reports with its last message, without these tools). Not your own internal subagents. The daemon checks, in order: your identity, your project's scope, duplicates (the same idempotencyKey within 24 h, or an open task with the same parent, target and title), your permission (a Lead delegates; a Worker only under its own task, at depth 2), the project's delegation mode (auto, reuse, off), the target (a user-stopped agent is never started, at most 3 waiting per Worker, a new Worker is refused while one of the same provider and role is idle or down: candidates come back), the limits (3 running Workers per project, 6 per host, 5 new Workers and 30 delegations a day, a budget within the parent's remaining), and the pairwise rate (6 a minute). worktree 'new' gives the task its own git worktree (branch task/<task id>-<slug> from the project's main branch, folder .worktrees/), made before the task is sent and given to the target: a Claude Worker starts in it on its next start (a running one is not moved; the message names the folder, work there), a Codex Worker runs there; worktree_failed if it cannot be made. Status: accepted = the task is on the board and sent (a new Worker gets it as its first prompt); queued = the Worker is busy or at its usage limit, it gets the task when free (position); pending_approval = the user (for a Lead) or your Lead (for a Worker) must approve, approvalId names it and you will get a line with the result; duplicate = the first result again; rejected = not done, see code and message (retryAfterSec for rate_limited, candidates for idle_worker_available). A Lead takes a Worker's proposal with delegate_task({ idempotencyKey, task: { id } }).",
    inputSchema: object(
      {
        idempotencyKey: { type: 'string', description: 'Required. The same key again within 24 h returns the first result with status "duplicate".' },
        task: object({
          id: { type: 'string', description: 'An existing task to hand out (a proposal or a to-do).' },
          title: { type: 'string' },
          detail: { type: 'string' },
          acceptance: { type: 'string', description: 'When it is done.' },
          parentTaskId: { type: 'string', description: 'Default: your current task.' },
          area: { type: 'string', description: 'A note for the record; the daemon does not read it.' },
          worktree: {
            description: "'new': the task's own worktree, given to the target; 'none'; or { path } of an existing one.",
            oneOf: [
              { type: 'string', enum: ['none', 'new'] },
              object({ path: { type: 'string', description: "An existing worktree of the project's repository." } }, ['path']),
            ],
          },
        }),
        target: {
          oneOf: [
            object({ agentId: { type: 'string', description: 'A Worker or Reviewer id from list_agents.' } }, ['agentId']),
            object(
              {
                newWorker: object(
                  {
                    provider: { type: 'string', description: "'claude', or 'codex' when it is installed here" },
                    model: { type: 'string' },
                    effort: { type: 'string' },
                    role: { type: 'string', enum: ['worker', 'reviewer'] },
                    name: { type: 'string' },
                    reason: { type: 'string', description: 'Why a new Worker (for the record).' },
                  },
                  ['provider', 'reason'],
                ),
              },
              ['newWorker'],
            ),
          ],
        },
        budget: object({ maxTurns: { type: 'integer', minimum: 1 }, maxMinutes: { type: 'integer', minimum: 1 } }),
      },
      ['idempotencyKey', 'task'],
    ),
  },
];
const NAMES = new Set(TOOLS.map((t) => t.name));

const error = (code, message) => ({ error: { code, message } });
const content = (result) => ({
  content: [{ type: 'text', text: JSON.stringify(result) }],
  ...(result && result.error ? { isError: true } : {}),
});

/** One tool call through the daemon. */
async function call(name, input) {
  if (!NAMES.has(name)) return error('unknown_tool', `no tool '${name}'`);
  if (!process.env.CLD_AGENT_TOKEN)
    return error('no_identity', 'this session has no CLD_AGENT_TOKEN: only sessions the cld-gui engine starts have the agent tools');
  const r = await request('mcp', { tool: name, input: input ?? {} });
  if (r === null) return error('daemon_off', 'the cld-gui daemon is not running');
  if (r.result && typeof r.result === 'object') return r.result;
  return error(r.code || 'daemon_error', r.error || 'the cld-gui daemon refused the call');
}

async function answer(m) {
  switch (m.method) {
    case 'initialize': {
      const asked = m.params && m.params.protocolVersion;
      return {
        protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'cld-gui', version: '1' },
      };
    }
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call':
      return content(await call(m.params && m.params.name, m.params && m.params.arguments));
    default:
      return undefined;
  }
}

const send = (msg) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`);

const invalid = (message = 'Invalid Request') => send({ id: null, error: { code: -32600, message } });

async function line(text) {
  if (!text.trim()) return;
  let m;
  try {
    m = JSON.parse(text);
  } catch {
    return send({ id: null, error: { code: -32700, message: 'Parse error' } });
  }
  if (Array.isArray(m)) return invalid('Batches are not supported');
  if (!m || typeof m !== 'object') return invalid();
  // A notification (no id) gets no answer: notifications/initialized and the like.
  const notification = m.id === undefined;
  if (!notification && typeof m.id !== 'string' && typeof m.id !== 'number') return invalid('Invalid id');
  if (typeof m.method !== 'string') {
    // A response from the client (we send no requests) is ignored.
    if (!notification && !('result' in m) && !('error' in m))
      send({ id: m.id, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }
  if (notification) return;
  try {
    const result = await answer(m);
    if (result === undefined) send({ id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } });
    else send({ id: m.id, result });
  } catch (err) {
    send({ id: m.id, error: { code: -32603, message: String((err && err.message) || err) } });
  }
}

// Lines in `buf` from 0; `scanned`: how far it has been searched for a newline (each byte once).
let buf = '';
let scanned = 0;
// Inside a line already refused as too long: everything up to its newline is dropped.
let dropping = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let start = 0;
  for (let nl = buf.indexOf('\n', scanned); nl !== -1; nl = buf.indexOf('\n', start)) {
    const text = buf.slice(start, nl);
    start = nl + 1;
    if (dropping) dropping = false;
    else if (text.length > LINE_MAX) invalid('Line too long');
    else void line(text);
  }
  buf = buf.slice(start);
  scanned = buf.length;
  if (buf.length > LINE_MAX) {
    if (!dropping) invalid('Line too long');
    dropping = true;
    buf = '';
    scanned = 0;
  }
});
process.stdin.on('end', () => {
  if (!dropping) void line(buf);
});
