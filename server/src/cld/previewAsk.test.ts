/** P4 S6: previewAsk's gate (privileged only) and URL rule (empty or loopback), and the rule itself. */
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { devServerExposed, loopbackUrl, scanDevUrl } from '../../../core/src/cld/devUrl.js';
import type { PreviewOpen } from '../../../core/src/messages.js';
import { Devroom } from './devroom.js';

const make = () => {
  const opened: PreviewOpen[] = [];
  const room = new Devroom({
    file: path.join(os.tmpdir(), 'no-such-dir', 'devroom.json'),
    repos: { devroomView: () => undefined },
    readOnly: true,
    terminals: async () => 0,
    hostPid: () => undefined,
    previewOpen: (m) => void opened.push(m),
  });
  return { room, opened };
};
const ask = (url: string, over: Record<string, unknown> = {}) => ({ type: 'previewAsk', project: 'shop', task: 'cart', url, ...over });

afterEach(() => vi.restoreAllMocks());

describe('previewAsk', () => {
  it('a privileged ask with an empty or loopback url becomes one previewOpen (normalised)', () => {
    const { room, opened } = make();
    expect(room.onClientMessage(ask('localhost:5173'), () => undefined, true)).toBe(true);
    room.onClientMessage(ask(''), () => undefined, true);
    expect(opened).toEqual([
      { type: 'previewOpen', project: 'shop', task: 'cart', url: 'http://localhost:5173/' },
      { type: 'previewOpen', project: 'shop', task: 'cart', url: '' },
    ]);
  });

  it('an unprivileged client gets nothing, even with a good url', () => {
    const { room, opened } = make();
    expect(room.onClientMessage(ask('http://localhost:5173'), () => undefined, false)).toBe(true);
    expect(opened).toEqual([]);
  });

  it('a url off this machine, a bad name or a wrong shape is dropped', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { room, opened } = make();
    for (const m of [
      ask('http://evil.example/'),
      ask('http://192.168.0.5:5173'),
      ask('http://localhost@evil.example/'),
      ask('javascript:alert(1)'),
      ask('http://localhost:5173', { task: '../etc' }),
      ask('http://localhost:5173', { project: '' }),
      ask(undefined as unknown as string),
    ])
      expect(room.onClientMessage(m, () => undefined, true)).toBe(true);
    expect(opened).toEqual([]);
  });
});

describe('the loopback rule', () => {
  it('accepts localhost, 127.0.0.1 and [::1] over http(s) only', () => {
    expect(loopbackUrl('localhost:5173')).toBe('http://localhost:5173/');
    expect(loopbackUrl('http://127.0.0.1:3000/app?x=1')).toBe('http://127.0.0.1:3000/app?x=1');
    expect(loopbackUrl('https://[::1]:8443')).toBe('https://[::1]:8443/');
    for (const bad of ['', 'http://0.0.0.0:5173', 'http://localhost.evil.com', 'http://evil.com/localhost', 'ftp://localhost', 'file:///etc/passwd', 'http://u:p@localhost:5173', 'http://localhost:5173 x'])
      expect(loopbackUrl(bad)).toBeNull();
  });

  it('scans the last loopback url of a dev server log, colours stripped, and spots a Network line', () => {
    const log = '  \u001b[32m➜\u001b[39m  Local:   http://localhost:\u001b[1m5173\u001b[22m/\n  ➜  Network: http://192.168.0.7:5173/\n';
    expect(scanDevUrl(log)).toBe('http://localhost:5173/');
    expect(scanDevUrl('Local: http://localhost:3000/\nretry http://127.0.0.1:3001.')).toBe('http://127.0.0.1:3001/');
    expect(scanDevUrl('Network: http://192.168.0.7:5173/')).toBeNull();
    expect(scanDevUrl('http://localhost.evil.com:5173 http://127.0.0.1@evil.com/')).toBeNull();
    expect(devServerExposed(log)).toBe(true);
    expect(devServerExposed('Local: http://localhost:3000/\nNetwork: use --host to expose')).toBe(false);
  });
});
