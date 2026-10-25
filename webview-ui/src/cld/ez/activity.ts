import type { EzRules } from '../../../../core/src/messages.js';
import { t, type TranslationKey } from '../../i18n/index.js';
import {
  COMMAND_RULES,
  type CommandRule,
  type Phrase,
  PHRASES,
  SHELL_TOOLS,
  TOOL_RULES,
  type ToolRule,
} from './rules.js';

export interface JobProgress {
  pct?: number | null;
  label?: string | null;
}

export interface ActivityInput {
  toolName?: string | null;
  status?: string | null;
  command?: string | null;
  subagent?: boolean;
  waitingInput?: boolean;
  permission?: boolean;
  idle?: boolean;
  /** The provider says a turn is in progress (office/engine `busy`); only matters with no tool running. */
  busy?: boolean;
  jobProgress?: JobProgress | null;
  /** The one-line description its owner gave (an agent's tool description, a job's `-d`): it replaces the phrase's words, never the emoji. */
  desc?: string | null;
}

export interface ActivityDescription {
  emoji: string;
  /** A short Korean summary. Callers render this beside `emoji`. */
  text: string;
  /** Safe, optional tooltip hint (a file basename); never a command line or path. */
  detail?: string;
}

/** What the phrase table is read against. */
export interface EzContext {
  /** The user's rules (ez-rules.json), tried before the built-in ones. */
  user?: Pick<EzRules, 'tools' | 'commands'>;
}

/** Built-in generic rules only: no user file. */
export const PLAIN_CONTEXT: EzContext = {};

const builtInText = (text: string): string =>
  text.startsWith('activity.') ? t(text as TranslationKey) : text;
const activity = (emoji: string, text: string, detail?: string): ActivityDescription =>
  detail ? { emoji, text: builtInText(text), detail } : { emoji, text: builtInText(text) };
const phrase = ({ emoji, text }: Phrase): ActivityDescription => ({ emoji, text: builtInText(text) });

/** The owner's own words for what it is doing win over the table's. */
const worded = (d: ActivityDescription, desc: string | null | undefined): ActivityDescription =>
  desc?.trim() ? { ...d, text: desc.trim() } : d;

const normalized = (value: string | null | undefined) =>
  (value ?? '').replace(/[^a-z0-9]/gi, '').toLowerCase();

/** Tool behind a status line, for rows that carry no tool name (sub-agent rows,
 *  older servers). Covers the Claude provider's formatToolStatus wording. */
const STATUS_TOOLS: Array<[RegExp, string]> = [
  [/^Using\s+(\S+)/i, '$1'],
  [/^Running:/i, 'bash'],
  [/^(Subtask:|Running subtask|Task\b)/i, 'task'],
  [/^Reading\b/i, 'read'],
  [/^Editing\b/i, 'edit'],
  [/^Writing\b/i, 'write'],
  [/^(Searching the web|Searching web)\b/i, 'websearch'],
  [/^(Searching|Globbing)\b/i, 'grep'],
  [/^Fetching\b/i, 'webfetch'],
  [/^Waiting for your answer/i, 'askuserquestion'],
  [/^(->|Sending message)/i, 'sendmessage'],
];

function toolFromStatus(status: string | null | undefined): string {
  const line = status?.trim() ?? '';
  for (const [pattern, tool] of STATUS_TOOLS) {
    const match = line.match(pattern);
    if (match) return normalized(tool === '$1' ? match[1] : tool);
  }
  return '';
}

/** Keep only a harmless final filename for detail-mode tooltips. */
function safeBasename(status: string | null | undefined): string | undefined {
  const rest = status?.replace(/^\s*\w+:?\s+/, '') ?? '';
  const leaf = rest
    .split(/[\\/]/)
    .at(-1)
    ?.replace(/[?#].*$/, '')
    .trim();
  return leaf && /^[\w.@+-]{1,80}$/.test(leaf) && !/^\.+$/.test(leaf) ? leaf : undefined;
}

/** Wrappers that run the real command, with their options that take a value.
 *  A Map, not an object literal: `constructor` must not look like a wrapper. */
const WRAPPER_VALUE_FLAGS = new Map<string, string[]>([
  ['sudo', ['-u', '-g', '-h', '-p', '-r', '-t', '-C', '-D']],
  ['nice', ['-n']],
  ['taskset', []],
  ['timeout', ['-s', '-k']],
  ['env', ['-u', '-C', '-S']],
  ['npx', ['-p', '--package']],
]);
/** Commands that only set the stage; the first command after them wins. */
const SETUP_COMMANDS = new Set(['cd', 'pushd', 'export', 'source', '.']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * The command that matters to a person, rather than a shell wrapper. Only a
 * conservative shell subset: the result never reaches the screen, it merely
 * feeds the phrase table.
 */
function firstMeaningfulCommand(command: string): string[] {
  for (const segment of command.split(/&&|\|\||[;|\n]/)) {
    const tokens =
      segment
        .trim()
        .replace(/^[({]\s*/, '')
        .match(/(?:[^\s'"`]+|'[^']*'|"[^"]*")+/g)
        ?.map((token) => token.replace(/^['"]|['"]$/g, '')) ?? [];
    let index = 0;
    for (;;) {
      const token = tokens[index] ?? '';
      if (ASSIGNMENT.test(token)) {
        index += 1;
        continue;
      }
      const valueFlags = WRAPPER_VALUE_FLAGS.get(token);
      if (!valueFlags) break;
      index += 1;
      while ((tokens[index] ?? '').startsWith('-')) {
        index += valueFlags.includes(tokens[index]) ? 2 : 1;
      }
      // taskset's CPU list and timeout's duration come before the command.
      if (token === 'taskset' || token === 'timeout') index += 1;
    }
    if (SETUP_COMMANDS.has(tokens[index] ?? '')) continue;
    if (tokens[index]) return tokens.slice(index);
  }
  return [];
}

/** Options that take a value and may precede the subcommand: `git -C dir -c k=v commit`. */
const SUBCOMMAND_VALUE_OPTIONS = new Map<string, string[]>([['git', ['-c']]]);
/** Words that only launch a script, so `npm run build` reads as `npm build`. */
const LAUNCH_WORDS = new Map<string, string[]>(
  ['npm', 'pnpm', 'yarn'].map((program) => [program, ['run', 'run-script']]),
);

/** The first argument that is not an option (empty when there is none). */
function subcommand(program: string, args: string[]): string {
  const valueOptions = SUBCOMMAND_VALUE_OPTIONS.get(program) ?? [];
  const launchWords = LAUNCH_WORDS.get(program) ?? [];
  let launched = false;
  for (let i = 0; i < args.length; i += 1) {
    if (valueOptions.includes(args[i])) i += 1;
    else if (args[i].startsWith('-')) continue;
    else if (!launched && launchWords.includes(args[i])) launched = true;
    else return args[i];
  }
  return '';
}

interface ParsedCommand {
  program: string;
  args: string[];
  sub: string;
}

/** `/usr/bin/python3.11` is `python`, `pip3` is `pip`. */
const programName = (token: string | undefined) =>
  (token ?? '')
    .split(/[\\/]/)
    .at(-1)!
    .toLowerCase()
    .replace(/^(python|pip)\d+(\.\d+)*$/, '$1');

function parseCommand(command: string): ParsedCommand {
  const tokens = firstMeaningfulCommand(command);
  const program = programName(tokens[0]);
  const args = tokens.slice(1).map((arg) => arg.toLowerCase());
  return { program, args, sub: subcommand(program, args) };
}

const listed = (list: readonly string[], word: string) =>
  list.some((w) => w.toLowerCase() === word);

function matches(rule: CommandRule, { program, args, sub }: ParsedCommand): boolean {
  return (
    rule.program.some((name) => programName(name) === program) &&
    (!rule.sub || listed(rule.sub, sub)) &&
    (!rule.subContains || rule.subContains.some((w) => sub.includes(w.toLowerCase()))) &&
    (!rule.has || rule.has.every((w) => args.includes(w.toLowerCase()))) &&
    (!rule.contains || rule.contains.some((w) => args.some((arg) => arg.includes(w.toLowerCase()))))
  );
}

/** The phrase for a shell command: the first rule that matches, the user's before the built-in ones. */
function describeCommand(
  command: string,
  ctx: EzContext,
): { description: ActivityDescription; training: boolean } {
  const parsed = parseCommand(command);
  const tables: ReadonlyArray<readonly CommandRule[]> = [ctx.user?.commands ?? [], COMMAND_RULES];
  for (const table of tables) {
    for (const rule of table) {
      if (matches(rule, parsed)) {
        return { description: activity(rule.emoji, rule.text), training: rule.training === true };
      }
    }
  }
  return { description: phrase(PHRASES.plainCommand), training: false };
}

/** The rule for a tool (already normalized), the user's before the built-in ones. */
function toolRule(tool: string, ctx: EzContext): ToolRule | undefined {
  if (!tool) return undefined;
  const named = (rule: ToolRule) => rule.tool.some((name) => normalized(name) === tool);
  return ctx.user?.tools.find(named) ?? TOOL_RULES.find(named);
}

/**
 * Rule-based, privacy-safe activity copy for the EZ display mode. The phrases
 * are data (rules.ts, the user's ez-rules.json); this only
 * picks one, and never returns a command line.
 *
 * ponytail: Bash is classified from the status line, which the server cuts at
 * 30 characters (BASH_COMMAND_DISPLAY_MAX_LENGTH), so a long `cd <dir> && …`
 * prefix falls back to 💻 명령 실행 중. Send the full command or a server-side
 * category in the protocol if that matters.
 */
export function describeActivity(
  input: ActivityInput,
  ctx: EzContext = PLAIN_CONTEXT,
): ActivityDescription {
  if (input.permission) return phrase(PHRASES.permission);
  if (input.waitingInput) {
    const rule = toolRule('askuserquestion', ctx);
    return rule ? activity(rule.emoji, rule.text) : phrase(PHRASES.unknownTool);
  }
  if (input.idle || /^\s*(idle|turn ended|finished)\s*$/i.test(input.status ?? '')) {
    // Precedence: tool > permission/waiting > busy (thinking) > idle.
    return phrase(input.busy ? PHRASES.thinking : PHRASES.idle);
  }

  const progress = input.jobProgress;
  if (typeof progress?.pct === 'number' && Number.isFinite(progress.pct)) {
    const pct = Math.max(0, Math.min(100, Math.round(progress.pct)));
    const training =
      /train|\ud559\uc2b5/i.test(progress.label ?? '') ||
      (!!input.command && describeCommand(input.command, ctx).training);
    const { emoji, text } = training ? PHRASES.trainingProgress : PHRASES.jobProgress;
    return activity(emoji, `${builtInText(text)} ${pct}%`);
  }

  const tool = input.subagent
    ? 'agent'
    : normalized(input.toolName) || toolFromStatus(input.status);
  const rule = toolRule(tool, ctx);
  if (rule) {
    return worded(
      activity(rule.emoji, rule.text, rule.file ? safeBasename(input.status) : undefined),
      input.desc,
    );
  }
  if (SHELL_TOOLS.includes(tool)) {
    const command = input.command ?? input.status?.match(/^\s*Running:\s*([\s\S]*)$/i)?.[1];
    return worded(describeCommand(command ?? '', ctx).description, input.desc);
  }
  return worded(phrase(PHRASES.unknownTool), input.desc);
}
