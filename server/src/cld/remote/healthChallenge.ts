/**
 * O6: "is this address THIS daemon?" without an oracle. A self-test issues a
 * random nonce N with a random reply R, kept in memory for a few seconds;
 * /api/health answers `cldReply: R` only for an N in the map (and uses it up).
 * An address that merely echoes N, or any other caller, learns nothing.
 */
import * as crypto from 'crypto';

export const CHALLENGE_TTL_MS = 5000;
export const CHALLENGE_MAX = 16;
const NONCE = /^[0-9a-f]{32}$/;
const pending = new Map<string, { reply: string; expires: number }>();

export function issueChallenge(): { nonce: string; reply: string } {
  const now = Date.now();
  for (const [key, entry] of pending) if (entry.expires <= now) pending.delete(key);
  // Insertion order: when full, the oldest goes.
  while (pending.size >= CHALLENGE_MAX) pending.delete(pending.keys().next().value as string);
  const nonce = crypto.randomBytes(16).toString('hex');
  const reply = crypto.randomBytes(16).toString('hex');
  pending.set(nonce, { reply, expires: now + CHALLENGE_TTL_MS });
  return { nonce, reply };
}

/** The reply for an issued, unexpired nonce (once); undefined for anything else. */
export function answerFor(nonce: unknown): string | undefined {
  if (typeof nonce !== 'string' || !NONCE.test(nonce)) return undefined;
  const entry = pending.get(nonce);
  pending.delete(nonce);
  return entry && entry.expires > Date.now() ? entry.reply : undefined;
}

/** Tests: how many challenges are waiting. */
export const pendingChallenges = () => pending.size;
