/** The "기기 추가" screen's rules, kept out of the JSX (O1). */

export type InvitePhase = 'loading' | 'failed' | 'active' | 'expired' | 'cancelled' | 'registered';

export function invitePhase(s: {
  hasCode: boolean;
  error: boolean;
  cancelled: boolean;
  registered: boolean;
  msLeft: number;
}): InvitePhase {
  if (s.registered) return 'registered';
  if (s.cancelled) return 'cancelled';
  if (!s.hasCode) return s.error ? 'failed' : 'loading';
  return s.msLeft > 0 ? 'active' : 'expired';
}

/** Which buttons a phase offers. Share only where the browser can open an OS share sheet. */
export function inviteButtons(phase: InvitePhase, canShare: boolean) {
  const live = phase === 'active';
  return { copyLink: live, share: live && canShare, cancel: live, closeNote: live };
}

export const canShareLink = (nav: { share?: unknown }): boolean => typeof nav.share === 'function';

/** "Windows · Chrome" -> "Windows Chrome": the name offered for a new device. */
export const suggestedNickname = (label: string): string =>
  label.replace(/\s*·\s*/g, ' ').trim();

/** Open the OS share sheet. A refused or dismissed sheet is not an error. */
export async function shareLink(
  nav: { share?: (data: { title?: string; text: string; url: string }) => Promise<void> },
  text: string,
  url: string,
): Promise<void> {
  try {
    await nav.share?.({ text, url });
  } catch {
    // The person closed the sheet, or the browser refused: nothing to report.
  }
}

/** What the screen shows once a cancel is answered: the code may have been used just before it. */
export function afterCancel(answer: {
  state?: string;
  device?: { label: string; nickname?: string };
}): { kind: 'registered'; device: { label: string; nickname?: string } } | { kind: 'cancelled' } {
  return answer.state === 'registered' && answer.device
    ? { kind: 'registered', device: answer.device }
    : { kind: 'cancelled' };
}
