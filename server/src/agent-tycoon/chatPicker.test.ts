/**
 * T-81: a picker or dialog is open on Claude Code's screen. A bare slash command (/model, /config)
 * opens one in the place of the input box, and a key typed then lands in it: Enter picks its
 * pointed row (11-11: a blind Enter in /config turned the owner's auto-compact off). The screens
 * are the real CLI's where a capture exists (fixtures/claude-screens/README.md), hand-made for what
 * must not be taken for one.
 */
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';

import { inputBoxTaken, inputLineEmpty, permissionDialog, pickerOnScreen } from './chat.js';
import { OfficeChat } from './office/chat.js';

const SCREENS = path.join(__dirname, 'fixtures/claude-screens');
const SIZE = { cols: 120, rows: 40 };

/** A screen's rows, as its file has them. */
function rows(name: string): string[] {
  const out = fs.readFileSync(path.join(SCREENS, `${name}.txt`), 'utf-8').replace(/\n$/, '').split('\n');
  if (out.length !== SIZE.rows || out.some((r) => [...r].length > SIZE.cols))
    throw new Error(`${name}: not a ${SIZE.cols}x${SIZE.rows} screen`);
  return out;
}

/** `look` at `screen` on a terminal of the captures' size. */
async function on<T>(screen: string[], look: (term: HeadlessTerminal) => T): Promise<T> {
  const term = new HeadlessTerminal({ ...SIZE, allowProposedApi: true });
  await new Promise<void>((r) => term.write(`\x1b[2J\x1b[H${screen.join('\r\n')}`, r));
  try {
    return look(term);
  } finally {
    term.dispose();
  }
}

/** The real 2.1.322 screens with a picker or dialog in the input box's place, then hand-made copies
 *  of them with no pointed row (the Settings dialog's Status tab, a search that matches nothing). */
const OPEN = [
  'picker-model',
  'dialog-config-search',
  'dialog-config-list',
  'dialog-model-no-pointer',
  'dialog-config-no-match',
  'dialog-settings-status',
  // T-141: the model picker opened while a turn runs, its spinner row above it (inferred, README).
  'picker-model-turn-running',
];
/** Real screens with the input box (the first four), and hand-made ones that only look alike. */
const NOT_OPEN = [
  'input-empty',
  'input-slash-suggestions',
  'input-slash-suggestions-after-a-command',
  'input-after-picker-closed',
  'turn-running',
  'permission-prompt',
  'long-output',
];
/** Where Claude Code's pointer and prompt glyph falls back (a Windows ConPTY, 10-28). */
const windows = (screen: string[], glyph: string) => screen.map((r) => r.replaceAll('❯', glyph));

describe("T-81: a picker or dialog in the input box's place, read off the screen", () => {
  it.each(OPEN)('open: %s', async (name) => {
    expect(await on(rows(name), pickerOnScreen)).toBe(true);
  });

  // The input row is the prompt glyph in the first column between the two rules. A pointer in a
  // suggestion list or a picker is indented; a command's echo in the transcript has no rules.
  it.each(NOT_OPEN)('not open: %s', async (name) => {
    expect(await on(rows(name), pickerOnScreen)).toBe(false);
  });

  it("the same with Windows' glyphs ('›', '>') for the prompt and the pointer", async () => {
    for (const glyph of ['›', '>']) {
      for (const name of OPEN) expect(await on(windows(rows(name), glyph), pickerOnScreen), `${name} ${glyph}`).toBe(true);
      for (const name of NOT_OPEN)
        expect(await on(windows(rows(name), glyph), pickerOnScreen), `${name} ${glyph}`).toBe(false);
    }
  });

  // inputRow() takes the prompt glyph and the rule above it after leading blanks: so does this.
  it('the same one column to the right (leading blanks before the prompt glyph and the rule)', async () => {
    const shifted = (screen: string[]) => screen.map((r) => ` ${r}`.slice(0, SIZE.cols));
    for (const name of OPEN) expect(await on(shifted(rows(name)), pickerOnScreen), name).toBe(true);
    for (const name of NOT_OPEN) expect(await on(shifted(rows(name)), pickerOnScreen), name).toBe(false);
  });

  it('nothing drawn yet is no picker: a terminal just started says nothing either way', async () => {
    expect(await on([], pickerOnScreen)).toBe(false);
  });

  // What the product reads off these screens today. If one of these fails, the fixture (or Claude
  // Code's screen) no longer has the shape the readers know, and the tests above prove nothing.
  it('the screens read as the existing readers know them', async () => {
    expect(await on(rows('input-empty'), (t) => inputLineEmpty(t))).toBe(true);
    expect(await on(rows('input-after-picker-closed'), (t) => inputLineEmpty(t))).toBe(true);
    for (const typed of ['input-slash-suggestions', 'input-slash-suggestions-after-a-command'])
      expect(await on(rows(typed), inputBoxTaken), typed).toBe(true);
    expect(await on(rows('turn-running'), (t) => [inputLineEmpty(t), inputLineEmpty(t, true)])).toEqual([false, true]);
    expect(await on(rows('permission-prompt'), (t) => permissionDialog(t))).toContain('rm -rf build');
    for (const name of [...OPEN, 'permission-prompt']) {
      expect(await on(rows(name), (t) => inputLineEmpty(t, true)), name).toBe(false);
      expect(await on(rows(name), inputBoxTaken), name).toBe(false);
    }
    for (const name of OPEN) expect(await on(rows(name), (t) => permissionDialog(t)), name).toBeNull();
  });
});

describe('T-81: the office passes a picker opened by a sent command on to the app', () => {
  /** An office chat over a messenger whose send answers `result` (the rest is not reached by a chatSend). */
  function chatWith(result: Record<string, unknown>) {
    const sent: Array<Record<string, unknown>> = [];
    const messenger = { send: vi.fn((req: Record<string, unknown>) => (sent.push(req), Promise.resolve(result))) };
    const chat = new OfficeChat({
      opts: { chat: true },
      engine: { names: () => ['alpha'], folderOf: () => null },
      messenger,
      slash: { list: () => [] },
    } as unknown as ConstructorParameters<typeof OfficeChat>[0]);
    const replies: Array<Record<string, unknown>> = [];
    const ask = async (text: string) => {
      chat.onClientMessage(
        { type: 'chatSend', requestId: 'r1', name: 'alpha', text },
        { send: (m) => replies.push(m as Record<string, unknown>), privileged: true },
      );
      return vi.waitFor(() => {
        expect(replies).toHaveLength(1);
        return replies[0];
      });
    };
    return { ask, sent };
  }

  it("chatSendResult carries screen: 'picker' when the command it entered opened one, so the app can offer the terminal view", async () => {
    const { ask, sent } = chatWith({ ok: true, delivered: 'pane', screen: 'picker' });
    expect(await ask('/model')).toEqual({
      type: 'chatSendResult',
      requestId: 'r1',
      name: 'alpha',
      ok: true,
      delivered: 'pane',
      screen: 'picker',
    });
    expect(sent).toEqual([expect.objectContaining({ to: 'alpha', text: '/model', raw: true })]);
  });

  it('no screen field on an ordinary delivery', async () => {
    const { ask } = chatWith({ ok: true, delivered: 'pane' });
    expect(await ask('/compact')).not.toHaveProperty('screen');
  });
});
