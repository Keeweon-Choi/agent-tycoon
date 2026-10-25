/**
 * The user's own EZ phrase rules (FR-OFC-018, ADR-0014): the optional file
 * ~/.config/cld-gui/ez-rules.json. The built-in table is the screen's
 * (webview-ui/src/cld/ez/rules.ts); this file only adds to it and overrides it,
 * so with no file everything works as it does.
 *
 *   {
 *     "tools":    [{ "tool": "WebFetch", "emoji": "🌐", "text": "자료 찾는 중" }],
 *     "commands": [{ "program": "make", "sub": ["deploy"], "emoji": "🚀", "text": "배포하는 중" }],
 *     "fatigue":  { "tired": 60, "rest": 90 }
 *   }
 *
 * A tool rule names agent tools (case and punctuation are ignored). A command
 * rule names the program (in a rule and in a command alike, case and path are
 * ignored and `python3.11` reads as `python`) and may narrow it:
 * `sub` (the first argument that is not an option is one of these), `subContains`
 * (it contains one of these), `has` (all of these are among the arguments),
 * `contains` (one of these is inside an argument). A list may be a single
 * string. `text` is at most 16 characters. A rule matches first-come in file
 * order, before the built-in ones.
 *
 * `fatigue` (T-0026) replaces any of the screen's fatigue numbers (EzFatigue in
 * the protocol): whole numbers, in percent points.
 *
 * Every entry is checked here, and a bad one is dropped with one log line while
 * the rest stay: a broken file never takes the daemon or the office down. The
 * phrases are fixed text -- no rule can template in a command line (SEC T3).
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { EzCommandRule, EzFatigue, EzRules, EzToolRule } from '../../../core/src/messages.js';

export const EZ_TEXT_MAX = 16;
const FILE_MAX_BYTES = 64 * 1024;
const RULES_MAX = 200;
const LIST_MAX = 16;
const WORD_MAX = 64;
/** UTF-16 units: a family emoji (ZWJ sequence) is 11. */
const EMOJI_MAX = 12;
const CONTROL = /[\p{Cc}\u2028\u2029]/u;

export interface EzRuleSet {
  tools: EzToolRule[];
  commands: EzCommandRule[];
  fatigue?: EzFatigue;
}

/** Each fatigue number's allowed range. */
const FATIGUE_RANGES: Record<keyof EzFatigue, [number, number]> = {
  compactionDrop: [1, 100],
  tired: [0, 100],
  yawn: [0, 100],
  rest: [0, 100],
};

export const ezRulesPath = (home = os.homedir()): string =>
  path.join(home, '.config', 'cld-gui', 'ez-rules.json');

type Note = (line: string) => void;
type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);

class Bad extends Error {}

/** A string without control characters, 1..max long once trimmed. */
function line(x: unknown, what: string, max: number): string {
  if (typeof x !== 'string') throw new Bad(`${what} must be a string`);
  const s = x.trim();
  if (!s) throw new Bad(`${what} is empty`);
  if (CONTROL.test(s)) throw new Bad(`${what} has a control character`);
  if (s.length > max) throw new Bad(`${what} is longer than ${max} characters`);
  return s;
}

/** One string or a list of them -> a non-empty list of clean words. */
function words(x: unknown, what: string): string[] {
  const list = Array.isArray(x) ? x : [x];
  if (!list.length) throw new Bad(`${what} is empty`);
  if (list.length > LIST_MAX) throw new Bad(`${what} has more than ${LIST_MAX} entries`);
  return list.map((w) => line(w, what, WORD_MAX));
}

function phrase(o: Obj): { emoji: string; text: string } {
  return {
    emoji: line(o.emoji, 'emoji', EMOJI_MAX),
    text: line(o.text, 'text', EZ_TEXT_MAX),
  };
}

function entry<T>(
  o: unknown,
  allowed: readonly string[],
  required: string,
  build: (o: Obj) => T,
): T {
  if (!isObj(o)) throw new Bad('not an object');
  const unknown = Object.keys(o).find((k) => !allowed.includes(k));
  if (unknown !== undefined) throw new Bad(`unknown field "${unknown}"`);
  if (o[required] === undefined) throw new Bad(`"${required}" is missing`);
  return build(o);
}

const toolRule = (o: unknown): EzToolRule =>
  entry(o, ['tool', 'emoji', 'text'], 'tool', (e) => ({
    tool: words(e.tool, 'tool'),
    ...phrase(e),
  }));

const COMMAND_LISTS = ['sub', 'subContains', 'has', 'contains'] as const;
const commandRule = (o: unknown): EzCommandRule =>
  entry(o, ['program', ...COMMAND_LISTS, 'emoji', 'text'], 'program', (e) => {
    const rule: EzCommandRule = { program: words(e.program, 'program'), ...phrase(e) };
    for (const key of COMMAND_LISTS) if (e[key] !== undefined) rule[key] = words(e[key], key);
    return rule;
  });

/** The valid fatigue numbers; a bad one is logged and left at the screen's default. */
function fatigue(x: unknown, note: Note): EzFatigue | undefined {
  if (x === undefined) return undefined;
  if (!isObj(x)) {
    note('[cld] ez-rules.json: "fatigue" must be an object; ignored');
    return undefined;
  }
  const out: EzFatigue = {};
  for (const [key, value] of Object.entries(x)) {
    const range = Object.hasOwn(FATIGUE_RANGES, key)
      ? FATIGUE_RANGES[key as keyof EzFatigue]
      : undefined;
    if (!range) note(`[cld] ez-rules.json: fatigue.${key}: unknown field; ignored`);
    else if (
      !Number.isInteger(value) ||
      (value as number) < range[0] ||
      (value as number) > range[1]
    )
      note(
        `[cld] ez-rules.json: fatigue.${key}: not a whole number ${range[0]}..${range[1]}; ignored`,
      );
    else out[key as keyof EzFatigue] = value as number;
  }
  return Object.keys(out).length ? out : undefined;
}

function section<T>(list: unknown, name: string, parse: (o: unknown) => T, note: Note): T[] {
  if (list === undefined) return [];
  if (!Array.isArray(list)) {
    note(`[cld] ez-rules.json: "${name}" must be a list; ignored`);
    return [];
  }
  const out: T[] = [];
  list.forEach((item, i) => {
    if (i >= RULES_MAX) {
      if (i === RULES_MAX)
        note(`[cld] ez-rules.json: "${name}" keeps its first ${RULES_MAX} rules`);
      return;
    }
    try {
      out.push(parse(item));
    } catch (err) {
      if (!(err instanceof Bad)) throw err;
      note(`[cld] ez-rules.json: ${name}[${i}]: ${err.message}; rule ignored`);
    }
  });
  return out;
}

/** The valid rules of a file's text; null when the file as a whole is unusable. */
export function parseEzRules(text: string, note: Note): EzRuleSet | null {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    note('[cld] ez-rules.json: not valid JSON; file ignored');
    return null;
  }
  if (!isObj(json)) {
    note(
      '[cld] ez-rules.json: expected an object with "tools", "commands" and/or "fatigue"; file ignored',
    );
    return null;
  }
  if (json.v !== undefined && json.v !== 1) {
    note(`[cld] ez-rules.json: unsupported v=${String(json.v)}; file ignored`);
    return null;
  }
  for (const key of Object.keys(json)) {
    if (!['v', 'tools', 'commands', 'fatigue'].includes(key)) {
      note(`[cld] ez-rules.json: unknown field "${key}" ignored`);
    }
  }
  const numbers = fatigue(json.fatigue, note);
  return {
    tools: section(json.tools, 'tools', toolRule, note),
    commands: section(json.commands, 'commands', commandRule, note),
    ...(numbers && { fatigue: numbers }),
  };
}

/**
 * The user's rules as the message a connecting client gets. The file is read
 * again only when it changed (mtime and size), so a client that connects after
 * an edit sees it and a bad file is logged once per edit, not once per client.
 */
export class EzRulesFile {
  private seen: string | null = null;
  private rules: EzRuleSet | null = null;

  constructor(
    readonly file: string,
    private readonly note: Note = (l) => console.warn(l),
  ) {}

  /** null when there is no file, or nothing valid in it. */
  message(): EzRules | null {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.file);
    } catch (err) {
      this.seen = null;
      this.rules = null;
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.note(`[cld] ez-rules.json: cannot read it (${(err as NodeJS.ErrnoException).code})`);
      }
      return null;
    }
    const version = `${stat.mtimeMs}:${stat.size}`;
    if (version !== this.seen) {
      this.seen = version;
      this.rules = this.read(stat);
    }
    const r = this.rules;
    return r && (r.tools.length || r.commands.length || r.fatigue)
      ? {
          type: 'ezRules',
          tools: r.tools,
          commands: r.commands,
          ...(r.fatigue && { fatigue: r.fatigue }),
        }
      : null;
  }

  private read(stat: fs.Stats): EzRuleSet | null {
    if (!stat.isFile()) {
      this.note('[cld] ez-rules.json: not a regular file; ignored');
      return null;
    }
    if (stat.size > FILE_MAX_BYTES) {
      this.note(`[cld] ez-rules.json: larger than ${FILE_MAX_BYTES / 1024} KiB; file ignored`);
      return null;
    }
    try {
      return parseEzRules(fs.readFileSync(this.file, 'utf-8'), this.note);
    } catch (err) {
      this.note(`[cld] ez-rules.json: cannot read it (${(err as NodeJS.ErrnoException).code})`);
      return null;
    }
  }
}
