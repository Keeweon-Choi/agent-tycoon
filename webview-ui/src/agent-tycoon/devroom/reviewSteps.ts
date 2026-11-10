/**
 * The review loop's six steps (mockups-1101/review-loop-R4): 변경 보기, 의견 달기, 보내기,
 * 에이전트가 고침, 다시 보기, 머지. Which one is "지금 여기" follows from the notes, the send in
 * flight, the Task and the worktree: the strip at the top of the 다시 보기 view just draws it.
 */
export const REVIEW_STEPS = ['look', 'note', 'send', 'fix', 'again', 'merge'] as const;
export type ReviewStepId = (typeof REVIEW_STEPS)[number];

export interface ReviewStepInput {
  /** The worktree's notes (sentAt set = sent). */
  notes: readonly { sentAt?: string }[];
  /** A send is on its way. */
  sending: boolean;
  /** The Worker is on the notes: its Task is `doing` after a send (no Task: its turn is running). */
  fixing: boolean;
  merged: boolean;
}

export function reviewStep({ notes, sending, fixing, merged }: ReviewStepInput): number {
  if (merged) return REVIEW_STEPS.length;
  // Notes waiting come first: a second round goes back to 의견 달기 (the "↺ 2번부터 다시").
  if (notes.some((n) => !n.sentAt)) return 2;
  if (sending) return 3;
  if (notes.length > 0) return fixing ? 4 : 5;
  return 1;
}
