// D5 (F7): a test daemon's PATH never leads to a real codex or claude.
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { findOnPath } from './providers/claudeProvider.js';
import { isFakeOf, testDaemonPath } from './testHome.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function folder(...bins: string[]): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-path-'));
  dirs.push(d);
  for (const b of bins) fs.writeFileSync(path.join(d, exe(b)), '#!/bin/sh\n', { mode: 0o755 });
  return d;
}
/** A program's file name here: Windows finds `claude.cmd`, never a bare `claude`. */
const exe = (b: string) => (process.platform === 'win32' ? `${b}.cmd` : b);

describe('testDaemonPath', () => {
  it('the fakes first, then the caller’s folders without the ones holding a real codex or claude', () => {
    const realCodex = folder('codex', 'uv');
    const realClaude = folder('claude');
    const tools = folder('git', 'node');
    const notExec = folder();
    fs.writeFileSync(path.join(notExec, 'codex'), 'not a program', { mode: 0o644 });
    const fakeClaude = folder('claude');
    const fakeCodex = folder('codex');
    const caller = [realCodex, tools, 'relative/bin', realClaude, notExec, fakeClaude].join(path.delimiter);
    const out = testDaemonPath([fakeCodex, fakeClaude], caller);
    expect(out.split(path.delimiter)).toEqual([fakeCodex, fakeClaude, tools, notExec, fakeClaude]);
    expect(findOnPath('codex', out)).toBe(path.join(fakeCodex, exe('codex')));
    expect(findOnPath('claude', out)).toBe(path.join(fakeClaude, exe('claude')));
    // No fakes: no codex or claude at all, the other tools still there.
    const bare = testDaemonPath([], caller);
    expect([findOnPath('codex', bare), findOnPath('claude', bare)]).toEqual([null, null]);
    expect(findOnPath('git', bare)).toBe(path.join(tools, exe('git')));
  });
});

describe('isFakeOf', () => {
  // Every real kill a test makes goes through it: only a fake session of that test HOME.
  it.runIf(process.platform !== 'win32')('names a fake session of this home only, never a stranger', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-fake-'));
    dirs.push(home);
    // A loop, as the fake's: a lone command would be exec'd and lose the argv.
    const child = spawn('sh', ['-c', 'while :; do sleep 1; done', 'fake-claude-session', home], {
      env: { ...process.env, HOME: home },
      stdio: 'ignore',
    });
    try {
      await new Promise((r) => child.once('spawn', r));
      expect(isFakeOf(child.pid!, home)).toBe(true);
      expect(isFakeOf(child.pid!, `${home}-other`)).toBe(false);
      expect(isFakeOf(process.pid, home)).toBe(false);
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('never on Windows', () => {
    expect(isFakeOf(process.pid, os.homedir(), 'win32')).toBe(false);
  });
});
