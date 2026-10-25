import fastifyCors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import Fastify from 'fastify';
import * as fs from 'fs';
import * as path from 'path';

import type { AgentRuntime } from './agentRuntime.js';
import type { AgentStateStore } from './agentStateStore.js';
import { isLocalRequest, redactLoginCode, sessionIdFromCookie, StandaloneAuth } from './cld/auth.js';
import {
  hostBearerValid,
  registerStandaloneAuth,
  sameOriginRequest,
  standaloneRequestAuthorized,
} from './cld/authRoutes.js';
import type { ChatManager } from './cld/chat.js';
import { registerChatRoute, registerChatSettingsRoutes } from './cld/chat.js';
import { registerProjectFileRoutes } from './cld/files/routes.js';
import { cldHooks, type SocketStepUp } from './cld/hooks.js';
import { answerFor } from './cld/remote/healthChallenge.js';
import { ShellRegistry } from './cld/shell/registry.js';
import { registerShellRoutes } from './cld/shell/routes.js';
import type {
  AssetCache,
  ReloadAssetsSideEffect,
  SetHooksEnabledSideEffect,
} from './clientMessageHandler.js';
import { handleClientMessage } from './clientMessageHandler.js';
import {
  HOOK_API_PREFIX,
  MAX_HOOK_BODY_SIZE,
  SERVER_HEALTH_PROTOCOL_VERSION,
  WS_CLOSE_FORBIDDEN_ORIGIN,
  WS_CLOSE_UNAUTHORIZED,
} from './constants.js';
import type { PtySessionManager } from './terminal/ptySessionManager.js';
import type { AgentState } from './types.js';
import {
  bearerTokenValid,
  isAllowedWebSocketOrigin,
  normalizeHostname,
  privilegedHostnames,
  redactTokenQuery,
} from './wsAuth.js';

/** Options for creating the HTTP + WebSocket server. */
export interface HttpServerOptions {
  /** true = VS Code embedded mode (ephemeral port, no static, quiet logging) */
  embedded: boolean;
  /** Host to bind to. Default: '127.0.0.1' */
  host?: string;
  /** Port to listen on. Default: 0 (auto-assign) */
  port?: number;
  /** Test seam: build and ready routes without binding a TCP listener. */
  listen?: boolean;
  /** Bearer auth token for hook and WebSocket endpoints */
  token: string;
  /** AgentStateStore for WebSocket broadcast piping */
  store: AgentStateStore;
  /** Shared agent lifecycle core (for toggle side effects + standalone restore). Optional in embedded mode. */
  runtime?: AgentRuntime;
  /** Path to SPA dist directory for static serving (standalone only) */
  staticDir?: string;
  /** Cached assets loaded at startup (standalone only) */
  assetCache?: AssetCache;
  /** Callback when a hook event is received */
  onHookEvent?: (providerId: string, event: Record<string, unknown>) => void;
  /** Invoked when setHooksEnabled is toggled via WebSocket. Standalone installs/uninstalls hooks here. */
  onSetHooksEnabled?: SetHooksEnabledSideEffect;
  /** Invoked when an external asset directory is added/removed. Standalone reloads + re-broadcasts assets here. */
  onReloadAssets?: ReloadAssetsSideEffect;
  /** PTY terminals for standalone-launched agents. Absent = terminal feature off
   *  (VS Code embedded mode, where the editor owns terminals). */
  ptyManager?: PtySessionManager;
  /** Extra Host names (beyond loopback and a specific bind address) a
   *  privileged standalone handshake may arrive under -- e.g. a reverse proxy's
   *  public name. See wsAuth.privilegedHostnames. */
  allowedHosts?: readonly string[];
  /** Legacy input, retained only so an old caller starts safely; it is ignored. */
  trustedTailscaleUsers?: readonly string[];
  /** Process-local standalone credentials. Omitted only by embedded callers. */
  auth?: StandaloneAuth;
  /** cld-gui chat (T-0014, --allow-chat). Absent: /cld/attach/* answers 404. */
  chat?: ChatManager;
  /** Host opt-in for trusted-device shells. */
  allowTerminal?: boolean;
  /** Injectable PTY registry for shell route tests. */
  shellRegistry?: ShellRegistry;
  /** Test seam for picker home bounds. */
  shellHome?: string;
}

/** Result of createHttpServer(). */
export interface HttpServerHandle {
  app: FastifyInstance;
  port: number;
}

const startTime = Date.now();

/** The served page's entry module, normalized for comparison with a client page. */
export function entryModuleSrc(indexHtml: string): string | undefined {
  for (const match of indexHtml.matchAll(/<script\b([^>]*)>/gi)) {
    const attributes = match[1];
    if (scriptAttribute(attributes, 'type')?.toLowerCase() !== 'module') continue;
    const src = scriptAttribute(attributes, 'src');
    if (!src) continue;
    return src.replace(/^(?:\.\/|\/)+/, '') || undefined;
  }
  return undefined;
}

/** Read the build marker once while creating the standalone server. */
export function webBuildFromStaticDir(staticDir: string): string | undefined {
  try {
    return entryModuleSrc(fs.readFileSync(path.join(staticDir, 'index.html'), 'utf8'));
  } catch {
    return undefined;
  }
}

function scriptAttribute(attributes: string, name: string): string | undefined {
  const pattern = new RegExp(
    `\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\`]+))`,
    'i',
  );
  const match = pattern.exec(attributes);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

/**
 * Create a Fastify server with hook endpoint, health check, and WebSocket support.
 *
 * All Fastify-specific code lives in this file. The rest of the server layer is
 * framework-agnostic. If Fastify is ever replaced, only this file changes.
 */
export async function createHttpServer(options: HttpServerOptions): Promise<HttpServerHandle> {
  const app = Fastify({
    // Standalone logs every request. The privilege token rides `/ws?token=`
    // and `/terminal/:id?token=` handshakes, so the url is redacted before it
    // is written -- otherwise every (re)connect would put the secret in stdout
    // and any log file (see wsAuth.redactTokenQuery).
    logger: options.embedded
      ? false
      : { level: cldHooks.logLevel ?? 'info', serializers: { req: serializeRequestForLog } },
    bodyLimit: MAX_HOOK_BODY_SIZE,
  });

  // S-22: standalone is same-origin (SPA + API on one port); reflecting any Origin there helps only a foreign page.
  if (options.embedded) await app.register(fastifyCors, { origin: true });
  await app.register(fastifyWebsocket);

  const host = options.host ?? '127.0.0.1';
  // cld-gui: a Set cld remote adds its public names to (cldHooks.onListening).
  const allowedHostnames = new Set(privilegedHostnames(host, options.allowedHosts ?? []));
  const runtimeHosts = [...(options.allowedHosts ?? [])];
  const configuredHosts = new Set(allowedHostnames);
  if (!options.embedded)
    cldHooks.dropRemoteHost = (name) => {
      // S-22: a name a closed tunnel left behind must not stay a privileged Host. Configured names stay.
      if (configuredHosts.has(name)) return;
      allowedHostnames.delete(name);
      const at = runtimeHosts.indexOf(name);
      if (at >= 0) runtimeHosts.splice(at, 1);
    };
  if (!options.embedded)
    cldHooks.allowRemoteHost = (name) => {
      const known = allowedHostnames.has(name);
      allowedHostnames.add(name);
      if (!runtimeHosts.includes(name)) runtimeHosts.push(name);
      // O3: a new public name is an exposure change (the count only; names are not secrets but are not needed).
      if (!known) auth?.audit.write({ kind: 'allowedHosts', detail: allowedHostnames.size });
    };
  const auth = options.embedded ? undefined : (options.auth ?? new StandaloneAuth());
  const webBuild = !options.embedded && options.staticDir ? webBuildFromStaticDir(options.staticDir) : undefined;

  if (!options.embedded)
    app.addHook('onSend', async (request, reply, payload) => {
      const type = String(reply.getHeader('content-type') ?? '');
      if (!type.startsWith('text/html') || reply.getHeader('content-security-policy'))
        return payload;
      const host = request.headers.host;
      const name = normalizeHostname(host);
      // An arbitrary Host can reach read-only pages. It must never become a CSP source.
      const sockets =
        name && allowedHostnames.has(name) && host ? ` wss://${host} ws://${host}` : '';
      reply.header(
        'content-security-policy',
        `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'${sockets}; worker-src 'self'; manifest-src 'self'; media-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
      );
      return payload;
    });

  // Static SPA serving (standalone mode only)
  if (!options.embedded && options.staticDir) {
    await app.register(fastifyStatic, {
      root: options.staticDir,
      prefix: '/',
    });
    // HTML5 history fallback, for logged-in clients only: a public path that
    // names no file must not answer with the app shell.
    app.setNotFoundHandler((request, reply) => {
      if (auth && !standaloneRequestAuthorized(request, options.token, auth))
        return reply.code(401).type('text/plain').send('unauthorized');
      // An unknown API call is a 404, not the app shell.
      if (request.method !== 'GET' && request.method !== 'HEAD') return reply.code(404).send();
      reply.sendFile('index.html');
    });
  }

  // ── Routes ──────────────────────────────────────────────────

  registerHealthRoute(app, options.token);
  // cld-gui: the session gate and the login routes (cld/authRoutes.ts).
  if (!options.embedded && auth)
    registerStandaloneAuth(app, {
      token: options.token,
      auth,
      allowedHosts: runtimeHosts,
      loginAssetsDir: options.staticDir && path.join(options.staticDir, '..', 'login'),
      chat: options.chat !== undefined,
      allowTerminal: options.allowTerminal === true,
      broadcast: (message) => options.store.broadcast(message),
    });
  registerHookRoute(app, options, auth);
  registerWebSocketRoute(app, options, allowedHostnames, auth, webBuild);
  if (!options.embedded && auth && options.chat) {
    registerChatSettingsRoutes(
      app,
      options.chat,
      sessionOrBearerAuth(options.token, auth),
      sameOriginRequest,
    );
    registerChatRoute(
      app,
      options.chat,
      (request) => standaloneWsRejection(request, options.token, auth, allowedHostnames),
      (request, socket) => bindSessionSocket(auth, request, socket),
    );
  }
  // cld-gui: our routes (character presets), behind the login session.
  if (!options.embedded && auth) {
    cldHooks.registerRoutes?.(
      app,
      sessionOrBearerAuth(options.token, auth),
      (request) => auth.stepUpFresh(auth.session(sessionIdFromCookie(request.headers.cookie))),
      (request) => {
        const session = auth.session(sessionIdFromCookie(request.headers.cookie));
        return session && auth.actorLabel(session);
      },
      (request) => {
        const host = hostBearerValid(request, options.token);
        return { host, remote: !host && !isLocalRequest(request) };
      },
    );
    registerProjectFileRoutes(app, auth, () => cldHooks.projectFolders?.() ?? []);
    cldHooks.useAuth?.(auth);
  }
  if (!options.embedded && auth && options.allowTerminal)
    registerShellRoutes(app, {
      auth,
      allowedHostnames,
      registry:
        // The host's tmux + shells.json registry comes only from the daemon
        // (server.ts): a server built here, by a test, never touches them.
        options.shellRegistry ??
        new ShellRegistry(undefined, (notice) => options.store.broadcast({ ...notice })),
      home: options.shellHome,
    });

  // ── Listen ──────────────────────────────────────────────────

  if (options.listen === false) {
    await app.ready();
    return { app, port: 0 };
  }
  await app.listen({ host, port: options.port ?? 0 });
  const address = app.server.address();
  const port = typeof address === 'object' ? (address?.port ?? 0) : 0;
  if (!options.embedded) cldHooks.onListening?.({ app, allowedHostnames });

  return { app, port };
}

// ── Health ──────────────────────────────────────────────────────

/** Which side of a Windows PC this daemon runs on (P7: the installers keep one local host per Windows
 *  user and tell a WSL daemon from a Windows one by it): win32 | wsl | linux | darwin. */
function hostOs(): string {
  if (process.platform !== 'linux') return process.platform;
  try {
    return /microsoft/i.test(fs.readFileSync('/proc/version', 'utf-8')) ? 'wsl' : 'linux';
  } catch {
    return 'linux';
  }
}
const HOST_OS = hostOs();

function registerHealthRoute(app: FastifyInstance, token: string): void {
  app.get('/api/health', async (request) => {
    const health = {
      status: 'ok',
      service: 'cld-gui',
      version: process.env.CLD_GUI_VERSION ?? '',
      protocol: SERVER_HEALTH_PROTOCOL_VERSION,
      os: HOST_OS,
    };
    // O6: a nonce this daemon itself just issued (its custom-address self-test) is answered with the
    // reply it made up for it; any other nonce gets the plain body, so nothing here can be asked.
    const reply = answerFor((request.query as { cldNonce?: unknown } | undefined)?.cldNonce);
    if (reply !== undefined) Object.assign(health, { cldReply: reply });
    if (!hostBearerValid(request, token)) return health;
    return {
      ...health,
      uptime: Math.floor((Date.now() - startTime) / 1000),
      pid: process.pid,
    };
  });
}

// ── Hook Events ────────────────────────────────────────────────

function registerHookRoute(
  app: FastifyInstance,
  options: HttpServerOptions,
  auth: StandaloneAuth | undefined,
): void {
  app.post<{
    Params: { providerId: string };
    Body: Record<string, unknown>;
  }>(
    `${HOOK_API_PREFIX}/:providerId`,
    {
      preHandler:
        options.embedded || !auth
          ? bearerAuth(options.token)
          : sessionOrBearerAuth(options.token, auth),
      schema: {
        params: {
          type: 'object',
          properties: {
            providerId: { type: 'string', pattern: '^[a-z0-9-]+$' },
          },
          required: ['providerId'],
        },
      },
    },
    async (request, reply) => {
      const { providerId } = request.params;
      const event = request.body;

      if (event.session_id && event.hook_event_name) {
        options.onHookEvent?.(providerId, event);
      }

      reply.send('ok');
    },
  );
}

// ── WebSocket ──────────────────────────────────────────────────

function registerWebSocketRoute(
  app: FastifyInstance,
  options: HttpServerOptions,
  allowedHostnames: ReadonlySet<string>,
  auth: StandaloneAuth | undefined,
  webBuild: string | undefined,
): void {
  app.get('/ws', { websocket: true }, (socket, request) => {
    // CONNECTION gate. Embedded (VS Code) requires the Bearer token. Standalone
    // requires a same-origin handshake instead (isAllowedWebSocketOrigin), so a
    // non-browser local client with no Origin can still watch the office. What
    // may be DONE over an accepted connection is a separate question, decided
    // below.
    const rejection = options.embedded
      ? bearerTokenValid(request.headers.authorization, options.token)
        ? null
        : ([WS_CLOSE_UNAUTHORIZED, 'unauthorized'] as const)
      : standaloneWsRejection(request, options.token, auth, allowedHostnames);
    if (rejection) {
      socket.close(rejection[0], rejection[1]);
      return;
    }

    // Both modes prove privilege with the SAME out-of-band secret, differently
    // carried: embedded sends the Bearer token it was handed in-process;
    // standalone sends the `?token=` the CLI printed in the local URL and the
    // SPA forwarded on this handshake, and it must arrive under an allowed Host
    // -- the same verdict the terminal socket applies. A network POSITION
    // never grants privilege, because every position is reproducible by a
    // forwarder; the Host allowlist can only take it away.
    const privileged = true;
    // S1: a remote session's dangerous engine actions need a fresh step-up; this PC's own
    // browser and the host's Bearer token (no session) keep working as before.
    const stepUp: SocketStepUp | undefined =
      !options.embedded && auth
        ? {
            remote: !isLocalRequest(request) && !hostBearerValid(request, options.token),
            fresh: () => auth.stepUpFresh(auth.session(sessionIdFromCookie(request.headers.cookie))),
          }
        : undefined;

    const { store } = options;
    // One send per socket, so cld hooks can tell this client apart on close.
    const send = (m: Record<string, unknown>) => safeSend(socket, m);
    // cld-gui (T-0022): signing this session out closes its socket.
    const unbind = bindSessionSocket(auth, request, socket);

    // Pipe store events to WebSocket client
    const onAgentAdded = (id: number, agent: AgentState) => {
      safeSend(socket, {
        type: 'agentCreated',
        id,
        directoryName: agent.directoryName,
        isExternal: agent.isExternal || undefined,
        isTeammate: agent.leadAgentId !== undefined || undefined,
        teammateName: agent.agentName,
        parentAgentId: agent.leadAgentId,
        teamName: agent.teamName,
        hooksOnly: agent.hooksOnly || undefined,
        palette: agent.palette,
        hueShift: agent.hueShift,
      });
    };

    const onAgentRemoved = (id: number) => {
      safeSend(socket, { type: 'agentClosed', id });
    };

    const onBroadcast = (message: Record<string, unknown>) => {
      safeSend(socket, message);
    };

    store.on('agentAdded', onAgentAdded);
    store.on('agentRemoved', onAgentRemoved);
    store.on('broadcast', onBroadcast);
    cldHooks.onClientOpened?.(send, auth?.rowIdOf(sessionIdFromCookie(request.headers.cookie)));

    // Handle incoming client messages
    socket.on('message', (data: Buffer | string) => {
      try {
        const msg = JSON.parse(data.toString()) as Record<string, unknown>;
        // The page's 10 s looking beat (U-49) is not worth a log line each.
        if (!options.embedded && msg.type && msg.type !== 'viewerVisibility') {
          console.log('[Pixel Agents] WS client message:', msg.type);
        }
        handleClientMessage(msg, send, {
          store,
          runtime: options.runtime,
          cache: options.assetCache ?? null,
          onSetHooksEnabled: options.onSetHooksEnabled,
          onReloadAssets: options.onReloadAssets,
          privileged,
          userAgent: request.headers['user-agent'],
          stepUp,
          ptyManager: options.ptyManager,
          standalone: !options.embedded,
          allowTerminal: options.allowTerminal === true,
          webBuild,
        });
      } catch {
        // Malformed JSON, ignore
      }
    });

    socket.on('close', () => {
      unbind();
      store.off('agentAdded', onAgentAdded);
      store.off('agentRemoved', onAgentRemoved);
      store.off('broadcast', onBroadcast);
      cldHooks.onClientClosed?.(send);
    });
  });
}

// ── Auth Helper ────────────────────────────────────────────────

/** cld-gui (T-0022): close a socket when its login session is signed out. */
function bindSessionSocket(
  auth: StandaloneAuth | undefined,
  request: FastifyRequest,
  socket: { close: (code: number, reason: string) => void },
): () => void {
  return (
    auth?.bindSocket(sessionIdFromCookie(request.headers.cookie), () =>
      socket.close(WS_CLOSE_UNAUTHORIZED, 'signed out'),
    ) ?? (() => undefined)
  );
}

/** The standalone /ws gate, also cld chat's: a same-origin handshake from a
 *  logged-in browser (session cookie or Bearer). A close code and reason, or null. */
function standaloneWsRejection(
  request: FastifyRequest,
  token: string,
  auth: StandaloneAuth | undefined,
  allowedHostnames: ReadonlySet<string>,
): readonly [number, string] | null {
  if (!isAllowedWebSocketOrigin(request.headers.origin, request.headers.host, allowedHostnames)) {
    return [WS_CLOSE_FORBIDDEN_ORIGIN, 'forbidden origin'];
  }
  if (!auth || !standaloneRequestAuthorized(request, token, auth)) {
    return [WS_CLOSE_UNAUTHORIZED, 'unauthorized'];
  }
  return null;
}

function bearerAuth(expectedToken: string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!bearerTokenValid(request.headers.authorization, expectedToken)) {
      reply.code(401).send('unauthorized');
    }
  };
}

function sessionOrBearerAuth(expectedToken: string, auth: StandaloneAuth) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    if (!standaloneRequestAuthorized(request, expectedToken, auth)) {
      reply.code(401).send('unauthorized');
    }
  };
}

// ── Logging ────────────────────────────────────────────────────

/** Fastify's default request serializer, minus the token query. Exported so a
 *  test can pin that the secret never reaches the log line. */
export function serializeRequestForLog(request: FastifyRequest): Record<string, unknown> {
  return {
    method: request.method,
    url: redactLoginCode(redactTokenQuery(request.url)),
    hostname: request.hostname,
    remoteAddress: request.ip,
    remotePort: request.socket.remotePort,
  };
}

// ── Utilities ──────────────────────────────────────────────────

function safeSend(
  socket: { send: (data: string) => void; readyState: number },
  message: Record<string, unknown>,
): void {
  // WebSocket.OPEN = 1
  if (socket.readyState === 1) {
    socket.send(JSON.stringify(message));
  }
}
