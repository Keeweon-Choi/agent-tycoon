/**
 * Our PTY host (ADR-0018 decision 1), `node cld-ptyhost.js <dir>`: a small detached process that
 * owns the agents' PTYs, so they outlive a restart of our daemon. Only a client that says the
 * token in <dir>/token (0600, in a 0700 folder) is served; what runs is the daemon's to decide.
 *
 * Each terminal has a headless xterm mirror (PtySession) that answers the terminal queries
 * (DA1, CPR) and Claude's OSC 7501 probe, before DA1 (programStatus.ts), so status reports flow
 * with or without a viewer. Output goes only to subscriptions (snapshot, then live); status and
 * exit go to every client. The terminal list is also written to <dir>/terminals.json, so the
 * daemon reads which agent runs where from a file, like Claude's own session files.
 *
 * Windows (TERM-P2): a named pipe instead of the socket file (endpointFor), the same token check,
 * node-pty's own ConPTY (useConptyDll) and its startup input check (conpty.ts).
 *
 * One host per folder: a second one finds the socket answering and leaves. A stale socket is
 * removed only when connecting proves nobody listens (ECONNREFUSED/ENOENT); a timeout proves
 * nothing (Orca's lesson). With no terminal for PTYHOST_IDLE_EXIT_MS since the last request it
 * ends: the daemon stays connected, so a client alone never keeps it up.
 */
import { randomBytes, timingSafeEqual } from 'crypto';
import * as fs from 'fs';
import * as net from 'net';

import {
  HOST_LOG_KEEP,
  HOST_LOG_MAX_BYTES,
  PTYHOST_CLIENT_BACKLOG_BYTES,
  PTYHOST_IDLE_EXIT_MS,
  PTYHOST_SCROLLBACK_LINES,
  TERMINAL_DEFAULT_COLS,
  TERMINAL_DEFAULT_ROWS,
} from '../../constants.js';
import type { PtyModule } from '../../terminal/ptyModule.js';
import { resolvePtyModule } from '../../terminal/ptyModule.js';
import { PtySession, spawnPty } from '../../terminal/ptySessionManager.js';
import { rotateFile } from '../audit.js';
import { writeJsonAtomic } from '../jsonFile.js';
import { commandArgv } from '../spawnJson.js';
import { spawnWithInputReader } from './conpty.js';
import type { ProgramStatus } from './programStatus.js';
import { watchProgramStatus } from './programStatus.js';
import type { TerminalInfo } from './protocol.js';
import { endpointFor, frame, lineReader, PTYHOST_VERSION } from './protocol.js';

interface Term {
  info: TerminalInfo;
  session: PtySession;
}

interface Client {
  sock: net.Socket;
  authed: boolean;
  subs: Map<string, () => void>;
  send(o: object): void;
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const isDim = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0 && (v as number) <= 1000;
const strRecord = (v: unknown): v is Record<string, string> =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every(isStr);

export function runHost(dir: string, o: { idleMs?: number; pty?: PtyModule } = {}): net.Server {
  const tokenText = fs.readFileSync(`${dir}/token`, 'utf-8').trim();
  const token = Buffer.from(tokenText);
  const sockPath = endpointFor(dir, tokenText);
  // A named pipe has no file: it goes with its server, and nothing of it is ours to remove.
  const win = process.platform === 'win32';
  const terminalsFile = `${dir}/terminals.json`;
  const terms = new Map<string, Term>();
  const clients = new Set<Client>();
  let serial = 0;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let pty: PtyModule | null = o.pty ?? null;

  const log = (line: string) => {
    try {
      const text = `${new Date().toISOString()} ${line}\n`;
      rotateFile(`${dir}/host.log`, Buffer.byteLength(text), HOST_LOG_MAX_BYTES, HOST_LOG_KEEP);
      fs.appendFileSync(`${dir}/host.log`, text, { mode: 0o600 });
    } catch {
      /* no log: nothing else to tell */
    }
  };
  const save = () => {
    try {
      writeJsonAtomic(terminalsFile, [...terms.values()].map((t) => t.info));
    } catch (err) {
      log(`terminals.json: ${String(err)}`);
    }
  };
  const broadcast = (o: object) => {
    for (const c of clients) if (c.authed) c.send(o);
  };
  /** (Re)start the idle clock when no terminal runs; each request restarts it (a spawn is coming). */
  // ponytail: a spawn in flight at the very moment the clock runs out is lost (start fails once).
  const idleCheck = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    if (terms.size) return;
    idleTimer = setTimeout(() => {
      log('idle: no terminal; exiting');
      shutdown();
    }, o.idleMs ?? PTYHOST_IDLE_EXIT_MS);
  };
  const shutdown = () => {
    server.close();
    try {
      if (!win) fs.rmSync(sockPath, { force: true });
      fs.rmSync(terminalsFile, { force: true });
    } catch {
      /* best effort */
    }
    process.exit(0);
  };

  async function spawnTerm(m: Record<string, unknown>): Promise<Record<string, unknown>> {
    const { file, args, cwd, env, meta } = m;
    if (!isStr(file) || !Array.isArray(args) || !args.every(isStr) || !isStr(cwd) || !strRecord(env))
      return { ok: false, error: 'bad spawn' };
    pty ??= resolvePtyModule().module;
    if (!pty) return { ok: false, error: 'no PTY module' };
    const mod = pty;
    const cols = isDim(m.cols) ? m.cols : TERMINAL_DEFAULT_COLS;
    const rows = isDim(m.rows) ? m.rows : TERMINAL_DEFAULT_ROWS;
    let id = randomBytes(4).toString('hex');
    while (terms.has(id)) id = randomBytes(4).toString('hex');
    const info: TerminalInfo = { id, pid: 0, cwd, startedAt: Date.now(), meta: strRecord(meta) ? meta : {} };
    let current: PtySession | null = null; // the last one made: a ConPTY started again replaces the first
    // A Windows .cmd/.bat launcher (npm's claude.cmd) through cmd.exe, escaped as spawnJson does;
    // node-pty takes that command line as it is. Its pid is cmd.exe's: claudePty joins by session id.
    const run = win ? commandArgv(file, args) : { file, args };
    const command = run.file;
    // node-pty on Windows takes one string as the command line as it is (its IPty typing allows it).
    const argv = ('windowsVerbatimArguments' in run ? run.args.join(' ') : run.args) as string[];
    const make = () => {
      const s = new PtySession(
        ++serial,
        spawnPty(mod, { agentId: serial, command, args: argv, cwd, env, replaceEnv: true, useConptyDll: win }, cols, rows),
        cols,
        rows,
        PTYHOST_SCROLLBACK_LINES,
      );
      // The mirror answers what the program asks the terminal (DA1, CPR, OSC 7501), from the
      // first byte: Windows ConPTY's own DA1 comes before the startup check below decides.
      s.mirror.onData((d) => s.write(d));
      watchProgramStatus(
        s.mirror,
        (d) => s.write(d),
        (st: ProgramStatus) => {
          if (current !== s) return;
          info.status = st;
          broadcast({ ev: 'status', t: id, ...st });
        },
      );
      current = s;
      return s;
    };
    let session: PtySession;
    try {
      session = win ? await spawnWithInputReader(make, log) : make();
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    info.pid = session.pid;
    terms.set(id, { info, session });
    session.onExit(({ exitCode, signal }) => {
      terms.delete(id);
      save();
      log(`exit ${id} pid ${info.pid} code ${exitCode}${signal ? ` signal ${signal}` : ''}`);
      broadcast({ ev: 'exit', t: id, code: exitCode, ...(signal && { signal }) });
      idleCheck();
    });
    save();
    log(`spawn ${id} pid ${info.pid} ${file} in ${cwd}`);
    idleCheck();
    return { ok: true, id, pid: info.pid };
  }

  async function handle(c: Client, m: Record<string, unknown>): Promise<Record<string, unknown>> {
    const t = isStr(m.t) ? terms.get(m.t) : undefined;
    switch (m.op) {
      case 'spawn':
        return spawnTerm(m);
      case 'list':
        return { ok: true, terminals: [...terms.values()].map((x) => x.info) };
      case 'write':
        if (!t || !isStr(m.data)) return { ok: false, error: 'no terminal' };
        t.session.write(m.data);
        return { ok: true };
      case 'resize':
        if (!t || !isDim(m.cols) || !isDim(m.rows)) return { ok: false, error: 'no terminal' };
        t.session.resize(m.cols, m.rows);
        return { ok: true };
      case 'kill':
        if (!t) return { ok: false, error: 'no terminal' };
        t.session.dispose(); // SIGHUP, SIGKILL after the grace
        return { ok: true };
      case 'subscribe': {
        // The client names the subscription (so its first data never beats its listener).
        if (!t || !isStr(m.s) || !m.s.startsWith(`${t.info.id}.`) || m.s.length > 64 || c.subs.has(m.s))
          return { ok: false, error: 'no terminal' };
        const s = m.s;
        // Snapshot-then-live: output arriving while the snapshot is taken waits behind it.
        let queue: string[] | null = [];
        const off = t.session.onData((d) => (queue ? queue.push(d) : c.send({ ev: 'data', s, d })));
        c.subs.set(s, off);
        const snapshot = await t.session.snapshot();
        setImmediate(() => {
          for (const d of queue ?? []) c.send({ ev: 'data', s, d });
          queue = null;
        });
        return { ok: true, s, snapshot, cols: t.session.cols, rows: t.session.rows };
      }
      case 'screen':
        if (!t) return { ok: false, error: 'no terminal' };
        return { ok: true, snapshot: await t.session.snapshot({ scrollback: 0 }), cols: t.session.cols, rows: t.session.rows };
      case 'unsubscribe':
        if (isStr(m.s)) {
          c.subs.get(m.s)?.();
          c.subs.delete(m.s);
        }
        return { ok: true };
      default:
        return { ok: false, error: 'unknown op' };
    }
  }

  const server = net.createServer((sock) => {
    const c: Client = {
      sock,
      authed: false,
      subs: new Map(),
      send: (o) => {
        if (sock.destroyed) return;
        // A client that does not read (a stuck daemon) must not grow the host without bound.
        if (sock.writableLength > PTYHOST_CLIENT_BACKLOG_BYTES) {
          log('client dropped: output backlog');
          sock.destroy();
          return;
        }
        sock.write(frame(o));
      },
    };
    clients.add(c);
    sock.on(
      'data',
      lineReader(
        (m) => {
          const r = m.r;
          if (!c.authed) {
            const said = Buffer.from(isStr(m.token) ? m.token : '');
            if (m.op !== 'hello' || said.length !== token.length || !timingSafeEqual(said, token)) {
              log('client refused: bad hello');
              sock.destroy();
              return;
            }
            if (m.version !== PTYHOST_VERSION) {
              c.send({ r, ok: false, error: `version ${PTYHOST_VERSION}` });
              sock.end();
              return;
            }
            c.authed = true;
            idleCheck();
            c.send({ r, ok: true, version: PTYHOST_VERSION, pid: process.pid });
            return;
          }
          idleCheck();
          handle(c, m).then(
            (reply) => c.send({ r, ...reply }),
            (err: unknown) => c.send({ r, ok: false, error: String(err) }),
          );
        },
        () => sock.destroy(),
      ),
    );
    const gone = () => {
      for (const off of c.subs.values()) off();
      c.subs.clear();
      clients.delete(c);
    };
    sock.on('close', gone);
    sock.on('error', () => undefined);
  });

  const listen = () => server.listen(sockPath, () => log(`listening, pid ${process.pid}`));
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code !== 'EADDRINUSE') {
      log(`listen: ${err.message}`);
      process.exit(1);
    }
    const probe = net.connect(sockPath);
    const timer = setTimeout(() => {
      log('another host may be alive (no answer, no refusal): leaving');
      process.exit(1);
    }, 1_000);
    probe.on('connect', () => {
      log('another host is listening: leaving');
      process.exit(0);
    });
    probe.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (e.code !== 'ECONNREFUSED' && e.code !== 'ENOENT') process.exit(1);
      if (!win) fs.rmSync(sockPath, { force: true });
      listen();
    });
  });
  // Detached with no terminal of our own: a hangup is never ours (the PTYs' children get theirs).
  process.on('SIGHUP', () => undefined);
  listen();
  idleCheck();
  return server;
}

if (require.main === module) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: cld-ptyhost.js <dir>');
    process.exit(2);
  }
  process.umask(0o077);
  runHost(dir);
}
