/**
 * A removed engine agent's records are detached from its name (a new agent may take it): they are
 * kept under `~<its assignment id>`, which no agent name can be (NAME_RE starts with a letter,
 * digit or Hangul) and every file system takes. The messenger shows such a name as "(알 수 없음)".
 */
export const GONE_PREFIX = '~';
export const GONE_NAME_RE = /^~a_[a-z2-7]{10}$/;
/** Every such name inside a text (a room's preview line). */
export const GONE_NAMES = /~a_[a-z2-7]{10}/g;

export const goneName = (assignmentId: string): string => `${GONE_PREFIX}${assignmentId}`;
export const isGoneName = (name: string): boolean => GONE_NAME_RE.test(name);
