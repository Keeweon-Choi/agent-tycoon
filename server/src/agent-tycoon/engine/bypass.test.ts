import { Terminal as HeadlessTerminal } from '@xterm/headless';
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import type { IPty } from '../../terminal/ptyModule.js';
import { makeEngineHome, removeTestHome } from '../testHome.js';
import { acceptBypass, BYPASS_ARGS,bypassDialog } from './bypass.js';

const FAST = {
  appearMs: 3_000,
  settleMs: 100,
  moveMs: 800,
  pastMs: 1_500,
  exitMs: 2_000,
  ctrlCGapMs: 80,
  pollMs: 25,
};

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanup.reverse()) c();
  cleanup = [];
});

function setup(mode?: string) {
  const { home, claudePath } = makeEngineHome();
  cleanup.push(() => removeTestHome(home));
  const folder = path.join(home, 'work', 'alpha');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, '.fake-bypass-needed'), '');
  if (mode) fs.writeFileSync(path.join(folder, '.fake-bypass'), mode);
  const logs: string[] = [];
  const killed: number[] = [];
  const run = (timing = FAST, answerTrust = false) =>
    acceptBypass({
      file: claudePath,
      args: BYPASS_ARGS,
      cwd: folder,
      env: { ...process.env, HOME: home, FAKE_HANG_MS: '3000' },
      log: (l) => logs.push(l),
      answerTrust,
      timing,
      kill: (p: IPty) => killed.push(p.pid),
    });
  const keys = (): string[] => {
    try {
      return fs
        .readFileSync(path.join(home, 'fake-claude-bypass.log'), 'utf-8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => (JSON.parse(l) as { key: string }).key);
    } catch {
      return [];
    }
  };
  return {
    run,
    keys,
    logs,
    killed,
    folder,
    needed: () => fs.existsSync(path.join(folder, '.fake-bypass-needed')),
  };
}

describe('Claude Code Bypass Permissions warning through a real PTY (fake claude)', () => {
  it('answers only the exact warning: Down, Enter, then Ctrl+C twice', async () => {
    const s = setup();
    expect(await s.run()).toEqual({
      outcome: 'accepted',
      trusted: false,
      steps: ['started', 'dialog', 'chose', 'past', 'closed'],
    });
    expect(s.keys()).toEqual(['\x1b[B', '\r', '\x03', '\x03']);
    expect(s.needed()).toBe(false);
    expect(s.killed).toEqual([]);
  });

  it('when Down does not put the pointer on Yes, it sends no Enter', async () => {
    const s = setup('nomove');
    const r = await s.run();
    expect(r.outcome).toBe('unknownScreen');
    expect(r.steps).toEqual(['started', 'dialog', 'killed']);
    expect(s.keys()).toEqual(['\x1b[B']);
    expect(s.needed()).toBe(true);
  });

  it('an unknown screen and trust with answerTrust false are untouched', async () => {
    for (const mode of ['unknown', 'trust']) {
      const s = setup(mode);
      const r = await s.run({ ...FAST, appearMs: 500 }, false);
      expect(r.outcome, mode).toBe('unknownScreen');
      expect(r.steps, mode).toEqual(['started', 'killed']);
      expect(s.keys(), mode).toEqual([]);
      expect(s.needed(), mode).toBe(true);
    }
  });

  it('answers the plain trust question before the bypass warning when authorised', async () => {
    const s = setup();
    fs.writeFileSync(path.join(s.folder, '.fake-untrusted'), '');
    expect(await s.run(FAST, true)).toEqual({
      outcome: 'accepted',
      trusted: true,
      steps: ['started', 'trusted', 'dialog', 'chose', 'past', 'closed'],
    });
    expect(s.keys()).toEqual(['\x1b[B', '\r', '\x1b[B', '\r', '\x03', '\x03']);
    expect(fs.existsSync(path.join(s.folder, '.fake-untrusted'))).toBe(false);
    expect(s.needed()).toBe(false);
  });

  it('a child that never shows a screen is killed within the bound', async () => {
    const s = setup('hang');
    const started = Date.now();
    const r = await s.run({ ...FAST, appearMs: 400 });
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(r).toEqual({ outcome: 'timeout', trusted: false, steps: ['started', 'killed'] });
    expect(s.keys()).toEqual([]);
    expect(s.killed).toHaveLength(1);
  });
});

const WARNING = [
  'WARNING: Claude Code running in Bypass Permissions mode',
  'By proceeding, you accept all responsibility for actions taken while running in Bypass Permissions mode.',
  '❯ No, exit',
  '  Yes, I accept',
];

async function screenOf(rows: string[]): Promise<HeadlessTerminal> {
  const term = new HeadlessTerminal({ cols: 160, rows: 60, scrollback: 0, allowProposedApi: true });
  await new Promise<void>((r) => term.write(rows.join('\r\n'), r));
  return term;
}

describe('bypassDialog', () => {
  it('requires every part of the one-time warning and reads the pointer', async () => {
    expect(bypassDialog(await screenOf(WARNING))).toEqual({ onYes: false, onNo: true });
    expect(bypassDialog(await screenOf([...WARNING.slice(0, 2), '  No, exit', '❯ Yes, I accept']))).toEqual({
      onYes: true,
      onNo: false,
    });
    // A Windows console's ASCII pointer reads the same.
    expect(bypassDialog(await screenOf([...WARNING.slice(0, 2), '> No, exit', '  Yes, I accept']))).toEqual({
      onYes: false,
      onNo: true,
    });
    // Windows Claude Code 2.1.311 uses U+203A for the focused option.
    expect(bypassDialog(await screenOf([...WARNING.slice(0, 2), '› No, exit', '  Yes, I accept']))).toEqual({
      onYes: false,
      onNo: true,
    });
    for (const rows of [WARNING.slice(1), WARNING.slice(0, -1), ['Accessing workspace:', '❯ No, exit', '  Yes, I accept']])
      expect(bypassDialog(await screenOf(rows))).toBeNull();
  });
});
