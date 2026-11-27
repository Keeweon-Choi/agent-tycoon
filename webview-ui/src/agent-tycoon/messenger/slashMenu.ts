import type { SlashCommand } from '../../../../core/src/messages.js';

/** Commands that match the unfinished first token: the exact name, then prefix hits, then the rest. */
export function filterSlashCommands(
  commands: readonly SlashCommand[],
  text: string,
): SlashCommand[] {
  if (!/^\/[^\s]*$/.test(text)) return [];
  const query = text.slice(1).toLocaleLowerCase();
  const rank = (name: string) => (name === query ? 0 : name.startsWith(query) ? 1 : 2);
  return commands
    .map((command, index) => ({ command, index, name: command.name.toLocaleLowerCase() }))
    .filter(({ name }) => name.includes(query))
    .sort((a, b) => rank(a.name) - rank(b.name) || a.index - b.index)
    .map(({ command }) => command);
}

/** `fill`: the composer becomes `/name ` (its hint shown after it); `send`: `/name` goes as it is. */
export type SlashMenuKey = 'moveUp' | 'moveDown' | 'fill' | 'send' | 'close' | null;

/**
 * T-81 C: the keys as in Claude Code's own prompt, independent of the composer DOM; IME never
 * drives the menu. Tab completes the highlighted command. Enter on a command typed whole sends it
 * (a bare /model opens its picker), unless it cannot go without an argument; on a partly typed one
 * it inserts a command that takes arguments and sends one that takes none. null: the key does
 * what it does without the menu (Enter with nothing to pick sends, and the daemon says why).
 */
export function slashMenuKey(
  key: string,
  open: boolean,
  isComposing: boolean,
  text: string,
  command: SlashCommand | undefined,
): SlashMenuKey {
  if (!open || isComposing) return null;
  if (key === 'ArrowUp') return 'moveUp';
  if (key === 'ArrowDown') return 'moveDown';
  if (key === 'Escape') return 'close';
  if (!command || (key !== 'Enter' && key !== 'Tab')) return null;
  if (key === 'Tab' || command.argsRequired) return 'fill';
  if (text.slice(1).toLocaleLowerCase() === command.name.toLocaleLowerCase()) return null;
  return command.args ? 'fill' : 'send';
}

/** The argument hint shown greyed after `/name ` until the owner types (never sent). */
export function slashHint(text: string, commands: readonly SlashCommand[] | undefined): string | null {
  const typed = /^\/(\S+) $/.exec(text)?.[1].toLocaleLowerCase();
  if (!typed) return null;
  return commands?.find((c) => c.name.toLocaleLowerCase() === typed)?.args ?? null;
}
