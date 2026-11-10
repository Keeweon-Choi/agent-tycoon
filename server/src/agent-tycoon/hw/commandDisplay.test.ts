import { describe, expect, it } from 'vitest';

import { shortProcessCommand } from './commandDisplay.js';

describe('shortProcessCommand', () => {
  it('keeps a program and flags but reduces home paths to their file names', () => {
    const display = shortProcessCommand(
      '/home/u/.local/share/claude/versions/2.1.309 --resume /home/u/.claude/projects/x/y.jsonl --append-system-prompt-file /home/u/.config/team/rules-engine.md',
    );

    expect(display).toBe('2.1.309 --resume y.jsonl --append-system-prompt-file rules-engine.md');
    expect(display).not.toContain('/home/');
  });

  it('uses ~ for a home directory itself and caps an overlong summary', () => {
    const display = shortProcessCommand(`tool --cwd /home/u ${'--verbose '.repeat(30)}`, 40);

    expect(display).toContain('--cwd ~');
    expect(display).toHaveLength(40);
    expect(display.endsWith('…')).toBe(true);
    expect(display).not.toContain('/home/');
  });
});
