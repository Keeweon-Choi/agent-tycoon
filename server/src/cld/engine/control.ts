/**
 * The local control channel (T-0019, cld/docs/design/cld-cli.md §7): how the
 * `cld-gui` CLI reaches the daemon. ~/.config/cld-gui/engine.sock (a Unix
 * socket, 0600, made under another name and renamed into place) on Linux and
 * macOS, \\.\pipe\cld-gui-engine-<user> on Windows. Only the same OS user
 * reaches it; the web UI never does. One JSON line per connection each way:
 * {v, cmd, cwd, source, token?, args} in, the CLI's JSON result out.
 *
 * Identity (S7): `token` is the caller's CLD_AGENT_TOKEN (agentTokens.ts);
 * a valid one makes the caller that project, whatever its cwd, `--from` or
 * source say. Without one the caller is an unidentified local process: cwd
 * and `--from` still pick a display label, but the app's own sources
 * (OWNER_SOURCE) are never accepted here, so nothing that comes over this
 * socket is typed under the owner's header.
 */
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

import type {
  EngineAction,
  EngineActionKind,
  EngineActionResult,
  EngineProject,
} from '../../../../core/src/messages.js';
import { CLI_NAME } from '../cliName.js';
import { jobDescription } from '../jobNames.js';
import { configDir } from './events.js';

const WORKER_OPS: EngineActionKind[] = ['add', 'edit', 'remove', 'start', 'stop', 'restart', 'promote'];
const WORKER_FIELDS = ['project', 'role', 'folder', 'model', 'permissionMode', 'effort', 'title', 'provider'] as const;
const WORKER_USAGE =
  `사용법: ${CLI_NAME} worker list | worker add <프로젝트> <이름> [--role worker|reviewer] [--provider claude|codex] [--folder F] [--model M] [--permission-mode P] [--effort E] | worker edit <이름> [같은 옵션] | worker remove|start|stop|restart <이름> | worker promote <이름> [--old stop]`;

const TRUST_USAGE = `사용법: ${CLI_NAME} trust [--start] <프로젝트 이름 또는 폴더>`;

const REQUEST_MAX = 1024 * 1024;
const SOURCE_RE = /^[A-Za-z0-9._:-]{1,64}$/;
/** Sources only the app's authenticated routes inside the daemon may use (the owner's headers). */
export const OWNER_SOURCE = /^(messenger|gui):/;
/** An engine project name (registry NAME_RE). */
const NAME_RE = /^[A-Za-z0-9가-힣][A-Za-z0-9가-힣._-]{0,40}$/;

export function controlPath(
  home = os.homedir(),
  platform: NodeJS.Platform = process.platform,
  user = os.userInfo().username,
): string {
  if (platform === 'win32')
    return `\\\\.\\pipe\\cld-gui-engine-${user.toLowerCase().replace(/[^a-z0-9._-]/g, '_')}`;
  return path.join(configDir(home), 'engine.sock');
}

export type ControlCode =
  'bad_request' | 'usage' | 'unknown_project' | 'no_project' | 'daemon_error';
export type Reply = Record<string, unknown> & { ok: boolean };
export const refuse = (code: string, error: string): Reply => ({ ok: false, code, error });

export interface ControlRequest {
  cmd: string;
  cwd: string;
  source: string;
  /** The caller's CLD_AGENT_TOKEN, when it sent one (unchecked here). */
  token?: string;
  args: Record<string, unknown>;
}

/** A request line, checked; a refusal when it is not one. */
export function parseControl(line: string): ControlRequest | Reply {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return refuse('bad_request', '요청을 읽지 못했습니다');
  }
  if (!j || typeof j !== 'object' || j.v !== 1 || typeof j.cmd !== 'string')
    return refuse('bad_request', '요청을 읽지 못했습니다');
  if (typeof j.cwd !== 'string' || !path.isAbsolute(j.cwd))
    return refuse('bad_request', '현재 폴더가 없습니다');
  const args = j.args && typeof j.args === 'object' ? (j.args as Record<string, unknown>) : {};
  const claimed = typeof j.source === 'string' && SOURCE_RE.test(j.source) ? j.source : 'cli';
  // The owner's sources are the app's; a caller here is at most a local CLI.
  const source = OWNER_SOURCE.test(claimed) ? 'cli' : claimed;
  const token = typeof j.token === 'string' && j.token.length <= 256 ? j.token : undefined;
  return { cmd: j.cmd, cwd: j.cwd, source, ...(token && { token }), args };
}

/** A sender or project name given on the command line, when it can be one. */
export const projectName = (x: unknown): string | null =>
  typeof x === 'string' && NAME_RE.test(x) ? x : null;

export interface ControlDeps {
  /** Every agent's name (D3: each project's Lead, named as the project, and the Workers). */
  names(): string[];
  /** S7: the agent a CLD_AGENT_TOKEN was issued to (a Lead or a Worker), or null (forged, stale, none). */
  agentOf?(token: string): string | null;
  /** D3: the project an agent works for (a Lead's is its own name): jobs, Codex tasks and
   *  작업 현황 stay attributed to the project. */
  projectOf?(name: string): string | null;
  /** D3: `cld-gui worker …`, the office's engine action (the owner's CLI only). */
  engineAction?(req: EngineAction): Promise<EngineActionResult>;
  workers?(): EngineProject[];
  /** The engine project whose folder holds `cwd` (longest wins), or null. */
  projectAt(cwd: string): string | null;
  send(req: {
    to: string;
    text: string;
    ifIdle: boolean;
    from: string | null;
    source: string;
  }): Promise<Reply>;
  /** A room post fans out through the same Messenger queue. */
  groupPost?(req: { room: string; text: string; from: string | null; source: string }): Promise<Reply>;
  groups?(): Reply;
  groupRead?(room: string, n: number): Reply;
  job(req: {
    cmd: string;
    desc?: string | null;
    cwd: string;
    project: string | null;
    tty: boolean;
    path?: string;
    source: string;
    gpu?: { vramGib: number | null; exclusive: boolean; label: string | null };
    /** D6: the task this job becomes an Execution of. */
    task?: string | null;
  }): Reply | Promise<Reply>;
  jobs(all: boolean): Reply;
  /** `cld-gui codex …` (T-0021): start a task, or (no spec) list them. */
  codex(req: {
    spec: string;
    model: string | null;
    effort?: string | null;
    worktree: boolean;
    project: string | null;
    cwd: string;
    path?: string;
    source: string;
    /** D6: the task this Codex task becomes an Execution of. */
    task?: string | null;
  }): Promise<Reply>;
  codexList(all: boolean): Reply;
  /** `cld-gui hw`: the daemon's latest HW sample (`{ok, hw}`), or a `no_sample` refusal. */
  hw(): Promise<Reply>;
  /** Read-only one-screen snapshot for `cld-gui status`. */
  status?(): Promise<Reply> | Reply;
  /** Owner-only bulk stop used immediately before a manager uninstall. */
  stopAgents?(): Promise<Reply> | Reply;
  stop(target: string, source: string): Reply;
  renew(name: string, handoff: string, file: string | null, source: string): Reply;
  /** C5a: one MCP tool call by `agent` (always the token's agent: mcpTools.ts). */
  mcp?(agent: string, tool: string, input: unknown): Promise<Record<string, unknown>>;
  /** W2: `cld-gui worktree new|list` (taskWorktree.ts); an agent's token keeps it to its project. */
  worktree?(
    args: Record<string, unknown>,
    who: { by: string; project: string | null; agent: string | null },
  ): Promise<Reply>;
  /** AUTO-TRUST: `agty trust [--start]`, Claude's folder trust question answered for a registered
   *  project (by name or folder), then optionally started (Engine.trustProject). */
  trust?(target: { name?: string; folder?: string }, start: boolean): Promise<Reply>;
  /** `cld-gui task …` (DEV-BOARD): `by` is the caller (its token's project, else its source). */
  task?(
    args: Record<string, unknown>,
    who: { by: string; project: string | null; agent: string | null },
  ): Reply;
}

const str = (x: unknown): string | null => (typeof x === 'string' ? x : null);

/** One CLI request, answered as the CLI prints it (cld-cli.md §4). */
export async function answerControl(req: ControlRequest, d: ControlDeps): Promise<Reply> {
  const a = req.args;
  const unknown = (name: string) =>
    refuse('unknown_project', `'${name}' 프로젝트가 없습니다: ${d.names().join(' ')}`);
  // The token's project wins, then the project the caller stands in; a given
  // name only stands in for neither.
  const agent = req.token && d.agentOf ? d.agentOf(req.token) : null;
  const here = agent ?? d.projectAt(req.cwd);
  const has = (key: 'from' | 'project') => a[key] !== undefined && a[key] !== null;
  const given = (key: 'from' | 'project') => (has(key) ? projectName(a[key]) : null);
  // D3: a Worker's jobs, Codex tasks and 작업 현황 belong to its project.
  const projectOf = (name: string | null) => (name && d.projectOf ? d.projectOf(name) : name);
  switch (req.cmd) {
    case 'send': {
      const text = str(a.text);
      const room = str(a.group);
      const to = str(a.to);
      if ((!to && !room) || text === null)
        return refuse('usage', `사용법: ${CLI_NAME} send [--if-idle] [--group <방>] <프로젝트|메시지>`);
      if (to && room) return refuse('usage', '프로젝트와 --group 을 같이 쓸 수 없어요');
      if (has('from') && given('from') === null)
        return refuse('usage', '--from 이름이 올바르지 않습니다');
      if (room) {
        if (!d.groupPost) return refuse('daemon_error', '단톡방을 쓸 수 없어요');
        // A room header names its sender: the boss's own name and the app sources are not for the CLI.
        const source = OWNER_SOURCE.test(req.source) ? 'cli' : req.source;
        return d.groupPost({ room, text, from: here ?? given('from'), source });
      }
      // TOKEN-GUARD (TG-09): an agent's own token naming the target is a self-send (refused by the
      // messenger). Without a token, standing in the target's own folder is the owner's terminal
      // (or a session from before tokens): no sender name, delivered as before.
      const from = here ?? given('from');
      return d.send({
        to: to!,
        text,
        ifIdle: a.ifIdle === true,
        from: !agent && here === to ? null : from,
        // parseControl already refused the app's sources; this guards direct callers too.
        source: OWNER_SOURCE.test(req.source) ? 'cli' : req.source,
      });
    }
    case 'groups': {
      const room = str(a.read);
      if (room) {
        const n = a.n === undefined ? 50 : a.n;
        if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 500)
          return refuse('usage', '-n 은 1~500 정수예요');
        return d.groupRead ? d.groupRead(room, n) : refuse('daemon_error', '단톡방을 읽을 수 없어요');
      }
      return d.groups ? d.groups() : refuse('daemon_error', '단톡방을 읽을 수 없어요');
    }
    case 'job': {
      const cmd = str(a.cmd);
      if (!cmd)
        return refuse('usage', `사용법: ${CLI_NAME} job [-t] [-d <설명>] [--project <이름>] <명령>`);
      let desc: string | null;
      try {
        desc = jobDescription(a.desc);
      } catch {
        return refuse('usage', '설명은 줄바꿈 없이 80자 이하여야 합니다');
      }
      let project = projectOf(here);
      if (has('project')) {
        project = given('project');
        if (!project || !d.names().includes(project)) return unknown(String(a.project));
        project = projectOf(project);
      }
      const gpu = a.gpu && typeof a.gpu === 'object' ? (a.gpu as Record<string, unknown>) : null;
      const vram = gpu?.vramGib ?? null;
      if (gpu && vram !== null && !(typeof vram === 'number' && Number.isFinite(vram) && vram >= 0))
        return refuse('usage', '--vram 은 GiB 숫자입니다');
      return d.job({
        cmd,
        desc,
        cwd: req.cwd,
        project,
        tty: a.tty === true,
        ...(str(a.path) && { path: str(a.path)! }),
        source: req.source,
        ...(str(a.task) && { task: str(a.task) }),
        ...(gpu && {
          gpu: {
            vramGib: vram as number | null,
            exclusive: gpu.exclusive === true,
            label: str(gpu.label)?.slice(0, 200) ?? null,
          },
        }),
      });
    }
    case 'codex': {
      if (a.list === true) return d.codexList(a.all === true);
      const spec = str(a.spec);
      if (!spec)
        return refuse(
          'usage',
          `사용법: ${CLI_NAME} codex [-m <모델>] [-e <강도>] [--worktree] [--project <이름>] <명세 파일>`,
        );
      let project = projectOf(here);
      if (has('project')) {
        project = given('project');
        if (!project || !d.names().includes(project)) return unknown(String(a.project));
        project = projectOf(project);
      }
      return d.codex({
        spec,
        model: str(a.model),
        effort: str(a.effort),
        worktree: a.worktree === true,
        project,
        cwd: req.cwd,
        ...(str(a.path) && { path: str(a.path)! }),
        source: req.source,
        ...(str(a.task) && { task: str(a.task) }),
      });
    }
    case 'jobs':
      return d.jobs(a.all === true);
    case 'hw':
      return d.hw();
    case 'status':
      return d.status ? d.status() : refuse('daemon_error', '상태를 읽을 수 없어요');
    case 'stop-agents':
      // An agent token represents one project.  It must never acquire the
      // owner's ability to stop every project and background job.
      if (agent) return refuse('forbidden', '에이전트는 모든 작업을 멈출 수 없어요');
      return d.stopAgents
        ? d.stopAgents()
        : refuse('daemon_error', '에이전트를 멈출 수 없어요');
    case 'stop': {
      const target = str(a.target);
      if (!target) return refuse('usage', `사용법: ${CLI_NAME} stop <작업 id 또는 pid>`);
      return d.stop(target, req.source);
    }
    case 'renew': {
      let name = here;
      if (has('project')) {
        name = given('project');
        if (!name || !d.names().includes(name)) return unknown(String(a.project));
        // S-06: an agent token renews only itself or its own Workers (the owner keeps --project).
        if (agent && name !== agent && projectOf(name) !== agent)
          return refuse('forbidden', '에이전트는 다른 프로젝트를 환생시킬 수 없어요');
      }
      if (!name)
        return refuse(
          'no_project',
          '어느 프로젝트인지 모릅니다: 프로젝트 폴더에서 부르거나 --project <이름>을 주세요',
        );
      return d.renew(name, str(a.text) ?? '', str(a.file), req.source);
    }
    case 'mcp': {
      // C5a: the MCP adapter's calls. Identity is the token's agent only: no cwd, no --from.
      if (!agent)
        return refuse('no_identity', 'no agent token, or one this daemon did not issue (restart the session)');
      const tool = str(a.tool);
      if (!tool) return refuse('bad_request', 'tool is required');
      if (!d.mcp) return refuse('daemon_error', 'agent tools are not available');
      const result = await d.mcp(agent, tool, a.input);
      return { ok: !('error' in result), result };
    }
    case 'task':
      return d.task
        ? d.task(a, { by: agent ?? req.source, project: projectOf(here), agent })
        : refuse('daemon_error', '작업 현황을 쓸 수 없어요');
    case 'worktree':
      return d.worktree
        ? d.worktree(a, { by: agent ?? req.source, project: projectOf(here), agent })
        : refuse('daemon_error', 'worktree 를 다룰 수 없어요');
    case 'trust': {
      // A person typed it: an agent (its token) never answers a trust question, as at the MCP tools.
      if (agent) return refuse('forbidden', '에이전트는 폴더 신뢰에 답할 수 없어요');
      if (!d.trust) return refuse('daemon_error', '폴더 신뢰를 다룰 수 없어요');
      // Exactly one of them: a project name, or an absolute folder (the CLI resolves it).
      const name = projectName(a.name);
      const folder = str(a.folder);
      const target =
        a.folder === undefined && name
          ? { name }
          : a.name === undefined && folder && path.isAbsolute(folder)
            ? { folder }
            : null;
      if (!target) return refuse('usage', TRUST_USAGE);
      return d.trust(target, a.start === true);
    }
    case 'worker': {
      // The owner's command: an agent (its token) does not make or change agents (C5/C6 will).
      if (agent) return refuse('forbidden', '에이전트는 Worker 를 만들거나 바꿀 수 없어요');
      if (!d.engineAction || !d.workers) return refuse('daemon_error', 'Worker 를 다룰 수 없어요');
      const op = str(a.op);
      if (op === 'list') return { ok: true, workers: d.workers() };
      const name = projectName(a.name);
      if (!op || !(WORKER_OPS as string[]).includes(op) || !name)
        return refuse('usage', WORKER_USAGE);
      if (op !== 'add' && !d.workers().some((w) => w.name === name))
        return refuse('unknown_worker', `'${name}' Worker 가 없습니다`);
      const fields: Partial<EngineAction> = {};
      for (const k of WORKER_FIELDS) {
        const v = str(a[k]);
        if (v !== null) (fields as Record<string, string>)[k] = v;
      }
      const r = await d.engineAction({
        type: 'engineAction',
        requestId: `cli-${Date.now()}`,
        action: op as EngineActionKind,
        name,
        ...(op === 'add' && { role: 'worker' }),
        ...fields,
        // D3b: what the old Lead becomes (worker unless --old stop).
        ...(op === 'promote' && { oldLead: a.oldLead === 'stop' ? 'stop' : 'worker' }),
      });
      return r.ok
        ? { ok: true, name, action: op, ...(r.note && { note: r.note }) }
        : refuse('refused', r.error ?? '');
    }
    default:
      return refuse('bad_request', `모르는 명령입니다: ${req.cmd}`);
  }
}

/**
 * Listen; null when another daemon already answers on this path (it keeps it).
 * Each line goes to `handle`, whose answer goes back as one line.
 */
export async function listenControl(
  file: string,
  handle: (req: ControlRequest) => Promise<Reply>,
  log: (line: string) => void = (l) => console.log(`[cld engine] ${l}`),
  platform: NodeJS.Platform = process.platform,
): Promise<net.Server | null> {
  const server = net.createServer((socket) => {
    let buf = '';
    let done = false;
    socket.setEncoding('utf-8');
    socket.setTimeout(120_000, () => socket.destroy());
    socket.on('error', () => undefined);
    socket.on('data', (chunk: string) => {
      if (done) return;
      buf += chunk;
      if (buf.length > REQUEST_MAX) {
        done = true;
        socket.end(`${JSON.stringify({ v: 1, ...refuse('bad_request', '요청이 너무 큽니다') })}\n`);
        return;
      }
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      done = true;
      const req = parseControl(buf.slice(0, nl));
      const answer =
        'ok' in req
          ? Promise.resolve(req)
          : handle(req).catch((err: unknown) => {
              log(`control: ${err instanceof Error ? err.message : String(err)}`);
              return refuse('daemon_error', 'cld-gui 데몬에서 오류가 났습니다');
            });
      void answer.then((r) => {
        if (!socket.destroyed) socket.end(`${JSON.stringify({ v: 1, ...r })}\n`);
      });
    });
  });
  if (platform === 'win32') {
    // libuv makes the first pipe instance only: a name someone else holds fails here.
    if (!(await listen(server, file))) {
      log(`${file} is taken; cld-gui commands will not reach this daemon`);
      return null;
    }
    return server;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  // An existing folder keeps its mode (often 0775): only the owner may reach or replace the socket.
  fs.chmodSync(path.dirname(file), 0o700);
  if (await answers(file)) {
    log(`${file} already answers (another cld-gui daemon); not taking it over`);
    return null;
  }
  // Made under a private name, 0600, then renamed over a stale socket.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.rmSync(tmp, { force: true });
  if (!(await listen(server, tmp))) {
    log(`cannot listen on ${tmp}`);
    return null;
  }
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  server.on('close', () => {
    try {
      if (fs.statSync(file).isSocket()) fs.rmSync(file, { force: true });
    } catch {
      /* gone */
    }
  });
  return server;
}

function listen(server: net.Server, at: string): Promise<boolean> {
  return new Promise((resolve) => {
    const onError = () => resolve(false);
    server.once('error', onError);
    server.listen(at, () => {
      server.off('error', onError);
      resolve(true);
    });
  });
}

/** Something accepts connections on `file`. */
function answers(file: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(file);
    const end = (v: boolean) => {
      s.destroy();
      resolve(v);
    };
    s.once('connect', () => end(true));
    s.once('error', () => end(false));
    s.setTimeout(500, () => end(false));
  });
}
