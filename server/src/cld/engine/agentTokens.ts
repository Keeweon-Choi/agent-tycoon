/**
 * Agent session tokens (S7, onboarding-security D-threats A1/A2): who is
 * calling over the control socket. The engine hands each Claude session it
 * starts its own CLD_AGENT_TOKEN (random 32 bytes, base64url) through the
 * `--settings` env; `cld-gui` sends it with every request, and the daemon
 * maps it back to the project. Rotated on every fresh start (start, restart,
 * revive, renew), dropped on remove. A bare wake resume carries no flags, so
 * that session keeps the token it already has.
 *
 * Kept as sha256 hashes in ~/.config/agent-tycoon/agent-tokens.json (0600, atomic)
 * so a daemon restart still knows the sessions that keep their old
 * environment. Sessions started before this existed have no token: they keep
 * working as unidentified callers (today's cwd / --from display label, never
 * the owner's header) and get one on their next start; no migration step.
 *
 * ponytail: same-user processes can read another session's environment
 * (/proc/<pid>/environ, the `--settings` argv), so a token separates agents
 * from the owner and from honest mistakes, not from a determined same-user
 * agent. The owner header needs no token at all: only the app writes it.
 */
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { configDir } from './events.js';
import { writeAtomic } from './messenger.js';

export const AGENT_TOKEN_ENV = 'CLD_AGENT_TOKEN';
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

const hash = (token: string): Buffer => createHash('sha256').update(token).digest();

export class AgentTokens {
  readonly file: string;
  /** project name → sha256 of its token */
  private readonly hashes = new Map<string, Buffer>();

  constructor(home: string, private readonly log: (line: string) => void = () => undefined) {
    this.file = path.join(configDir(home), 'agent-tokens.json');
    let raw: string;
    try {
      raw = fs.readFileSync(this.file, 'utf-8');
    } catch {
      return; // none yet
    }
    try {
      const j = JSON.parse(raw) as { v?: unknown; tokens?: Record<string, unknown> };
      if (j.v !== 1 || !j.tokens || typeof j.tokens !== 'object') throw new Error('shape');
      for (const [name, h] of Object.entries(j.tokens))
        if (typeof h === 'string' && /^[0-9a-f]{64}$/.test(h))
          this.hashes.set(name, Buffer.from(h, 'hex'));
    } catch {
      // Unreadable: nobody is identified until their next start issues a fresh token.
      this.log(`${this.file}: unreadable; agent tokens are re-issued on each session's next start`);
    }
  }

  /** A fresh token for `name` (the old one stops working), persisted first. */
  issue(name: string): string {
    const token = randomBytes(32).toString('base64url');
    this.hashes.set(name, hash(token));
    this.save();
    return token;
  }

  drop(name: string): void {
    if (this.hashes.delete(name)) this.save();
  }

  /** The project this token was issued to, or null. Constant time per entry. */
  agentOf(token: unknown): string | null {
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) return null;
    const h = hash(token);
    let found: string | null = null;
    for (const [name, known] of this.hashes) if (timingSafeEqual(h, known)) found = name;
    return found;
  }

  private save(): void {
    const tokens = Object.fromEntries([...this.hashes].map(([n, h]) => [n, h.toString('hex')]));
    try {
      writeAtomic(this.file, JSON.stringify({ v: 1, tokens }));
    } catch (err) {
      // In memory still: this daemon recognises them; a restart would not.
      this.log(`${this.file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
