/**
 * T-0078: a terminal socket that has to prove the device before each connect
 * (a shell), and what it does when the daemon restarts and forgets every proof.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WS_RECONNECT_DELAYS_MS } from '../../constants.js';
import type { TerminalConnectionStatus } from '../../terminal/terminalClient.js';
import { TerminalConnection } from '../../terminal/terminalClient.js';

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static made: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeSocket.made.push(this);
  }
  send() {}
  close() {
    this.readyState = FakeSocket.CLOSED;
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  drop(code = 1006, reason = '') {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.({ code, reason });
  }
}

const doc = Object.assign(new EventTarget(), { hidden: false });
const win = Object.assign(new EventTarget(), {
  location: { protocol: 'http:', host: 'office.test' },
});
const last = () => FakeSocket.made.at(-1)!;

beforeEach(() => {
  FakeSocket.made = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('document', doc);
  vi.stubGlobal('window', win);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function connect(prepare?: (force: boolean) => Promise<boolean>) {
  const statuses: TerminalConnectionStatus[] = [];
  const refused: string[] = [];
  const connection = new TerminalConnection(
    -1,
    {
      onOutput: () => undefined,
      onReplay: () => undefined,
      onExit: () => undefined,
      onStatusChange: (s) => statuses.push(s),
      onRefused: (r) => refused.push(r),
    },
    '/cld/shell/abc',
    { prepare },
  );
  void connection.connect();
  return { connection, statuses, refused };
}

describe('a socket that proves the device first', () => {
  it('asks before every connect, and a daemon restart is just a reconnect that proves again', async () => {
    const prepare = vi.fn(async () => true);
    const { statuses, refused } = connect(prepare);
    await vi.advanceTimersByTimeAsync(0);
    expect(prepare).toHaveBeenLastCalledWith(false);
    expect(FakeSocket.made).toHaveLength(1);
    last().open();
    expect(statuses.at(-1)).toBe('connected');
    last().drop(1006); // the daemon went away
    expect(statuses.at(-1)).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(WS_RECONNECT_DELAYS_MS[0]);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(FakeSocket.made).toHaveLength(2);
    last().open();
    expect(statuses.at(-1)).toBe('connected');
    expect(refused).toEqual([]);
  });

  it('keeps retrying while the proof cannot be made (the daemon is down), without opening a socket', async () => {
    let up = false;
    const prepare = vi.fn(async () => {
      if (!up) throw new TypeError('Failed to fetch');
      return true;
    });
    const { statuses } = connect(prepare);
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(10_000);
    expect(prepare.mock.calls.length).toBeGreaterThan(2);
    expect(FakeSocket.made).toHaveLength(0);
    expect(statuses.at(-1)).toBe('reconnecting');
    up = true;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(FakeSocket.made).toHaveLength(1);
  });

  it('a proof only a tap can make stops the socket as refused "proof"', async () => {
    const { statuses, refused } = connect(async () => false);
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeSocket.made).toHaveLength(0);
    expect(refused).toEqual(['proof']);
    expect(statuses.at(-1)).toBe('closed');
  });

  it('the server refusing the proof ("proof") asks once more, forced; a second refusal is final', async () => {
    const prepare = vi.fn(async () => true);
    const { statuses, refused } = connect(prepare);
    await vi.advanceTimersByTimeAsync(0);
    last().open();
    last().drop(4001, 'proof'); // the daemon restarted and forgot the proof we thought was fresh
    await vi.advanceTimersByTimeAsync(0);
    expect(prepare).toHaveBeenLastCalledWith(true);
    expect(FakeSocket.made).toHaveLength(2);
    last().drop(4001, 'proof'); // still refused, without ever opening
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeSocket.made).toHaveLength(2);
    expect(refused).toEqual(['proof']);
    expect(statuses.at(-1)).toBe('closed');
  });

  it('a shell that is gone is final and says why; no retry', async () => {
    const { statuses, refused } = connect(async () => true);
    await vi.advanceTimersByTimeAsync(0);
    last().open();
    last().drop(4004, 'no shell');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refused).toEqual(['no shell']);
    expect(statuses.at(-1)).toBe('closed');
    expect(FakeSocket.made).toHaveLength(1);
  });
});

describe('without prepare (an agent terminal): as before, plus the reason', () => {
  it('connects at once and reports a final refusal with its reason', async () => {
    const { refused } = connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeSocket.made).toHaveLength(1);
    last().open();
    last().drop(4004, 'cap');
    expect(refused).toEqual(['cap']);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.made).toHaveLength(1);
  });
});
