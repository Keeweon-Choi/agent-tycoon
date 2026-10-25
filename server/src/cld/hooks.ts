/**
 * The one seam between upstream pixel-agents and cld-gui code. Upstream calls
 * these (when set) from the WebSocket handshake and message dispatch; with
 * nothing set, upstream behaves exactly as before.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { StandaloneAuth } from './auth.js';
import type { ProjectFolder } from './engine/git/repoRead.js';

/** A socket's S1 standing: `remote` (not this PC or the host token), `fresh()` its session's step-up. */
export interface SocketStepUp {
  remote: boolean;
  fresh(): boolean;
}

export type WsSend = (message: Record<string, unknown>) => void;

export interface CldHooks {
  /** Current registered engine project folders for the file browser. */
  projectFolders?(): ProjectFolder[];
  /** The cld office always answers with its generated layout plus decor. */
  layoutFor?(saved: Record<string, unknown> | null): Record<string, unknown> | undefined;
  /** The cld office keeps an editor save as decor; true: handled (layout.json is not written). */
  saveLayout?(layout: Record<string, unknown>, send: WsSend): boolean;
  /** Seat (chair uid) for an agent; wins over the persisted seat. */
  seatFor?(agentId: number): string | undefined;
  /** Extra Directory -> Area mappings (the user's own mappings win). */
  areaMappings?(): Record<string, string[]>;
  /** Fastify log level (standalone); unset keeps upstream's `info`. */
  logLevel?: string;
  /** A /ws socket passed the connection gate. Viewers are counted here, not on
   *  webviewReady: the webview does not resend that after a reconnect.
   *  `device`: the login's device-list row (T-0039), when it is a browser session. */
  onClientOpened?(send: WsSend, device?: string): void;
  /** After a client's webviewReady handshake: send snapshots. */
  onClientReady?(send: WsSend): void;
  /** A client message upstream does not know (statusView, chatSend, ...).
   *  `privileged`: the connection's verdict (the actions refuse without it);
   *  `userAgent`: the /ws upgrade request's (names the device in the log). */
  onClientMessage?(
    msg: Record<string, unknown>,
    send: WsSend,
    privileged: boolean,
    userAgent?: string,
    /** S1: how this connection stands for a dangerous action; absent = as today. */
    stepUp?: SocketStepUp,
  ): void;
  /** A client's socket closed (same `send` as in onClientOpened/onClientReady). */
  onClientClosed?(send: WsSend): void;
  /** Standalone only: the login store, once (T-0039: a revoked device's push goes). */
  useAuth?(auth: StandaloneAuth): void;
  /** Device-list rows (device key id / session handle) that have Web Push on; absent: push is not built. */
  pushDevices?(): ReadonlySet<string>;
  /** Standalone only: add routes; `auth` is the login-session (or Bearer) check. */
  registerRoutes?(
    app: FastifyInstance,
    auth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>,
    /** S1: this request's session has a fresh step-up (the shell gate's window). */
    stepUpFresh?: (request: FastifyRequest) => boolean,
    /** O3: the logged-in device behind this request, as the security record names it. */
    actorOf?: (request: FastifyRequest) => string | undefined,
    /** P3a: the host's Bearer token, or a remote device (not this PC, not the host). */
    kindOf?: (request: FastifyRequest) => { host: boolean; remote: boolean },
  ): void;
  /** Standalone only, after listen: cld remote (T-0024) adds its LAN and public
   *  listeners, which hand requests to `app.server`, and the names they answer
   *  to join the /ws Host allowlist. */
  onListening?(server: { app: FastifyInstance; allowedHostnames: Set<string> }): void;
  /** A newly configured Serve hostname becomes usable without restarting the daemon. */
  allowRemoteHost?(host: string): void;
  /** A name `allowRemoteHost` added stops being a privileged Host (its tunnel closed). */
  dropRemoteHost?(host: string): void;
  /** The one address every invitation carries, ending in `/` (T-0024). */
  canonicalUrl?(): string | undefined;
  /** A checked and currently active outside address, for moving a registered device. */
  verifiedOutsideUrl?(): string | undefined;
}

export const cldHooks: CldHooks = {};
