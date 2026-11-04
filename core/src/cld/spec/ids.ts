/**
 * SPT §2.1: the display-ID grammar, one for the daemon's document reading (tracking/docs.ts) and
 * the spec tracking. A display ID is what a document writes (`FR-OFC-001`, `R-01`, `D-001`,
 * `T-0050`, Spec Kit's `T001`); it is evidence, never a key. Short ones (`D5`, `C3a`) count only
 * when the project turns them on; a project may add its own patterns (checked, capped).
 */

/** `FR-OFC-001`, `NFR-PERF-008`, `T-0050`, `U-48`, `R-01`: a capital, then dashed parts, then a number. */
export const ID_DEFAULT = '[A-Z][A-Z0-9]{0,7}(?:-[A-Z0-9]{1,8})*-\\d{1,5}';
/** Spec Kit's task ids (`T001`). */
const ID_SPEC_KIT = 'T\\d{3}';
/** `D5`, `C3a`: only when the project turns short ids on. */
export const ID_SHORT = '[A-Z]\\d{1,2}[a-z]?';
export const ID_PATTERNS_MAX = 5;
export const ID_PATTERN_LENGTH_MAX = 60;

/** A project pattern's quantifiers: `?`, `{m}` or `{m,n}` with n at most ID_QUANT_MAX, and the
 *  product of their choices at most ID_PATTERN_CHOICES_MAX (what one start can try, bounded). */
export const ID_QUANT_MAX = 10;
export const ID_PATTERN_CHOICES_MAX = 64;
/** Each line a reader runs the patterns on, at most this many characters (agent-written text, commit messages). */
export const ID_LINE_MAX = 4096;

/** One atom of the safe subset: a letter, digit, `_` or `-`; `\d`, `\.`, `\-`, `\_`; a class of those and ranges (no negation). */
const ATOM = /^(?:[A-Za-z0-9_-]|\\[d.\-_]|\[(?:[A-Za-z0-9]-[A-Za-z0-9]|[A-Za-z0-9_-]|\\[d\-_.])+\])/;
const QUANT = /^(?:\?|\{(\d{1,2})(?:,(\d{1,2}))?\})/;

/** The safe subset: atoms, each with at most one bounded quantifier; no group, alternation, `*`, `+`, backreference or lookaround. */
function safeShape(p: string): boolean {
  let rest = p;
  let choices = 1;
  while (rest) {
    const a = ATOM.exec(rest);
    if (!a) return false;
    rest = rest.slice(a[0].length);
    const q = QUANT.exec(rest);
    if (!q) continue;
    const m = q[0] === '?' ? 0 : Number(q[1]);
    const n = q[0] === '?' ? 1 : q[2] === undefined ? m : Number(q[2]);
    if (n < m || n > ID_QUANT_MAX) return false;
    choices *= n - m + 1;
    rest = rest.slice(q[0].length);
  }
  return choices <= ID_PATTERN_CHOICES_MAX;
}

/** null = a pattern a project may add: short, compiles, never matches an empty text, and within the
 *  safe subset (`unsafe`: groups, alternation, `*`, `+`, big or nested repeats could backtrack for
 *  seconds on an agent's text; write two patterns instead of `(?:A|B)`). */
export function idPatternError(p: unknown): 'type' | 'length' | 'syntax' | 'empty' | 'unsafe' | null {
  if (typeof p !== 'string') return 'type';
  if (!p || p.length > ID_PATTERN_LENGTH_MAX) return 'length';
  if (/\\\d|\(\?[=!<]|\((?!\?:)|\\k</.test(p)) return 'syntax';
  try {
    if (new RegExp(`^(?:${p})$`).test('')) return 'empty';
  } catch {
    return 'syntax';
  }
  return safeShape(p) ? null : 'unsafe';
}

/** The alternation every reader matches: the default and Spec Kit's, short ids when on, then the project's valid extras. */
export function idSource(shortIds: boolean, extra: readonly string[] = []): string {
  const valid = extra.filter((p) => idPatternError(p) === null).slice(0, ID_PATTERNS_MAX);
  return [ID_DEFAULT, ID_SPEC_KIT, ...(shortIds ? [ID_SHORT] : []), ...valid].join('|');
}

/** Every display ID in a text (not inside a longer word). */
export const idPattern = (shortIds: boolean, extra: readonly string[] = []): RegExp =>
  new RegExp(`(?<![A-Za-z0-9_-])(?:${idSource(shortIds, extra)})(?![A-Za-z0-9_])`, 'g');

/** The display ID a text starts with (a definition). */
export const idAtStartPattern = (shortIds: boolean, extra: readonly string[] = []): RegExp =>
  new RegExp(`^(?:${idSource(shortIds, extra)})(?![A-Za-z0-9_])`);
