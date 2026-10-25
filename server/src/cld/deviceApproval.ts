/**
 * New-device approval (T-0022), off unless the daemon runs with
 * --allow-approval-requests. A device without a session asks; a logged-in
 * device approves by TYPING the 6-digit code the new device shows. A tap is
 * never enough: "approve a request someone else started" is the pattern
 * device-code and linked-device phishing used in 2025 (Storm-2372, Signal,
 * WhatsApp "GhostPairing"), so the code proves the approver is looking at
 * the new device. The code is never sent to the logged-in devices.
 */
import * as crypto from 'crypto';

import { koText } from '../../../core/src/cld/serverText.js';

export const APPROVAL_TTL_MS = 5 * 60_000;
const MAX_PENDING = 10;
const MAX_PENDING_PER_CLIENT = 3;
/** Wrong codes typed for one request before it is refused. */
const MAX_WRONG_CODES = 3;

/** Where the request came from, for the approver: the coarse network. */
export type ApprovalNetwork = 'funnel' | 'tailnet' | 'lan' | 'local';

interface Approval {
  /** Public handle (sent to logged-in devices). */
  id: string;
  /** The new device's poll token. */
  secret: string;
  code: string;
  label: string;
  /** The requester's User-Agent, as a device name. */
  agent: string;
  ip: string;
  network: ApprovalNetwork;
  createdAt: number;
  expiresAt: number;
  state: 'pending' | 'approved' | 'refused';
  wrongCodes: number;
}

/** What logged-in devices see (protocol `deviceApprovalRequest`): no code. */
export interface ApprovalView {
  id: string;
  label: string;
  agent: string;
  ip: string;
  network: ApprovalNetwork;
  createdAt: number;
  expiresAt: number;
}

export type PollResult =
  | { state: 'pending'; expiresIn: number }
  | { state: 'approved'; label: string }
  | { state: 'refused' }
  | { state: 'gone' };

export type AnswerResult = 'approved' | 'refused' | 'wrong-code' | 'gone';

export class DeviceApprovals {
  private readonly requests = new Map<string, Approval>();

  constructor(
    /** To every logged-in client: deviceApprovalRequest / deviceApprovalClosed. */
    private readonly broadcast: (message: Record<string, unknown>) => void,
  ) {}

  /** A new request, or null when too many are pending (all, or from this client). */
  create(req: { label: string; agent: string; ip: string; network: ApprovalNetwork }): {
    secret: string;
    code: string;
    expiresIn: number;
  } | null {
    this.sweep();
    const pending = [...this.requests.values()];
    if (
      pending.length >= MAX_PENDING ||
      pending.filter((a) => a.ip === req.ip).length >= MAX_PENDING_PER_CLIENT
    )
      return null;
    const now = Date.now();
    const approval: Approval = {
      ...req,
      id: crypto.randomBytes(9).toString('base64url'),
      secret: crypto.randomBytes(32).toString('base64url'),
      code: this.newCode(),
      createdAt: now,
      expiresAt: now + APPROVAL_TTL_MS,
      state: 'pending',
      wrongCodes: 0,
    };
    this.requests.set(approval.id, approval);
    this.broadcast({ type: 'deviceApprovalRequest', ...view(approval) });
    console.log(
      `[cld auth] device approval requested: "${approval.label}" (${approval.agent}, ${approval.network} ${approval.ip})`,
    );
    return { secret: approval.secret, code: approval.code, expiresIn: APPROVAL_TTL_MS / 1000 };
  }

  pending(): ApprovalView[] {
    this.sweep();
    return [...this.requests.values()].filter((a) => a.state === 'pending').map(view);
  }

  /** The new device polls with its secret. An answer is handed out once. */
  poll(secret: unknown): PollResult {
    this.sweep();
    const approval =
      typeof secret === 'string'
        ? [...this.requests.values()].find((a) => a.secret === secret)
        : undefined;
    if (!approval) return { state: 'gone' };
    if (approval.state === 'pending')
      return { state: 'pending', expiresIn: Math.ceil((approval.expiresAt - Date.now()) / 1000) };
    this.requests.delete(approval.id);
    return approval.state === 'approved'
      ? { state: 'approved', label: approval.label }
      : { state: 'refused' };
  }

  /**
   * A logged-in device answers. Approving needs the code typed from the new
   * device's screen; three wrong codes refuse the request.
   */
  answer(id: unknown, approve: boolean, code: unknown, by: string): AnswerResult {
    this.sweep();
    const approval = typeof id === 'string' ? this.requests.get(id) : undefined;
    if (!approval || approval.state !== 'pending') return 'gone';
    if (!approve) return this.close(approval, 'refused', by);
    if (typeof code !== 'string' || code.replace(/\s+/g, '') !== approval.code) {
      approval.wrongCodes++;
      if (approval.wrongCodes >= MAX_WRONG_CODES)
        this.close(approval, 'refused', koText('audit_wrong_codes', { by }));
      return 'wrong-code';
    }
    return this.close(approval, 'approved', by);
  }

  /** The host CLI types the code itself: `cld-gui-login --approve <code>`. */
  approveByCode(code: string, by: string): boolean {
    this.sweep();
    const approval = [...this.requests.values()].find(
      (a) => a.state === 'pending' && a.code === code,
    );
    if (!approval) return false;
    this.close(approval, 'approved', by);
    return true;
  }

  private close(approval: Approval, outcome: 'approved' | 'refused', by: string): AnswerResult {
    approval.state = outcome;
    this.broadcast({ type: 'deviceApprovalClosed', id: approval.id, outcome });
    console.log(
      `[cld auth] device ${outcome === 'approved' ? 'approved' : 'refused'}: "${approval.label}" (${approval.agent}, ${approval.network} ${approval.ip}) by ${by}`,
    );
    return outcome;
  }

  /** Expired requests go away, and logged-in devices drop them. */
  private sweep(): void {
    const now = Date.now();
    for (const approval of this.requests.values()) {
      if (approval.expiresAt > now) continue;
      this.requests.delete(approval.id);
      if (approval.state === 'pending')
        this.broadcast({ type: 'deviceApprovalClosed', id: approval.id, outcome: 'expired' });
    }
  }

  private newCode(): string {
    for (;;) {
      const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
      if (![...this.requests.values()].some((a) => a.code === code)) return code;
    }
  }
}

function view({ id, label, agent, ip, network, createdAt, expiresAt }: Approval): ApprovalView {
  return { id, label, agent, ip, network, createdAt, expiresAt };
}

/** 100.64.0.0/10 and fd7a:115c:a1e0::/48: Tailscale's address ranges. */
export function isTailscaleAddress(ip: string): boolean {
  const v4 = /^(?:::ffff:)?(\d+)\.(\d+)\.\d+\.\d+$/.exec(ip);
  if (v4) return Number(v4[1]) === 100 && Number(v4[2]) >= 64 && Number(v4[2]) <= 127;
  return ip.toLowerCase().startsWith('fd7a:115c:a1e0:');
}
