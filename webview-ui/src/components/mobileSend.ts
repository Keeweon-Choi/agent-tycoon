import { TERMINAL_SEQ_ENTER } from '../constants.js';

/** What the key bar's send key needs of a terminal (a TerminalInputHandle). */
export interface TerminalSendInput {
  send: (sequence: string) => void;
  busy?: () => boolean;
}

/** Claude Code's chat:sendNow (ctrl+x ctrl+s): Enter during a turn only queues the text for the
 *  turn's end; this sends it at once (user 10-22 20:25). */
export const SEND_NOW = '\x18\x13';

/** The send key: Enter, or chat:sendNow while Claude's turn is running. */
export function submitTerminalLine(input: TerminalSendInput): void {
  input.send(input.busy?.() ? SEND_NOW : TERMINAL_SEQ_ENTER);
}
