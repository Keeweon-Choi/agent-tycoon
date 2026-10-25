/**
 * MSG-ACTIONS: a reply's reference (답글). The id a reply names is the replied
 * message's C2 message id when it has one (the boss's or a peer's message, whose
 * header carried ` ⟨m:<id>⟩`), else the room post's id, else the chat item's own
 * id (`<at>-<uuid8>-<n>`, stable: it comes from the transcript record). The
 * server writes it into the header as ` ⟨re:<id>⟩` after the C2 mark and starts
 * the body with one quote line (quoteLine); transcriptView.ts unmark() reads both back.
 */

/** What a reply id may be: C2 ids, room post ids and chat item ids all fit. */
export const REPLY_ID = /^[A-Za-z0-9._:-]{1,64}$/;
/** The quote line the agent reads carries this much of the replied message. */
export const REPLY_QUOTE_MAX = 120;
/** What the app sends of the replied message: whole lines, so the server masks a secret before it
 *  cuts the quote (a cut first can leave a token's head that no mask rule matches).
 *  ponytail: a secret straddling this far-off cut could still leak a head if masking shrank
 *  everything before it (mask.ts LINE_MAX is the same bound per line). */
export const REPLY_SOURCE_MAX = 2000;
/** The composer's reply chip shows this much. */
export const REPLY_CHIP_MAX = 60;
/** A sender name in the quote line. */
export const REPLY_SENDER_MAX = 40;

/** `text` on one line, at most `max` characters, `…` when cut. */
export function snippet(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

/** A sender name for the quote line: one line, no `:` (the line's own separator). */
export const replySender = (name: string): string =>
  snippet(name.replace(/:/g, ' '), REPLY_SENDER_MAX);

/** The body's first line of a reply: `> <sender>: <first REPLY_QUOTE_MAX characters>`. */
export const quoteLine = (sender: string, text: string): string =>
  `> ${replySender(sender)}: ${snippet(text, REPLY_QUOTE_MAX)}`;

/** A quote line read back (`> ` already removed): the sender and the quoted text. */
export function parseQuote(line: string): { sender: string; text: string } {
  const i = line.indexOf(': ');
  return i < 0 ? { sender: '', text: line } : { sender: line.slice(0, i), text: line.slice(i + 2) };
}
