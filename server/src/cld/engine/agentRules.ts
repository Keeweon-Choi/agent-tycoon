/**
 * RULES-DEFAULT: the rules every session the engine starts with flags begins with.
 *
 * Layers, in this order, joined into ONE file the engine writes per agent
 * (config dir, atomic, 0600) and hands to `claude --append-system-prompt-file`:
 *   1. the product's built-in rules, when the host keeps them enabled (next to cld/bin; they
 *      update with the engine): the shared default.<ko|en>.md, then (C7a, OSD-J) the role's
 *      playbook <lead|worker|reviewer>.<ko|en>.md,
 *   2. the user's global rules, ~/.config/agent-tycoon/rules.md (written only by the settings page),
 *   3. the agent's own `rulesFile`, if set.
 * A missing or unreadable layer is skipped; the engine never writes layers 2 and 3.
 */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { SocketStepUp, WsSend } from '../hooks.js';
import { STEPUP_REQUIRED } from '../shell/gate.js';
import { configDir } from './events.js';
import { writeAtomic } from './messenger.js';
import type { WorkerRole } from './registry.js';

export type RulesLang = 'ko' | 'en';
/** C7a: whose playbook a session gets. */
export type RulesRole = 'lead' | WorkerRole;

/** The user's global rules: the one file the settings page writes. */
export const userRulesPath = (home: string): string => path.join(configDir(home), 'rules.md');
/** The owner's UI language, remembered when the settings page last told us (the server has no other way to know). */
const languagePath = (home: string): string => path.join(configDir(home), 'ui-language');
const builtInRulesPath = (home: string): string => path.join(configDir(home), 'use-built-in-rules');
const combinedDir = (home: string): string => path.join(configDir(home), 'rules-combined');
export const USER_RULES_MAX_CHARS = 32_000;

/** cld/rules next to cld/bin (a checkout and an installed bundle share this layout). */
export const rulesDirFor = (binDir: string | null): string | null =>
  binDir ? path.join(binDir, '..', 'rules') : null;

const read = (file: string): string => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};

const asLang = (v: unknown): RulesLang | null => (v === 'ko' || v === 'en' ? v : null);

/** The owner's UI language if known, else Korean when the host locale is Korean, else English. */
export function rulesLanguage(home: string, env: NodeJS.ProcessEnv = process.env): RulesLang {
  const known = asLang(read(languagePath(home)).trim());
  if (known) return known;
  const locale = env.LC_ALL || env.LC_MESSAGES || env.LANG || Intl.DateTimeFormat().resolvedOptions().locale;
  return /^ko/i.test(locale ?? '') ? 'ko' : 'en';
}

function rememberLanguage(home: string, lang: RulesLang): void {
  if (read(languagePath(home)).trim() !== lang) writeAtomic(languagePath(home), `${lang}\n`);
}

/** The host uses the product's built-in rules unless its owner explicitly turned them off. */
export function useBuiltInRules(home: string): boolean {
  return read(builtInRulesPath(home)).trim() !== 'off';
}

function rememberUseBuiltInRules(home: string, enabled: boolean): void {
  if (useBuiltInRules(home) !== enabled) writeAtomic(builtInRulesPath(home), `${enabled ? 'on' : 'off'}\n`);
}

/** A shipped `<base>.<lang>.md`; the other language when that file is missing, else ''. */
function shipped(rulesDir: string | null, base: string, lang: RulesLang): string {
  if (!rulesDir) return '';
  const other = lang === 'ko' ? 'en' : 'ko';
  return (
    read(path.join(rulesDir, `${base}.${lang}.md`)).trim() ||
    read(path.join(rulesDir, `${base}.${other}.md`)).trim()
  );
}

/** The shipped default rules (the part every role shares) in `lang`. */
export const defaultRules = (rulesDir: string | null, lang: RulesLang): string =>
  shipped(rulesDir, 'default', lang);

/** C7a: everything shipped a `role` session gets: the shared defaults, then the role's playbook. */
export const builtinRules = (rulesDir: string | null, lang: RulesLang, role: RulesRole): string =>
  [defaultRules(rulesDir, lang), shipped(rulesDir, role, lang)].filter(Boolean).join('\n\n');

export const readUserRules = (home: string): string => read(userRulesPath(home));

/** Built-in (shared + role) + user + project, blank-line separated; '' when all are empty.
 *  The shipped layer is left out when the host switch is off or `builtin: false`. */
export function composeRules(o: {
  home: string;
  rulesDir: string | null;
  role?: RulesRole;
  builtin?: boolean;
  projectRulesFile?: string | null;
  env?: NodeJS.ProcessEnv;
}): string {
  return [
    o.builtin === false || !useBuiltInRules(o.home)
      ? ''
      : builtinRules(o.rulesDir, rulesLanguage(o.home, o.env), o.role ?? 'lead'),
    readUserRules(o.home).trim(),
    o.projectRulesFile ? read(o.projectRulesFile).trim() : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** The composition and the playbook it carries (`<role>-<hash of the built-in text>`, null when
 *  none: the start event records it). */
export function composeWithPlaybook(o: Parameters<typeof composeRules>[0]): { text: string; playbook: string | null } {
  const role = o.role ?? 'lead';
  const builtin =
    o.builtin === false || !useBuiltInRules(o.home) ? '' : builtinRules(o.rulesDir, rulesLanguage(o.home, o.env), role);
  const playbook = builtin ? `${role}-${createHash('sha1').update(builtin).digest('hex').slice(0, 8)}` : null;
  return { text: composeRules(o), playbook };
}

/**
 * The file agent `name` starts with: the composition, written fresh at each start, and the
 * playbook it carries. null when there is nothing to pass (or it cannot be written): the
 * caller then uses the agent's own `rulesFile`, as before this feature.
 */
export function writeCombinedRules(
  o: Parameters<typeof composeRules>[0] & { name: string; log: (line: string) => void },
): { file: string; playbook: string | null } | null {
  const { text, playbook } = composeWithPlaybook(o);
  if (!text) return null;
  const hash = createHash('sha1').update(o.name).digest('hex').slice(0, 6);
  const file = path.join(combinedDir(o.home), `${o.name.replace(/[^\w.-]/g, '_').slice(0, 40)}-${hash}.md`);
  try {
    if (read(file) !== `${text}\n`) writeAtomic(file, `${text}\n`);
    return { file, playbook };
  } catch (err) {
    o.log(`${file}: ${err instanceof Error ? err.message : String(err)}; the session starts with the project's own rules`);
    return null;
  }
}

/**
 * The settings page's `agentRulesRequest`: no changed setting = show, `text` = save the user's
 * global rules, `useBuiltInRules` = enable or disable the product's tool-use rules. Anyone may
 * read the defaults and enabled state; changing either setting needs a privileged connection and
 * a remote one needs a fresh step-up (it changes what every agent does).
 * Answers the sender with `agentRules` (+ `error`, never a throw).
 */
export function handleAgentRules(
  msg: Record<string, unknown>,
  send: WsSend,
  ctx: {
    home: string;
    rulesDir: string | null;
    privileged: boolean;
    readOnly: boolean;
    stepUp?: SocketStepUp;
    log?: (line: string) => void;
  },
): void {
  const lang = asLang(msg.language);
  const requestedBuiltInRules = typeof msg.useBuiltInRules === 'boolean' ? msg.useBuiltInRules : null;
  const saving = typeof msg.text === 'string' || requestedBuiltInRules !== null;
  let error: string | undefined;
  if (saving && (!ctx.privileged || ctx.readOnly)) error = 'read_only';
  else if (saving && ctx.stepUp?.remote && !ctx.stepUp.fresh()) error = STEPUP_REQUIRED;
  else if (typeof msg.text === 'string' && msg.text.length > USER_RULES_MAX_CHARS) error = 'too_long';
  try {
    if (ctx.privileged && lang) rememberLanguage(ctx.home, lang);
    if (saving && !error) {
      if (requestedBuiltInRules !== null) rememberUseBuiltInRules(ctx.home, requestedBuiltInRules);
      if (typeof msg.text === 'string') {
        const text = msg.text.replace(/\r\n/g, '\n').trim();
        if (text) writeAtomic(userRulesPath(ctx.home), `${text}\n`);
        else fs.rmSync(userRulesPath(ctx.home), { force: true });
      }
    }
  } catch (err) {
    ctx.log?.(`agent rules: ${err instanceof Error ? err.message : String(err)}`);
    error = 'write_failed';
  }
  const shown = lang ?? rulesLanguage(ctx.home);
  send({
    type: 'agentRules',
    language: shown,
    defaults: defaultRules(ctx.rulesDir, shown),
    useBuiltInRules: useBuiltInRules(ctx.home),
    text: ctx.privileged ? readUserRules(ctx.home).trim() : '',
    ...(error ? { error } : {}),
  });
}
