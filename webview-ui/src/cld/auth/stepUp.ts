import { deviceStepUp } from '../shell/shellApi.js';
import { authFetch, type Me, noteStepUpFailure, setStepUpPrompt } from './authApi.js';

/** Shows the passkey button (WebKit wants the person's own tap); `done(true)` once it proved. */
type Asker = (done: (ok: boolean) => void) => void;
let asker: Asker | null = null;
export const setStepUpAsker = (next: Asker | null) => {
  asker = next;
};

let inflight: Promise<boolean> | null = null;

/**
 * S1: prove this device before a dangerous action -- the shell's step-up, the
 * device key signing by itself, else a passkey tap. One prompt at a time.
 * False: it could not be proved, or the person said no.
 */
export function requestStepUp(): Promise<boolean> {
  inflight ??= prove().finally(() => {
    inflight = null;
  });
  return inflight;
}

async function prove(): Promise<boolean> {
  const me = await authFetch<Me>('/api/auth/me');
  const why = await deviceStepUp(me);
  if (why === 'ok') return true;
  const ask = asker;
  // A passkey here: the tap (a cancel is a plain failure). Else the key's own reason.
  noteStepUpFailure(me.passkeyHere && ask ? 'failed' : why);
  return me.passkeyHere && ask ? new Promise<boolean>((resolve) => ask(resolve)) : false;
}

setStepUpPrompt(requestStepUp);
