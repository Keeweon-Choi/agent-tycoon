import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { configDirectory } from './configPath.js';
import {
  callerIdentity,
  ensureOwnerToken,
  jobsFolder,
  ownerTokenMatches,
  ownerTokenPath,
  readOwnerToken,
} from './controlIdentity.js';
import { jobsDir } from './engine/jobs.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'agty-ident-'));
  dirs.push(d);
  return d;
};

/** A fake /proc: pid → [ppid, environment]. */
function fakeProc(tree: Record<number, [number, Record<string, string>]>): string {
  const proc = tmp();
  for (const [pid, [ppid, env]] of Object.entries(tree)) {
    fs.mkdirSync(path.join(proc, pid));
    fs.writeFileSync(path.join(proc, pid, 'stat'), `${pid} (a b) c) S ${ppid} 1 1 0`);
    fs.writeFileSync(
      path.join(proc, pid, 'environ'),
      Object.entries(env).map(([k, v]) => `${k}=${v}\0`).join(''),
    );
  }
  return proc;
}

const T1 = 'a'.repeat(43);
const T2 = 'b'.repeat(43);

function homeWithAgent(token: string): string {
  const home = tmp();
  fs.mkdirSync(configDirectory(home), { recursive: true });
  const hash = createHash('sha256').update(token).digest('hex');
  fs.writeFileSync(path.join(configDirectory(home), 'agent-tokens.json'), JSON.stringify({ v: 1, tokens: { alpha: hash } }));
  return home;
}

describe('SEC-CONTROL owner token', () => {
  it('is made once, 0600, kept across calls; a file that is not one is replaced', () => {
    const home = tmp();
    expect(readOwnerToken(home)).toBeNull();
    const t = ensureOwnerToken(home);
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(ensureOwnerToken(home)).toBe(t);
    if (process.platform !== 'win32') expect(fs.statSync(ownerTokenPath(home)).mode & 0o777).toBe(0o600);
    expect(ownerTokenMatches(home, t)).toBe(true);
    expect(ownerTokenMatches(home, T1)).toBe(false);
    expect(ownerTokenMatches(home, undefined)).toBe(false);
    fs.writeFileSync(ownerTokenPath(home), 'garbage');
    const again = ensureOwnerToken(home);
    expect(again).not.toBe(t);
    expect(ownerTokenMatches(home, t)).toBe(false);
    expect(fs.readdirSync(configDirectory(home)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('the jobs folder is the engine’s', () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const)
      expect(jobsFolder('/h', platform, { LOCALAPPDATA: 'C:/L' })).toBe(jobsDir('/h', platform, { LOCALAPPDATA: 'C:/L' }));
  });
});

describe('SEC-CONTROL callerIdentity', () => {
  it('nothing of this daemon in the line: the owner token (and a foreign env token passes through)', () => {
    const home = homeWithAgent(T1);
    const owner = ensureOwnerToken(home);
    const proc = fakeProc({ 10: [5, {}], 5: [1, { AGTY_AGENT_TOKEN: T2 }] });
    expect(callerIdentity(home, {}, { proc, pid: 10, platform: 'linux' })).toEqual({ owner });
    expect(callerIdentity(home, { AGTY_AGENT_TOKEN: T2 }, { proc, pid: 10, platform: 'linux' })).toEqual({ token: T2, owner });
  });

  it('an agent of this daemon: its token, never the owner token, also with the variable dropped or faked', () => {
    const home = homeWithAgent(T1);
    ensureOwnerToken(home);
    const proc = fakeProc({ 10: [7, {}], 7: [5, { AGTY_AGENT_TOKEN: T1 }], 5: [1, {}] });
    const o = { proc, pid: 10, platform: 'linux' as const };
    expect(callerIdentity(home, { AGTY_AGENT_TOKEN: T1 }, o)).toEqual({ token: T1 });
    expect(callerIdentity(home, {}, o)).toEqual({ token: T1 }); // dropped: the shell above still has it
    expect(callerIdentity(home, { AGTY_AGENT_TOKEN: T2 }, o)).toEqual({ token: T1 }); // faked
  });

  it('a job of this daemon (its record exists): neither token', () => {
    const home = tmp();
    ensureOwnerToken(home);
    const job = '1101-020000-alpha';
    fs.mkdirSync(jobsFolder(home, 'linux'), { recursive: true });
    fs.writeFileSync(path.join(jobsFolder(home, 'linux'), `${job}.json`), '{}');
    const proc = fakeProc({ 10: [6, {}], 6: [1, { AGTY_JOB_ID: job }] });
    expect(callerIdentity(home, {}, { proc, pid: 10, platform: 'linux' })).toEqual({});
    expect(callerIdentity(home, { AGTY_JOB_ID: job }, { platform: 'darwin' })).toEqual({});
    // Another daemon's job (a runner started from a job): the owner of this one.
    const other = fakeProc({ 10: [6, {}], 6: [1, { AGTY_JOB_ID: '1101-020000-other' }] });
    expect(callerIdentity(home, {}, { proc: other, pid: 10, platform: 'linux' }).owner).toBe(readOwnerToken(home));
  });

  it('off Linux only the own environment counts; no owner-token file means no owner', () => {
    const home = homeWithAgent(T1);
    expect(callerIdentity(home, {}, { platform: 'win32' })).toEqual({});
    ensureOwnerToken(home);
    expect(callerIdentity(home, { AGTY_AGENT_TOKEN: T1 }, { platform: 'win32' })).toEqual({ token: T1 });
  });
});
