/**
 * Question tags: an agent ends a question to the owner with `⟨q:name⟩` and, asking it again, writes a
 * one-line summary and the same tag. The messenger draws the tag as a chip that jumps to the message it
 * first appeared in. Pure.
 */

/** A tag: lower-case English letters, digits and "-", 2 to 24 characters. */
export const QUESTION_TAG = /⟨q:([a-z0-9-]{2,24})⟩/g;

/** The text cut at its tags: plain strings between, and `{ tag }` for each tag's name. */
export function splitQuestionTags(text: string): Array<string | { tag: string }> {
  const parts: Array<string | { tag: string }> = [];
  let at = 0;
  for (const m of text.matchAll(QUESTION_TAG)) {
    if (m.index > at) parts.push(text.slice(at, m.index));
    parts.push({ tag: m[1] });
    at = m.index + m[0].length;
  }
  if (at < text.length) parts.push(text.slice(at));
  return parts;
}

/** The text without its tags (previews and notice lines). */
export function stripQuestionTags(text: string): string {
  return text.replace(QUESTION_TAG, '');
}

/** The text a search for this tag looks for. */
export const tagText = (name: string): string => `⟨q:${name}⟩`;
