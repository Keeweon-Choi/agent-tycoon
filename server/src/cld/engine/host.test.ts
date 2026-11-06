import * as fs from 'fs';
import { createRequire, syncBuiltinESMExports } from 'module';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { hostLabel, setHostName } from '../hostName.js';
import { hostPath, loadOrCreateHost } from './host.js';

/** The builtin's own object: what syncBuiltinESMExports copies into the ESM bindings host.ts reads. */
const fsObject = createRequire(__filename)('fs') as typeof fs;

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

function home(): string {
  const value = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-host-'));
  homes.push(value);
  return value;
}

describe('host identity', () => {
  it('creates one id and returns that same id later', () => {
    const h = home();
    const first = loadOrCreateHost(h);
    const stored = JSON.parse(fs.readFileSync(hostPath(h), 'utf8'));

    expect(first.hostId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(stored).toMatchObject({ v: 1, hostId: first.hostId });
    expect(loadOrCreateHost(h)).toEqual(first);
  });

  it('leaves a corrupt file untouched and reports no identity', () => {
    const h = home();
    const file = hostPath(h);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const bytes = '{not json}\n';
    fs.writeFileSync(file, bytes);
    const logs: string[] = [];

    expect(loadOrCreateHost(h, (line) => logs.push(line))).toEqual({ hostId: null });
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
    expect(logs).toHaveLength(1);
  });
});

describe('host name (MHO 3.6)', () => {
  it('defaults to the machine name, keeps a set name with the same id, and clears it back', () => {
    const h = home();
    expect(hostLabel(h)).toEqual({ hostName: os.hostname() }); // no host.json: no id
    const { hostId } = loadOrCreateHost(h);
    expect(hostLabel(h)).toEqual({ hostId, hostName: os.hostname() });
    expect(setHostName(h, 'Desk')).toBe(true);
    expect(hostLabel(h)).toEqual({ hostId, hostName: 'Desk' });
    expect(loadOrCreateHost(h).hostId).toBe(hostId);
    expect(setHostName(h, '')).toBe(true);
    expect(hostLabel(h).hostName).toBe(os.hostname());
  });

  it('never writes a name over a corrupt host.json', () => {
    const h = home();
    const file = hostPath(h);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{not json}\n');
    expect(setHostName(h, 'Desk')).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe('{not json}\n');
  });
});

describe('host identity races and hand edits', () => {
  it('a second start that loses the race takes the id already on disk, never replacing it', () => {
    const h = home();
    const first = loadOrCreateHost(h).hostId;
    const before = fs.readFileSync(hostPath(h), 'utf8');
    // This start read before the other wrote: it saw no file, then finds one when it links.
    // (The builtin's own object, synced into the ESM bindings host.ts reads.)
    const spy = vi.spyOn(fsObject, 'readFileSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    syncBuiltinESMExports();
    try {
      expect(loadOrCreateHost(h).hostId).toBe(first);
    } finally {
      spy.mockRestore();
      syncBuiltinESMExports();
    }
    expect(fs.readFileSync(hostPath(h), 'utf8')).toBe(before);
    expect(fs.readdirSync(path.dirname(hostPath(h))).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('reads a hand-edited name only when it passes the nickname rule', () => {
    const h = home();
    loadOrCreateHost(h);
    const file = hostPath(h);
    const host = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const name of ['a\u202eb', 'x'.repeat(41), 'zero\u200bwidth', 'line\u2028sep', 42]) {
      fs.writeFileSync(file, JSON.stringify({ ...host, name }));
      expect(hostLabel(h).hostName).toBe(os.hostname());
    }
    fs.writeFileSync(file, JSON.stringify({ ...host, name: ' Desk ' }));
    expect(hostLabel(h).hostName).toBe('Desk');
  });
});
