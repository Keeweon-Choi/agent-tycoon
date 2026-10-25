import * as fs from 'node:fs';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { koText, refused } from '../../../../core/src/cld/serverText.js';
import { encodeTerminalFrame, parseClientFrame } from '../../../../core/src/terminalFrames.js';
import { WS_CLOSE_NO_SESSION, WS_CLOSE_UNAUTHORIZED } from '../../constants.js';
import { isAllowedWebSocketOrigin, normalizeHostname } from '../../wsAuth.js';
import {
  clientAddress,
  isPublicListener,
  type Session,
  sessionIdFromCookie,
  type StandaloneAuth,
} from '../auth.js';
import { sameOriginRequest } from '../authRoutes.js';
import { detectHostInfo, listFolders } from '../folders.js';
import { type ShellRefusal, shellRefusal } from './gate.js';
import { ShellRegistry } from './registry.js';

interface ShellSocket {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', listener: (data: Buffer | string) => void): void;
  on(event: 'close', listener: () => void): void;
}

/** At most 20 open/join attempts per client per minute, including refused ones. */
class ShellRateLimit {
  private readonly clients = new Map<string, { since: number; count: number }>();
  allow(client: string, now = Date.now()): boolean {
    const old = this.clients.get(client);
    const bucket = !old || now - old.since >= 60_000 ? { since: now, count: 0 } : old;
    bucket.count++;
    this.clients.set(client, bucket);
    if (this.clients.size > 10_000) this.clients.delete(this.clients.keys().next().value!);
    return bucket.count <= 20;
  }
}

export interface ShellRouteOptions {
  auth: StandaloneAuth;
  allowedHostnames: ReadonlySet<string>;
  registry: ShellRegistry;
  /** Test seam for picker bounds. */
  home?: string;
}

export function registerShellRoutes(app: FastifyInstance, opts: ShellRouteOptions): void {
  const { auth, registry } = opts;
  const limiter = new ShellRateLimit();
  const hostAllowed = (request: FastifyRequest) =>
    opts.allowedHostnames.has(normalizeHostname(request.headers.host) ?? '');
  const session = (request: FastifyRequest) =>
    auth.session(sessionIdFromCookie(request.headers.cookie));
  const device = (s: Session) => auth.rowId(s);
  const requestClient = (request: FastifyRequest) => {
    const forwarded = request.headers['x-forwarded-for'];
    return clientAddress(
      request.socket.remoteAddress,
      Array.isArray(forwarded) ? forwarded.join(',') : forwarded,
      isPublicListener(request.socket),
    );
  };
  /** `join`: attaching to a shell this session already opened -- the cap is about opening. */
  const refusal = (
    request: FastifyRequest,
    s: Session | undefined,
    rate: boolean,
    join = false,
  ): ShellRefusal | null =>
    shellRefusal({
      enabled: true,
      privileged: !!s,
      registered: !!s && auth.shellDevice(s),
      // A proof 필수 no longer accepts (a key proof once a passkey binds) is none.
      proofAt: s && auth.stepUpFresh(s) ? s.shellProofAt : undefined,
      now: Date.now(),
      originAllowed: sameOriginRequest(request),
      hostAllowed: hostAllowed(request),
      rateAllowed: rate,
      openCount: s && !join ? registry.count(device(s)) : 0,
    });
  const status = (why: ShellRefusal) =>
    why === 'session' ? 401 : why === 'rate' ? 429 : why === 'cap' ? 409 : 403;
  /**
   * Listing and closing: any logged-in session at an allowed Host, like the
   * device list it belongs to (a session that may revoke a device, and so
   * kill its shells, may close one shell too). Opening and attaching need
   * the full gate.
   */
  const basic = (request: FastifyRequest, reply: FastifyReply): Session | undefined => {
    const s = session(request);
    if (!s) {
      reply.code(401).send({ ...refused('login_needed') });
      return;
    }
    if (!hostAllowed(request) || (request.headers.origin && !sameOriginRequest(request))) {
      reply.code(403).send({ ...refused('origin_mismatch') });
      return;
    }
    return s;
  };

  // `canOpen`: this session is a registered device (the 터미널 tab says why not otherwise).
  app.get('/api/shell', async (request, reply) => {
    const s = basic(request, reply);
    if (!s) return reply;
    return { shells: registry.list(), canOpen: auth.shellDevice(s), device: device(s) };
  });

  app.post<{ Body: { cwd?: unknown } | undefined }>('/api/shell', async (request, reply) => {
    const s = session(request);
    const why = refusal(request, s, limiter.allow(requestClient(request)));
    if (why) return reply.code(status(why)).send({ error: why });
    const cwd = request.body?.cwd;
    if (typeof cwd !== 'string' || cwd.length > 4096)
      return reply.code(400).send({ ...refused('pick_a_folder') });
    const answer = listFolders(
      { type: 'listFolders', requestId: 'shell', path: cwd },
      detectHostInfo(opts.home),
    );
    if (!answer.ok || !answer.path)
      return reply.code(403).send({ error: answer.error ?? koText('folder_not_allowed') });
    let canonical: string;
    try {
      canonical = fs.realpathSync(answer.path);
    } catch {
      return reply.code(403).send({ ...refused('folder_unreadable') });
    }
    if (
      !listFolders(
        { type: 'listFolders', requestId: 'shell', path: canonical },
        detectHostInfo(opts.home),
      ).ok
    )
      return reply.code(403).send({ error: koText('folder_not_allowed') });
    try {
      const shell = registry.open(device(s!), s!.handle, s!.label, canonical);
      return reply.code(201).send(shell);
    } catch (error) {
      console.warn(
        `[cld shell] spawn failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return reply.code(503).send({ ...refused('terminal_start_failed') });
    }
  });

  app.delete<{ Params: { id: string } }>('/api/shell/:id', async (request, reply) => {
    const s = basic(request, reply);
    if (!s) return reply;
    if (!sameOriginRequest(request)) return reply.code(403).send({ ...refused('origin_mismatch') });
    return registry.close(request.params.id, 'requested', s.label)
      ? { ok: true }
      : reply.code(404).send();
  });

  app.get<{ Params: { id: string } }>(
    '/cld/shell/:id',
    { websocket: true },
    (socket: ShellSocket, request) => {
      const s = session(request);
      const why = refusal(request, s, limiter.allow(requestClient(request)), true);
      if (
        why ||
        !isAllowedWebSocketOrigin(
          request.headers.origin,
          request.headers.host,
          opts.allowedHostnames,
        )
      ) {
        socket.close(WS_CLOSE_UNAUTHORIZED, why ?? 'origin');
        return;
      }
      const id = request.params.id;
      if (!registry.ownedBy(id, device(s!), s!.handle)) {
        socket.close(WS_CLOSE_NO_SESSION, 'no shell');
        return;
      }
      const pty = registry.get(id)!;
      const unbind = auth.bindSocket(sessionIdFromCookie(request.headers.cookie), () =>
        socket.close(WS_CLOSE_UNAUTHORIZED, 'signed out'),
      );
      const send = (data: string) => {
        if (socket.readyState === 1) socket.send(data);
      };
      // The shell ended itself (`exit`): say so, so the pane can tell that
      // from a shell closed from elsewhere. The close reason says it too.
      const offClose = registry.onClose(id, (reason) => {
        if (reason === 'exit')
          send(encodeTerminalFrame({ type: 'exit', exitCode: pty.exitStatus?.exitCode ?? 0 }));
        socket.close(WS_CLOSE_NO_SESSION, reason === 'exit' ? 'exited' : 'shell closed');
      });
      let replaySent = false;
      const pending: string[] = [];
      const forward = (frame: string) => {
        if (replaySent) send(frame);
        else pending.push(frame);
      };
      const offData = pty.onData((data) => {
        registry.touch(id);
        forward(encodeTerminalFrame({ type: 'output', data }));
      });
      const offExit = pty.onExit((exit) =>
        forward(
          encodeTerminalFrame({ type: 'exit', exitCode: exit.exitCode, signal: exit.signal }),
        ),
      );
      void pty.snapshot().then((data) => {
        if (socket.readyState !== 1) return;
        send(encodeTerminalFrame({ type: 'replay', data, cols: pty.cols, rows: pty.rows }));
        replaySent = true;
        const notice = registry.noticeFor(id);
        if (notice)
          send(encodeTerminalFrame({ type: 'output', data: `\r\n\x1b[33m${notice}\x1b[0m\r\n` }));
        for (const frame of pending) send(frame);
        pending.length = 0;
      });
      socket.on('message', (raw) => {
        if (raw.length > 65_536) {
          socket.close(1009, 'frame too large');
          return;
        }
        const frame = parseClientFrame(raw.toString());
        if (!frame) return;
        if (frame.type === 'input') {
          registry.touch(id);
          pty.write(frame.data);
        } else pty.resize(frame.cols, frame.rows);
      });
      socket.on('close', () => {
        offData();
        offExit();
        offClose();
        unbind();
      });
    },
  );

  // Shells that outlived the last daemon (in tmux) are ours again.
  const restored = registry.restore();
  if (restored) console.log(`[cld shell] ${restored} shell(s) restored after the restart`);
  // Compose with push subscription cleanup and other auth lifecycle observers.
  const previous = auth.onRowGone;
  auth.onRowGone = (id) => {
    previous?.(id);
    registry.closeForRow(id);
  };
  app.addHook('onClose', async () => registry.disposeAll());
}
