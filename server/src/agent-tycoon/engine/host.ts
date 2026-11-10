import { randomBytes, randomUUID } from 'node:crypto';

import * as fs from 'fs';
import * as path from 'path';

import { configDirectory } from '../configPath.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const hostPath = (home: string): string =>
  path.join(configDirectory(home), 'host.json');

export interface HostFile {
  v: 1;
  hostId: string;
  createdAt: string;
  /** MHO 3.6: the name set in 설정; absent, the machine's name. */
  name?: string;
}

function validHost(value: unknown): value is HostFile {
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
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tmp, `${JSON.stringify(host, null, 2)}\n`, { mode: 0o600 });
    // link, not rename: never replaces a host.json another process made first (two starts on one
    // HOME would otherwise each keep an id, and a cookie name, the file no longer has).
    fs.linkSync(tmp, file);
    return { hostId: host.hostId };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      const theirs = readHost(home);
      if (theirs) return { hostId: theirs.hostId };
    }
    log(`${file}: cannot create host.json; host identity is unavailable`);
    return { hostId: null };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** host.json when it is valid, else null (missing, unreadable or another shape). */
export function readHost(home: string): HostFile | null {
  try {
    const value = JSON.parse(fs.readFileSync(hostPath(home), 'utf8')) as unknown;
    return validHost(value) ? value : null;
  } catch {
    return null;
  }
}

