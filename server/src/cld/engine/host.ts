import { randomBytes, randomUUID } from 'node:crypto';

import * as fs from 'fs';
import * as path from 'path';

import { configDirectory } from '../configPath.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const hostPath = (home: string): string =>
  path.join(configDirectory(home), 'host.json');

function validHost(value: unknown): value is { v: 1; hostId: string; createdAt: string } {
  if (typeof value !== 'object' || value === null) return false;
  const host = value as Partial<{ v: number; hostId: string; createdAt: string }>;
  return (
    host.v === 1 &&
    typeof host.hostId === 'string' &&
    UUID_RE.test(host.hostId) &&
    typeof host.createdAt === 'string' &&
    !Number.isNaN(Date.parse(host.createdAt))
  );
}

/** Read this installation's durable identity, without ever repairing a bad file in place. */
export function loadOrCreateHost(
  home: string,
  log: (line: string) => void = () => undefined,
): { hostId: string | null } {
  const file = hostPath(home);
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (validHost(value)) return { hostId: value.hostId };
    log(`${file}: invalid host.json; host identity is unavailable`);
    return { hostId: null };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log(`${file}: cannot read host.json; host identity is unavailable`);
      return { hostId: null };
    }
  }

  const host = { v: 1 as const, hostId: randomUUID(), createdAt: new Date().toISOString() };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(host, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
    return { hostId: host.hostId };
  } catch {
    log(`${file}: cannot create host.json; host identity is unavailable`);
    return { hostId: null };
  }
}
