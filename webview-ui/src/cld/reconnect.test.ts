/**
 * T-0025: sockets coming back to the foreground. iOS stops a backgrounded
 * home-screen app's networking without closing its sockets, so the page must
 * check them itself when it shows again. Fake sockets, a fake page.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LOOKING_FRESH_MS } from '../../../core/src/constants.js';
import type { ClientMessage } from '../../../core/src/messages.js';
import { LOOKING_BEAT_MS, WS_HEARTBEAT_MS, WS_RECONNECT_DELAYS_MS } from '../constants.js';
import { TerminalConnection } from '../terminal/terminalClient.js';
import { viewerBeat, WebSocketTransport } from '../transport/webSocketTransport.js';

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static made: FakeSocket[] = [];
  readonly url: string;
  readyState = FakeSocket.CONNECTING;
  sent: Array<Record<string, unknown>> = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
    FakeSocket.made.push(this);
  }
  send(data: string) {
    if (this.readyState !== FakeSocket.OPEN) throw new Error('send on a socket that is not open');
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close() {
    this.readyState = FakeSocket.CLOSED;
  }
  // Test drivers: the server side of the socket.
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  receive(msg: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  drop(code = 1006) {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({ code, reason: '' });
  }
}

const page = { hidden: false };
const doc = new EventTarget();
Object.defineProperty(doc, 'hidden', { get: () => page.hidden });
const win = Object.assign(new EventTarget(), {
  location: { protocol: 'http:', host: 'office.test' },
});
const setHidden = (hidden: boolean) => {
  page.hidden = hidden;
  doc.dispatchEvent(new Event('visibilitychange'));
};
const pageShow = (persisted: boolean) =>
  win.dispatchEvent(Object.assign(new Event('pageshow'), { persisted }));
const sockets = () => FakeSocket.made;
const last = () => FakeSocket.made.at(-1)!;
const visible = (v: boolean) => ({ type: 'viewerVisibility', visible: v });
const ACK = { type: 'viewerVisibilityAck', visible: true };

beforeEach(() => {
  FakeSocket.made = [];
  page.hidden = false;
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', win);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.useFakeTimers();
});
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanup.splice(0)) c();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function transport(): WebSocketTransport {
  const t = new WebSocketTransport('ws://office.test/ws');
  cleanup.push(() => t.dispose());
  t.connect();
  return t;
}

describe('the /ws transport', () => {
  it('re-requests the state on every new socket: the session first, then the rest', () => {
    const t = transport();
    const send = (m: ClientMessage) => t.send(m);
    send({ type: 'webviewReady' });
    send({ type: 'chatView', agentId: 7, on: true });
    send({ type: 'statusView', name: 'alpha', on: true });
    send({ type: 'statusView', name: 'alpha', on: false }); // closed again: no longer state
    send({ type: 'requestDiagnostics' }); // a one-off
    sockets()[0].open();
    expect(sockets()[0].sent).toEqual([
      visible(true),
      { type: 'webviewReady' },
      { type: 'chatView', agentId: 7, on: true },
      { type: 'requestDiagnostics' },
    ]);
    sockets()[0].drop(); // dropped while showing: the usual backoff
    vi.advanceTimersByTime(WS_RECONNECT_DELAYS_MS[0]);
    last().open();
    expect(last().sent).toEqual([
      visible(true),
      { type: 'webviewReady' },
      { type: 'chatView', agentId: 7, on: true },
    ]);
    expect(t.state).toBe('connected');
  });

  it('after a network cut, requests a fresh snapshot and flushes a queued message once', () => {
    const t = transport();
    const received: unknown[] = [];
    t.onMessage((message) => received.push(message));
    t.send({ type: 'webviewReady' });
    sockets()[0].open();
    sockets()[0].drop();
    t.send({ type: 'requestDiagnostics' });

    vi.advanceTimersByTime(WS_RECONNECT_DELAYS_MS[0]);
    last().open();
    last().receive(ACK);

    expect(last().sent.filter((message) => message.type === 'webviewReady')).toHaveLength(1);
    expect(last().sent.filter((message) => message.type === 'requestDiagnostics')).toHaveLength(1);
    expect(received).toEqual([ACK]);
    expect(t.state).toBe('connected');
  });

  it('a hidden page says so and keeps no reconnect timer; shown again it reconnects at once', () => {
    const t = transport();
    t.send({ type: 'webviewReady' });
    sockets()[0].open();
    setHidden(true);
    expect(sockets()[0].sent.at(-1)).toEqual(visible(false));
    sockets()[0].drop();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10 * 60_000);
    expect(sockets()).toHaveLength(1);
    setHidden(false);
    expect(sockets()).toHaveLength(2); // no backoff wait
    last().open();
    expect(last().sent).toEqual([visible(true), { type: 'webviewReady' }]);
  });

  it('a socket left open but dead is replaced when it stays silent for the heartbeat window', () => {
    const t = transport();
    t.send({ type: 'webviewReady' });
    const s = sockets()[0];
    s.open();
    s.receive(ACK); // this server answers viewerVisibility
    setHidden(true);
    setHidden(false);
    expect(s.sent.at(-1)).toEqual(visible(true));
    vi.advanceTimersByTime(WS_HEARTBEAT_MS - 1);
    expect(sockets()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets()).toHaveLength(2);
    expect(t.state).toBe('reconnecting');
    expect(s.onmessage).toBeNull(); // nothing more from the old one
    last().open();
    expect(last().sent).toEqual([visible(true), { type: 'webviewReady' }]);
  });

  it('a socket that answers stays', () => {
    transport();
    const s = sockets()[0];
    s.open();
    s.receive(ACK);
    setHidden(true);
    setHidden(false);
    s.receive(ACK);
    vi.advanceTimersByTime(60_000);
    expect(sockets()).toHaveLength(1);
  });

  it('a server that never answered viewerVisibility is not taken for dead', () => {
    transport();
    sockets()[0].open(); // plain pixel-agents: no answer ever
    setHidden(true);
    setHidden(false);
    vi.advanceTimersByTime(60_000);
    expect(sockets()).toHaveLength(1);
  });

  it('a page back from the back/forward cache with its socket closed reconnects at once', () => {
    transport();
    sockets()[0].open();
    sockets()[0].readyState = FakeSocket.CLOSED; // closed on the way in, no event heard
    pageShow(false);
    expect(sockets()).toHaveLength(1);
    pageShow(true);
    expect(sockets()).toHaveLength(2);
  });

  it('skips a long backoff wait when the page shows again', () => {
    transport();
    sockets()[0].open();
    for (const delay of WS_RECONNECT_DELAYS_MS) {
      last().drop();
      vi.advanceTimersByTime(delay);
    }
    last().drop(); // now on the last rung: 4 s
    const before = sockets().length;
    setHidden(true);
    setHidden(false);
    expect(sockets()).toHaveLength(before + 1);
    vi.advanceTimersByTime(WS_RECONNECT_DELAYS_MS.at(-1)!);
    expect(sockets()).toHaveLength(before + 1); // the old timer is gone
  });
});

describe('U-49: a showing page repeats that it shows (the daemon pushes to a device it cannot see)', () => {
  const beats = (s: FakeSocket) => s.sent.filter((m) => m.type === 'viewerVisibility');

  it('what a page repeats: showing while shown, nothing while hidden', () => {
    expect(viewerBeat(false)).toEqual(visible(true));
    expect(viewerBeat(true)).toBeNull();
    expect(LOOKING_FRESH_MS / LOOKING_BEAT_MS).toBeGreaterThanOrEqual(3); // a missed beat or two is not "gone"
  });

  it('a shown page beats every LOOKING_BEAT_MS; hidden, it stops; shown again, it resumes', () => {
    transport();
    const s = sockets()[0];
    s.open();
    const opened = beats(s).length; // the session's own report on connect
    vi.advanceTimersByTime(LOOKING_BEAT_MS * 3);
    expect(beats(s).length - opened).toBe(3);
    setHidden(true);
    const hiddenAt = beats(s).length;
    expect(beats(s).at(-1)).toEqual(visible(false));
    vi.advanceTimersByTime(LOOKING_BEAT_MS * 5);
    expect(beats(s)).toHaveLength(hiddenAt); // a hidden page says nothing more
    setHidden(false);
    vi.advanceTimersByTime(LOOKING_BEAT_MS);
    expect(
      beats(s)
        .slice(hiddenAt)
        .every((m) => m.visible === true),
    ).toBe(true);
    expect(beats(s).length - hiddenAt).toBe(2); // the show itself, then one beat
  });

  it('no beat is queued for a socket that is not open', () => {
    transport();
    vi.advanceTimersByTime(LOOKING_BEAT_MS * 3); // still connecting
    expect(sockets()[0].sent).toEqual([]);
  });
});

describe('a terminal socket', () => {
  function terminal() {
    const status = vi.fn();
    const c = new TerminalConnection(3, {
      onOutput: vi.fn(),
      onReplay: vi.fn(),
      onExit: vi.fn(),
      onStatusChange: status,
    });
    cleanup.push(() => c.dispose());
    void c.connect();
    last().open();
    return { c, status };
  }

  it('closed while hidden: no timer, reopened at once when shown', () => {
    const { status } = terminal();
    setHidden(true);
    sockets()[0].drop();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(sockets()).toHaveLength(1);
    setHidden(false);
    expect(sockets()).toHaveLength(2);
    expect(status).toHaveBeenLastCalledWith('reconnecting');
    expect(last().url).toBe('ws://office.test/terminal/3');
  });

  it('open but hidden and silent for the heartbeat window: reopened (its screen replays)', () => {
    terminal();
    setHidden(true);
    vi.advanceTimersByTime(WS_HEARTBEAT_MS);
    setHidden(false);
    expect(sockets()).toHaveLength(2);
    expect(sockets()[0].onclose).toBeNull(); // the old one cannot schedule another
  });

  it('a short glance away, or a socket still talking, keeps it', () => {
    terminal();
    setHidden(true);
    vi.advanceTimersByTime(WS_HEARTBEAT_MS - 1);
    setHidden(false);
    setHidden(true);
    vi.advanceTimersByTime(WS_HEARTBEAT_MS * 2);
    sockets()[0].receive({ type: 'output', data: 'still here' });
    setHidden(false);
    expect(sockets()).toHaveLength(1);
  });

  it('refused by the server: never reopened', () => {
    terminal();
    sockets()[0].drop(4401);
    setHidden(true);
    vi.advanceTimersByTime(WS_HEARTBEAT_MS);
    setHidden(false);
    pageShow(true);
    expect(sockets()).toHaveLength(1);
  });
});
