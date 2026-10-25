/** A compact, path-safe label for a process command line shown outside the host. */
const MAX_COMMAND_DISPLAY = 120;

const unixPath =
  /\/(?:home|Users)\/[^/\s]+(?:\/[^\s]*)?|\/[A-Za-z0-9_.~+@%=-]+(?:\/[A-Za-z0-9_.~+@%=-]+)+/g;
const windowsPath = /[A-Za-z]:\\(?:[^\s\\]+\\)*[^\s\\]*/g;

function shortPath(value: string): string {
  const punctuation = value.match(/[),;:'"`\]]*$/)?.[0] ?? '';
  const path = value.slice(0, value.length - punctuation.length);
  if (/^\/(?:home|Users)\/[^/]+\/?$/.test(path)) return `~${punctuation}`;
  const name = path.split(/[\\/]/).filter(Boolean).pop();
  return `${name ?? '~'}${punctuation}`;
}

function shortPaths(token: string): string {
  return token.replace(unixPath, shortPath).replace(windowsPath, shortPath);
}

/**
 * Retains a process name and useful flags while never exposing a full filesystem path.
 * This is deliberately shell-agnostic: /proc already separates command arguments with
 * NUL bytes, which the collector changes to spaces before calling this function.
 */
export function shortProcessCommand(command: string, maxLength = MAX_COMMAND_DISPLAY): string {
  const display = command.trim().split(/\s+/).filter(Boolean).map(shortPaths).join(' ');
  if (display.length <= maxLength) return display;
  return `${display.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}
