import { expect, it } from 'vitest';

import { filterSlashCommands, slashComplete, slashMenuKey } from './slashMenu.js';

const commands = [
  { name: 'context', description: '', source: 'builtin' as const },
  { name: 'compact', description: '', source: 'builtin' as const },
  { name: 'my:compare', description: '', source: 'project' as const },
];

it('filters slash commands with prefix matches before substring matches', () => {
  expect(filterSlashCommands(commands, '/co').map((command) => command.name)).toEqual([
    'context',
    'compact',
    'my:compare',
  ]);
  expect(filterSlashCommands(commands, '/compare').map((command) => command.name)).toEqual([
    'my:compare',
  ]);
  expect(filterSlashCommands(commands, '/compact arg')).toEqual([]);
});

it('uses arrows to move, Enter or Tab to choose, Esc to close, and ignores IME', () => {
  expect(slashMenuKey('ArrowUp', true, false)).toBe('moveUp');
  expect(slashMenuKey('ArrowDown', true, false)).toBe('moveDown');
  expect(slashMenuKey('Enter', true, false)).toBe('choose');
  expect(slashMenuKey('Tab', true, false)).toBe('choose');
  expect(slashMenuKey('Escape', true, false)).toBe('close');
  expect(slashMenuKey('Enter', true, true)).toBeNull();
  expect(slashMenuKey('Enter', false, false)).toBeNull();
});

it('lets Enter send a fully typed command that needs no argument', () => {
  const compact = { name: 'compact', description: '', source: 'builtin' as const };
  const model = { name: 'model', description: '', source: 'builtin' as const, argsRequired: true };
  expect(slashComplete('/compact', compact)).toBe(true);
  expect(slashComplete('/Compact', compact)).toBe(true);
  expect(slashComplete('/comp', compact)).toBe(false);
  expect(slashComplete('/model', model)).toBe(false);
  expect(slashMenuKey('Enter', true, false, true)).toBeNull();
  expect(slashMenuKey('Tab', true, false, true)).toBe('choose');
});
