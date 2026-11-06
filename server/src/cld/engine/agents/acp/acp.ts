/**
 * ACP-1: the one provider every agent that speaks ACP (Agent Client Protocol) joins the office
 * through, one instance per installed preset (presets.ts; provider id = preset id, protocol 'acp').
 * An agent is its installed binary with the preset's argv, started in the agent's folder (its
 * project's, or the worktree it was given), spoken to over stdio through @agentclientprotocol/sdk.
 *
 * - session/prompt <- a message the messenger hands over (deliver): one at a time; while a prompt
 *   runs the session is `busy` and the messenger's queue holds the rest.
 * - session/update -> a Claude-shaped transcript (transcript.ts), so the office character, the
 *   messenger, the party and the 개발실's 대화 pane follow it as any agent's.
 * - session/request_permission -> the owner's permission card with the offered options (ask);
 *   only the owner's button answers. No answer (a timeout, the character gone, a lost pipe) sends
 *   no decision: the request stays open until the turn is stopped (then `cancelled`, as ACP asks of
 *   a client) or the pipe closes. Nothing is ever allowed on our own.
 * - stop -> session/cancel when a prompt runs, session/close when offered, then the child ends.
 * - a start with a conversation to continue -> session/resume, else session/load (its replay is
 *   not written again), else a new session and the owner is told it started fresh.
 * Client capabilities: none (no fs/*, no terminal/*): the agent works with its own tools in its own
 * folder, and nothing it asks can make us read, write or run anything for it.
 *
 * Everything an agent sends is untrusted: the SDK caps a message at ACP_MESSAGE_MAX_BYTES and
 * answers malformed requests with JSON-RPC errors; every handler here catches, so an agent can end
 * its own session but never the daemon.
 *
 * ponytail: the child lives in the daemon and dies with it (a daemon restart resumes the session
 * when the agent can); holding the pipes in cld-ptyhost would keep it alive, add when that matters.
 */
import type { ChildProcess } from 'child_process';
import { spawn } from 'child_process';
import * as fs from 'fs';
import { Readable, Writable } from 'stream';

import { koText } from '../../../../../../core/src/cld/serverText.js';
import {
  ACP_ASKS_MAX,
  ACP_CLOSE_MS,
  ACP_FIELD_MAX,
  ACP_KILL_GRACE_MS,
  ACP_MESSAGE_MAX_BYTES,
  ACP_OPTIONS_MAX,
  ACP_START_MS,
  ACP_STDERR_KEEP,
} from '../../../../constants.js';
import { maskText } from '../../../mask.js';
import { commandArgv } from '../../../spawnJson.js';
import { AGENT_TOKEN_ENV } from '../../agentTokens.js';
import { AGENT_SESSION_ID_RE, type ProjectRecord } from '../../registry.js';
import type { AgentCapabilities, AgentProvider, DeliverResult, LiveSession, StartResult, StopResult } from '../types.js';
import type { AcpPreset } from './presets.js';
import { acpFillPct, AcpTranscript, acpTranscriptPath, toolUse } from './transcript.js';

type ClientConnection = import('@agentclientprotocol/sdk', { with: { 'resolution-mode': 'import' } }).ClientConnection;

/** One option of a permission request, as the card offers it. */
export interface AcpOption {
  optionId: string;
  name: string;
  kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';
}
const KINDS: readonly string[] = ['allow_once', 'allow_always', 'reject_once', 'reject_always'];

/** What the office's card needs for one request. */
export interface AcpAsk {
  tool: string;
  input: Record<string, unknown>;
  options: AcpOption[];
}

export interface AcpAgentOptions {
  preset: AcpPreset;
  /** The installed executable presets.ts found. */
  bin: string;
  home: string;
  /** The engine's clean environment (read at each start). */
  env: () => NodeJS.ProcessEnv;
  /** The owner's card: the chosen option's id, or null (no decision). `signal` ends the wait. */
  /** The owner's option, null (no decision), or false: a newer request took its card (cancel it). */
  ask: (name: string, ask: AcpAsk, signal: AbortSignal) => Promise<string | false | null>;
  log: (line: string) => void;
  /** Tests shorten the start and stop waits. */
  timing?: { startMs?: number; closeMs?: number; killMs?: number };
  platform?: NodeJS.Platform;
}

interface Conn {
  assignmentId: string;
  name: string;
  cwd: string;
  child: ChildProcess;
  pid: number;
  startedAt: number;
  connection: ClientConnection | null;
  /** Set once the session is there (updates for any other id are ignored, a load's replay too). */
  sessionId: string;
  transcript: AcpTranscript | null;
  caps: { resume: boolean; load: boolean; close: boolean };
  busy: boolean;
  /** Aborted when the session ends or is stopped: open permission requests then end. */
  abort: AbortController;
  /** Permission requests being answered (a stop lets their `cancelled` go out first). */
  asks: Set<Promise<unknown>>;
  gone: boolean;
}

const READY_MS = 10_000;
const CANCELLED = { outcome: { outcome: 'cancelled' as const } };
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 300);
const aborted = (signal: AbortSignal): Promise<void> =>
  signal.aborted ? Promise.resolve() : new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));

/** `p` within `ms`, else rejected. */
function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what}: no answer in ${Math.round(ms / 1000)} s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** The valid options of a request, at most ACP_OPTIONS_MAX (anything else is dropped). */
export function permissionOptions(raw: unknown): AcpOption[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  return raw.flatMap((o) => {
    const { optionId, name, kind } = obj(o);
    if (typeof optionId !== 'string' || !optionId || optionId.length > ACP_FIELD_MAX || seen.has(optionId)) return [];
    if (typeof kind !== 'string' || !KINDS.includes(kind)) return [];
    seen.add(optionId);
    return [{ optionId, name: typeof name === 'string' ? name.slice(0, 200) : kind, kind: kind as AcpOption['kind'] }];
  }).slice(0, ACP_OPTIONS_MAX);
}

export class AcpAgent implements AgentProvider {
  readonly protocol = 'acp' as const;
  private readonly conns = new Map<string, Conn>();
  private readonly starting = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readyAt = -Infinity;
  private readyWhy: string | null = null;
  /** What the agent said in its initialize answer, once it has (the UI's caps). */
  private learned: { resume: boolean; context: boolean } = { resume: false, context: false };
  readonly compaction = { mark: '"subtype":"compact_boundary"', fillPct: acpFillPct };

  constructor(private readonly o: AcpAgentOptions) {}

  get id(): string {
    return this.o.preset.id;
  }

  get capabilities(): AgentCapabilities {
    return {
      // Every permission is asked through ACP and answered by the owner: no mode to choose.
      approvalPolicy: ['ask'],
      sandbox: null,
      attach: null,
      resume: this.learned.resume,
      naming: 'none',
      usage: null,
      lifetime: 'session',
      limits: false,
      usageRefresh: false,
      // Reported once the agent sends usage_update (the gauge reads it from the transcript).
      context: this.learned.context,
      billing: this.o.preset.billing,
      name: this.o.preset.name,
    };
  }

  private changed(): void {
    for (const cb of this.listeners) {
      try {
        cb();
      } catch (err) {
        this.o.log(`acp ${this.id}: change listener: ${errText(err)}`);
      }
    }
  }

  live(): LiveSession[] {
    return [...this.conns.values()]
      .filter((c) => !c.gone && c.sessionId)
      .map((c) => ({
        id: c.sessionId,
        pid: c.pid,
        cwd: c.cwd,
        kind: 'background',
        startedAt: c.startedAt,
        sessionId: c.sessionId,
        name: c.name,
        status: c.busy ? 'busy' : 'idle',
        assignmentId: c.assignmentId,
      }));
  }

  liveUnsure(): boolean {
    return this.starting.size > 0;
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  nameMatches(): boolean {
    return false;
  }

  ready(): string | null {
    const now = Date.now();
    if (now - this.readyAt > READY_MS) {
      this.readyWhy = fs.existsSync(this.o.bin) ? null : koText('acp_missing', { name: this.o.preset.name });
      this.readyAt = now;
    }
    return this.readyWhy;
  }

  held(): Promise<boolean> {
    return Promise.resolve(false);
  }

  transcript(s: Pick<LiveSession, 'cwd' | 'sessionId'>): string {
    return s.sessionId ? acpTranscriptPath(this.o.home, this.id, s.cwd, s.sessionId) : '';
  }

  /** An agent that cannot continue a conversation is never stopped for idleness (it would forget). */
  viewed(s: LiveSession): boolean {
    const c = this.connOf(s);
    return !c || !(c.caps.resume || c.caps.load);
  }

  async start(p: ProjectRecord, o: { resume?: string; token: () => string | null }): Promise<StartResult> {
    const assignmentId = p.assignmentId ?? p.leadAssignmentId;
    if (!assignmentId) return { ok: false, error: koText('acp_start_failed', { name: this.o.preset.name, why: 'no assignment' }) };
    const had = this.conns.get(assignmentId);
    if (had && !had.gone) return { ok: true, id: had.sessionId };
    const why = this.ready();
    if (why) return { ok: false, error: why };
    if (this.starting.has(assignmentId)) return { ok: false, error: koText('acp_start_failed', { name: this.o.preset.name, why: 'starting' }) };
    this.starting.add(assignmentId);
    try {
      return await this.open(p, assignmentId, o);
    } finally {
      this.starting.delete(assignmentId);
    }
  }

  private async open(p: ProjectRecord, assignmentId: string, o: { resume?: string; token: () => string | null }): Promise<StartResult> {
    const name = this.o.preset.name;
    const fail = (why: string, detail?: string): StartResult => ({
      ok: false,
      error: koText('acp_start_failed', { name, why: why.slice(0, 300) }),
      ...(detail && { detail }),
    });
    const startMs = this.o.timing?.startMs ?? ACP_START_MS;
    let sdk: typeof import('@agentclientprotocol/sdk', { with: { 'resolution-mode': 'import' } });
    try {
      sdk = await import('@agentclientprotocol/sdk');
    } catch (err) {
      return fail(errText(err));
    }
    const token = o.token();
    let child: ChildProcess;
    try {
      // Only the preset's own argv: nothing from a client, the registry or the agent is appended.
      const cmd = commandArgv(this.o.bin, [...this.o.preset.argv], this.o.platform);
      child = spawn(cmd.file, cmd.args, {
        cwd: p.folder,
        env: { ...this.o.env(), ...(token && { [AGENT_TOKEN_ENV]: token }) },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        ...(cmd.windowsVerbatimArguments && { windowsVerbatimArguments: true }),
      });
    } catch (err) {
      return fail(errText(err));
    }
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString('utf8')).slice(-ACP_STDERR_KEEP);
    });
    child.stdin?.on('error', () => undefined); // EPIPE once it is gone: the exit says so
    const spawnError = new Promise<never>((_, reject) => child.once('error', reject));
    spawnError.catch(() => undefined);
    const conn: Conn = {
      assignmentId,
      name: p.name,
      cwd: p.folder,
      child,
      pid: child.pid ?? 0,
      startedAt: Date.now(),
      connection: null,
      sessionId: '',
      transcript: null,
      caps: { resume: false, load: false, close: false },
      busy: false,
      abort: new AbortController(),
      asks: new Set(),
      gone: false,
    };
    child.once('exit', (code, signal) => this.gone(conn, `exit ${code ?? signal ?? '?'}`));
    try {
      const app = sdk
        .client({ name: 'agent-tycoon' })
        .onNotification(sdk.methods.client.session.update, ({ params }) => this.onUpdate(conn, params))
        .onRequest(sdk.methods.client.session.requestPermission, ({ params, signal }) => {
          const answer = this.onPermission(conn, params, signal);
          conn.asks.add(answer);
          void answer.finally(() => conn.asks.delete(answer));
          return answer;
        });
      const stream = sdk.ndJsonStream(
        Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
        { maxMessageBytes: ACP_MESSAGE_MAX_BYTES },
      );
      const connection = app.connect(stream);
      conn.connection = connection;
      void connection.closed.then(
        () => this.gone(conn, 'connection closed'),
        (err: unknown) => this.gone(conn, `connection closed (${errText(err)})`),
      );
      const ask = <T>(what: string, run: Promise<T>) => within(Promise.race([run, spawnError]), startMs, what);
      const init = obj(
        await ask(
          'initialize',
          connection.agent.request(sdk.methods.agent.initialize, {
            protocolVersion: sdk.PROTOCOL_VERSION,
            // None: the agent uses its own tools; we never read, write or run for it.
            clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
            clientInfo: { name: 'agent-tycoon', version: '1' },
          }),
        ),
      );
      const agentCaps = obj(init.agentCapabilities);
      const sessionCaps = obj(agentCaps.sessionCapabilities);
      conn.caps = { load: agentCaps.loadSession === true, resume: !!sessionCaps.resume, close: !!sessionCaps.close };
      this.learned = { ...this.learned, resume: conn.caps.resume || conn.caps.load };
      const where = { cwd: p.folder, mcpServers: [] };
      let sessionId: string | undefined;
      if (o.resume) {
        try {
          if (conn.caps.resume) {
            await ask('session/resume', connection.agent.request(sdk.methods.agent.session.resume, { ...where, sessionId: o.resume }));
            sessionId = o.resume;
          } else if (conn.caps.load) {
            // Its replay comes as session/update for this id before the answer: conn.sessionId is not
            // set yet, so none of it is written again.
            await ask('session/load', connection.agent.request(sdk.methods.agent.session.load, { ...where, sessionId: o.resume }));
            sessionId = o.resume;
          }
        } catch (err) {
          this.o.log(`acp ${this.id} "${p.name}": could not continue ${o.resume} (${errText(err)}); a new session`);
        }
      }
      if (!sessionId) {
        const made = obj(await ask('session/new', connection.agent.request(sdk.methods.agent.session.new, where)));
        // Only an id the registry reads back (printable, no spaces): one it cannot read would leave the
        // registry unreadable at the next start and every project refused, Claude's included.
        if (typeof made.sessionId === 'string' && made.sessionId.length <= ACP_FIELD_MAX && AGENT_SESSION_ID_RE.test(made.sessionId))
          sessionId = made.sessionId;
      }
      if (!sessionId) throw new Error('no session id');
      if (conn.gone) throw new Error(maskText(stderr.trim()).split('\n').at(-1) || 'it ended');
      // L1: an id another live session of this agent holds in this folder (the same file) is not ours.
      if ([...this.conns.values()].some((c) => !c.gone && c.sessionId === sessionId && c.cwd === p.folder))
        throw new Error(`session id ${sessionId.slice(0, 80)} is another session's`);
      conn.sessionId = sessionId;
      conn.transcript = new AcpTranscript(acpTranscriptPath(this.o.home, this.id, p.folder, sessionId), sessionId, this.o.log);
      conn.transcript.begin();
      this.conns.set(assignmentId, conn);
      this.o.log(`acp ${this.id} "${p.name}": session ${sessionId} in ${p.folder} (pid ${conn.pid})`);
      this.changed();
      return { ok: true, id: sessionId, ...(o.resume && sessionId !== o.resume && { note: koText('acp_started_fresh') }) };
    } catch (err) {
      this.kill(conn);
      conn.gone = true;
      const code = obj(err).code;
      // ACP's auth_required: the agent wants its own login first.
      if (code === -32000) return { ok: false, error: koText('acp_auth', { name }) };
      // L2: an agent may echo its env or a key on stderr: masked before the log or the UI sees it.
      const tail = maskText(stderr.trim());
      this.o.log(`acp ${this.id} "${p.name}": not started (${errText(err)}) ${tail.slice(-300)}`);
      return fail(errText(err), tail.slice(-500) || undefined);
    }
  }

  private connOf(s: Pick<LiveSession, 'sessionId' | 'assignmentId'>): Conn | undefined {
    const all = [...this.conns.values()];
    return (
      (s.assignmentId ? all.find((c) => c.assignmentId === s.assignmentId) : undefined) ??
      all.find((c) => !!s.sessionId && c.sessionId === s.sessionId)
    );
  }

  private onUpdate(conn: Conn, params: unknown): void {
    try {
      const n = obj(params);
      if (conn.gone || !conn.sessionId || n.sessionId !== conn.sessionId) return;
      const kind = obj(n.update).sessionUpdate;
      if (kind === 'usage_update' && !this.learned.context) this.learned = { ...this.learned, context: true };
      conn.transcript?.update(n.update);
    } catch (err) {
      this.o.log(`acp ${this.id} "${conn.name}": update ignored (${errText(err)})`);
    }
  }

  /** Only the owner's button answers; anything else leaves the request open (no decision). */
  private async onPermission(conn: Conn, params: unknown, signal: AbortSignal) {
    try {
      const r = obj(params);
      if (conn.gone || !conn.sessionId || r.sessionId !== conn.sessionId) return CANCELLED;
      if (conn.asks.size >= ACP_ASKS_MAX) {
        this.o.log(`acp ${this.id} "${conn.name}": ${conn.asks.size} permission requests open; this one cancelled`);
        return CANCELLED;
      }
      const options = permissionOptions(r.options);
      const done = AbortSignal.any([signal, conn.abort.signal]);
      if (options.length) {
        const { name: tool, input } = toolUse(obj(r.toolCall));
        const chosen = await this.o.ask(conn.name, { tool, input, options }, done).catch((err: unknown) => {
          this.o.log(`acp ${this.id} "${conn.name}": permission card failed (${errText(err)})`);
          return null;
        });
        if (chosen && !done.aborted && options.some((x) => x.optionId === chosen))
          return { outcome: { outcome: 'selected' as const, optionId: chosen } };
        // M2: a newer request took the card: this one ends now, or the agent's turn waits on it forever.
        if (chosen === false) return CANCELLED;
      } else this.o.log(`acp ${this.id} "${conn.name}": a permission request with no valid option; left open`);
      await aborted(done);
    } catch (err) {
      this.o.log(`acp ${this.id} "${conn.name}": permission request: ${errText(err)}`);
    }
    return CANCELLED;
  }

  async deliver(p: ProjectRecord, text: string): Promise<DeliverResult> {
    const conn = this.conns.get(p.assignmentId ?? p.leadAssignmentId ?? '');
    if (!conn || conn.gone || !conn.connection || !conn.transcript) return 'notReady';
    if (conn.busy) return 'notReady';
    const { connection, transcript, sessionId } = conn;
    conn.busy = true;
    transcript.user(text);
    this.changed();
    void connection.agent
      .request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] })
      .then(
        () => transcript.end(),
        (err: unknown) => transcript.end(errText(err)),
      )
      .finally(() => {
        conn.busy = false;
        this.changed();
      });
    return 'typed';
  }

  async stop(s: LiveSession): Promise<StopResult> {
    const conn = this.connOf(s);
    if (!conn || conn.gone) return { ok: true };
    const { connection, sessionId } = conn;
    if (connection) {
      if (conn.busy) await connection.agent.notify('session/cancel', { sessionId }).catch(() => undefined);
      conn.abort.abort(); // open permission requests answer `cancelled` (the turn is cancelled)
      const closeMs = this.o.timing?.closeMs ?? ACP_CLOSE_MS;
      await within(Promise.allSettled([...conn.asks]), closeMs, 'answers').catch(() => undefined);
      await new Promise((resolve) => setImmediate(resolve)); // their answers written before the close
      if (conn.caps.close)
        await within(connection.agent.request('session/close', { sessionId }), closeMs, 'session/close').catch(
          () => undefined,
        );
    }
    this.kill(conn);
    return { ok: true };
  }

  /** The daemon stops: every child we started ends with it. */
  dispose(): void {
    for (const c of this.conns.values()) this.kill(c);
  }

  /** Our own child only: SIGTERM, then SIGKILL if it is still there. */
  private kill(conn: Conn): void {
    const { child } = conn;
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      child.stdin?.end();
      child.kill('SIGTERM');
      const t = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, this.o.timing?.killMs ?? ACP_KILL_GRACE_MS);
      t.unref?.();
    } catch (err) {
      this.o.log(`acp ${this.id}: stop pid ${conn.pid}: ${errText(err)}`);
    }
  }

  private gone(conn: Conn, why: string): void {
    if (conn.gone) return;
    conn.gone = true;
    conn.abort.abort();
    try {
      conn.connection?.close();
    } catch {
      /* already closed */
    }
    this.kill(conn);
    if (this.conns.get(conn.assignmentId) === conn) this.conns.delete(conn.assignmentId);
    if (conn.sessionId) this.o.log(`acp ${this.id} "${conn.name}": session ${conn.sessionId} ended (${why})`);
    this.changed();
  }
}
