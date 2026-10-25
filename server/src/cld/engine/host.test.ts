import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { hostPath, loadOrCreateHost } from './host.js';

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
