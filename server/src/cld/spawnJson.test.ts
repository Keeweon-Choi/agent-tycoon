import { spawnSync } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import type { SpawnFn } from './spawnJson.js';
import { commandArgv, spawnJson } from './spawnJson.js';

/** A spawn whose children answer `{}` only when `finish(name)` is called. */
function heldSpawn() {
  const running = new Map<string, () => void>();
  const fn = ((file: string) => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    running.set(file, () => {
      running.delete(file);
      child.stdout.emit('data', Buffer.from('{}'));
      child.emit('close', 0, null);
    });
    return child;
  }) as unknown as SpawnFn;
  const finish = async (name: string) => {
    running.get(name)!();
    await new Promise((r) => setImmediate(r));
  };
  return { fn, running: () => [...running.keys()], finish };
}

describe('spawnJson', () => {
  it('runs one child at a time', async () => {
    const s = heldSpawn();
    const opts = { timeoutMs: 1_000, spawnFn: s.fn };
    const a = spawnJson('a', [], opts);
    const b = spawnJson('b', [], opts);
    await new Promise((r) => setImmediate(r));
    expect(s.running()).toEqual(['a']);
    await s.finish('a');
    expect(s.running()).toEqual(['b']);
    await s.finish('b');
    await expect(Promise.all([a, b])).resolves.toEqual([{}, {}]);
  });
});

describe('commandArgv', () => {
  it('runs a program as it is, and a Windows .cmd through cmd.exe, escaped', () => {
    expect(commandArgv('/usr/bin/claude', ['a b'], 'linux')).toEqual({ file: '/usr/bin/claude', args: ['a b'] });
    expect(commandArgv('C:\\x\\claude.exe', ['a b'], 'win32')).toEqual({ file: 'C:\\x\\claude.exe', args: ['a b'] });
    const r = commandArgv('C:\\Program Files\\npm\\claude.CMD', ['--settings', '{"a":"b c"}', 'x\\'], 'win32', 'cmd.exe');
    expect(r).toEqual({
      file: 'cmd.exe',
      args: ['/d', '/v:off', '/s', '/c', '"C:\\Program^ Files\\npm\\claude.CMD ^^^"--settings^^^" ^^^"{\\^^^"a\\^^^":\\^^^"b^^^ c\\^^^"}^^^" ^^^"x\\\\^^^""'],
      windowsVerbatimArguments: true,
    });
    expect(() => commandArgv('C:\\x\\claude.cmd', ['a\nb'], 'win32')).toThrow(/line break/);
  });

  // The real cmd.exe parse: what the .cmd's program receives is the argv given.
  it.runIf(process.platform === 'win32')('passes every argument through a real .cmd unchanged', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmdargv-'));
    const echo = path.join(dir, 'echo args.js');
    fs.writeFileSync(echo, 'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
    const cmd = path.join(dir, 'echo.cmd');
    fs.writeFileSync(cmd, `@"${process.execPath}" "%~dp0echo args.js" %*\r\n`);
    const args = ['plain', 'a b', '{"env":{"PATH":"C:\\\\x;D:\\\\y"}}', '%PATH%', 'a&b|c<d>e^f!g', 'tail\\', '"q"', ''];
    const r = commandArgv(cmd, args);
    const out = spawnSync(r.file, r.args, { windowsVerbatimArguments: true, encoding: 'utf-8' });
    expect(JSON.parse(out.stdout)).toEqual(args);
  });
});

/**
 * A reference model of cmd.exe (after the community write-up "How does the Windows Command
 * Interpreter parse scripts"), only what our lines need: `cmd /s /c "<line>"` drops the outer
 * quotes, expands defined %vars% (command-line mode), then reads quotes, ^ escapes and the
 * & | < > operators; npm's claude.cmd then runs `"node" "cli.js" %*`, and that line is read
 * once more (BatBadBut: %* is pasted in as it is and parsed again). Node's argv: the C runtime rule.
 * Delayed expansion (!var!) is not modelled: /v:off keeps it off whatever the registry says.
 */
const ENV: Record<string, string> = { PATH: 'C:\\Windows', VAR: 'EXPANDED' };
function expandLine(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; ) {
    const j = s[i] === '%' ? s.indexOf('%', i + 1) : -1;
    const name = j > i ? s.slice(i + 1, j).toUpperCase() : '';
    if (name in ENV) {
      out += ENV[name];
      i = j + 1;
    } else out += s[i++];
  }
  return out;
}
function readLine(s: string): { text: string; ops: string[]; command: string } {
  let text = '';
  let quoted = false;
  let command = -1;
  const ops: string[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"') quoted = !quoted;
    else if (!quoted && c === '^') {
      text += s[++i] ?? '';
      continue;
    } else if (!quoted && '&|<>'.includes(c)) ops.push(c);
    else if (!quoted && c === ' ' && command < 0) command = text.length;
    text += c;
  }
  return { text, ops, command: command < 0 ? text : text.slice(0, command) };
}
function crtArgv(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  for (;;) {
    while (s[i] === ' ') i++;
    if (i >= s.length) return out;
    let a = '';
    let quoted = false;
    while (i < s.length && (quoted || s[i] !== ' ')) {
      let n = 0;
      while (s[i] === '\\') {
        n++;
        i++;
      }
      if (s[i] !== '"') {
        a += '\\'.repeat(n) + (n ? '' : s[i++]);
        continue;
      }
      a += '\\'.repeat(n >> 1);
      if (n % 2) a += '"';
      else quoted = !quoted;
      i++;
    }
    out.push(a);
  }
}
function throughNpmShim(file: string, args: string[]) {
  const line = commandArgv(file, args, 'win32', 'cmd.exe').args.at(-1)!.slice(1, -1);
  const first = readLine(expandLine(line));
  const shim = readLine(`"node" "cli.js" ${first.text.slice(first.command.length + 1)}`);
  return { command: first.command, ops: [...first.ops, ...shim.ops], argv: crtArgv(shim.text).slice(2) };
}

describe('commandArgv through a modelled cmd.exe and npm shim', () => {
  const file = 'C:\\Program Files (x86)\\npm\\claude.cmd';
  it.each([
    'plain', 'a b', '', '"', '"q"', 'a"&calc', 'x"&calc&"', 'a&b|c<d>e', '^', 'e^f', '^^"&', '%PATH%',
    '%VAR%', '%%', '%PATH^%', '"%VAR%"', 'tail\\', 'tail\\\\', '\\"', '\\\\"&x', '(', ')', 'a;b,c=d',
    'Tom & "Jerry"', '{"env":{"PATH":"C:\\\\a&b;D:\\\\y"}}', 'ünï 日本',
  ])('%j reaches the program as it is, no operator anywhere', (arg) => {
    const r = throughNpmShim(file, ['-n', arg, '--next']);
    expect(r).toEqual({ command: file, ops: [], argv: ['-n', arg, '--next'] });
  });
});
