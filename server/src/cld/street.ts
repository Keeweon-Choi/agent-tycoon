/**
 * MHO v1b (ADR-0020): the street between PCs. Two sides of one pairing, kept in `street.json`
 * (0600, written through a temp file and a rename) beside host.json:
 *
 * - this host READS a neighbour (the laptop, A): the neighbour's host id (pinned at the first
 *   pairing), name, https address and the street key made from the token it gave us;
 * - a neighbour READS this host (the desktop, B): that host's id and name and the same street key.
 *   Deleting that row revokes it at once.
 *
 * The token crosses the wire once, in the pairing reply. After that A signs each summary request
 * with the key (`streetAuthorization`: method, path, time, both host ids), so a certificate holder
 * at a moved address learns no credential. The key opens one route, `GET /api/street/summary` (the
 * gate asks STREET_GATE), never /ws or anything else. The summary is names, states and a count (core/src/cld/street.ts). A asks its
 * neighbours only while some client watches the street (`streetWatch`), every STREET_POLL_MS.
 */
import * as crypto from 'crypto';
import * as path from 'path';

import { isServerTextCode, type Refused, refused, type ServerTextCode } from '../../../core/src/cld/serverText.js';
import {
  isHostId,
  neighbourUrl,
  normalizeStreetSummary,
  type StreetAgent,
  type StreetAgentState,
  streetName,
  type StreetSummary,
} from '../../../core/src/cld/street.js';
import {
  STREET_KEY_LABEL,
  STREET_PAIR_PATH,
  STREET_PAIRS_MAX,
  STREET_REPLY_BYTES,
  STREET_SUMMARY_PATH,
  STREET_SUMMARY_VERSION,
} from '../../../core/src/constants.js';
import {
  STREET_FETCH_TIMEOUT_MS,
  STREET_PAIR_CODE_MS,
  STREET_POLL_MS,
  STREET_SIG_WINDOW_MS,
  STREET_SUMMARY_MIN_MS,
} from '../constants.js';
import type { AgentState } from '../types.js';
import { AuthLimiter, SHORT_CODE_LOCK } from './auth.js';
import { configDirectory } from './configPath.js';
import type { WsSend } from './hooks.js';
import { readJson, writeJsonAtomic } from './jsonFile.js';
import { maskText } from './mask.js';

/** A host this one reads (it paired with that host's code). */
interface Neighbour {
  hostId: string;
  name: string;
  url: string;
  /** `streetKey(token)`: what signs our requests to it. */
  key: string;
  pairedAt: number;
}

/** A host that reads this one: the key its requests are signed with (the token is not kept). */
interface Reader {
  hostId: string;
  name: string;
  key: string;
  pairedAt: number;
}

interface StreetFile {
  v: 1;
  neighbours: Neighbour[];
  readers: Reader[];
}

/**
 * How a neighbour looks from here. `unknown`: not asked yet; `off`: its address answers but its
 * daemon does not (refused, or the proxy in front says 502-504); `unreachable`: no answer, or one
 * not to trust (`reason`); `old`: its daemon has no street (update it); `unpaired`: pair again,
 * not asked again: it refused our signature (its owner deleted the pairing), or `reason: other_host`
 * another host answered at its address.
 */
export type NeighbourState = 'unknown' | 'online' | 'off' | 'unreachable' | 'old' | 'unpaired';
/**
 * `other_host`: a different host id answered (dropped, pair again); `http`: a plain-http address in
 * the file; `clock`: it refused our signature and its clock is more than STREET_SIG_WINDOW_MS off.
 */
export type NeighbourReason = 'other_host' | 'tls' | 'timeout' | 'network' | 'bad_reply' | 'http' | 'clock';

interface Live {
  state: NeighbourState;
  /** Not asked again until it is paired again (or this daemon restarts). */
  stop?: boolean;
  reason?: NeighbourReason;
  summary?: StreetSummary;
  lastSeen?: number;
}

/** One neighbour in `streetState`. */
export interface NeighbourView {
  hostId: string;
  name: string;
  url: string;
  state: NeighbourState;
  reason?: NeighbourReason;
  version?: string;
  lastSeen: number | null;
  agents: StreetAgent[];
  waiting: number;
}

/** What `POST /api/street/pair` answers the host that paired. */
export interface PairReply {
  v: typeof STREET_SUMMARY_VERSION;
  hostId: string;
  name: string;
  version: string;
  token: string;
}

/** A refusal with the HTTP status the route answers it with. */
export type StreetRefusal = Refused & { status: number };

export interface StreetOptions {
  home: string;
  /** This host's id and display name (host.json), read when needed: 설정 can rename it. */
  self: () => { hostId?: string; hostName: string };
  version: string;
  /** Every agent on this host, its display name and street state. */
  agents: () => StreetAgent[];
  /** To every logged-in client of this host. */
  broadcast: (message: Record<string, unknown>) => void;
  /** Tests: the network. */
  fetch?: typeof fetch;
  pollMs?: number;
  log?: (line: string) => void;
}

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const PAIR_CODE = /^\d{8}$/;
/** `Street <reader host id>.<unix seconds>.<signature>` (the host id in lower case). */
const STREET_AUTH = /^Street ([0-9a-f-]{36})\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/;

/** The key both sides make from the pairing token: the token itself never travels again. */
export function streetKey(token: string): string {
  return crypto.createHmac('sha256', token).update(STREET_KEY_LABEL).digest('base64url');
}

function streetSignature(key: string, method: string, pathname: string, ts: string, reader: string, target: string): string {
  return crypto.createHmac('sha256', key).update([method, pathname, ts, reader, target].join('\n')).digest('base64url');
}

/** The `Authorization` of one request from `reader` to `target` (host ids), signed now. */
export function streetAuthorization(
  key: string,
  reader: string,
  target: string,
  method: string,
  pathname: string,
  now = Date.now(),
): string {
  const ts = String(Math.floor(now / 1000));
  const r = reader.toLowerCase();
  return `Street ${r}.${ts}.${streetSignature(key, method, pathname, ts, r, target.toLowerCase())}`;
}

/** How an agent of this host stands on the street. `entry`: the office's row for it, when it has one. */
export function agentStreetState(
  agent: Pick<AgentState, 'permissionSent' | 'questionOffset' | 'activeToolIds'>,
  entry?: { state: 'running' | 'off'; busy: boolean | null } | null,
  permissionCard = false,
): StreetAgentState {
  // ponytail: a question tool open mid-turn is not counted (the turn's end question is); the
  // screen's waiting.ts rule needs the tool names, a Claude detail the street does not carry.
  if (permissionCard || agent.permissionSent || agent.questionOffset !== undefined) return 'waiting';
  // `state`, not `alive`: only the engine's rows set `alive`, a Claude session's row leaves it false.
  if (entry?.state === 'off') return 'off';
  if (agent.activeToolIds.size > 0 || entry?.busy) return 'working';
  return 'idle';
}

/**
 * Every agent of this host as the street sees it: its display name, the office's label (usually the
 * project folder's last name, as the office shows it; never a full path or a transcript) and its
 * state. Nothing else of the agent is read.
 */
export function streetAgents(
  agents: Iterable<AgentState>,
  entryOf: (id: number) => { state: 'running' | 'off'; busy: boolean | null } | null,
  permissionCard: (id: number) => boolean,
): StreetAgent[] {
  return [...agents].map((a) => ({
    name: a.directoryName ?? a.agentName ?? '',
    state: agentStreetState(a, entryOf(a.id), permissionCard(a.id)),
  }));
}

export class Street {
  /** All failed pair codes together: the short-code lock's policy (NFR-SEC-016), its own bucket. */
  readonly pairLock = new AuthLimiter(SHORT_CODE_LOCK);
  private readonly file: string;
  /** street.json could not be read: it is kept as it is, never written over, and nothing pairs. */
  private readonly broken: boolean;
  private data: StreetFile = { v: 1, neighbours: [], readers: [] };
  /** One pair code at a time: a new one ends the last. */
  private code: { code: string; expiresAt: number } | null = null;
  private readonly live = new Map<string, Live>();
  /** When each reader last asked (memory only). */
  private readonly seen = new Map<string, number>();
  private readonly watchers = new Set<WsSend>();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** The round of asking under way, which a second ask joins. */
  private polling: Promise<void> | null = null;
  private readonly fetchFn: typeof fetch;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: StreetOptions) {
    this.file = path.join(configDirectory(opts.home), 'street.json');
    this.fetchFn = opts.fetch ?? fetch;
    this.log = opts.log ?? ((line) => console.warn(`[Agent Tycoon] street: ${line}`));
    let broken = false;
    try {
      const raw = readJson(this.file);
      if (raw !== null) {
        if (validFile(raw)) this.data = raw;
        else broken = true;
      }
    } catch {
      broken = true;
    }
    this.broken = broken;
    if (broken) this.log(`${this.file} could not be read: kept as it is, pairing is off`);
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.watchers.clear();
  }

  // ── This host is read (B) ───────────────────────────────────

  /** A pair code is out and not expired: only then do failed pairings count toward the lock. */
  codeLive(): boolean {
    return !!this.code && this.code.expiresAt > Date.now();
  }

  createPairCode(): { code: string; expiresIn: number } {
    const code = crypto.randomInt(0, 100_000_000).toString().padStart(8, '0');
    this.code = { code, expiresAt: Date.now() + STREET_PAIR_CODE_MS };
    return { code, expiresIn: STREET_PAIR_CODE_MS / 1000 };
  }

  /**
   * POST /api/street/pair: the pair code, and the other host's id and name. A right code is used up
   * (a wrong one is the limiter's business, so a guesser cannot end the owner's code); the reply
   * carries a new street token, bound to that host id; it crosses once, both sides keep only
   * `streetKey(token)`.
   */
  pair(rawCode: unknown, peer: { hostId?: unknown; name?: unknown } | undefined): PairReply | StreetRefusal {
    const code = typeof rawCode === 'string' ? rawCode.replace(/\s+/g, '') : '';
    const live = this.code;
    if (live && live.expiresAt <= Date.now()) this.code = null;
    if (!live || live.expiresAt <= Date.now() || !PAIR_CODE.test(code) || !safeEqual(code, live.code))
      return { ...refused('street_pair_refused'), status: 401 };
    const self = this.opts.self();
    if (!self.hostId || this.broken) return { ...refused('street_no_identity'), status: 500 };
    if (!isHostId(peer?.hostId)) return { ...refused('street_bad_reply'), status: 400 };
    const hostId = peer.hostId.toLowerCase();
    if (hostId === self.hostId.toLowerCase()) return { ...refused('street_self'), status: 400 };
    // A code makes a new row, never takes over one: whoever holds a code could name any reader.
    if (this.data.readers.some((r) => r.hostId === hostId)) return { ...refused('street_reader_exists'), status: 409 };
    if (this.data.readers.length >= STREET_PAIRS_MAX) return { ...refused('street_full', { max: STREET_PAIRS_MAX }), status: 409 };
    this.code = null;
    const token = crypto.randomBytes(32).toString('base64url');
    const reader: Reader = { hostId, name: streetName(peer.name, hostId.slice(0, 8)), key: streetKey(token), pairedAt: Date.now() };
    if (!this.save({ ...this.data, readers: [...this.data.readers, reader] }))
      return { ...refused('save_failed', { why: 'street.json' }), status: 500 };
    return { v: STREET_SUMMARY_VERSION, hostId: self.hostId, name: streetName(self.hostName), version: this.version(), token };
  }

  /**
   * The reader that signed this request (`streetAuthorization` for this method and path, within
   * STREET_SIG_WINDOW_MS of now), or undefined. A replay inside the window only reads the summary
   * again, so no nonce is kept.
   */
  readerOf(authorization: string | undefined, method: string, pathname: string): { hostId: string; name: string } | undefined {
    const m = STREET_AUTH.exec(authorization ?? '');
    if (!m) return undefined;
    const [, hostId, ts, sig] = m;
    if (Math.abs(Date.now() - Number(ts) * 1000) > STREET_SIG_WINDOW_MS) return undefined;
    const reader = this.data.readers.find((r) => r.hostId === hostId);
    const self = this.opts.self().hostId?.toLowerCase();
    if (!reader || !self || !safeEqual(sig, streetSignature(reader.key, method, pathname, ts, hostId, self))) return undefined;
    return { hostId: reader.hostId, name: reader.name };
  }

  /** `reader` asked for a summary less than STREET_SUMMARY_MIN_MS ago. */
  tooSoon(reader: string): boolean {
    const last = this.seen.get(reader);
    return last !== undefined && Date.now() - last < STREET_SUMMARY_MIN_MS;
  }

  /** This host's summary, made now from memory; null without a host id. `reader`: who asked. */
  summary(reader?: string): StreetSummary | null {
    if (reader) this.seen.set(reader, Date.now());
    const self = this.opts.self();
    return normalizeStreetSummary({
      v: STREET_SUMMARY_VERSION,
      hostId: self.hostId,
      name: self.hostName,
      version: this.version(),
      // A secret someone typed into a name is masked before it leaves.
      agents: this.opts.agents().map((a) => ({ name: maskText(a.name), state: a.state })),
    });
  }

  /** Delete a reader's row: its token stops working at once. */
  unpair(hostId: string): { hostId: string; name: string } | null {
    const gone = this.data.readers.find((r) => r.hostId === hostId);
    if (!gone || !this.save({ ...this.data, readers: this.data.readers.filter((r) => r !== gone) })) return null;
    this.seen.delete(hostId);
    return { hostId: gone.hostId, name: gone.name };
  }

  // ── This host reads (A) ─────────────────────────────────────

  /**
   * Pair with another PC: its https address and the pair code its owner got there. Its host id is
   * pinned: another host answering at an address already paired is refused.
   */
  async addNeighbour(rawUrl: unknown, rawCode: unknown): Promise<{ neighbour: NeighbourView } | StreetRefusal> {
    const checked = neighbourUrl(rawUrl);
    if ('error' in checked) return { ...refused(checked.error), status: 400 };
    const url = checked.url;
    const self = this.opts.self();
    if (!self.hostId || this.broken) return { ...refused('street_no_identity'), status: 500 };
    const code = typeof rawCode === 'string' ? rawCode.replace(/\s+/g, '') : '';
    if (!PAIR_CODE.test(code)) return { ...refused('street_pair_refused'), status: 400 };
    let res: { status: number; body: unknown };
    try {
      res = await this.call(`${url}${STREET_PAIR_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, hostId: self.hostId, name: streetName(self.hostName) }),
      });
    } catch (err) {
      return { ...refused('street_unreachable', { why: failureOf(err).reason ?? 'network' }), status: 502 };
    }
    if (res.status === 404 || (res.status === 401 && (await this.health(url))?.street !== STREET_SUMMARY_VERSION))
      return { ...refused('street_pair_old'), status: 502 };
    if (res.status === 429) return { ...refused('street_pair_rate'), status: 429 };
    if (res.status !== 200) {
      const theirs = (res.body as { errorCode?: unknown } | null)?.errorCode;
      const code: ServerTextCode =
        isServerTextCode(theirs) && theirs.startsWith('street_') ? theirs : 'street_pair_refused';
      return { ...refused(code, code === 'street_full' ? { max: STREET_PAIRS_MAX } : undefined), status: 400 };
    }
    const reply = (res.body ?? {}) as Partial<Record<keyof PairReply, unknown>>;
    if (!isHostId(reply.hostId) || typeof reply.token !== 'string' || !TOKEN.test(reply.token))
      return { ...refused('street_bad_reply'), status: 502 };
    const hostId = reply.hostId.toLowerCase();
    if (hostId === self.hostId.toLowerCase()) return { ...refused('street_self'), status: 400 };
    const there = this.data.neighbours.find((n) => n.url === url);
    if (there && there.hostId !== hostId) return { ...refused('street_other_host'), status: 409 };
    // Pinned per host too: another address answering as a paired neighbour never replaces its
    // address and key (the review's L3). Remove that neighbour first, or pair at its address.
    const elsewhere = this.data.neighbours.find((n) => n.hostId === hostId && n.url !== url);
    if (elsewhere) return { ...refused('street_known_elsewhere', { url: elsewhere.url }), status: 409 };
    const others = this.data.neighbours.filter((n) => n.hostId !== hostId);
    if (others.length >= STREET_PAIRS_MAX) return { ...refused('street_full', { max: STREET_PAIRS_MAX }), status: 409 };
    const neighbour: Neighbour = { hostId, name: streetName(reply.name, hostId.slice(0, 8)), url, key: streetKey(reply.token), pairedAt: Date.now() };
    if (!this.save({ ...this.data, neighbours: [...others, neighbour] }))
      return { ...refused('save_failed', { why: 'street.json' }), status: 500 };
    this.live.delete(hostId);
    if (this.watchers.size) void this.pollAll();
    else this.publish();
    return { neighbour: this.view(neighbour) };
  }

  /** Forget a neighbour (its token here). Its own row for this host stays until deleted there. */
  removeNeighbour(hostId: string): { hostId: string; name: string } | null {
    const gone = this.data.neighbours.find((n) => n.hostId === hostId);
    if (!gone || !this.save({ ...this.data, neighbours: this.data.neighbours.filter((n) => n !== gone) })) return null;
    this.live.delete(hostId);
    this.publish();
    return { hostId: gone.hostId, name: gone.name };
  }

  /** Both lists, for the pairing section (never a token or its hash). */
  lists() {
    return {
      neighbours: this.data.neighbours.map(({ hostId, name, url, pairedAt }) => ({ hostId, name, url, pairedAt })),
      readers: this.data.readers.map(({ hostId, name, pairedAt }) => ({
        hostId,
        name,
        pairedAt,
        lastSeen: this.seen.get(hostId) ?? null,
      })),
    };
  }

  stateMessage(): { type: 'streetState'; neighbours: NeighbourView[] } {
    return { type: 'streetState', neighbours: this.data.neighbours.map((n) => this.view(n)) };
  }

  /** `streetWatch {on}`, `streetEnter {hostId}`; false: not a street message. */
  onClientMessage(msg: Record<string, unknown>, send: WsSend): boolean {
    if (msg.type === 'streetWatch') {
      if (typeof msg.on === 'boolean') this.watch(send, msg.on);
      return true;
    }
    if (msg.type === 'streetEnter') {
      const n = this.data.neighbours.find((x) => x.hostId === msg.hostId);
      // B's address only: B's own login, in B's own origin. No credential for B passes here.
      send(
        n
          ? { type: 'streetEnterResult', hostId: n.hostId, url: n.url }
          : { type: 'streetEnterResult', hostId: streetName(msg.hostId, '?'), ...refused('street_unknown') },
      );
      return true;
    }
    return false;
  }

  /** A client shows the street (on) or stopped; the neighbours are asked only while one does. */
  watch(send: WsSend, on: boolean): void {
    if (!on) return this.unwatch(send);
    this.watchers.add(send);
    send({ ...this.stateMessage() });
    if (this.timer) return;
    void this.pollAll();
    this.timer = setInterval(() => void this.pollAll(), this.opts.pollMs ?? STREET_POLL_MS);
    this.timer.unref?.();
  }

  /** A socket closed or looks away: the last one stops the asking at once. */
  unwatch(send: WsSend): void {
    this.watchers.delete(send);
    if (this.watchers.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Ask every paired neighbour once (one that `stop`ped is not asked again), then tell the clients. */
  pollAll(): Promise<void> {
    this.polling ??= this.pollRound().finally(() => {
      this.polling = null;
    });
    return this.polling;
  }

  private async pollRound(): Promise<void> {
    await Promise.all(
      this.data.neighbours.map(async (n) => {
        const before = this.live.get(n.hostId);
        if (before?.stop) return;
        const next = await this.pollOne(n);
        // Too soon for it (429): what we had stands. Removed or paired again meanwhile: this answer
        // is for a key we no longer hold.
        if (!next || !this.data.neighbours.some((x) => x.hostId === n.hostId && x.key === n.key)) return;
        this.live.set(n.hostId, { ...next, lastSeen: next.lastSeen ?? before?.lastSeen });
      }),
    );
    this.publish();
  }

  // ── Inside ──────────────────────────────────────────────────

  private async pollOne(n: Neighbour): Promise<Live | null> {
    if ('error' in neighbourUrl(n.url)) return { state: 'unreachable', reason: 'http' };
    try {
      const self = this.opts.self().hostId;
      if (!self) return { state: 'unknown' };
      // The path B's routes see (a direct address's secret path is taken off before them).
      const res = await this.call(`${n.url}${STREET_SUMMARY_PATH}?v=${STREET_SUMMARY_VERSION}`, {
        headers: { authorization: streetAuthorization(n.key, self, n.hostId, 'GET', STREET_SUMMARY_PATH) },
      });
      if (res.status === 429) return null;
      // No summary route: an old daemon, or no daemon behind this address any more (a direct
      // address whose secret path was rotated answers 404 for everything).
      if (res.status === 404)
        return (await this.health(n.url)) ? { state: 'old' } : { state: 'unreachable', reason: 'network' };
      // A refusal is not asked again: every 401 counts against our address in its login limiter.
      // Its clock far from ours (its Date header) explains a refused signature; else its health
      // check says whether it has a street (an old daemon's gate answers 401 too).
      if (res.status === 401) {
        if (Number.isFinite(res.date) && Math.abs(res.date - Date.now()) > STREET_SIG_WINDOW_MS)
          return { state: 'unreachable', reason: 'clock', stop: true };
        return { state: (await this.health(n.url))?.street === STREET_SUMMARY_VERSION ? 'unpaired' : 'old', stop: true };
      }
      if (res.status >= 502 && res.status <= 504) return { state: 'off' };
      if (res.status !== 200) return { state: 'unreachable', reason: 'network' };
      const summary = normalizeStreetSummary(res.body);
      if (!summary) return { state: 'unreachable', reason: 'bad_reply' };
      // Pinned: whatever another host says at this address is dropped, and it is not asked again
      // (pair again: the address may belong to someone else now, ADR-0020).
      if (summary.hostId !== n.hostId) return { state: 'unpaired', reason: 'other_host', stop: true };
      return { state: 'online', summary, lastSeen: Date.now() };
    } catch (err) {
      return failureOf(err);
    }
  }

  /** The public health check of the daemon at `url` (`street` says it has the street), or null. */
  private async health(url: string): Promise<{ street?: unknown } | null> {
    try {
      const res = await this.call(`${url}/api/health`, {});
      return res.status === 200 && res.body && typeof res.body === 'object' ? (res.body as { street?: unknown }) : null;
    } catch {
      return null;
    }
  }

  /** One call to another PC: no redirect followed, a time limit, a size limit, JSON or null. */
  private async call(url: string, init: RequestInit): Promise<{ status: number; body: unknown; date: number }> {
    const res = await this.fetchFn(url, {
      ...init,
      redirect: 'manual',
      signal: AbortSignal.timeout(STREET_FETCH_TIMEOUT_MS),
    });
    const text = await readCapped(res, STREET_REPLY_BYTES);
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: res.status, body, date: Date.parse(res.headers.get('date') ?? '') };
  }

  private view(n: Neighbour): NeighbourView {
    const live = this.live.get(n.hostId);
    const summary = live?.state === 'online' ? live.summary : undefined;
    return {
      hostId: n.hostId,
      name: summary?.name || live?.summary?.name || n.name,
      url: n.url,
      state: live?.state ?? 'unknown',
      ...(live?.reason ? { reason: live.reason } : {}),
      ...(live?.summary?.version ? { version: live.summary.version } : {}),
      lastSeen: live?.lastSeen ?? null,
      agents: summary?.agents ?? [],
      waiting: summary?.waiting ?? 0,
    };
  }

  private publish(): void {
    this.opts.broadcast({ ...this.stateMessage() });
  }

  private version(): string {
    return this.opts.version;
  }

  private save(next: StreetFile): boolean {
    if (this.broken) return false;
    try {
      writeJsonAtomic(this.file, next);
      this.data = next;
      return true;
    } catch (err) {
      this.log(`could not write ${this.file}: ${String(err)}`);
      return false;
    }
  }
}

/** A failed call: refused at the address is `off` (no daemon there), the rest `unreachable`. */
function failureOf(err: unknown): Live {
  const e = err as { name?: string; cause?: { code?: unknown } } | null;
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return { state: 'unreachable', reason: 'timeout' };
  const code = String(e?.cause?.code ?? '');
  if (code === 'ECONNREFUSED') return { state: 'off' };
  if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|ALTNAME/i.test(code)) return { state: 'unreachable', reason: 'tls' };
  return { state: 'unreachable', reason: 'network' };
}

/** A response body as text, or '' when it is larger than `max` (read no further). */
async function readCapped(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return '';
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function validFile(raw: unknown): raw is StreetFile {
  const f = raw as Partial<StreetFile> | null;
  return (
    f?.v === 1 &&
    Array.isArray(f.neighbours) &&
    Array.isArray(f.readers) &&
    f.neighbours.every(
      (n) =>
        isHostId(n?.hostId) &&
        typeof n.name === 'string' &&
        typeof n.url === 'string' &&
        typeof n.key === 'string' &&
        TOKEN.test(n.key) &&
        Number.isFinite(n.pairedAt),
    ) &&
    f.readers.every(
      (r) =>
        isHostId(r?.hostId) &&
        typeof r.name === 'string' &&
        typeof r.key === 'string' &&
        TOKEN.test(r.key) &&
        Number.isFinite(r.pairedAt),
    )
  );
}
