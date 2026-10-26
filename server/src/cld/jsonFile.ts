/**
 * The login stores under ~/.config/agent-tycoon (passkeys, sessions): read them,
 * and write them 0600 through a temp file and a rename, so a crash never
 * leaves half a file.
 */
import * as fs from 'fs';
import * as path from 'path';

/** A JSON file's contents, or null when it does not exist. Throws when it can't be read or parsed. */
export function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** 0600, write-then-rename. */
export function writeJsonAtomic(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(tmp, 0o600); // a leftover tmp keeps its old mode
  fs.renameSync(tmp, file);
}
