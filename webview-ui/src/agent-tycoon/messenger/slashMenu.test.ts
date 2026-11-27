import { expect, it } from 'vitest';

import { filterSlashCommands, slashHint, slashMenuKey } from './slashMenu.js';

const commands = [
  { name: 'context', description: '', source: 'builtin' as const },
  { name: 'compact', args: '[instruction]', description: '', source: 'builtin' as const },
  { name: 'my:compare', description: '', source: 'project' as const },
];
const [context, compact] = commands;
const model = { name: 'model', args: '<model>', description: '', source: 'builtin' as const };
const addDir = {
  name: 'add-dir',
  args: '<path>',
  description: '',
  source: 'builtin' as const,
  argsRequired: true,
};

it('filters slash commands with the exact name, then prefix matches, then substring matches', () => {
  expect(filterSlashCommands(commands, '/co').map((command) => command.name)).toEqual([
    'context',
    'compact',
    'my:compare',
  ]);
  expect(filterSlashCommands(commands, '/compare').map((command) => command.name)).toEqual([
    'my:compare',
  ]);
  expect(filterSlashCommands(commands, '/compact arg')).toEqual([]);
  const named = [{ name: 'models', description: '', source: 'user' as const }, model];
  expect(filterSlashCommands(named, '/model').map((command) => command.name)).toEqual([
    'model',
    'models',
  ]);
});

it('moves with the arrows, completes with Tab, closes with Esc, and ignores IME', () => {
  expect(slashMenuKey('ArrowUp', true, false, '/c', context)).toBe('moveUp');
  expect(slashMenuKey('ArrowDown', true, false, '/c', context)).toBe('moveDown');
  expect(slashMenuKey('Escape', true, false, '/c', context)).toBe('close');
  expect(slashMenuKey('Tab', true, false, '/c', context)).toBe('fill');
  expect(slashMenuKey('Tab', true, false, '/context', context)).toBe('fill');
  expect(slashMenuKey('Enter', true, true, '/c', context)).toBeNull();
  expect(slashMenuKey('Enter', false, false, '/c', context)).toBeNull();
  expect(slashMenuKey('a', true, false, '/c', context)).toBeNull();
});

it('Enter inserts a command that takes arguments and sends a complete one, like the terminal', () => {
  // Partly typed: one with arguments is inserted (its hint shows), one without goes at once.
  expect(slashMenuKey('Enter', true, false, '/mo', model)).toBe('fill');
  expect(slashMenuKey('Enter', true, false, '/comp', compact)).toBe('fill');
  expect(slashMenuKey('Enter', true, false, '/cont', context)).toBe('send');
  // Typed whole: it goes as typed (a bare /model opens the CLI's picker).
  expect(slashMenuKey('Enter', true, false, '/model', model)).toBeNull();
  expect(slashMenuKey('Enter', true, false, '/Context', context)).toBeNull();
  // One that cannot go without its argument is always inserted.
  expect(slashMenuKey('Enter', true, false, '/add-dir', addDir)).toBe('fill');
  // Nothing to pick: Enter sends what is typed, and the daemon says why it is no command.
  expect(slashMenuKey('Enter', true, false, '/nope', undefined)).toBeNull();
  expect(slashMenuKey('Tab', true, false, '/nope', undefined)).toBeNull();
});

it('shows the argument hint only right after an inserted command, until the owner types', () => {
  const list = [...commands, model];
  expect(slashHint('/model ', list)).toBe('<model>');
  expect(slashHint('/Model ', list)).toBe('<model>');
  expect(slashHint('/model', list)).toBeNull();
  expect(slashHint('/model s', list)).toBeNull();
  expect(slashHint('/model  ', list)).toBeNull();
  expect(slashHint('/context ', list)).toBeNull();
  expect(slashHint('/model ', undefined)).toBeNull();
});
