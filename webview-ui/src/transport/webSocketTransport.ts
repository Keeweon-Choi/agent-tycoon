import {
  TRANSPORT_STATE_CONNECTED,
  TRANSPORT_STATE_CONNECTING,
  TRANSPORT_STATE_DISCONNECTED,
  TRANSPORT_STATE_RECONNECTING,
} from '../../../core/src/constants.js';
import type { ClientMessage, ServerMessage } from '../../../core/src/messages.js';
import { LOOKING_BEAT_MS, WS_HEARTBEAT_MS } from '../constants.js';
import { reconnectDelayMs } from './reconnectBackoff.js';
import type { MessageTransport, TransportState } from './types.js';

/**
 * cld-gui (T-0025): the key of a message that sets this client's state on the
 * server, which the server forgets with the socket — the handshake, the page's
 * visibility, the panels it watches — or null. `on: false` ends that state.
 */
export function sessionKey(msg: ClientMessage): string | null {
  switch (msg.type) {
    case 'webviewReady':
    case 'viewerVisibility':
      return msg.type;
    case 'statusView':
      return `statusView:${msg.name}`;
    case 'chatView':
      return `chatView:${msg.agentId}`;
    case 'workView':
      return `workView:${msg.kind}:${msg.agentId ?? ''}:${msg.id ?? ''}`;
    case 'repoView':
      return `repoView:${msg.project}`;
    default:
      return null;
  }
}

/** U-49: what a page repeats to the daemon on a timer: "showing" while it shows, nothing while hidden. */
export function viewerBeat(hidden: boolean): ClientMessage | null {
  return hidden ? null : { type: 'viewerVisibility', visible: true };
}

/**
 * WebSocket transport for standalone browser mode.
 * Connects to the Pixel Agents server via WebSocket for bidirectional messaging.
 * Includes automatic reconnection with exponential backoff and message queuing.
 *
 * cld-gui (T-0025): every new socket re-sends the session (sessionKey), so a
 * reconnect re-requests the state; a page coming back to the foreground
 * reconnects at once when its socket is gone or does not answer, and a hidden
 * page neither counts as a viewer nor keeps reconnect timers.
 */
export class WebSocketTransport implements MessageTransport {
  private ws: WebSocket | null = null;
  private handlers: Array<(msg: ServerMessage) => void> = [];
  private stateHandlers: Array<(state: TransportState) => void> = [];
  private url: string;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private pendingMessages: ClientMessage[] = [];
  private _state: TransportState = TRANSPORT_STATE_CONNECTING;
  private readonly _ready: Promise<void>;
  private resolveReady!: () => void;
  /** The latest message per sessionKey, in first-sent order (webviewReady leads). */
  private readonly session = new Map<string, ClientMessage>();
  /** This server answers viewerVisibility, so silence after one means a dead socket. */
  private answersVisibility = false;
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  /** U-49: repeats "showing" while the page shows (see LOOKING_BEAT_MS). */
  private beatTimer: ReturnType<typeof setInterval> | null = null;
  private watchingPage = false;

  constructor(url: string) {
    this.url = url;
    this._ready = new Promise<void>((resolve) => {
      this.resolveReady = resolve;
    });
  }

  get state(): TransportState {
    return this._state;
  }

  get ready(): Promise<void> {
    return this._ready;
  }

  private setState(next: TransportState): void {
    if (this._state === next) return;
    this._state = next;
    for (const handler of this.stateHandlers) handler(next);
  }

  connect(): void {
    if (this.disposed) return;
    this.watchPage();

    // First attempt is "connecting"; any retry after a drop is "reconnecting".
    this.setState(
      this.reconnectAttempts > 0 ? TRANSPORT_STATE_RECONNECTING : TRANSPORT_STATE_CONNECTING,
    );

    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempts = 0;
      console.log('[Transport] WebSocket connected');
      this.setState(TRANSPORT_STATE_CONNECTED);
      this.resolveReady();
      // A new socket is a new client to the server: the session first, then
      // whatever else was queued while connecting (session messages in the
      // queue are already in the session, as their latest state).
      const queued = this.pendingMessages.filter((m) => sessionKey(m) === null);
      this.pendingMessages = [];
      for (const msg of [...this.session.values(), ...queued]) ws.send(JSON.stringify(msg));
    };

    ws.onmessage = (e: MessageEvent) => {
      this.clearHeartbeat(); // it answers
      try {
        const msg = JSON.parse(e.data as string) as ServerMessage;
        if (msg.type === 'viewerVisibilityAck') this.answersVisibility = true;
        for (const handler of this.handlers) handler(msg);
      } catch {
        // Malformed JSON, ignore
      }
    };

    ws.onclose = () => {
      if (!this.disposed) {
        this.setState(TRANSPORT_STATE_RECONNECTING);
        this.scheduleReconnect();
      }
    };

    ws.onerror = () => {
      // onclose will fire after onerror, triggering reconnect
    };
  }

  send(message: ClientMessage): void {
    const key = sessionKey(message);
    if (key !== null) {
      if ('on' in message && message.on === false) this.session.delete(key);
      else this.session.set(key, message);
    }
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      // Queue messages while connecting (flushed in onopen)
      this.pendingMessages.push(message);
    }
  }

  onMessage(handler: (message: ServerMessage) => void): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  /**
   * Deliver an externally-sourced message to all handlers, as if it had arrived
   * over the socket. Used in Vite dev mode to bridge `browserMock`'s injected
   * `window` messages (there is no real server to connect to in dev).
   */
  deliver(message: ServerMessage): void {
    for (const handler of this.handlers) handler(message);
  }

  onStateChange(handler: (state: TransportState) => void): () => void {
    this.stateHandlers.push(handler);
    return () => {
      this.stateHandlers = this.stateHandlers.filter((h) => h !== handler);
    };
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearHeartbeat();
    this.stopBeat();
    if (this.watchingPage) {
      document.removeEventListener('visibilitychange', this.onVisibility);
      window.removeEventListener('pageshow', this.onPageShow);
    }
    this.ws?.close();
    this.ws = null;
    this.handlers = [];
    this.pendingMessages = [];
    this.setState(TRANSPORT_STATE_DISCONNECTED);
    this.stateHandlers = [];
  }

  private scheduleReconnect(): void {
    // A hidden page keeps no timers; showing it again reconnects at once.
    if (document.hidden) return;
    const delay = reconnectDelayMs(this.reconnectAttempts);
    this.reconnectAttempts++;

    console.log(
      `[Transport] WebSocket reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`,
    );
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  // ── cld-gui (T-0025): the page's visibility ──────────────────

  private watchPage(): void {
    if (this.watchingPage) return;
    this.watchingPage = true;
    this.session.set('viewerVisibility', { type: 'viewerVisibility', visible: !document.hidden });
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('pageshow', this.onPageShow);
    this.startBeat();
  }

  /** The daemon's push decision needs to hear that the page still shows: a suspended page cannot say it. */
  private startBeat(): void {
    if (this.beatTimer || document.hidden) return;
    this.beatTimer = setInterval(() => {
      const beat = viewerBeat(document.hidden);
      if (beat && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(beat));
    }, LOOKING_BEAT_MS);
  }

  private stopBeat(): void {
    if (this.beatTimer) clearInterval(this.beatTimer);
    this.beatTimer = null;
  }

  private readonly onVisibility = (): void => {
    if (!document.hidden) return this.onShow();
    this.clearHeartbeat();
    this.stopBeat();
    this.send({ type: 'viewerVisibility', visible: false });
  };

  /** Back from the back/forward cache: its socket was closed on the way in. */
  private readonly onPageShow = (e: PageTransitionEvent): void => {
    if (e.persisted) this.onShow();
  };

  /** Shown again: a socket that is gone, or does not answer, is replaced now. */
  private onShow(): void {
    if (this.disposed || document.hidden) return;
    this.startBeat();
    this.send({ type: 'viewerVisibility', visible: true }); // into the session first
    const ws = this.ws;
    if (!ws || ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) {
      this.reconnectNow();
      return;
    }
    if (ws.readyState === WebSocket.OPEN && this.answersVisibility && !this.heartbeatTimer) {
      this.heartbeatTimer = setTimeout(() => {
        this.heartbeatTimer = null;
        console.log('[Transport] WebSocket silent after the page came back; reconnecting');
        this.reconnectNow();
      }, WS_HEARTBEAT_MS);
    }
  }

  /** A new socket at once, skipping the backoff wait. */
  private reconnectNow(): void {
    if (this.disposed) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearHeartbeat();
    const old = this.ws;
    if (old) {
      // Nothing more from it: no late message, no second reconnect.
      old.onopen = old.onmessage = old.onclose = old.onerror = null;
      old.close();
    }
    this.ws = null;
    this.reconnectAttempts = Math.max(this.reconnectAttempts, 1); // a retry, not a first connect
    this.connect();
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }
}
