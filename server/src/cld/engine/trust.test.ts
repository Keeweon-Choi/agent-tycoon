import { Terminal as HeadlessTerminal } from '@xterm/headless';
import * as fs from 'fs';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import type { IPty } from '../../terminal/ptyModule.js';
import { makeEngineHome, removeTestHome } from '../testHome.js';
import { trustDialog, trustFolder } from './trust.js';

const FAST = {
  appearMs: 5_000,
  settleMs: 200,
  moveMs: 1_000,
  pastMs: 1_500,
  exitMs: 2_000,
  ctrlCGapMs: 100,
  pollMs: 30,
};

let cleanup: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanup.reverse()) c();
  cleanup = [];
});

/** A folder the fake claude does not trust yet, with an optional variant (.fake-trust). */
function setup(mode?: string, untrusted = true) {
  const { home, claudePath } = makeEngineHome();
  cleanup.push(() => removeTestHome(home));
  const folder = path.join(home, 'work', 'alpha');
  fs.mkdirSync(folder, { recursive: true });
  if (untrusted) fs.writeFileSync(path.join(folder, '.fake-untrusted'), '');
  if (mode) fs.writeFileSync(path.join(folder, '.fake-trust'), mode);
  const logs: string[] = [];
  const killed: number[] = [];
  const run = (timing = FAST) =>
    trustFolder({
      file: claudePath,
      args: [],
      cwd: folder,
      env: { ...process.env, HOME: home, FAKE_HANG_MS: '3000' },
      log: (l) => logs.push(l),
      timing,
      kill: (p: IPty) => killed.push(p.pid),
    });
  const keys = (): string[] => {
    try {
      return fs
        .readFileSync(path.join(home, 'fake-claude-trust.log'), 'utf-8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => (JSON.parse(l) as { key: string }).key);
    } catch {
      return [];
    }
  };
  const stillUntrusted = () => fs.existsSync(path.join(folder, '.fake-untrusted'));
  return { run, keys, stillUntrusted, logs, killed };
}

describe('the folder-trust question through a real PTY (fake claude)', () => {
  it('answers the recorded dialog: Down onto Yes, Enter, then Claude exits with Ctrl+C twice', async () => {
    const s = setup();
    const r = await s.run();
    expect(r).toEqual({
      outcome: 'trusted',
      steps: ['started', 'dialog', 'chose', 'past', 'closed'],
    });
    expect(s.stillUntrusted()).toBe(false);
    expect(s.keys()).toEqual(['\x1b[B', '\r', '\x03', '\x03']);
    expect(s.killed).toEqual([]);
    expect(s.logs.some((l) => l.includes('chose "Yes, I trust this folder"'))).toBe(true);
  });

  it('a folder already trusted: no dialog, nothing chosen, a clean exit', async () => {
    const s = setup(undefined, false);
    const r = await s.run();
    expect(r).toEqual({ outcome: 'alreadyTrusted', steps: ['started', 'closed'] });
    expect(s.keys()).toEqual(['\x03', '\x03']);
  });

  it('negative controls: an unknown screen, a dialog listing pre-approvals, a crash: nothing pressed', async () => {
    for (const [mode, outcome] of [
      ['unknown', 'unknownScreen'],
      ['warn', 'warnings'],
      ['crash', 'exited'],
    ] as const) {
      const s = setup(mode);
      const r = await s.run({ ...FAST, appearMs: 1_500 });
      expect(r.outcome, mode).toBe(outcome);
      expect(r.steps, mode).not.toContain('chose');
      // Only Claude's own exit keys, never an answer.
      expect(
        s.keys().filter((k) => k !== '\x03'),
        mode,
      ).toEqual([]);
      expect(s.stillUntrusted(), mode).toBe(true);
      expect(s.killed, mode).toEqual([]);
    }
  });

  it('the screen changes between Down and Enter (input line, late pre-approvals): no Enter', async () => {
    for (const mode of ['swap', 'latewarn']) {
      const s = setup(mode);
      const r = await s.run();
      expect(r.outcome, mode).toBe('unknownScreen');
      expect(r.steps, mode).not.toContain('chose');
      expect(s.keys(), mode).toEqual(['\x1b[B', '\x03', '\x03']);
      expect(s.stillUntrusted(), mode).toBe(true);
    }
  });

  it('a dialog that stays after Enter is not taken for an answer', async () => {
    const s = setup('stuck');
    const r = await s.run();
    expect(r.outcome).toBe('notMoved');
    expect(r.steps).toEqual(['started', 'dialog', 'chose', 'closed']);
  });

  it('a hang: bounded, then our own child is ended (fake kill)', async () => {
    const s = setup('hang');
    const started = Date.now();
    const r = await s.run({ ...FAST, appearMs: 800, exitMs: 500 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(r.outcome).toBe('timeout');
    expect(r.steps).toEqual(['started', 'killed']);
    expect(s.killed).toHaveLength(1);
    expect(s.stillUntrusted()).toBe(true);
  });
});

/** Screens as Claude Code 2.1.310 drew them in the verifier's real run (10-25, 160x60 PTY), and
 *  other screens the recogniser must never take for the trust question. */
const RULE = '─'.repeat(160);
const REAL_TRUST = (pointerOnYes: boolean, warn = false) => [
  RULE,
  ' Accessing workspace:',
  '',
  ' /var/tmp/vat-trust-5axkDu',
  '',
  ' Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source project, or work from your team). If not,',
  " take a moment to review what's in this folder first.",
  '',
  " Claude Code'll be able to read, edit, and execute files here.",
  '',
  ...(warn
    ? [
        ' ⚠ This folder pre-approves 2 tool permissions in .claude/settings.json:',
        '   WebFetch and Bash(rm:*)',
        ' These will apply without asking. Only proceed if you trust this configuration.',
        '',
      ]
    : []),
  ' Security guide',
  '',
  ` ${pointerOnYes ? ' ' : '❯'} No, exit`,
  ` ${pointerOnYes ? '❯' : ' '} Yes, I trust this folder`,
  '',
  ' Enter to confirm · Esc to cancel',
];
const REAL_PROMPT = (input: string) => [
  ' ▐▛███▛█   Claude Code v2.1.310',
  '▝▜██████▀  Opus 5.5 with high effort · Claude Max',
  ' ▝▝   ▝▝   /var/tmp/vat-trust-5axkDu',
  RULE,
  `❯ ${input}`,
  RULE,
  '  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents',
];

async function screenOf(rows: string[]): Promise<HeadlessTerminal> {
  const term = new HeadlessTerminal({ cols: 160, rows: 60, scrollback: 0, allowProposedApi: true });
  await new Promise<void>((r) => term.write(rows.join('\r\n'), r));
  return term;
}

describe('trustDialog: the real 2.1.310 screens, and screens that are not the question', () => {
  it('reads the real dialog: pointer on No, then on Yes, and the pre-approvals variant', async () => {
    expect(trustDialog(await screenOf(REAL_TRUST(false)))).toEqual({ onYes: false, warnings: false });
    expect(trustDialog(await screenOf(REAL_TRUST(true)))).toEqual({ onYes: true, warnings: false });
    expect(trustDialog(await screenOf(REAL_TRUST(false, true)))).toEqual({ onYes: false, warnings: true });
  });

  it('is null for the prompt, a recalled history line, other dialogs and partial frames', async () => {
    const screens: Record<string, string[]> = {
      prompt: REAL_PROMPT('Try "refactor <filepath>"'),
      history: REAL_PROMPT('Yes, I trust this folder'),
      bypass: [
        ' WARNING: Claude Code running in Bypass Permissions mode',
        ' By proceeding, you accept all responsibility for actions taken while running in Bypass Permissions mode.',
        ' ❯ 1. No, exit',
        '   2. Yes, I accept',
      ],
      mcp: [
        ' New MCP server found in .mcp.json: files',
        ' ❯ 1. Use this and all future MCP servers in this project',
        '   2. Use this MCP server',
        '   3. Continue without using this MCP server',
      ],
      login: [' Select login method:', ' ❯ 1. Claude account with subscription', '   2. Anthropic Console account'],
      theme: [' Choose the text style that looks best with your terminal', ' ❯ 1. Dark mode', '   2. Light mode'],
      // The question drawn in pieces: the title and No without Yes yet, or the options without the title.
      partialNoYes: REAL_TRUST(false).slice(0, -3),
      partialNoTitle: REAL_TRUST(false).slice(2),
      // Its wording inside other text (a quoted line), not as the dialog's own option rows.
      quoted: [' Accessing workspace:', ' the options read "No, exit" and "Yes, I trust this folder"'],
    };
    for (const [name, rows] of Object.entries(screens))
      expect(trustDialog(await screenOf(rows)), name).toBeNull();
  });
});
