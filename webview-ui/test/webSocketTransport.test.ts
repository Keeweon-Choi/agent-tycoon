/**
 * FIX-PERM-RESTART: a permissionAnswer is sent over a live socket or not at all. One pressed while
 * the socket is down is never queued, so a reconnect (maybe to a restarted daemon showing another
 * call under the same id) never carries it; other messages still wait for the socket.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WebSocketTransport } from '../src/transport/webSocketTransport.js';

class FakeSocket {
  static readonly OPEN = 1;
  static all: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((e: unknown) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeSocket.all.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  drop() {
    this.readyState = 3;
    this.onclose?.();
  }
}

const answer = { type: 'permissionAnswer', requestId: 'r1', agentId: 7, toolId: 'hook:abc:1', allow: true } as const;
const types = (s: FakeSocket) => s.sent.map((d) => (JSON.parse(d) as { type: string }).type);

beforeEach(() => {
  FakeSocket.all = [];
  vi.useFakeTimers();
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('document', { hidden: false, addEventListener: () => undefined, removeEventListener: () => undefined });
  vi.stubGlobal('window', { addEventListener: () => undefined, removeEventListener: () => undefined });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('WebSocketTransport and permission answers', () => {
  it('sends an answer on a live socket; one pressed while down never leaves after the reconnect', () => {
    const t = new WebSocketTransport('ws://x/ws');
    t.connect();
    FakeSocket.all[0].open();
    t.send(answer);
    expect(types(FakeSocket.all[0])).toContain('permissionAnswer');
    FakeSocket.all[0].drop();
    t.send({ ...answer, requestId: 'r2' }); // pressed while disconnected
    t.send({ type: 'webviewReady' }); // an ordinary message still waits
    vi.runOnlyPendingTimers(); // the reconnect
    const next = FakeSocket.all.at(-1)!;
    expect(next).not.toBe(FakeSocket.all[0]);
    next.open();
    expect(types(next)).not.toContain('permissionAnswer');
    expect(types(next)).toContain('webviewReady');
    // Pressed again on the new connection: it goes.
    t.send({ ...answer, requestId: 'r3' });
    expect(types(next).filter((x) => x === 'permissionAnswer')).toHaveLength(1);
    t.dispose();
  });
});
