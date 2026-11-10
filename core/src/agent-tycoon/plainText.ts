/**
 * Markdown to readable one-line text, for the places that show a message's start where nothing
 * renders markdown (a push body, a notice, a contact's last line). Pure.
 */

import { stripQuestionTags } from './questionTag.js';

/** What a list item starts with once its "-", "*", "+" or "1." is dropped. */
export const LIST_MARK = '· ';

/** One line of markdown without its block marks (heading, quote, list, rule, code fence). */
function line(raw: string): string {
  if (/^\s*(```|~~~)/.test(raw) || /^\s*([-*_])(\s*\1){2,}\s*$/.test(raw)) return '';
  return raw
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/^\s*(>\s?)+/, '')
    .replace(/^\s*([-*+]|\d+[.)])\s+/, LIST_MARK);
}

/** Inline marks: images and links to their text, code, bold, italic and strike-through to what they hold. */
function inline(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<((?:https?|mailto):[^>\s]+)>/g, '$1')
    .replace(/`+([^`]+)`+/g, '$1')
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '$2')
    .replace(/~~(?=\S)(.+?)(?<=\S)~~/g, '$1')
    .replace(/\*(?=\S)([^*]+?)(?<=\S)\*/g, '$1')
    .replace(/(?<!\w)_(?=\S)([^_]+?)(?<=\S)_(?!\w)/g, '$1');
}

/** "**굵게** `코드` [링크](url)" reads "굵게 코드 링크"; whitespace folds to single spaces. */
export function plainText(markdown: string): string {
  return inline(stripQuestionTags(markdown).split('\n').map(line).join('\n'))
    .replace(/\s+/g, ' ')
    .trim();
}
