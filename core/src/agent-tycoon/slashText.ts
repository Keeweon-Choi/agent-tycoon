import { type Refused, refused } from './serverText.js';

/** Slash input that may safely be typed directly into Claude Code. */
export const SLASH_TEXT_MAX = 500;
// One name, then at most one space and plain text: no control character, tab or line separator.
const COMMAND = /^\/[A-Za-z][A-Za-z0-9:_-]*(?: [^\x00-\x1f\x7f-\x9f\u2028\u2029]*)?$/;

/** A refusal for slash input, or null when it is one safe command line. */
export function slashTextProblem(text: string): Refused | null {
  if (/[\r\n]/.test(text)) return refused('slash_multiline');
  if (text.length > SLASH_TEXT_MAX) return refused('slash_too_long', { max: SLASH_TEXT_MAX });
  if (!COMMAND.test(text)) return refused('slash_spacing');
  return null;
}
