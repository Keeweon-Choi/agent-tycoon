import { getLanguage, t } from '../../i18n/index.js';

// The daemon's all-member mention is a wire value, independent of display language.
const ALL_MEMBER = String.fromCodePoint(0xc804, 0xccb4);

/** The unfinished @word around a room composer's caret, if there is one. */
export function mentionAt(text: string, cursor: number): { from: number; query: string } | null {
  const before = text.slice(0, cursor);
  const at = before.lastIndexOf('@');
  if (
    at < 0 ||
    /\s/.test(before.slice(at + 1)) ||
    (at > 0 && !/\s|[([{'".,!?;:]/u.test(before[at - 1]))
  )
    return null;
  return { from: at, query: before.slice(at + 1) };
}

/** `전체` is always first; Korean matching is case-insensitive for mixed-name projects. */
export function filterMentions(members: string[], query: string): string[] {
  const needle = query.toLocaleLowerCase();
  return [ALL_MEMBER, ...members.filter((name) => name !== ALL_MEMBER)].filter(
    (name, index, all) =>
      all.indexOf(name) === index &&
      (name.toLocaleLowerCase().includes(needle) ||
        (name === ALL_MEMBER && getLanguage() === 'en' && t('messenger.everyone').includes(needle))),
  );
}

export const mentionDisplay = (name: string): string =>
  name === ALL_MEMBER ? t('messenger.everyone') : name;

export function canonicalizeMentions(text: string): string {
  return getLanguage() === 'en'
    ? text.replace(/@everyone(?=$|[\s,.;!?])/giu, `@${ALL_MEMBER}`)
    : text;
}

/** Replace just the active @word, preserving the rest of a multiline draft. */
export function chooseMention(
  text: string,
  cursor: number,
  name: string,
): { text: string; cursor: number } {
  const active = mentionAt(text, cursor);
  if (!active) return { text, cursor };
  const replacement = `@${name} `;
  const end = cursor + (text.slice(cursor).match(/^[\p{L}\p{N}_-]*/u)?.[0].length ?? 0);
  return {
    text: `${text.slice(0, active.from)}${replacement}${text.slice(end)}`,
    cursor: active.from + replacement.length,
  };
}

/** MSG-UI3: replying to a room member tags them (the daemon records an untagged post and wakes no one).
 *  No tag for the boss, a system line or a name that is not in the room, and none twice. */
export function replyPrefill(text: string, sender: string | undefined, members: readonly string[]): string {
  if (!sender || !members.includes(sender) || text.includes(`@${sender}`)) return text;
  return `@${sender} ${text}`;
}
