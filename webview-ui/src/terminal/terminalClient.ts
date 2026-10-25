/**
 * Terminal data-plane client: one WebSocket per attached agent terminal.
 *
 * Deliberately NOT part of the MessageTransport abstraction. That interface
 * carries the AsyncAPI control plane (`send(msg: ClientMessage)`), and it is a
 * single multiplexed connection shared by the whole app. Terminal I/O is a
 * per-agent raw byte stream on its own socket, so forcing it through the same
 * seam would mean widening the protocol union with a message no other client can
 * use. See docs/design/standalone-terminal.md.
 */

import { TERMINAL_WS_PREFIX } from '../../../core/src/constants.js';
import { parseServerFrame } from '../../../core/src/terminalFrames.js';
import { WS_HEARTBEAT_MS } from '../constants.js';
import { reconnectDelayMs } from '../transport/reconnectBackoff.js';

export interface TerminalConnectionHandlers {
  onOutput(data: string): void;
  /** First frame of every (re)attach: a serialized snapshot of the server-side
   *  screen, laid out at cols×rows. Replace the terminal's content with it. */
  onReplay(data: string, cols: number, rows: number): void;
  onExit(exitCode: number): void;
  onStatusChange(status: TerminalConnectionStatus): void;
  /** cld-gui (T-0078): the server closed the socket for good (a 4xxx close), with its reason
   *  ('cap', 'no shell', 'shell closed', 'exited', 'proof', ...). */
  onRefused?(reason: string): void;
}

export interface TerminalConnectionOptions {
  /** cld-gui (T-0078): runs before every (re)connect. True: go ahead. False: the user has to
   *  act first (the connection stops, refused as 'proof'). A throw (offline, the daemon
   *  restarting) is retried on the usual ladder. `force`: the server just refused the last proof. */
  prepare?: (force: boolean) => Promise<boolean>;
}

export type TerminalConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'closed';

/** Where an agent's terminal socket connects; cld-gui points its chats at
 *  `/cld/attach/<background id>` (cld/chat.ts). */
export const terminalSocket = {
  path: (agentId: number): string => `${TERMINAL_WS_PREFIX}/${String(agentId)}`,
};

/**
 * A reconnecting terminal socket for one agent.
 *
 * The PTY outlives the socket server-side, so a reconnect replays the scrollback
 * ring and resumes -- dropping the connection never kills the user's session.
 */
export class TerminalConnection {
  private socket: WebSocket | null = null;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private exited = false;
  /** Last known geometry, re-sent on reconnect so a resize during a drop isn't lost. */
  private pending: { cols: number; rows: number } | null = null;
  /** cld-gui (T-0025): refused by the server (a 4xxx close), never reopened. */
  private refused = false;
  /** When the last frame arrived and when the page was last hidden (ms). */
  private lastFrameAt = 0;
  private hiddenAt = 0;

  // Declared as fields rather than constructor parameter properties:
  // `erasableSyntaxOnly` is on in the webview, and parameter properties emit
  // runtime code.
  private readonly agentId: number;
  private readonly socketPath?: string;
  private readonly handlers: TerminalConnectionHandlers;
  private readonly options: TerminalConnectionOptions;
  /** The server refused the last proof: ask `prepare` for a new one, once, before giving up. */
  private forceProof = false;
  private proofRetried = false;

  constructor(
    agentId: number,
    handlers: TerminalConnectionHandlers,
    socketPath?: string,
    options: TerminalConnectionOptions = {},
  ) {
    this.agentId = agentId;
    this.handlers = handlers;
    this.socketPath = socketPath;
    this.options = options;
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('pageshow', this.onPageShow);
  }

  // ── cld-gui (T-0025): back in the foreground ─────────────────

  private readonly onVisibility = (): void => {
    if (document.hidden) this.hiddenAt = Date.now();
    else this.onShow(Date.now() - this.hiddenAt);
  };

  /** Back from the back/forward cache: its socket was closed on the way in. */
  private readonly onPageShow = (e: PageTransitionEvent): void => {
    if (e.persisted) this.onShow(Infinity);
  };

  /** A socket that is gone is reopened now, skipping the backoff; so is one
   *  that was hidden and silent for the heartbeat window (iOS leaves those
   *  open but dead). Reopening is cheap: the server replays the screen. */
  private onShow(hiddenMs: number): void {
    if (this.disposed || this.exited || this.refused) return;
    const state = this.socket?.readyState;
    if (state === WebSocket.CONNECTING) return;
    if (
      state === WebSocket.OPEN &&
      (hiddenMs < WS_HEARTBEAT_MS || Date.now() - this.lastFrameAt < WS_HEARTBEAT_MS)
    ) {
      return;
    }
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.detach();
    this.attempt = Math.max(this.attempt, 1); // reported as reconnecting
    void this.connect();
  }

  async connect(): Promise<void> {
    if (this.disposed || this.exited) return;
    this.handlers.onStatusChange(this.attempt === 0 ? 'connecting' : 'reconnecting');

    if (this.options.prepare) {
      let ready: boolean;
      try {
        ready = await this.options.prepare(this.forceProof);
      } catch {
        this.scheduleReconnect(); // offline, or the daemon is restarting
        return;
      } finally {
        this.forceProof = false;
      }
      if (this.disposed || this.exited) return;
      if (!ready) {
        this.refused = true;
        this.handlers.onRefused?.('proof');
        this.handlers.onStatusChange('closed');
        return;
      }
    }

    // The standalone server disables this route, but preserve a cookie-only
    // connection shape for embedded-compatible clients: never leak a token.
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//${window.location.host}${this.socketPath ?? terminalSocket.path(this.agentId)}`;
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.onopen = () => {
      this.attempt = 0;
      this.proofRetried = false;
      this.handlers.onStatusChange('connected');
      // Re-assert geometry: the fresh PTY-side socket doesn't know our size.
      if (this.pending) this.resize(this.pending.cols, this.pending.rows);
    };

    socket.onmessage = (event: MessageEvent) => {
      this.lastFrameAt = Date.now();
      const frame = parseServerFrame(String(event.data));
      if (!frame) return;
      if (frame.type === 'output') {
        this.handlers.onOutput(frame.data);
      } else if (frame.type === 'replay') {
        this.handlers.onReplay(frame.data, frame.cols, frame.rows);
      } else {
        this.exited = true;
        this.handlers.onExit(frame.exitCode);
        this.handlers.onStatusChange('closed');
      }
    };

    socket.onclose = (event: CloseEvent) => {
      if (this.disposed || this.exited) return;
      // An application close code (bad token, forbidden origin, no such
      // session) is final: retrying can't fix any of them, and hammering an
      // auth-rejecting endpoint is pointless.
      if (event.code >= 4000 && event.code < 5000) {
        // A proof that went stale (or the daemon restarted and forgot it): get one more, once.
        if (this.options.prepare && event.reason === 'proof' && !this.proofRetried) {
          this.proofRetried = true;
          this.forceProof = true;
          this.detach();
          void this.connect();
          return;
        }
        console.error(
          `[Webview] Terminal: agent ${String(this.agentId)} rejected (${String(event.code)}: ${event.reason})`,
        );
        this.refused = true;
        this.handlers.onRefused?.(event.reason);
        this.handlers.onStatusChange('closed');
        return;
      }
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      // onclose always follows; reconnection is handled there.
    };
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.exited || this.reconnectTimer) return;
    this.handlers.onStatusChange('reconnecting');
    // A hidden page keeps no timers; showing it again reconnects at once.
    if (document.hidden) return;
    const delay = reconnectDelayMs(this.attempt);
    this.attempt++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private send(frame: Record<string, unknown>): boolean {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(frame));
    return true;
  }

  write(data: string): void {
    this.send({ type: 'input', data });
  }

  resize(cols: number, rows: number): void {
    this.pending = { cols, rows };
    this.send({ type: 'resize', cols, rows });
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('pageshow', this.onPageShow);
    this.detach();
  }

  /** Close the socket without its handlers: onclose would otherwise schedule
   *  a reconnect for a connection we're deliberately tearing down. */
  private detach(): void {
    if (this.socket) {
      this.socket.onclose = null;
      this.socket.onmessage = null;
      this.socket.onopen = null;
      this.socket.onerror = null;
      this.socket.close();
      this.socket = null;
    }
  }
}
