import * as crypto from 'crypto';
import type { IncomingHttpHeaders } from 'http';
import * as path from 'path';

import { koText, refused } from '../../../core/src/cld/serverText.js';
import { type AuditContext, type AuditLog, auditLog, cleanAuditText } from './audit.js';
import { DEVICE_ERRORS, type DeviceKey, DeviceKeys, type RegisterResult } from './deviceKeys.js';
import { readJson, writeJsonAtomic } from './jsonFile.js';
import { Passkeys,type PasskeyView } from './passkeys.js';
import { proofFresh } from './shell/gate.js';

/** Sliding: every use moves a session's expiry to now + 90 days (T-0034). */
export const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
/** LAN cookies are deliberately short-lived and never slide. */
export const LAN_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** A use is written to sessions.json at most once a minute per session. */
export const SESSION_TOUCH_SAVE_MS = 60_000;
const MAX_SESSIONS = 1000;
/**
 * A login by code, passkey, approval or Tailscale that is still no known
 * device this long after (the app registers or proves its device key within
 * a second or two) is announced as a new device.
 */
export const NEW_DEVICE_NOTICE_MS = 30_000;

/**
 * One-time login codes. `link`: the 60 s `/login?code=` link the CLI and the
 * desktop app open. `qr`: the same link in a QR code, 10 minutes because
 * scanning takes time. `short`: 8 digits a person types, 5 minutes. `move`
 * (T-0034): a logged-in device takes itself to another address (the
 * canonical one), 5 minutes, bound to its device id.
 */
export type CodeKind = 'link' | 'qr' | 'short' | 'move' | 'handoff';
export const CODE_TTL_MS: Record<CodeKind, number> = {
  link: 60_000,
  qr: 10 * 60_000,
  short: 5 * 60_000,
  move: 5 * 60_000,
  handoff: 2 * 60_000,
};
/**
 * S3: only a session this young (it just came in through the QR) may ask for a
 * handoff code; the QR itself lives 10 minutes.
 */
export const HANDOFF_ASK_MS = CODE_TTL_MS.qr;

/** How a browser session was made (shown in the session list). */
export type LoginMethod = CodeKind | 'tailscale' | 'approval' | 'passkey' | 'device';
export type SessionLifetime = 'lan';
export type DeviceKind = 'phone' | 'tablet' | 'desktop' | 'unknown';
export type DevicePath = 'local' | 'lan' | 'tailscale' | 'remote';

interface LoginCode {
  kind: CodeKind;
  expiresAt: number;
  /** "기기 추가" issues a short code and a QR link as one credential. */
  partner?: string;
  /** A move code's device. */
  deviceId?: string;
  /** A handoff code's session (token hash): it dies with it. */
  issuer?: string;
  /** O1: the "기기 추가" invitation this code belongs to. */
  invite?: string;
}

/** O1: one "기기 추가" invitation, as its issuing session sees it. Memory only; holds no code. */
interface Invite {
  /** Token hash of the session that issued it: the only one that may ask about it. */
  issuer: string;
  expiresAt: number;
  codes: string[];
  cancelled: boolean;
  /** The session the invitation logged in, and the device it became. */
  handle?: string;
  deviceId?: string;
}

export type InviteState = 'pending' | 'registered' | 'cancelled' | 'expired';
export interface InviteStatus {
  state: InviteState;
  /** Once registered: what the host recorded (user agent label) and the nickname, if one is set. */
  device?: { label: string; nickname?: string };
}

const INVITE_KEEP_MS = 60 * 60 * 1000;
const MAX_INVITES = 200;

export interface Session {
  /**
   * SHA-256 of the cookie value (base64url): the key here and in
   * sessions.json. The cookie value itself is never stored.
   */
  hash: string;
  /** Public handle for the session list. */
  handle: string;
  method: LoginMethod;
  label: string;
  createdAt: number;
  lastSeen: number;
  expiresAt: number;
  /** LAN sessions are absolute 12-hour sessions; absent records predate this and still slide. */
  lifetime?: SessionLifetime;
  /** The device (key) this session is; one session per device. */
  deviceId?: string;
  /** O1: a name the owner gave this device; shown instead of `label`. */
  nickname?: string;
  /** O2: derived from this session's User-Agent at sign-in. */
  kind?: DeviceKind;
  /** A move (or O5: device-carrying handoff) session that already brought its key here: from then on it is a plain cookie (kept in sessions.json). */
  moveUsed?: boolean;
  /** Most recent explicit shell step-up; memory only and lost on restart. */
  shellProofAt?: number;
  /** What proved it: under 패스키 필수 with a passkey somewhere, a key proof counts for nothing. */
  shellProofBy?: 'key' | 'passkey';
  /** Passkey that created or most recently verified this session; memory only. */
  shellPasskeyId?: string;
  /** O3: how the request that made this session came in; memory only. */
  arrival?: AuditContext;
}

/** O3: the four moments a device is news. */
export type DeviceEventKind = 'new' | 'replaced' | 'passkey' | 'unknown';
/** O3: what the push and the audit line know about such a moment (the toast gets only the notice). */
export interface DeviceEvent extends AuditContext {
  /** Its row in the device list. */
  id: string;
  /** Its plain name: no prefix. */
  label: string;
  kind: DeviceKind;
  event: DeviceEventKind;
  at: number;
  /** The session handle it acted through: a push subscribed under it is the same device. */
  handle?: string;
}

/** A device the server had not seen logged in (to every logged-in client). */
export interface NewDeviceNotice {
  /** Its row in the device list. */
  id: string;
  label: string;
  at: number;
}

/** A session just made: `id` is its cookie value, handed out once for Set-Cookie. */
export interface NewSession extends Session {
  id: string;
}

interface SessionFile {
  v: 1;
  sessions: Session[];
}

/**
 * One row of the device list: a device with a key (its session, if any,
 * folded in) or a session without one. `id` is the device id or the
 * session's handle -- never a cookie.
 */
export interface SessionView {
  id: string;
  method: LoginMethod;
  label: string;
  /** The User-Agent label, retained when `label` is a nickname. */
  device: string;
  kind: DeviceKind;
  path: DevicePath;
  createdAt: number;
  lastSeen: number;
  current: boolean;
  connected: boolean;
  /** It has a device key: it logs back in by itself. */
  deviceKey: boolean;
  /** Where its key works. */
  origin?: string;
  /** S5: passkeys tied to this device; signing it out revokes them (and their synced copies). */
  passkeys: number;
}

export interface StandaloneAuthOptions {
  /**
   * ~/.config/agent-tycoon: where passkeys.json, sessions.json and devices.json
   * live. Absent: no passkeys or device keys, and sessions are kept in memory
   * only (no file is read or written).
   */
  configDir?: string;
  /** --allow-approval-requests: new devices may ask a logged-in one (off by default). */
  allowApprovalRequests?: boolean;
}

/**
 * Credentials for the standalone browser surface. Passkeys and sessions are
 * on disk (sessions as token hashes, so a daemon restart signs nobody out);
 * login codes and the rest are in memory.
 */
export class StandaloneAuth {
  private readonly codes = new Map<string, LoginCode>();
  private readonly invites = new Map<string, Invite>();
  /** By token hash. */
  private readonly sessions = new Map<string, Session>();
  /** Token hash -> when a use of it was last written to sessions.json. */
  private readonly touchSaved = new Map<string, number>();
  private readonly sessionFile?: string;
  /** sessions.json could not be read: it is kept as it is and never written over. */
  private readonly sessionFileBroken: boolean = false;
  /** Token hash -> close callbacks of its open sockets. */
  private readonly sockets = new Map<string, Set<() => void>>();
  /** Failed attempts on every auth endpoint, per client address and per code. */
  readonly limiter = new AuthLimiter();
  /** Nonce requests without a session, per client (the login page's silent re-login). */
  readonly challengeLimiter = new AuthLimiter();
  /**
   * A session's nonce requests, per session: devices behind one address (hairpin NAT) and a
   * page's terminal panes re-proving after a restart must not lock each other out.
   */
  readonly sessionChallengeLimiter = new AuthLimiter(SESSION_CHALLENGE_LIMIT);
  /** All failed short-code attempts together: 20 in 10 minutes lock short codes for 10. */
  readonly shortCodeLock = new AuthLimiter(SHORT_CODE_LOCK);
  /** Every failed code on the direct listener together (T-0024): stricter, see DIRECT_CODE_LOCK. */
  readonly directCodeLock = new AuthLimiter(DIRECT_CODE_LOCK);
  readonly passkeys?: Passkeys;
  readonly devices?: DeviceKeys;
  readonly allowApprovalRequests: boolean;
  /** Told about every new device (the routes broadcast it). */
  onNewDevice?: (notice: NewDeviceNotice) => void;
  /** O3: told about the same moments with more to say (the push composes this). */
  onDeviceEvent?: (event: DeviceEvent) => void;
  /** O3: the security record of this config dir. */
  readonly audit: AuditLog;
  /** Told when a device-list row is gone: a revoked device's id, an ended session's handle (T-0039). */
  onRowGone?: (id: string) => void;

  constructor(options: StandaloneAuthOptions = {}) {
    if (options.configDir) {
      this.passkeys = new Passkeys(path.join(options.configDir, 'passkeys.json'));
      this.devices = new DeviceKeys(path.join(options.configDir, 'devices.json'));
      this.sessionFile = path.join(options.configDir, 'sessions.json');
      this.sessionFileBroken = !this.loadSessions(this.sessionFile);
    }
    this.allowApprovalRequests = options.allowApprovalRequests ?? false;
    this.audit = auditLog(options.configDir);
  }

  /** O3: who a session is, as the record names it. */
  actorLabel(session: Session): string {
    const device = this.knownDevice(session);
    return cleanAuditText(device?.nickname ?? device?.label ?? session.nickname ?? session.label);
  }

  /** O3: one device-news moment: the audit line, the push, the toast. `noticeLabel`: the toast's text. */
  announceDevice(event: DeviceEvent, noticeLabel = event.label): void {
    this.audit.write({
      kind: 'deviceRegistered',
      device: { id: event.id, label: event.label, kind: event.kind },
      by: event.by,
      via: event.via,
      peer: event.peer,
      detail: event.event,
      at: event.at,
    });
    this.onDeviceEvent?.(event);
    this.onNewDevice?.({ id: event.id, label: noticeLabel, at: event.at });
  }

  createLoginCode(kind: CodeKind = 'link'): { code: string; expiresIn: number } {
    const code =
      kind === 'short' ? this.newShortCode() : crypto.randomBytes(24).toString('base64url');
    this.codes.set(code, { kind, expiresAt: Date.now() + CODE_TTL_MS[kind] });
    return { code, expiresIn: CODE_TTL_MS[kind] / 1000 };
  }

  /**
   * "기기 추가": a short code to type and a QR link code, made together and
   * expiring together (5 minutes) as ONE invitation (S3): whichever is used
   * first uses up both. On an iPhone the camera opens a QR in the default
   * browser; its page then offers a handoff code (`createHandoffCode`) for
   * the Home-Screen app, which keeps its own cookies.
   */
  createDeviceCodes(issuer?: Session, context?: AuditContext): { short: string; link: string; expiresIn: number; id: string } {
    const short = this.newShortCode();
    const link = crypto.randomBytes(24).toString('base64url');
    const id = crypto.randomBytes(16).toString('base64url');
    const expiresAt = Date.now() + CODE_TTL_MS.short;
    this.codes.set(short, { kind: 'short', expiresAt, partner: link, invite: id });
    this.codes.set(link, { kind: 'qr', expiresAt, partner: short, invite: id });
    const now = Date.now();
    for (const [code, entry] of this.codes) if (entry.expiresAt <= now) this.codes.delete(code);
    // An evicted invitation takes its codes with it: it could no longer be cancelled.
    for (const [key, invite] of this.invites)
      if (invite.expiresAt + INVITE_KEEP_MS < now || this.invites.size >= MAX_INVITES) {
        this.dropInviteCodes(invite);
        this.invites.delete(key);
      }
    this.invites.set(id, {
      issuer: issuer?.hash ?? '',
      expiresAt,
      codes: [short, link],
      cancelled: false,
    });
    this.audit.write({ kind: 'inviteCreated', by: issuer && this.actorLabel(issuer), ...context });
    return { short, link, expiresIn: CODE_TTL_MS.short / 1000, id };
  }

  /** O1: where an invitation stands, for the session that issued it; undefined for anyone else. */
  inviteStatus(session: Session, id: string): InviteStatus | undefined {
    const invite = this.invites.get(id);
    if (!invite || invite.issuer !== session.hash) return undefined;
    if (invite.handle) {
      const { label, nickname } = this.inviteDevice(invite);
      return { state: 'registered', device: { label, ...(nickname ? { nickname } : {}) } };
    }
    if (invite.cancelled) return { state: 'cancelled' };
    return { state: invite.expiresAt <= Date.now() ? 'expired' : 'pending' };
  }

  /**
   * O1: make an unused invitation's codes worthless at once. The answer is the
   * invitation's state afterwards: `cancelled`, or -- when the code was used
   * before the cancel arrived -- `registered`, whose device stays. Undefined:
   * not an invitation of this session.
   */
  cancelInvite(session: Session, id: string, context?: AuditContext): InviteStatus | undefined {
    const invite = this.invites.get(id);
    if (!invite || invite.issuer !== session.hash) return undefined;
    const wasPending = !invite.handle && !invite.cancelled;
    this.dropInviteCodes(invite);
    if (wasPending)
      this.audit.write({ kind: 'inviteRefused', detail: 'cancelled', by: this.actorLabel(session), ...context });
    return this.inviteStatus(session, id);
  }

  /** The codes of an invitation nobody used are gone; it reads as cancelled. */
  private dropInviteCodes(invite: Invite): void {
    for (const code of invite.codes) this.codes.delete(code);
    if (!invite.handle) invite.cancelled = true;
  }

  /** O1: name the device an invitation registered. False: no such invitation, or its device is gone. */
  nameInviteDevice(session: Session, id: string, nickname: string): boolean {
    const invite = this.invites.get(id);
    if (!invite?.handle || invite.issuer !== session.hash) return false;
    const { session: target, device } = this.inviteDevice(invite);
    if (!target && !device) return false;
    if (target) target.nickname = nickname;
    if (device) this.devices?.setNickname(device.id, nickname);
    this.saveSessions();
    return true;
  }

  /** The session an invitation logged in and the device it has become (remembered once seen). */
  private inviteDevice(invite: Invite) {
    const session = [...this.sessions.values()].find((s) => s.handle === invite.handle);
    invite.deviceId = session?.deviceId ?? invite.deviceId;
    const device = invite.deviceId ? this.devices?.get(invite.deviceId) : undefined;
    return {
      session,
      device,
      label: device?.label ?? session?.label ?? '',
      nickname: device?.nickname ?? session?.nickname,
    };
  }

  /**
   * A move code (T-0034): the device `deviceId` opens the canonical address
   * with it and is the same device there. Single use, 5 minutes (O5's automatic
   * move, used at once: `ttlMs` 60 s).
   */
  createMoveCode(deviceId: string, ttlMs = CODE_TTL_MS.move): { code: string; expiresIn: number } {
    const code = crypto.randomBytes(24).toString('base64url');
    this.codes.set(code, { kind: 'move', expiresAt: Date.now() + ttlMs, deviceId });
    return { code, expiresIn: ttlMs / 1000 };
  }

  /**
   * S3: a fresh 8-digit code, 2 minutes, single use, for the Home-Screen app of
   * the phone whose Safari `session` the QR logged in. Only a session that
   * logged in through a QR, or a move (manual or automatic: the Safari tab that
   * just moved to a new address), in the last 10 minutes may ask; a new ask
   * replaces the last one. The code is handed to that one response, nowhere
   * else. Its session is the issuing device, when that has a key (`login`).
   */
  createHandoffCode(session: Session): { code: string; expiresIn: number } | null {
    if (!this.mayHandoff(session)) return null;
    for (const [code, entry] of this.codes)
      if (entry.kind === 'handoff' && entry.issuer === session.hash) this.codes.delete(code);
    const code = this.newShortCode();
    this.codes.set(code, {
      kind: 'handoff',
      expiresAt: Date.now() + CODE_TTL_MS.handoff,
      issuer: session.hash,
    });
    return { code, expiresIn: CODE_TTL_MS.handoff / 1000 };
  }

  /** S3: whether this session may be shown a handoff code (the /api/auth/me flag). */
  mayHandoff(session: Session): boolean {
    return (session.method === 'qr' || session.method === 'move') && Date.now() - session.createdAt <= HANDOFF_ASK_MS;
  }

  /** Consume a one-time code (spaces ignored) and mint its session, or return null. */
  login(
    code: string,
    label = koText('device_browser'),
    lifetime?: SessionLifetime,
    kind: DeviceKind = 'unknown',
    context?: AuditContext,
  ): NewSession | null {
    const key = normalizeCode(code);
    const entry = this.codes.get(key);
    // Delete before checking expiry: invalid attempts never leave reusable data.
    this.codes.delete(key);
    // S3: a "기기 추가" invitation is one credential. Using either half leaves neither.
    if (entry?.partner) this.codes.delete(entry.partner);
    if (entry?.invite && entry.expiresAt <= Date.now())
      this.audit.write({ kind: 'inviteRefused', detail: 'expired', ...context });
    if (!entry || entry.expiresAt <= Date.now()) return null;
    // A handoff code is only as good as the Safari session that asked for it.
    if (entry.kind === 'handoff' && !(entry.issuer && this.sessions.has(entry.issuer))) return null;
    // O5 review: a handoff is the issuing device continuing in its Home-Screen app, so its
    // session is that device (revoking it ends this too) and may bring the device's key once.
    const issuer = entry.kind === 'handoff' ? this.sessions.get(entry.issuer as string) : undefined;
    const carried = issuer && this.knownDevice(issuer)?.id;
    if (entry.kind !== 'move') {
      const session = this.createSession(entry.kind, label, carried, lifetime, kind, context);
      if (carried) {
        this.sessions.get(session.hash)!.moveUsed = false;
        this.saveSessions();
      }
      const invite = entry.invite ? this.invites.get(entry.invite) : undefined;
      if (invite) invite.handle = session.handle;
      // An invitation's code, or the host's own login code (CLI, installer, handoff).
      this.audit.write({
        kind: entry.invite ? 'inviteUsed' : 'loginCodeUsed',
        device: { id: session.handle, label: session.label, kind },
        detail: entry.kind,
        ...context,
      });
      return session;
    }
    // Only while its device is still registered: a removed device moves nowhere.
    const device = entry.deviceId ? this.devices?.get(entry.deviceId) : undefined;
    if (!device) return null;
    const moved = this.createSession('move', label, device.id, lifetime, kind, context);
    this.sessions.get(moved.hash)!.moveUsed = false;
    this.saveSessions();
    this.audit.write({
      kind: 'loginCodeUsed',
      device: { id: device.id, label: device.nickname ?? device.label, kind: device.kind ?? kind },
      detail: 'move',
      ...context,
    });
    return moved;
  }

  createSession(
    method: LoginMethod = 'link',
    label = koText('device_browser'),
    deviceId?: string,
    lifetime?: SessionLifetime,
    kind: DeviceKind = 'unknown',
    context?: AuditContext,
  ): NewSession {
    const now = Date.now();
    const id = crypto.randomBytes(32).toString('base64url');
    const session: Session = {
      hash: hashToken(id),
      handle: crypto.randomBytes(9).toString('base64url'),
      method,
      label,
      createdAt: now,
      lastSeen: now,
      expiresAt: now + (lifetime === 'lan' ? LAN_SESSION_TTL_MS : SESSION_TTL_MS),
      ...(deviceId ? { deviceId } : {}),
      ...(lifetime ? { lifetime } : {}),
      kind,
      ...(context ? { arrival: context } : {}),
    };
    this.sessions.set(session.hash, session);
    this.touchSaved.set(session.hash, now);
    // ponytail: past 1000 sessions the least recently seen one goes; only a
    // valid credential or a trusted Tailscale login makes one.
    if (this.sessions.size > MAX_SESSIONS)
      this.end([...this.sessions.values()].reduce((a, b) => (b.lastSeen < a.lastSeen ? b : a)));
    this.saveSessions();
    if (!deviceId)
      setTimeout(() => this.announceIfUnknown(session.hash), NEW_DEVICE_NOTICE_MS).unref();
    return { ...session, id };
  }

  /**
   * S5: a verified passkey login. A passkey tied to a live device logs in on its
   * own (a synced copy on another device included, until that device is revoked).
   * An unbound one -- a legacy v1 record, or one whose device is gone -- never
   * does: it needs the SAME browser to prove a registered, non-revoked device key
   * too, and is tied to that device from then on. Without one the user goes
   * through a registration invite. The session, or null.
   */
  passkeyLogin(
    used: PasskeyView,
    proven: DeviceKey | null,
    lifetime?: SessionLifetime,
    context?: AuditContext,
  ): NewSession | null {
    const bound = used.deviceId ? this.devices?.get(used.deviceId) : undefined;
    if (!bound) {
      if (!proven || !this.passkeys?.bind(used.id, proven.id)) return null;
    }
    const session = this.createSession('passkey', used.name, proven?.id, lifetime, proven?.kind, context);
    if (proven) this.endOtherSessions(proven.id, session.hash);
    this.session(session.id)!.shellPasskeyId = used.id;
    return session;
  }

  /** A device proved its key: a new session for it, and its older sessions end. */
  deviceLogin(device: DeviceKey, lifetime?: SessionLifetime): NewSession {
    const session = this.createSession('device', device.label, device.id, lifetime, device.kind);
    this.endOtherSessions(device.id, session.hash);
    return session;
  }

  /** This session proved it holds `deviceId`'s key: it is that device now (one session each). */
  linkDevice(session: Session, deviceId: string): void {
    session.deviceId = deviceId;
    this.endOtherSessions(deviceId, session.hash);
  }

  /**
   * The web app's device key for this session. A session that already is a
   * known device stays it, and only a move (that browser has no key for it
   * yet) replaces its key in its one row: a stolen cookie or an XSS must not
   * swap in a key of its own, unannounced, under the victim's own row. A new
   * device is announced to every client. A replacement also alerts the other
   * devices, since a leaked move code could have caused it.
   */
  registerDevice(
    session: Session,
    deviceId: unknown,
    publicKey: unknown,
    origin: string,
    context?: AuditContext,
  ): RegisterResult {
    if (!this.devices) return { status: 404, ...refused('device_keys_off') };
    // A move's key comes once, at its new address: later the move session's cookie is a plain
    // one, whatever Host it is sent under (one daemon answers to several names).
    // A handoff's key comes once too, into the Home-Screen app at the device's own address.
    const known = this.knownDevice(session);
    const bringing =
      (session.method === 'move' || session.method === 'handoff') && session.deviceId === deviceId && !session.moveUsed;
    const moving = bringing && (session.method === 'move' ? known?.origin !== origin : known?.origin === origin);
    if (known && !moving) return { status: 409, error: DEVICE_ERRORS.taken };
    const mayReplace = typeof deviceId === 'string' && session.deviceId === deviceId;
    const result = this.devices.register(
      deviceId,
      publicKey,
      origin,
      session.label,
      mayReplace,
      session.kind,
    );
    if ('error' in result) return result;
    if (result.isNew && session.nickname) this.devices.setNickname(result.device.id, session.nickname);
    if (session.method === 'move' || session.method === 'handoff') session.moveUsed = true;
    // linkDevice saves sessions.json (moveUsed with it).
    this.linkDevice(session, result.device.id);
    const event: DeviceEvent = {
      id: result.device.id,
      label: result.device.label,
      kind: result.device.kind ?? 'unknown',
      event: result.isNew ? 'new' : 'replaced',
      at: Date.now(),
      by: this.actorLabel(session),
      handle: session.handle,
      ...context,
    };
    this.announceDevice(
      event,
      result.isNew ? result.device.label : koText('audit_key_replaced', { label: result.device.label }),
    );
    return result;
  }

  /** The caller's row in the device list. */
  rowId(session: Session): string {
    return this.knownDevice(session) ? (session.deviceId as string) : session.handle;
  }

  /** A registered key or a session obtained with an existing passkey. */
  shellDevice(session: Session): boolean {
    return (
      !!this.knownDevice(session) ||
      (session.method === 'passkey' &&
        !!session.shellPasskeyId &&
        !!this.passkeys?.list().some((key) => key.id === session.shellPasskeyId))
    );
  }

  /** The device-list row of the live session behind a cookie value (T-0039: push per device). */
  rowIdOf(id: string | undefined): string | undefined {
    const session = this.session(id);
    return session && this.rowId(session);
  }

  /** S1: this session proved itself (device key or passkey) within the shell gate's window. */
  stepUpFresh(session: Session | undefined, now = Date.now()): boolean {
    // A key proof taken before 필수 bound the device keys proves nothing now.
    if (session?.shellProofBy === 'key' && this.keyStepUpRefused()) return false;
    return proofFresh(session?.shellProofAt, now);
  }

  /** A step-up just passed on this session. */
  provedStepUp(session: Session, by: 'key' | 'passkey'): void {
    session.shellProofAt = Date.now();
    session.shellProofBy = by;
  }

  /**
   * "패스키 필수": every step-up is a passkey tap, the device key alone is not
   * enough -- unless no passkey exists anywhere. Then nobody could tap one, and
   * the key steps up again (lockout recovery, 10-24: 필수 was on with none left).
   */
  keyStepUpRefused(): boolean {
    return !!this.devices?.passkeyRequired && !!this.passkeys?.list().length;
  }

  /**
   * 필수 just started to bind the device keys (it went on, or the first passkey came under it):
   * every key proof still in its window ends, on every session.
   */
  dropKeyProofs(): void {
    if (!this.keyStepUpRefused()) return;
    for (const s of this.sessions.values())
      if (s.shellProofBy === 'key') {
        delete s.shellProofAt;
        delete s.shellProofBy;
      }
  }

  /**
   * The live session behind a cookie value. Normal sessions slide to 90 days;
   * LAN sessions retain their absolute 12-hour expiry.
   */
  session(id: string | undefined): Session | undefined {
    const session = id ? this.sessions.get(hashToken(id)) : undefined;
    if (!session) return undefined;
    const now = Date.now();
    if (session.expiresAt <= now) {
      this.end(session);
      this.saveSessions();
      return undefined;
    }
    session.lastSeen = now;
    if (session.lifetime !== 'lan') session.expiresAt = now + SESSION_TTL_MS;
    if (now - (this.touchSaved.get(session.hash) ?? 0) >= SESSION_TOUCH_SAVE_MS) {
      this.touchSaved.set(session.hash, now);
      this.saveSessions();
      // A device in use keeps its key from the 180-day prune.
      if (session.deviceId) this.devices?.touch(session.deviceId);
    }
    return session;
  }

  validSession(id: string | undefined): boolean {
    return this.session(id) !== undefined;
  }

  /** Call `close` when this session is signed out; returns the unbind. */
  bindSocket(id: string | undefined, close: () => void): () => void {
    const hash = id ? hashToken(id) : undefined;
    const session = hash ? this.sessions.get(hash) : undefined;
    if (!hash || !session) return () => undefined;
    const set = this.sockets.get(hash) ?? new Set();
    set.add(close);
    this.sockets.set(hash, set);
    // A LAN session's 12 hours are absolute: end it on time, not when a request next looks it up.
    // A timer can fire a little before Date.now() reaches expiresAt (ms rounding, a clock set back): arm again.
    let expiry: NodeJS.Timeout | undefined;
    const arm = () => {
      expiry = setTimeout(
        () => (session.expiresAt > Date.now() ? arm() : this.session(id)),
        Math.max(0, session.expiresAt - Date.now()),
      ).unref();
    };
    if (session.lifetime === 'lan') arm();
    return () => {
      clearTimeout(expiry);
      set.delete(close);
      if (set.size === 0) this.sockets.delete(hash);
    };
  }

  /**
   * The device list: one row per device key (its session folded in) and one
   * per session without a key.
   */
  listSessions(currentId: string | undefined): SessionView[] {
    const now = Date.now();
    const current = currentId ? hashToken(currentId) : undefined;
    const rows = new Map<string, SessionView>();
    for (const s of this.sessions.values()) {
      if (s.expiresAt <= now) continue;
      const device = this.knownDevice(s);
      const id = device?.id ?? s.handle;
      const row = rows.get(id);
      rows.set(id, {
        id,
        method: s.method,
        label: device?.nickname ?? device?.label ?? s.nickname ?? s.label,
        device: device?.label ?? s.label,
        kind: device?.kind ?? s.kind ?? 'unknown',
        path: devicePath(device?.origin),
        createdAt: device?.createdAt ?? s.createdAt,
        lastSeen: Math.max(s.lastSeen, row?.lastSeen ?? 0),
        current: s.hash === current || !!row?.current,
        connected: this.sockets.has(s.hash) || !!row?.connected,
        deviceKey: !!device,
        ...(device ? { origin: device.origin } : {}),
        passkeys: device ? (this.passkeys?.countFor(device.id) ?? 0) : 0,
      });
    }
    for (const d of this.devices?.list() ?? []) {
      if (rows.has(d.id)) continue;
      rows.set(d.id, {
        id: d.id,
        method: 'device',
        label: d.nickname ?? d.label,
        device: d.label,
        kind: d.kind ?? 'unknown',
        path: devicePath(d.origin),
        createdAt: d.createdAt,
        lastSeen: d.lastUsedAt,
        current: false,
        connected: false,
        deviceKey: true,
        origin: d.origin,
        passkeys: this.passkeys?.countFor(d.id) ?? 0,
      });
    }
    return [...rows.values()];
  }

  /**
   * O3: a device-list row by its id (a device id, or a session handle: the row the handle belongs
   * to), as the list shows it; `currentId` is the caller's cookie. Undefined: no such row.
   */
  rowOf(id: string, currentId: string | undefined): SessionView | undefined {
    const session = [...this.sessions.values()].find((s) => s.handle === id);
    const rowId = session ? (this.knownDevice(session)?.id ?? session.handle) : id;
    return this.listSessions(currentId).find((row) => row.id === rowId);
  }

  /** O2: rename a persisted device row and every current session folded into it. */
  nameDevice(id: string, nickname: string): boolean {
    if (!this.devices?.setNickname(id, nickname)) return false;
    for (const session of this.sessions.values()) if (session.deviceId === id) session.nickname = nickname;
    this.saveSessions();
    return true;
  }

  /**
   * Remove one row of the device list -- a device (its key and sessions) or
   * a session without a key -- by its id. Its open sockets close.
   */
  /** The device a device-list id names: a session handle resolves to its session's device. */
  revokeTarget(id: string): string {
    return [...this.sessions.values()].find((s) => s.handle === id)?.deviceId ?? id;
  }

  revoke(id: string): boolean {
    const session = [...this.sessions.values()].find((s) => s.handle === id);
    const deviceId = this.revokeTarget(id);
    const removedKey = this.devices?.remove(deviceId) ?? false;
    // S5: its passkeys die with it, and so do the sessions they made (this process's memory).
    const deadPasskeys = new Set(this.passkeys?.revokeDevice(deviceId));
    const ended = [...this.sessions.values()].filter(
      (s) =>
        s === session ||
        s.deviceId === deviceId ||
        (s.shellPasskeyId !== undefined && deadPasskeys.has(s.shellPasskeyId)),
    );
    for (const s of ended) this.end(s);
    if (ended.length) this.saveSessions();
    if (removedKey) this.onRowGone?.(deviceId);
    return removedKey || ended.length > 0;
  }

  /** Remove every row of the device list but the caller's; returns how many. */
  revokeOthers(currentId: string | undefined): number {
    const others = this.listSessions(currentId).filter((row) => !row.current);
    for (const row of others) this.revoke(row.id);
    return others.length;
  }

  private knownDevice(session: Session): DeviceKey | undefined {
    return session.deviceId ? this.devices?.get(session.deviceId) : undefined;
  }

  /** One session per device: the device's sessions other than `keep` end. */
  private endOtherSessions(deviceId: string, keep: string): void {
    for (const s of [...this.sessions.values()])
      if (s.deviceId === deviceId && s.hash !== keep) this.end(s);
    this.saveSessions();
  }

  /** A login that turned out to be no known device: tell the other clients. */
  private announceIfUnknown(hash: string): void {
    const s = this.sessions.get(hash);
    if (s && !this.knownDevice(s))
      this.announceDevice({
        id: s.handle,
        label: s.label,
        kind: s.kind ?? 'unknown',
        event: 'unknown',
        at: s.createdAt,
        ...s.arrival,
      });
  }

  /** Forget a session and close its sockets; the caller saves. */
  private end(session: Session): void {
    // O1: a pending invitation must not outlive the only session able to cancel it.
    for (const invite of this.invites.values())
      if (invite.issuer === session.hash) this.dropInviteCodes(invite);
    this.sessions.delete(session.hash);
    this.touchSaved.delete(session.hash);
    const closers = this.sockets.get(session.hash);
    this.sockets.delete(session.hash);
    for (const close of closers ?? []) close();
    this.onRowGone?.(session.handle);
  }

  /** sessions.json into memory, expired ones left out; false when it can't be read. */
  private loadSessions(file: string): boolean {
    let data: unknown;
    try {
      data = readJson(file);
      if (data !== null && !isSessionFile(data)) throw new Error('unknown shape');
    } catch {
      console.warn(
        `[cld auth] ${file} is unreadable; it is kept as it is, and logins last only until the daemon restarts`,
      );
      return false;
    }
    const now = Date.now();
    for (const s of (data as SessionFile | null)?.sessions ?? []) {
      if (s.expiresAt <= now) continue;
      const { hash, handle, method, label, createdAt, lastSeen, expiresAt, deviceId, lifetime, nickname, kind, moveUsed } = s;
      this.sessions.set(hash, {
        hash,
        handle,
        method,
        label,
        createdAt,
        lastSeen,
        expiresAt,
        ...(deviceId ? { deviceId } : {}),
        ...(lifetime ? { lifetime } : {}),
        ...(nickname ? { nickname } : {}),
        ...(kind ? { kind } : {}),
        // A move session written before the flag existed (or with a bad one) counts as used.
        ...((method === 'move' || method === 'handoff') && moveUsed !== false ? { moveUsed: true } : {}),
      });
    }
    return true;
  }

  /** Never over a file that could not be read. A failed write is logged; logins go on. */
  private saveSessions(): void {
    if (!this.sessionFile || this.sessionFileBroken) return;
    const now = Date.now();
    const sessions = [...this.sessions.values()]
      .filter((s) => s.expiresAt > now)
      .map(({ shellProofAt: _proof, shellProofBy: _by, shellPasskeyId: _passkey, arrival: _arrival, ...s }) => s);
    try {
      writeJsonAtomic(this.sessionFile, { v: 1, sessions } satisfies SessionFile);
    } catch (err) {
      console.warn(`[cld auth] could not write ${this.sessionFile}: ${String(err)}`);
    }
  }

  private newShortCode(): string {
    for (;;) {
      const code = crypto.randomInt(0, 100_000_000).toString().padStart(8, '0');
      if (!this.codes.has(code)) return code;
    }
  }
}

/**
 * What sessions.json keeps of a cookie value: its SHA-256. The value is 256
 * random bits, so the hash needs no salt and can't be turned back into it.
 */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('base64url');
}

const TOKEN_HASH = /^[A-Za-z0-9_-]{43}$/;

function isSessionFile(data: unknown): data is SessionFile {
  const file = data as SessionFile | null;
  return (
    file?.v === 1 &&
    Array.isArray(file.sessions) &&
    file.sessions.every(
      (s: Session | null) =>
        typeof s?.hash === 'string' &&
        TOKEN_HASH.test(s.hash) &&
        typeof s.handle === 'string' &&
        typeof s.method === 'string' &&
        typeof s.label === 'string' &&
        (s.deviceId === undefined || typeof s.deviceId === 'string') &&
        (s.nickname === undefined || typeof s.nickname === 'string') &&
        (s.kind === undefined || ['phone', 'tablet', 'desktop', 'unknown'].includes(s.kind)) &&
        (s.lifetime === undefined || s.lifetime === 'lan') &&
        [s.createdAt, s.lastSeen, s.expiresAt].every(Number.isFinite),
    )
  );
}

/** Codes are typed as "1234 5678": whitespace never matters. */
export function normalizeCode(code: string): string {
  return code.replace(/\s+/g, '');
}

export function isShortCode(code: string): boolean {
  return /^\d{8}$/.test(normalizeCode(code));
}

/** "1234 5678" */
export function formatShortCode(code: string): string {
  return `${code.slice(0, 4)} ${code.slice(4)}`;
}

/** A short device name from a User-Agent, e.g. "iPhone · Safari". */
export function deviceName(userAgent: string | undefined): string {
  const ua = userAgent ?? '';
  const os =
    [
      [/iPhone/, 'iPhone'],
      [/iPad/, 'iPad'],
      [/Android/, 'Android'],
      [/Windows/, 'Windows'],
      [/Macintosh|Mac OS X/, 'Mac'],
      [/Linux|X11/, 'Linux'],
    ].find(([re]) => (re as RegExp).test(ua))?.[1] ?? koText('device_browser');
  const browser = [
    [/Edg\//, 'Edge'],
    [/Firefox\//, 'Firefox'],
    [/CriOS|Chrome\//, 'Chrome'],
    [/Safari\//, 'Safari'],
  ].find(([re]) => (re as RegExp).test(ua))?.[1];
  return browser ? `${os} · ${browser}` : String(os);
}

/** O2: broad form factor from the same User-Agent used for `deviceName`. */
export function deviceKind(userAgent: string | undefined): DeviceKind {
  const ua = userAgent ?? '';
  if (
    /iPad/i.test(ua) ||
    (/Android/i.test(ua) && (/\b(?:Tablet|SM-T|Nexus (?:7|9|10))\b/i.test(ua) || !/Mobile/i.test(ua)))
  )
    return 'tablet';
  if (/iPhone|Android/i.test(ua)) return 'phone';
  if (/Windows|Macintosh|Mac OS X|Linux|X11|CrOS/i.test(ua)) return 'desktop';
  return 'unknown';
}

/** O2: a stored browser origin's connection path. Never resolves a name. */
export function devicePath(origin: string | undefined): DevicePath {
  let host: string;
  try {
    host = new URL(origin ?? '')
      .hostname.toLowerCase()
      .replace(/^\[|\]$/g, '')
      .replace(/\.$/, '');
  } catch {
    return 'remote';
  }
  if (host === 'localhost' || host === '::1' || /^127\./.test(host)) return 'local';
  if (host.endsWith('.ts.net') || ipv4InRange(host, 100, 64, 127)) return 'tailscale';
  if (
    host.endsWith('.local') ||
    ipv4InRange(host, 10, 0, 255) ||
    ipv4InRange(host, 192, 168, 168) ||
    ipv4InRange(host, 172, 16, 31)
  )
    return 'lan';
  return 'remote';
}

function ipv4InRange(host: string, first: number, secondMin: number, secondMax: number): boolean {
  const parts = host.split('.').map(Number);
  return (
    parts.length === 4 &&
    parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) &&
    parts[0] === first &&
    parts[1] >= secondMin &&
    parts[1] <= secondMax
  );
}

/** C0/C1 controls, and what hides or reorders text: bidi controls and isolates, zero-width characters, line and paragraph separators, BOM. */
const HIDDEN_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/;

/** O1: a device nickname -- trimmed, 1-40 characters, no control or invisible characters; null when it is none of that. */
export function validNickname(raw: unknown): string | null {
  if (typeof raw !== 'string' || HIDDEN_CHARACTERS.test(raw)) return null;
  const name = raw.trim();
  const length = [...name].length;
  return length >= 1 && length <= 40 ? name : null;
}

/** A label a client typed: one line, no control characters, at most 40 characters. */
export function cleanLabel(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const label = [...raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim()].slice(0, 40).join('');
  return label || fallback;
}

/** Build the cookie sent after code or trusted-Tailscale authentication. */
export function sessionCookie(sessionId: string, secure: boolean, lifetime?: SessionLifetime): string {
  return [
    `cld_session=${encodeURIComponent(sessionId)}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${(lifetime === 'lan' ? LAN_SESSION_TTL_MS : SESSION_TTL_MS) / 1000}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

export function sessionIdFromCookie(cookie: string | undefined): string | undefined {
  if (!cookie) return undefined;
  for (const part of cookie.split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === 'cld_session') {
      try {
        return decodeURIComponent(value.join('='));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export function requestIsHttps(forwardedProto: string | undefined): boolean {
  return forwardedProto?.split(',')[0]?.trim().toLowerCase() === 'https';
}

// ── Public (Funnel) requests ────────────────────────────────────

/**
 * True when Tailscale Funnel brought this request in from the internet.
 *
 * tailscaled's HTTP proxy first deletes any client-sent Tailscale-User-Login,
 * -User-Name, -User-Profile-Pic, Tailscale-Funnel-Request and
 * Tailscale-Headers-Info; then it sets `Tailscale-Funnel-Request: ?1` on
 * Funnel traffic (and no identity), and the identity headers on tailnet
 * traffic only (tailscale v1.104.2, ipn/ipnlocal/serve.go,
 * addTailscaleIdentityHeaders). A public request never gets the Tailscale
 * auto-login and never authenticates with the host's Bearer token.
 *
 * Only the HTTP proxy does this. Funnel in TCP mode (`--tcp`,
 * `--tls-terminated-tcp`) passes client headers through untouched, so it must
 * never front this server.
 */
export function isFunnelRequest(headers: IncomingHttpHeaders): boolean {
  return headers['tailscale-funnel-request'] !== undefined;
}

/** The TCP peer is this machine: how `tailscale serve` reaches a 127.0.0.1 backend. */
export function isLoopbackPeer(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

/** Sockets of the direct connector's public TLS listener (remote/direct.ts adds them). */
export const directSockets = new WeakSet<object>();

/**
 * Sockets of every other listener that serves outsiders (the LAN listener,
 * remote/index.ts adds them). T-0074: Windows portproxy plus WSL's localhost
 * forwarding hand the internet's connections over from 127.0.0.1, so what a
 * request is comes from the listener it arrived on, never from its peer.
 */
export const publicSockets = new WeakSet<object>();

/** This request came in on the direct connector's public listener (the internet). */
export function isDirectRequest(socket: object | undefined): boolean {
  return socket !== undefined && directSockets.has(socket);
}

/** It came in on a listener that serves outsiders, whatever its peer address says. */
export function isPublicListener(socket: object | undefined): boolean {
  return socket !== undefined && (directSockets.has(socket) || publicSockets.has(socket));
}

/** Plain HTTP on the LAN listener: marked from the accepting socket, never headers. */
export function isLanRequest(socket: object | undefined): boolean {
  return isPublicListener(socket) && !isDirectRequest(socket) && !(socket as { encrypted?: boolean } | undefined)?.encrypted;
}

/**
 * Trusted vs public (T-0024, T-0074). Public: a Funnel request, anything on a
 * public listener (direct, LAN) whatever its peer, and every non-loopback
 * peer (`--host 0.0.0.0`). A public request never auto-logs in, never uses
 * the host token and is rate-limited. Trusted is only a loopback peer on the
 * loopback listener: this machine itself, or tailscaled's `serve` proxy,
 * which alone may carry a tailnet identity.
 */
export function isPublicRequest(
  headers: IncomingHttpHeaders,
  socket: { remoteAddress?: string } | undefined,
): boolean {
  return (
    isFunnelRequest(headers) || isPublicListener(socket) || !isLoopbackPeer(socket?.remoteAddress)
  );
}

/**
 * This PC's own browser (S1): a trusted request that names localhost and
 * carries no proxy header. Everything else is remote -- a tailscale serve
 * proxy is a loopback peer too, which is why the headers count.
 */
export function isLocalRequest(request: {
  headers: IncomingHttpHeaders;
  socket: { remoteAddress?: string };
}): boolean {
  const { headers } = request;
  return (
    !isPublicRequest(headers, request.socket) &&
    /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(headers.host ?? '') &&
    !headers['x-forwarded-for'] &&
    !headers['x-forwarded-proto']
  );
}

/**
 * The client the rate limits count. Behind `tailscale serve` (a loopback peer)
 * it is the X-Forwarded-For tailscaled sets: Go's ReverseProxy drops any
 * client-sent one before tailscaled's Rewrite adds the real source address
 * (serve.go addProxyForwardedHeaders). Otherwise it is the TCP peer. On a
 * public listener it is the peer in a bucket of that listener's own: behind
 * a portproxy every outsider is 127.0.0.1, and their failures must not lock
 * out the host's own loopback logins.
 */
export function clientAddress(
  peer: string | undefined,
  forwardedFor: string | undefined,
  publicListener = false,
): string {
  if (publicListener) return `listener:${peer ?? 'unknown'}`;
  const forwarded = forwardedFor?.split(',').at(-1)?.trim();
  return isLoopbackPeer(peer) && forwarded ? forwarded : (peer ?? 'unknown');
}

/** Login codes stay out of the request log, like the server token. */
export function redactLoginCode(url: string): string {
  return url.replace(/([?&]code=)[^&#]*/g, '$1[redacted]');
}

// ── Rate limits ─────────────────────────────────────────────────

export interface LimitPolicy {
  /** Failures within one window that block the key. */
  failures: number;
  windowMs: number;
  blockMs: number;
}

/** Per client and per code: 10 failures a minute, then 5 minutes blocked. */
export const AUTH_LIMIT: LimitPolicy = { failures: 10, windowMs: 60_000, blockMs: 5 * 60_000 };
/** A logged-in session's nonces: 30 a minute, then a minute's pause (a page with many terminal panes). */
export const SESSION_CHALLENGE_LIMIT: LimitPolicy = { failures: 30, windowMs: 60_000, blockMs: 60_000 };
/** All clients together, short codes only: 20 failures in 10 minutes, then 10 minutes locked. */
export const SHORT_CODE_LOCK: LimitPolicy = {
  failures: 20,
  windowMs: 10 * 60_000,
  blockMs: 10 * 60_000,
};
/**
 * The direct listener, all clients and all code kinds together: 10 failures in
 * an hour lock code logins there for an hour. Only invited devices know its
 * secret path, so a failure there is rare; the LAN, links already opened and
 * device keys keep working.
 */
export const DIRECT_CODE_LOCK: LimitPolicy = {
  failures: 10,
  windowMs: 60 * 60_000,
  blockMs: 60 * 60_000,
};
const AUTH_LIMITER_MAX_KEYS = 10_000;

interface Failures {
  /** Failure times inside the sliding window. */
  times: number[];
  blockedUntil: number;
}

export const ipKey = (address: string) => `ip:${address}`;
/** Hashed: a client chooses the code string, so keep only a fixed-size digest. */
export const codeKey = (code: string) =>
  `code:${crypto.createHash('sha256').update(normalizeCode(code)).digest('base64url')}`;

/**
 * Failed attempts on the auth endpoints, per key: the policy's Nth failure
 * inside a sliding window blocks that key. While a key is blocked every
 * attempt gets the same refusal, right or wrong, and a blocked code is not
 * consumed, so a block tells a guesser nothing about a code.
 */
export class AuthLimiter {
  private readonly failures = new Map<string, Failures>();

  constructor(private readonly policy: LimitPolicy = AUTH_LIMIT) {}

  blocked(keys: readonly string[], now = Date.now()): boolean {
    return keys.some((key) => (this.failures.get(key)?.blockedUntil ?? 0) > now);
  }

  /** Count one failure per key; true when this one blocked a key. */
  fail(keys: readonly string[], now = Date.now()): boolean {
    let tripped = false;
    for (const key of keys) {
      const entry = this.failures.get(key) ?? { times: [], blockedUntil: 0 };
      entry.times = entry.times.filter((t) => now - t < this.policy.windowMs);
      entry.times.push(now);
      if (entry.times.length >= this.policy.failures) {
        entry.blockedUntil = now + this.policy.blockMs;
        entry.times = [];
        tripped = true;
      }
      // Re-insert so the Map's order is least recently failed first.
      this.failures.delete(key);
      this.failures.set(key, entry);
    }
    // ponytail: oldest-first eviction past 10k keys; an attacker with more
    // addresses than that is not slowed by per-address limits anyway.
    for (const key of this.failures.keys()) {
      if (this.failures.size <= AUTH_LIMITER_MAX_KEYS) break;
      this.failures.delete(key);
    }
    return tripped;
  }
}
