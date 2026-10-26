/** Names are pure: the caller supplies the optional user table. First match wins. */
import * as fs from 'fs';
import * as path from 'path';

import { koText } from '../../../core/src/cld/serverText.js';
import { configDirectory } from './configPath.js';
// Bundled by esbuild for the daemon; TS's NodeNext config does not resolve JSON imports.
// @ts-expect-error JSON is bundled at build time.
import shipped from './jobRules.json';
export { particle } from '../../../core/src/cld/work.js';

export interface NameRule {
  pattern: string;
  name: string;
}
const builtin = shipped.names as NameRule[];

export function readNameRules(home: string): NameRule[] {
  try {
    const file = path.join(configDirectory(home), 'job-names.json');
    const data: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    const rows = Array.isArray(data) ? data : (data as { names?: unknown })?.names;
    return Array.isArray(rows)
      ? rows.filter(
          (r): r is NameRule =>
            typeof r?.pattern === 'string' && typeof r?.name === 'string' && r.name.length <= 80,
        )
      : [];
  } catch {
    return [];
  }
}

export function deriveJobName(cmd: string, rules: NameRule[] = []): string {
  for (const rule of [...rules, ...builtin]) {
    try {
      const hit = new RegExp(rule.pattern, 'i').exec(cmd);
      if (hit) return rule.name.replace(/\$(\d+)/g, (_s, n: string) => hit[Number(n)] ?? '');
    } catch {
      /* An invalid user rule does not hide shipped rules. */
    }
  }
  const tokens = cmd.trim().match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
  const program = path.basename((tokens[0] ?? koText('jobname_unknown_program')).replace(/^['"]|['"]$/g, ''));
  return koText('jobname_program', { program });
}

export function jobDescription(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 80 ||
    /[\r\n\p{Cc}]/u.test(value)
  )
    throw new Error('설명은 줄바꿈 없이 80자 이하여야 합니다');
  return value.trim();
}

/** The rules block every orchestrator puts at the top of a `cld-gui codex` spec: it says how to
 *  work, not what, so it is never a run's title (10-24 12:09: every card read "Rules for this task"). */
const RULES_HEADING = /^Rules for this task\b/i;

/** A run's title: the spec's first top-level heading that is not the rules block, else the file name. */
export function codexTitle(spec: string, contents: string): string {
  for (const m of contents.matchAll(/^\s*#\s+(.+?)\s*$/gm)) {
    const heading = m[1].trim();
    if (heading && !RULES_HEADING.test(heading)) return heading;
  }
  return path.basename(spec);
}

const shownTitles = new Map<string, string>();
/** A run's title as shown: one recorded as the rules heading (before 10-24) is read again from its spec, once. */
export function codexShownTitle(title: string | undefined, spec: string): string {
  if (title && !RULES_HEADING.test(title)) return title;
  let shown = shownTitles.get(spec);
  if (shown === undefined) {
    try {
      shown = codexTitle(spec, fs.readFileSync(spec, 'utf8'));
    } catch {
      shown = path.basename(spec);
    }
    shownTitles.set(spec, shown);
  }
  return shown;
}
