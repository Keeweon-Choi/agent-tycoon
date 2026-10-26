/**
 * Web Push (T-0039, FR-NTF-001/002/004/006, IR-PUSH-001): the daemon tells a
 * device about a turn end, a question or permission ask, or a finished job
 * while that device has no visible client open.
 *
 * - push.json (~/.config/agent-tycoon, 0600, write-then-rename): the VAPID keys,
 *   made once, and one subscription per device (its device-key id, else its
 *   session handle). Unreadable: kept as it is, logged, push off.
 * - Messages are encrypted for the subscription (RFC 8291 aes128gcm) and
 *   signed with VAPID (RFC 8292, ES256, `sub` the public host's https origin, else a mailto: address), with
 *   node:crypto alone. The payload is title, body, character id and url;
 *   never transcript text.
 * - One POST to the subscription's https endpoint, with a timeout and no
 *   retry; 404/410 removes the subscription. Endpoints are capability URLs:
 *   never logged.
 * - Same rules as the screen (core/src/cld/notices.ts): per device, its kinds,
 *   orchestrator-only turn ends unless asked, the 5-minute cooldown.
 * - U-49: a turn that ends with text the agent wrote to the user is pushed AS that message
 *   (title the sender, body a masked preview), in place of the generic turn-end push, never held
 *   back by the burst window or the cooldown (its tag makes the newest replace the one shown).
 *   Only that preview of the last assistant text leaves the machine: never tool output or private
 *   thinking (the "updates"-mode lines a lead shows its user mid-turn count as its words, as in the messenger).
 */
import * as crypto from 'crypto';

import {
  CAUSE_TEXT,
  DEVICE_ICON,
  DEVICE_PUSH_KIND,
  DEVICE_PUSH_TITLE,
  DEVICE_PUSH_VIA,
  NOTICE_ICON,
  type NoticeCause,
  type NoticeKind,
  type NoticeTarget,
  noticeTarget,
  noticeUrl,
  noticeVerdict,
  PUSH_TIME_MARK,
  pushTag,
} from '../../../core/src/cld/notices.js';
import { koText, textIn, type TextLang } from '../../../core/src/cld/serverText.js';
import { staffName } from '../../../core/src/cld/staffNames.js';
import { LOOKING_FRESH_MS } from '../../../core/src/constants.js';
import type { AgentStateStore } from '../agentStateStore.js';
import { cleanAuditText } from './audit.js';
import type { DeviceEvent, StandaloneAuth } from './auth.js';
import type { WsSend } from './hooks.js';
import { readJson, writeJsonAtomic } from './jsonFile.js';
import { maskText } from './mask.js';
import type { RoomRef } from './transcriptView.js';

/** One push request may take this long; then it is dropped (no retry). */
export const PUSH_TIMEOUT_MS = 10_000;
/** How long the push service may hold a message for an offline device. */
export const PUSH_TTL_SEC = 3600;
/** VAPID JWTs live this long (RFC 8292 caps it at 24 h). */
const VAPID_JWT_SEC = 12 * 3600;
/** IR-PUSH-001: the subject with no public host: a mailto: address (never a person's). push.json's `subject` replaces it. */
export const DEFAULT_PUSH_SUBJECT = 'mailto:cld-gui@localhost';
const RECORD_SIZE = 4096;
/** Turn ends to one device closer together than this are one buzz (asks and job ends are never held). */
export const PUSH_COALESCE_MS = 10_000;
/** A "nobody to push to" line at most this often; the events in between are counted in it. */
export const PUSH_SKIP_LOG_MS = 10 * 60_000;
const KINDS: readonly NoticeKind[] = ['turnEnd', 'attention', 'job', 'reply'];
const ENDPOINT_MAX = 2048;
/** U-49: a message's body is at most this many characters (a notification is a glance, not the text). */
export const PUSH_PREVIEW_MAX = 120;
/** U-49: the same message from the same sender again within this is one turn's end reported twice (a hook and the idle timer), not a new message. */
export const PUSH_REPEAT_MS = 30_000;
/** U-49: the counters in push.json are written at most this often (cld-gui doctor reads them). */
const STATS_SAVE_MS = 60_000;

export interface PushSubscriptionRow {
  /** The device-list row: a device-key id, or a session handle. */
  device: string;
  endpoint: string;
  /** base64url: the 65-byte P-256 public key, the 16-byte auth secret. */
  p256dh: string;
  auth: string;
  /** The kinds that were on when it was saved. */
  kinds: NoticeKind[];
  /**
   * U-49: the kinds the user turned off. ABSENT = a row saved before `reply` existed: its `kinds`
   * is the whole truth for the kinds it knew (an old "turn ends off" stays off) and `reply` is on
   * until the user turns 메시지 off. PRESENT (every client that knows `reply` sends it, even
   * empty) = a kind is off only if listed here: "absent = on", like core NoticeRules.
   */
  off?: NoticeKind[];
  subagents: boolean;
  /** FR-NTF-006: turn ends of remote-control orchestrators too (absent: yes). */
  remoteTurnEnds?: boolean;
  /** I1: the language the device reads; its pushes are worded in it (absent: Korean). */
  lang?: TextLang;
  createdAt: number;
}

interface Vapid {
  /** base64url uncompressed P-256 point (the browser's applicationServerKey). */
  publicKey: string;
  /** JWK of the private key. */
  privateKey: crypto.webcrypto.JsonWebKey;
}

interface PushFile {
  vapid: Vapid;
  subject?: string;
  subscriptions: PushSubscriptionRow[];
  /** U-49: counters of what went out and what was left (`sent.reply`, `skipped.reply.looking`, ...); numbers only. */
  stats?: Record<string, number>;
}

/** Whether a device wants a kind (see PushSubscriptionRow.off). */
export function kindOn(row: Pick<PushSubscriptionRow, 'kinds' | 'off'>, kind: NoticeKind): boolean {
  return row.off ? !row.off.includes(kind) : kind === 'reply' || row.kinds.includes(kind);
}

/**
 * U-49: the body of a message push from the turn's last assistant text: secrets masked first
 * (mask.ts works per line, so before the whitespace is folded), then folded to one line and cut
 * to PUSH_PREVIEW_MAX characters. null: nothing to say (the generic turn-end push stays).
 */
export function replyPreview(text: string | null): string | null {
  if (!text) return null;
  const chars = [...maskText(text).replace(/\s+/g, ' ').trim()];
  if (!chars.length) return null;
  return chars.length > PUSH_PREVIEW_MAX
    ? `${chars.slice(0, PUSH_PREVIEW_MAX - 1).join('')}…`
    : chars.join('');
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const unb64 = (s: string) => Buffer.from(s, 'base64url');

function newVapid(): Vapid {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = privateKey.export({ format: 'jwk' });
  return {
    publicKey: b64url(Buffer.concat([Buffer.from([4]), unb64(jwk.x!), unb64(jwk.y!)])),
    privateKey: jwk,
  };
}

function isPushFile(v: unknown): v is PushFile {
  const f = v as PushFile;
  return (
    !!f &&
    typeof f === 'object' &&
    typeof f.vapid?.publicKey === 'string' &&
    typeof f.vapid?.privateKey?.d === 'string' &&
    Array.isArray(f.subscriptions)
  );
}

/** push.json: VAPID keys and subscriptions. `available` false = push off. */
export class PushStore {
  private data: PushFile | null = null;

  /**
   * `publicHost`: the daemon's first `--allowed-host`; its https origin is then the VAPID
   * subject (RFC 8292 takes mailto: or https:), unless push.json names one.
   */
  constructor(
    private readonly file: string,
    private readonly publicHost?: string,
  ) {
    let raw: unknown;
    try {
      raw = readJson(file);
    } catch (err) {
      console.warn(`[cld push] ${file} could not be read, push off (file kept): ${errText(err)}`);
      return;
    }
    if (raw === null) {
      this.data = { vapid: newVapid(), subscriptions: [] };
      this.save();
    } else if (isPushFile(raw)) {
      this.data = raw;
    } else {
      console.warn(`[cld push] ${file} is not a push file, push off (file kept)`);
    }
  }

  get available(): boolean {
    return this.data !== null;
  }
  get vapid(): Vapid | null {
    return this.data?.vapid ?? null;
  }
  get subject(): string {
    return (
      this.data?.subject ?? (this.publicHost ? `https://${this.publicHost}` : DEFAULT_PUSH_SUBJECT)
    );
  }
  list(): readonly PushSubscriptionRow[] {
    return this.data?.subscriptions ?? [];
  }
  get(device: string): PushSubscriptionRow | undefined {
    return this.list().find((s) => s.device === device);
  }

  /** The device's subscription, replacing its previous one. */
  set(row: PushSubscriptionRow): void {
    if (!this.data) return;
    this.data.subscriptions = [
      ...this.data.subscriptions.filter(
        (s) => s.device !== row.device && s.endpoint !== row.endpoint,
      ),
      row,
    ];
    this.save();
  }

  get stats(): Readonly<Record<string, number>> {
    return this.data?.stats ?? {};
  }
  /** U-49: replace the counters (saved with the file). */
  setStats(stats: Record<string, number>): void {
    if (!this.data) return;
    this.data.stats = stats;
    this.save();
  }

  /** Forget subscriptions matching `drop`; true when one went. */
  removeWhere(drop: (s: PushSubscriptionRow) => boolean): boolean {
    if (!this.data) return false;
    const kept = this.data.subscriptions.filter((s) => !drop(s));
    if (kept.length === this.data.subscriptions.length) return false;
    this.data.subscriptions = kept;
    this.save();
    return true;
  }

  private save(): void {
    try {
      writeJsonAtomic(this.file, this.data);
    } catch (err) {
      console.warn(`[cld push] could not save ${this.file}: ${errText(err)}`);
    }
  }
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

// ── RFC 8291 / 8292 ───────────────────────────────────────────

const hkdf = (ikm: Buffer, salt: Buffer, info: Buffer | string, len: number) =>
  Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from(info), len));

/**
 * RFC 8291 aes128gcm body for one subscription: header (salt, record size,
 * the sender's public key) and one record. `salt`/`sender` only for the
 * RFC's test vector.
 */
export function encryptPayload(
  plaintext: Buffer,
  p256dh: Buffer,
  authSecret: Buffer,
  test?: { salt: Buffer; sender: crypto.ECDH },
): Buffer {
  const sender = test?.sender ?? crypto.createECDH('prime256v1');
  if (!test) sender.generateKeys();
  const senderPublic = sender.getPublicKey();
  const shared = sender.computeSecret(p256dh);
  const ikm = hkdf(
    shared,
    authSecret,
    Buffer.concat([Buffer.from('WebPush: info\0'), p256dh, senderPublic]),
    32,
  );
  const salt = test?.salt ?? crypto.randomBytes(16);
  const cek = hkdf(ikm, salt, 'Content-Encoding: aes128gcm\0', 16);
  const nonce = hkdf(ikm, salt, 'Content-Encoding: nonce\0', 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const record = Buffer.concat([
    cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), // 2: the last record
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(senderPublic.length, 20);
  return Buffer.concat([header, senderPublic, record]);
}

/** RFC 8292 Authorization header for `endpoint`'s push service. */
export function vapidAuthorization(
  endpoint: string,
  vapid: Vapid,
  subject: string,
  now = Date.now(),
): string {
  const head = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64url(
    JSON.stringify({
      aud: new URL(endpoint).origin,
      exp: Math.floor(now / 1000) + VAPID_JWT_SEC,
      sub: subject,
    }),
  );
  const key = crypto.createPrivateKey({ key: vapid.privateKey, format: 'jwk' });
  const sig = crypto.sign('sha256', Buffer.from(`${head}.${claims}`), {
    key,
    dsaEncoding: 'ieee-p1363',
  });
  return `vapid t=${head}.${claims}.${b64url(sig)}, k=${vapid.publicKey}`;
}

/** What a device is shown: no transcript text, ever. */
export interface PushPayload {
  title: string;
  body: string;
  agentId: number | null;
  url: string;
  /** The notification's tag: the same event again replaces the one shown. */
  tag: string;
  /** When it happened: the service worker fills it into the body's time mark. */
  at?: number;
}

export type PushResult = 'sent' | 'gone' | 'failed';

/** One POST, no retry. */
export async function sendPush(
  sub: Pick<PushSubscriptionRow, 'endpoint' | 'p256dh' | 'auth'>,
  payload: PushPayload,
  vapid: Vapid,
  subject: string,
  fetchFn: typeof fetch = fetch,
): Promise<PushResult> {
  if (!isHttpsUrl(sub.endpoint)) return 'failed';
  try {
    const res = await fetchFn(sub.endpoint, {
      method: 'POST',
      headers: {
        TTL: String(PUSH_TTL_SEC),
        Urgency: 'normal',
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        Authorization: vapidAuthorization(sub.endpoint, vapid, subject),
      },
      body: new Uint8Array(
        encryptPayload(Buffer.from(JSON.stringify(payload)), unb64(sub.p256dh), unb64(sub.auth)),
      ),
      redirect: 'error',
      signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
    });
    if (res.status === 404 || res.status === 410) return 'gone';
    if (res.ok) return 'sent';
    console.warn(`[cld push] push service answered ${res.status}`);
    return 'failed';
  } catch (err) {
    console.warn(`[cld push] push failed: ${err instanceof Error ? err.name : 'error'}`);
    return 'failed';
  }
}

function isHttpsUrl(s: string): boolean {
  try {
    return new URL(s).protocol === 'https:';
  } catch {
    return false;
  }
}

/** A pushSubscribe's fields, checked; null when malformed. */
export function parsePushSubscribe(
  msg: Record<string, unknown>,
): Pick<
  PushSubscriptionRow,
  'endpoint' | 'p256dh' | 'auth' | 'kinds' | 'off' | 'subagents' | 'remoteTurnEnds' | 'lang'
> | null {
  const { endpoint, p256dh, auth, kinds, kindsOff, subagents, remoteTurnEnds, lang } = msg;
  if (typeof endpoint !== 'string' || endpoint.length > ENDPOINT_MAX || !isHttpsUrl(endpoint))
    return null;
  if (typeof p256dh !== 'string' || typeof auth !== 'string') return null;
  const key = unb64(p256dh);
  if (key.length !== 65 || key[0] !== 4 || unb64(auth).length !== 16) return null;
  if (!Array.isArray(kinds) || typeof subagents !== 'boolean') return null;
  if (remoteTurnEnds !== undefined && typeof remoteTurnEnds !== 'boolean') return null;
  if (kindsOff !== undefined && !Array.isArray(kindsOff)) return null;
  return {
    endpoint,
    p256dh,
    auth,
    kinds: KINDS.filter((k) => kinds.includes(k)),
    ...(kindsOff && { off: KINDS.filter((k) => kindsOff.includes(k)) }),
    subagents,
    remoteTurnEnds: remoteTurnEnds !== false,
    ...(lang === 'en' && { lang }),
  };
}

// ── The service ───────────────────────────────────────────────

/** What a turn end's push needs to know of the turn that ended. */
export interface TurnInfo {
  room: RoomRef | null;
  text: string | null;
}

export interface PushServiceOptions {
  store: PushStore;
  agents: AgentStateStore;
  /**
   * When this socket's page last reported "showing" (T-0025 visibility, repeated while it shows,
   * U-49); null when it is hidden or not a viewer. A device is looking only through a page that
   * said so within LOOKING_FRESH_MS: a suspended phone page keeps its socket but stops reporting.
   */
  lookedAt(send: WsSend): number | null;
  /** Character `id`'s name and kind ('teammate' and 'subagent' are noise for turn ends). */
  describe(id: number): {
    name: string;
    who: string;
    remote?: boolean;
    /** T-0043: it is a lead (its notice opens its conversation); its session is a background one. */
    lead?: boolean;
    background?: boolean;
  } | null;
  /** The character of a project (a feed event names it). */
  agentIdOf(name: string): number | null;
  /**
   * Character `id`'s newest turn: the room whose post it answers (C3; null: a one-to-one turn) and
   * the text of its last assistant message (U-49; null: none). A turn end of a room turn notifies
   * the room, never the character's conversation. Asked only when a push has someone to go to;
   * may answer later (a transcript read).
   */
  turn?(id: number): TurnInfo | Promise<TurnInfo>;
  fetchFn?: typeof fetch;
}

/**
 * Who is connected from which device, the subscriptions' messages, and the
 * pushes: listens to the office's broadcasts (agentStatus waiting,
 * agentToolPermission, officeEvent job_end/codex_end).
 */
export class PushService {
  private readonly deviceOf = new Map<WsSend, string>();
  /** device -> kind:target -> when it last went out (the cooldown). */
  private readonly last = new Map<string, Map<string, number>>();
  /** device -> when its last turn-end push went out (the burst window). */
  private readonly lastTurnEnd = new Map<string, number>();
  private skipped = 0;
  private skipLoggedAt = -Infinity;
  /** tag -> the last message pushed under it (PUSH_REPEAT_MS). */
  private readonly lastReply = new Map<string, { body: string; at: number }>();
  private stats: Record<string, number>;
  private statsTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly onBroadcast = (m: Record<string, unknown>) => this.broadcast(m);

  constructor(private readonly opts: PushServiceOptions) {
    this.stats = { ...opts.store.stats };
    opts.agents.on('broadcast', this.onBroadcast);
  }

  dispose(): void {
    this.opts.agents.off('broadcast', this.onBroadcast);
    if (this.statsTimer) {
      clearTimeout(this.statsTimer);
      this.statsTimer = null;
      this.opts.store.setStats(this.stats);
    }
  }

  /** U-49: what went out and what was left, for `cld-gui doctor` (push.json, at most once a minute). */
  private count(key: string): void {
    this.stats[key] = (this.stats[key] ?? 0) + 1;
    if (this.statsTimer) return;
    this.statsTimer = setTimeout(() => {
      this.statsTimer = null;
      this.opts.store.setStats(this.stats);
    }, STATS_SAVE_MS);
    this.statsTimer.unref();
  }

  /** A device or session is gone: its subscription goes with it. */
  useAuth(auth: StandaloneAuth): void {
    // Composed, never replaced: a revoke must still end that device's shells (T-0052).
    const previous = auth.onRowGone;
    auth.onRowGone = (id) => {
      previous?.(id);
      if (this.opts.store.removeWhere((s) => s.device === id))
        console.log('[cld push] subscription of a revoked device removed');
    };
    // O3: composed too; the toast and the audit line stay where they are.
    const previousEvent = auth.onDeviceEvent;
    auth.onDeviceEvent = (event) => {
      previousEvent?.(event);
      this.notifyDevice(event);
    };
  }

  /**
   * O3 (T16): a device came in. Every OTHER subscribed device is told, whatever
   * its notice settings, cooldown or visible page say, and the new device's own
   * subscription (under its device id or the session it came through) never is.
   * Nothing the new device sent is in the text but its masked name.
   */
  notifyDevice(event: DeviceEvent): void {
    const { store } = this.opts;
    const vapid = store.vapid;
    if (!vapid) return;
    const payload = (lang: TextLang): PushPayload => ({
      title: `${DEVICE_ICON} ${textIn(lang, DEVICE_PUSH_TITLE[event.event] ?? DEVICE_PUSH_TITLE.new)}: ${cleanAuditText(event.label)}`,
      body: [
        textIn(lang, DEVICE_PUSH_KIND[event.kind] ?? DEVICE_PUSH_KIND.unknown),
        PUSH_TIME_MARK,
        ...(event.via && DEVICE_PUSH_VIA[event.via] ? [textIn(lang, DEVICE_PUSH_VIA[event.via])] : []),
      ].join(' · '),
      agentId: null,
      url: noticeUrl({ open: 'security' }),
      // One per event: a later notice never replaces this one in the tray.
      tag: `device:${event.id}:${event.at}`,
      at: event.at,
    });
    for (const sub of store.list()) {
      // A new device's own row is never told. For a replaced key or an added passkey the row IS the
      // device that already existed (its old browser, or a stolen cookie's victim): only the session
      // that just did it is left out.
      if (event.handle !== undefined && sub.device === event.handle) continue;
      if (sub.device === event.id && (event.event === 'new' || event.event === 'unknown')) continue;
      void sendPush(sub, payload(sub.lang ?? 'ko'), vapid, store.subject, this.opts.fetchFn).then((result) => {
        if (result === 'gone' && store.removeWhere((s) => s.endpoint === sub.endpoint))
          console.log('[cld push] subscription expired at the push service: removed');
      });
    }
  }

  opened(send: WsSend, device: string | undefined): void {
    if (device) this.deviceOf.set(send, device);
  }
  closed(send: WsSend): void {
    this.deviceOf.delete(send);
  }

  ready(send: WsSend): void {
    send({ ...this.state(send) });
  }

  private state(send: WsSend, error: string | null = null) {
    const { store } = this.opts;
    const device = this.deviceOf.get(send);
    return {
      type: 'pushState',
      available: store.available && device !== undefined,
      publicKey: store.vapid?.publicKey ?? null,
      subscribed: device !== undefined && store.get(device) !== undefined,
      error,
    };
  }

  /** pushSubscribe / pushUnsubscribe; false for any other message. */
  onClientMessage(msg: Record<string, unknown>, send: WsSend, privileged: boolean): boolean {
    if (msg.type !== 'pushSubscribe' && msg.type !== 'pushUnsubscribe') return false;
    const device = this.deviceOf.get(send);
    const { store } = this.opts;
    if (!privileged || !device || !store.available) {
      send(this.state(send, koText('push_not_allowed')));
      return true;
    }
    if (msg.type === 'pushUnsubscribe') {
      store.removeWhere((s) => s.device === device);
      send(this.state(send));
      return true;
    }
    const sub = parsePushSubscribe(msg);
    if (!sub) {
      console.warn('[cld push] malformed pushSubscribe dropped');
      send(this.state(send, koText('push_registration_invalid')));
      return true;
    }
    store.set({ ...sub, device, createdAt: Date.now() });
    console.log('[cld push] a device subscribed');
    send(this.state(send));
    return true;
  }

  /** Devices with a Web Push subscription (the device list shows it). */
  subscribedDevices(): ReadonlySet<string> {
    return new Set(this.opts.store.list().map((s) => s.device));
  }

  /** A notice that had nobody to go to: one log line per PUSH_SKIP_LOG_MS, counting the rest. */
  private noteSkipped(reason: string, now: number): void {
    this.skipped++;
    if (now - this.skipLoggedAt < PUSH_SKIP_LOG_MS) return;
    console.warn(`[cld push] ${this.skipped} notice(s) not pushed: ${reason}`);
    this.skipped = 0;
    this.skipLoggedAt = now;
  }

  private deviceVisible(device: string, now: number): boolean {
    for (const [send, d] of this.deviceOf) {
      if (d !== device) continue;
      const at = this.opts.lookedAt(send);
      if (at !== null && now - at < LOOKING_FRESH_MS) return true;
    }
    return false;
  }

  private broadcast(m: Record<string, unknown>): void {
    if (m.type === 'agentStatus' && m.status === 'waiting' && typeof m.id === 'number') {
      this.notifyAgent(m.id, m.awaitingInput === true ? 'question' : 'turnEnd');
    } else if (m.type === 'agentToolPermission' && typeof m.id === 'number') {
      // PERM-PROMPT: a sub-agent's dialog names it (its staff name).
      this.notifyAgent(m.id, 'permission', typeof m.asker === 'string' ? m.asker : undefined);
    } else if (
      m.type === 'officeEvent' &&
      (m.kind === 'job_end' || m.kind === 'codex_end' || m.kind === 'orch_giveup') &&
      typeof m.summary === 'string'
    ) {
      const name = typeof m.name === 'string' ? m.name : koText('work_default');
      const event = { kind: m.kind, ref: typeof m.ref === 'string' ? m.ref : null };
      const agentId = this.opts.agentIdOf(name);
      this.notify('job', agentId, name, m.summary, 'orchestrator', false, Date.now(), {
        // T-0091: the engine gave up on a session: its character, not a job.
        target:
          m.kind === 'orch_giveup'
            ? agentId === null
              ? { open: 'office' }
              : { open: 'agent', agentId }
            : noticeTarget({ cause: 'job', agentId, event }),
      });
    }
  }

  private notifyAgent(
    id: number,
    cause: Exclude<NoticeCause, 'job' | 'reply'>,
    asker?: string,
  ): void {
    const d = this.opts.describe(id);
    if (!d) return;
    const now = Date.now();
    if (asker) {
      // ponytail: the Korean staff name in every language (textIn swaps the words around it).
      const text = koText('cause_permission_sub', { sub: staffName(asker, 'ko') });
      return this.deliverTurnEnd(id, d, cause, now, null, undefined, text);
    }
    const none: TurnInfo = { room: null, text: null };
    const turn = cause === 'turnEnd' && this.hasAudience() ? (this.opts.turn?.(id) ?? none) : none;
    if (turn instanceof Promise) {
      void turn.then(
        (r) => this.deliverAgent(id, d, cause, now, r),
        () => this.deliverAgent(id, d, cause, now, none),
      );
      return;
    }
    this.deliverAgent(id, d, cause, now, turn);
  }

  /** Someone could be pushed to at all (checked before any transcript is read for a turn end). */
  private hasAudience(): boolean {
    const { store } = this.opts;
    return store.vapid !== null && store.list().length > 0;
  }

  private deliverAgent(
    id: number,
    d: NonNullable<ReturnType<PushServiceOptions['describe']>>,
    cause: Exclude<NoticeCause, 'job' | 'reply'>,
    now: number,
    { room, text }: TurnInfo,
  ): void {
    // U-49: a turn that ended with text for the user is that message, in place of the generic
    // turn end (one buzz). Asks stay asks.
    const preview = cause === 'turnEnd' ? replyPreview(text) : null;
    if (preview) {
      const target: NoticeTarget = room
        ? room.id
          ? { open: 'room', room: room.id }
          : { open: 'office' }
        : noticeTarget({ cause: 'reply', agentId: id, lead: d.lead ? d.name : null, at: now });
      const sender = room ? `${room.name} · ${d.name}` : d.name;
      this.notify('reply', room ? null : id, sender, preview, d.who, d.remote, now, {
        target,
        devices: (s) => kindOn(s, 'reply'),
      });
      // A device with 메시지 off still gets the turn end, as on the screen.
      this.deliverTurnEnd(id, d, cause, now, room, (s) => !kindOn(s, 'reply'));
      return;
    }
    this.deliverTurnEnd(id, d, cause, now, room);
  }

  private deliverTurnEnd(
    id: number,
    d: NonNullable<ReturnType<PushServiceOptions['describe']>>,
    cause: Exclude<NoticeCause, 'job' | 'reply'>,
    now: number,
    room: RoomRef | null,
    devices?: (s: PushSubscriptionRow) => boolean,
    text = CAUSE_TEXT[cause],
  ): void {
    // ROOM-NOTICE: a room turn's end is the MEMBER's, in the room ("<room> · <member>", the room
    // thread opens): one per member and post (the cooldown folds a repeat), so two members
    // answering one post are two notices. Asks (a question, a permission) stay the character's.
    if (room) {
      this.notify('turnEnd', null, `${room.name} · ${d.name}`, text, d.who, d.remote, now, {
        target: room.id ? { open: 'room', room: room.id } : { open: 'office' },
        key: `${room.post ?? room.id ?? room.name}:${d.name}`,
        devices,
      });
      return;
    }
    const target = noticeTarget({
      cause,
      agentId: id,
      lead: d.lead ? d.name : null,
      background: d.background,
      at: now,
    });
    this.notify(cause, id, d.name, text, d.who, d.remote, now, { target, devices });
  }

  /** Push one notice to every subscribed device that is not looking. */
  notify(
    cause: NoticeCause,
    agentId: number | null,
    name: string,
    text: string,
    who: string,
    remote = false,
    now = Date.now(),
    /** Where its click opens (T-0043); the character when absent. */
    opts: {
      target?: NoticeTarget;
      /** C3: what one notice is about, for a notice with no character (a room's post): its cooldown key. */
      key?: string;
      /** Only these devices (U-49: who wants the message, who the plain turn end). */
      devices?: (s: PushSubscriptionRow) => boolean;
    } = {},
  ): void {
    const { store } = this.opts;
    const vapid = store.vapid;
    if (!vapid) return this.noteSkipped('push is off on this host', now);
    if (store.list().length === 0)
      return this.noteSkipped('no device has push notifications on', now);
    const pushTarget =
      opts.target ??
      (agentId === null ? ({ open: 'office' } as const) : { open: 'agent' as const, agentId });
    const payload: PushPayload = {
      // A message is titled by its sender alone; the other notices lead with their kind's icon.
      title: cause === 'reply' ? name : `${NOTICE_ICON[cause]} ${name}`,
      body: text,
      agentId,
      url: noticeUrl(pushTarget),
      tag: pushTag(cause, agentId, name, pushTarget),
    };
    const sends: Promise<PushResult>[] = [];
    const left = (why: string) => {
      this.count(`skipped.${cause}.${why.replace(/ /g, '-')}`);
      this.noteSkipped(`${cause}: ${why}`, now);
    };
    if (cause === 'reply') {
      const before = this.lastReply.get(payload.tag);
      if (before && before.body === text && Math.abs(now - before.at) < PUSH_REPEAT_MS)
        return left('repeat');
      if (this.lastReply.size > 200) this.lastReply.clear();
      this.lastReply.set(payload.tag, { body: text, at: now });
    }
    for (const sub of store.list().filter(opts.devices ?? (() => true))) {
      if (this.deviceVisible(sub.device, now)) {
        left('device looking');
        continue;
      }
      const rules = {
        kinds: Object.fromEntries(KINDS.map((k) => [k, kindOn(sub, k)])) as Record<
          NoticeKind,
          boolean
        >,
        subagents: sub.subagents,
        remoteTurnEnds: sub.remoteTurnEnds,
      };
      let last = this.last.get(sub.device);
      if (!last) this.last.set(sub.device, (last = new Map()));
      const target = agentId !== null ? String(agentId) : opts.key ? `room:${opts.key}` : name;
      const verdict = noticeVerdict(
        { cause, target, who, remote, at: now },
        rules,
        last,
        false,
        true,
      );
      if (verdict !== 'loud') {
        left(verdict === 'off' ? 'switched off here' : 'cooldown');
        continue;
      }
      if (cause === 'turnEnd' && !opts.key) {
        // A room member's turn end is its own notice (like its text reply), never part of a burst.
        const prev = this.lastTurnEnd.get(sub.device);
        if (prev !== undefined && now - prev < PUSH_COALESCE_MS) {
          left('burst'); // the burst's one buzz went out
          continue;
        }
        this.lastTurnEnd.set(sub.device, now);
      }
      sends.push(
        sendPush(sub, { ...payload, body: textIn(sub.lang ?? 'ko', payload.body) }, vapid, store.subject, this.opts.fetchFn).then((result) => {
          if (result === 'gone' && store.removeWhere((s) => s.endpoint === sub.endpoint))
            console.log('[cld push] subscription expired at the push service: removed');
          return result;
        }),
      );
    }
    if (!sends.length) return;
    // One line per batch, no content: whether pushes go out is visible in `cld-gui logs`.
    void Promise.all(sends).then((results) => {
      const ok = results.filter((r) => r === 'sent').length;
      const bad = results.length - ok;
      for (let i = 0; i < results.length; i++)
        this.count(`${results[i] === 'sent' ? 'sent' : 'failed'}.${cause}`);
      console.log(`[cld push] sent ${cause} to ${ok} device(s)${bad ? `, ${bad} failed` : ''}`);
    });
  }
}
