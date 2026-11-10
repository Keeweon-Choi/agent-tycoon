import type { SlashCommand } from '../../../../core/src/messages.js';

/** Commands that match the unfinished first token, with prefix hits first. */
export function filterSlashCommands(
  commands: readonly SlashCommand[],
  text: string,
): SlashCommand[] {
  if (!/^\/[^\s]*$/.test(text)) return [];
  const query = text.slice(1).toLocaleLowerCase();
  return commands
    .map((command, index) => ({ command, index, name: command.name.toLocaleLowerCase() }))
    .filter(({ name }) => name.includes(query))
    .sort(
      (a, b) =>
        Number(!a.name.startsWith(query)) - Number(!b.name.startsWith(query)) || a.index - b.index,
    )
    .map(({ command }) => command);
}

export type SlashMenuKey = 'moveUp' | 'moveDown' | 'choose' | 'close' | null;

/** Keyboard behavior independent of the composer DOM; IME never drives the menu. */
export function slashMenuKey(
  key: string,
  open: boolean,
  isComposing: boolean,
  complete = false,
): SlashMenuKey {
  if (!open || isComposing) return null;
  // The whole command name is typed and it needs no argument: Enter sends it.
  if (key === 'Enter' && complete) return null;
  if (key === 'ArrowUp') return 'moveUp';
  if (key === 'ArrowDown') return 'moveDown';
  if (key === 'Enter' || key === 'Tab') return 'choose';
  if (key === 'Escape') return 'close';
  return null;
}

/** The highlighted command is exactly what was typed and can go without an argument. */
export function slashComplete(text: string, command: SlashCommand | undefined): boolean {
  return (
    !!command &&
    !command.argsRequired &&
    text.toLocaleLowerCase() === `/${command.name.toLocaleLowerCase()}`
  );
}
