/**
 * The daemon's office files: `<settings directory>/office/` (configPath.cjs officeDirectory)
 * since 2026-11, `~/.pixel-agents/` (the upstream Pixel Agents folder) before.
 *
 * ponytail: the ~/.pixel-agents read fallback and the discovery dual-write (server.ts) are for the
 * one release after the 2026-11 move; the release after it deletes them, and then deletes only the
 * files MIGRATED_FILES names in ~/.pixel-agents (the upstream extension's stay).
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { legacyOfficeDirectory, officeDirectory } from './cld/configPath.js';
import {
  CONFIG_FILE_NAME,
  LAYOUT_FILE_NAME,
  STANDALONE_STATE_FILE_NAME,
  STANDALONE_TOKEN_FILE_NAME,
} from './constants.js';

/** Ours to copy. server.json and servers/ are rewritten at every start; hooks/ by the installer;
 *  vscode-state.json belonged to the removed extension (and maybe still to upstream's). */
export const MIGRATED_FILES = [
  CONFIG_FILE_NAME,
  STANDALONE_STATE_FILE_NAME,
  LAYOUT_FILE_NAME,
  STANDALONE_TOKEN_FILE_NAME,
] as const;

/** Where an office file is written (and watched). */
export function officeFile(name: string, home = os.homedir()): string {
  return path.join(officeDirectory(home), name);
}

/** Where an office file is read: the new folder, else ~/.pixel-agents when only that has it. */
export function officeFileToRead(name: string, home = os.homedir()): string {
  const file = officeFile(name, home);
  if (fs.existsSync(file)) return file;
  const old = path.join(legacyOfficeDirectory(home), name);
  return fs.existsSync(old) ? old : file;
}

const sha256 = (file: string) =>
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/**
 * Copy our files from ~/.pixel-agents into the office folder, once, before anything reads them.
 * Per file: copy to a tmp beside the target, compare sha256 with the original, then rename (the
 * switch); the original stays where it is. A file already in the office folder is never
 * overwritten, so a re-run changes nothing and a run cut short is finished by the next one (a
 * leftover tmp is replaced). Never throws: a file that did not copy is still read from the old
 * folder (officeFileToRead).
 */
export function migrateOfficeFolder(home = os.homedir()): { copied: string[]; failed: string[] } {
  const oldDir = legacyOfficeDirectory(home);
  const present = MIGRATED_FILES.filter((name) => fs.existsSync(path.join(oldDir, name)));
  const copied: string[] = [];
  const failed: string[] = [];
  for (const name of present) {
    const target = officeFile(name, home);
    if (fs.existsSync(target)) continue;
    const source = path.join(oldDir, name);
    const tmp = `${target}.migrating`;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.copyFileSync(source, tmp); // keeps the mode: the token stays 0600
      if (sha256(tmp) !== sha256(source)) throw new Error('copy differs from the original');
      fs.renameSync(tmp, target);
      copied.push(name);
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true, recursive: true });
      } catch {
        /* the original is untouched either way */
      }
      failed.push(name);
      console.error(
        `[Agent Tycoon] Office move: ${name} stays in ${oldDir} (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }
  const verified = present.filter((name) => fs.existsSync(officeFile(name, home))).length;
  if (copied.length || verified !== present.length) {
    console.log(
      `[Agent Tycoon] Office move: ${verified}/${present.length} files in ${officeDirectory(home)} (copied ${copied.join(', ') || 'none'}); the originals stay in ${oldDir}`,
    );
  }
  return { copied, failed };
}
