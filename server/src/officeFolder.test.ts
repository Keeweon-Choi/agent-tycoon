import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { legacyOfficeSkipFile } from './agent-tycoon/configPath.js';
import { readLayoutFromFile } from './layoutPersistence.js';
import {
  MIGRATED_FILES,
  migrateOfficeFolder,
  officeFile,
  officeFileToRead,
} from './officeFolder.js';

let home: string;
const old = (...p: string[]) => path.join(home, '.pixel-agents', ...p);
const office = (...p: string[]) => path.join(home, '.config', 'agent-tycoon', 'office', ...p);
const sha = (file: string) =>
  crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** A home as a daemon before 2026-11 left it, beside the upstream extension's own files. */
function seedOldHome(): Record<string, string> {
  const files: Record<string, string> = {
    'config.json': JSON.stringify({
      vscode: { soundEnabled: false },
      standalone: { showAreas: true },
    }),
    'standalone-state.json': JSON.stringify({ agents: [], seats: { '1': { palette: 2 } } }),
    'layout.json': JSON.stringify({ version: 1, cols: 3 }),
    'standalone-token': 'old-token-0123456789\n',
  };
  fs.mkdirSync(old('servers'), { recursive: true });
  fs.mkdirSync(old('hooks'), { recursive: true });
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(old(name), content);
  fs.chmodSync(old('standalone-token'), 0o600);
  fs.writeFileSync(old('server.json'), '{"port":18240}');
  fs.writeFileSync(old('servers', '1-18240.json'), '{}');
  fs.writeFileSync(old('hooks', 'claude-hook.js'), '// hook');
  fs.writeFileSync(old('vscode-state.json'), '{"agents":[]}'); // the extension's
  return files;
}

/** Every file under ~/.pixel-agents with its hash: the move must leave all of it as it was. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile())
      out[path.relative(dir, path.join(entry.parentPath, entry.name))] = sha(
        path.join(entry.parentPath, entry.name),
      );
  }
  return out;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'office-move-'));
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe('migrateOfficeFolder', () => {
  it('copies our four files byte for byte, leaves ~/.pixel-agents untouched, and a re-run changes nothing', () => {
    seedOldHome();
    const before = snapshot(old());

    expect(migrateOfficeFolder(home)).toEqual({ copied: [...MIGRATED_FILES], failed: [] });

    for (const name of MIGRATED_FILES) expect(sha(office(name))).toBe(sha(old(name)));
    expect(fs.statSync(office('standalone-token')).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(office()).sort()).toEqual([...MIGRATED_FILES].sort());
    expect(snapshot(old())).toEqual(before);

    fs.writeFileSync(office('layout.json'), '{"newer":true}'); // the daemon wrote since
    expect(migrateOfficeFolder(home)).toEqual({ copied: [], failed: [] });
    expect(fs.readFileSync(office('layout.json'), 'utf-8')).toBe('{"newer":true}');
  });

  it('a run cut short (one file switched, a torn tmp left) is finished by the next one', () => {
    seedOldHome();
    fs.mkdirSync(office(), { recursive: true });
    fs.copyFileSync(old('config.json'), office('config.json'));
    fs.writeFileSync(office('layout.json.migrating'), '{"vers'); // the crash

    const { copied } = migrateOfficeFolder(home);

    expect(copied).toEqual(['standalone-state.json', 'layout.json', 'standalone-token']);
    for (const name of MIGRATED_FILES) expect(sha(office(name))).toBe(sha(old(name)));
    expect(fs.existsSync(office('layout.json.migrating'))).toBe(false);
  });

  it('a file that cannot be copied stays readable from ~/.pixel-agents; writes go to the office folder', () => {
    seedOldHome();
    fs.mkdirSync(office('layout.json.migrating'), { recursive: true }); // copy target blocked

    expect(migrateOfficeFolder(home).failed).toEqual(['layout.json']);
    expect(officeFileToRead('layout.json', home)).toBe(old('layout.json'));
    expect(officeFileToRead('config.json', home)).toBe(office('config.json'));
    expect(officeFile('layout.json', home)).toBe(office('layout.json'));
    // Nothing anywhere: read and write the office folder.
    expect(officeFileToRead('absent.json', home)).toBe(office('absent.json'));
  });

  it('D2.4: an unparseable office layout.json is kept aside before anything can save over it', () => {
    fs.mkdirSync(office(), { recursive: true });
    fs.writeFileSync(office('layout.json'), '{"version":1,"cols":');
    expect(readLayoutFromFile(home)).toBeNull();
    const aside = fs.readdirSync(office()).filter((f) => f.startsWith('layout.json.corrupt-'));
    expect(aside).toHaveLength(1);
    expect(fs.readFileSync(office(aside[0]), 'utf-8')).toBe('{"version":1,"cols":');
  });

  it('D2.4: a config.json kept aside as corrupt is not revived from ~/.pixel-agents', () => {
    seedOldHome();
    fs.mkdirSync(office(), { recursive: true });
    fs.writeFileSync(office('config.json.corrupt-1'), '{"broken');
    expect(officeFileToRead('config.json', home)).toBe(office('config.json'));
    expect(officeFileToRead('layout.json', home)).toBe(old('layout.json'));
    expect(migrateOfficeFolder(home).copied).not.toContain('config.json');
  });

  it('D2.2: after a full reset (the skip marker) nothing is copied or read back from ~/.pixel-agents', () => {
    seedOldHome();
    const before = snapshot(old());
    fs.mkdirSync(office(), { recursive: true });
    fs.writeFileSync(legacyOfficeSkipFile(home), '');

    expect(migrateOfficeFolder(home)).toEqual({ copied: [], failed: [] });
    expect(fs.readdirSync(office())).toEqual([path.basename(legacyOfficeSkipFile(home))]);
    expect(officeFileToRead('config.json', home)).toBe(office('config.json'));
    expect(officeFileToRead('layout.json', home)).toBe(office('layout.json'));
    expect(snapshot(old())).toEqual(before);
  });

  it('a fresh home has nothing to move', () => {
    expect(migrateOfficeFolder(home)).toEqual({ copied: [], failed: [] });
    expect(fs.existsSync(office())).toBe(false);
  });
});
