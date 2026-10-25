/** P3a: the update notice's rules, kept out of the JSX. The daemon's view of GET /api/cld/update. */

export interface UpdateView {
  managed: boolean;
  current: string | null;
  available: { version: string; notes: string | null } | null;
  signature: {
    canVerify: boolean;
    release: 'verified' | 'unknown';
    officialKey: boolean;
    osCodeSigning: boolean;
  };
  facts: { sessions: number; jobs: number; worktrees: number; merging: boolean };
  canInstall: boolean;
  terminalOnly: boolean;
  command: string;
  install: { state: 'running' | 'done' | 'failed'; to: string; message: string } | null;
}

/**
 * The signature section: "this build can check" and "this release is signed" are separate lines, and
 * only a release a check really verified gets the tick. Nothing here claims more than the daemon sent.
 */
export type SignatureKey =
  | 'update.sig.canVerify'
  | 'update.sig.cannotVerify'
  | 'update.sig.verified'
  | 'update.sig.unknown'
  | 'update.sig.noOfficialKey'
  | 'update.sig.noOsSigning';

export function signatureLines(
  sig: UpdateView['signature'],
): { key: SignatureKey; tick: boolean }[] {
  const lines: { key: SignatureKey; tick: boolean }[] = [
    { key: sig.canVerify ? 'update.sig.canVerify' : 'update.sig.cannotVerify', tick: false },
  ];
  lines.push(
    sig.release === 'verified'
      ? { key: 'update.sig.verified', tick: true }
      : { key: 'update.sig.unknown', tick: false },
  );
  if (!sig.officialKey) lines.push({ key: 'update.sig.noOfficialKey', tick: false });
  if (!sig.osCodeSigning) lines.push({ key: 'update.sig.noOsSigning', tick: false });
  return lines;
}

/** What the page shows: nothing, the notice, or the result of an install. */
export function noticePhase(
  v: UpdateView | null,
  dismissedResult: string | null,
): 'none' | 'notice' | 'result' {
  if (!v?.managed) return 'none';
  if (v.install && (v.install.state === 'running' || dismissedResult !== resultKey(v.install)))
    return 'result';
  return v.available ? 'notice' : 'none';
}

export const resultKey = (i: NonNullable<UpdateView['install']>): string => `${i.state}:${i.to}`;

/** The buttons: read-only and terminal-only clients see the notice and no 설치. */
export const showInstall = (v: UpdateView): boolean => v.canInstall && !!v.available;
