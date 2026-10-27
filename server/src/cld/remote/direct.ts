/**
 * The direct connector (T-0024): the internet reaches this PC through the
 * home router with no account anywhere.
 *
 * - The router maps external TCP 443 to this PC's TLS port (UPnP, re-mapped
 *   every 10 minutes because a router reboot forgets it).
 * - Let's Encrypt issues a certificate for the public IP (TLS-ALPN-01 on that
 *   same 443; 160 h, renewed at two thirds) or for a DuckDNS name the user has.
 * - "My devices only": the public listener answers only under
 *   `/<128-bit secret>/`. Anything else gets an empty 404 (a WebSocket, a
 *   closed socket), so scanners and Certificate Transparency watchers learn
 *   nothing. The secret rides every invitation (QR, link, the web app's start
 *   URL); the first request under it sets an HttpOnly cookie so the app's own
 *   absolute paths (/ws, /api/...) pass too. Every request here is public
 *   (auth.ts isPublicRequest): no auto-login, no host token, no passkeys or
 *   approval requests, a stricter code cap.
 * - A new public IP (the ISP reassigned it) is noticed within 10 minutes:
 *   the certificate is issued again and LAN clients are told to re-pair.
 *   Devices outside cannot learn the new address without a rendezvous; a
 *   DuckDNS name avoids that.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import type { IncomingMessage, ServerResponse } from 'http';
import * as https from 'https';
import * as net from 'net';
import type { Duplex } from 'stream';
import * as tls from 'tls';

import { koText } from '../../../../core/src/cld/serverText.js';
import { directSockets } from '../auth.js';
import type { AlpnChallenges, Certificate, DuckDns, Issuer } from './acme.js';
import { classifyNat, isPublicIpv4, type NatVerdict, relayCommands } from './net.js';
import type { Gateway, PortMapping } from './upnp.js';

export const DIRECT_PORT = 18443;
export const EXTERNAL_PORT = 443;
export const MAINTENANCE_MS = 10 * 60_000;
/** After a failed issue, wait this long before asking Let's Encrypt again (5 failures/hour/identifier). */
export const ISSUE_RETRY_MS = 60 * 60_000;
const GATE_COOKIE = 'cld_gate';
const GATE_MAX_AGE = 400 * 24 * 60 * 60; // the longest browsers keep a cookie

/** One line of a run: ✔/✖ with a Korean reason; `admin` is a host command a person runs once. */
export interface Step {
  ok: boolean;
  text: string;
  fix?: string;
  admin?: string;
  guide?: string;
  actions?: ({ kind: 'open'; url: string; label: string } | { kind: 'copy'; text: string; label: string })[];
  suggest?: 'local' | 'lan' | 'direct' | 'ssh' | 'duckdns' | 'tailscale' | 'funnel' | 'tunnel';
  /** The person says they ran `actions` (a rule nothing here can read back). */
  confirm?: boolean;
  /** Passed, but could not be checked from this PC. */
  unknown?: boolean;
}

export interface DirectState {
  enabled: boolean;
  secret: string;
  /** The public IP the certificate (or the DuckDNS name) points at. */
  ip?: string;
  /** A DuckDNS name used instead of the IP. */
  name?: string;
  /** The router mapping is ours to refresh (UPnP); false after a manual port forward. */
  upnp: boolean;
  notBefore?: number;
  notAfter?: number;
  /** What the installed certificate names (an IP certificate goes stale with the IP). */
  certFor?: string;
  ipChangedAt?: number;
  previousIp?: string;
  issueFailedAt?: number;
  /** In DuckDNS mode, the separate certificate that keeps old IP invitations valid. */
  ipCertFor?: string;
  ipNotBefore?: number;
  ipNotAfter?: number;
  ipIssueFailedAt?: number;
}

/** Where gated requests go: the Fastify server (`app.server`). */
export interface ForwardTarget {
  emit(event: 'request', req: IncomingMessage, res: ServerResponse): boolean;
  emit(event: 'upgrade', req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
}

export interface DirectDeps {
  /** ~/.config/agent-tycoon/tls (0700; files 0600). */
  dir: string;
  lanIp: string | null;
  /** The TLS port the router forwards 443 to. */
  port: number;
  /** Where the TLS listener binds; default the LAN address. */
  listenHost?: string;
  target: ForwardTarget;
  /** The /ws Host allowlist: the public name joins it while direct is on. */
  hosts: { add(name: string): void; delete(name: string): void };
  findGateway(lanIp: string): Promise<Gateway | null>;
  observedIp(): Promise<string | null>;
  issue: Issuer;
  duck?: { name: string; client: DuckDns };
  /** The hairpin check (tests point it at 127.0.0.1 and a test CA). */
  selfTest?: (url: string) => Promise<Step>;
  now?: () => number;
  log?: (line: string) => void;
  /**
   * WSL in NAT mode (T-0074): Windows' portproxy carries 443 to 127.0.0.1,
   * WSL's localhost forwarding carries that to this listener. No UPnP from
   * inside WSL (its SSDP never reaches the LAN); the listener binds 127.0.0.1.
   */
  relay?: () => Promise<boolean>;
  /** Windows' own IPv4 addresses (ipconfig.exe), null when it can't be asked. */
  windowsAddresses?: () => Promise<string[] | null>;
  /** One TCP connection to host:port and closed, as an outsider would make (tests: a local pipe). */
  dial?: (host: string, port: number) => Promise<void>;
  /** Between relay checks (WSL notices a new listener within about a second). */
  relayGapMs?: number;
}

/** Connect and close; rejects on refusal or after 2 s. */
export function tcpTouch(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    socket.setTimeout(2000, () => {
      socket.destroy();
      reject(new Error('timeout'));
    });
    socket.once('connect', () => {
      socket.end();
      resolve();
    });
    socket.once('error', reject);
  });
}

// ── The secret path gate (pure) ─────────────────────────────────

export function newSecret(): string {
  return crypto.randomBytes(16).toString('base64url'); // 128 bits
}

const safeEqual = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

function gateCookie(cookie: string | undefined): string | undefined {
  for (const part of (cookie ?? '').split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === GATE_COOKIE) return value.join('=');
  }
  return undefined;
}

export type GateVerdict =
  | { pass: false }
  | { pass: true; url: string; viaPath: boolean }
  | { pass: true; redirect: string };

/**
 * Whether a request on the public listener may go on, and as what URL.
 * `/<secret>/rest` -> `/rest`; `/<secret>` -> redirect to `/<secret>/` (so the
 * page's relative URLs resolve under it); anything else only with the gate cookie.
 */
export function gate(url: string, cookie: string | undefined, secret: string): GateVerdict {
  if (!url.startsWith('/')) return { pass: false }; // absolute-form, `*`: never
  const match = /^\/([A-Za-z0-9_-]{22})(\/[^]*|\?[^]*)?$/.exec(url);
  if (match && safeEqual(match[1], secret)) {
    const rest = match[2] ?? '';
    if (rest === '' || rest.startsWith('?')) return { pass: true, redirect: `/${secret}/${rest}` };
    return { pass: true, url: rest, viaPath: true };
  }
  const value = gateCookie(cookie);
  if (value !== undefined && safeEqual(value, secret)) return { pass: true, url, viaPath: false };
  return { pass: false };
}

export function gateSetCookie(secret: string): string {
  return `${GATE_COOKIE}=${secret}; Path=/; Max-Age=${GATE_MAX_AGE}; HttpOnly; Secure; SameSite=Strict`;
}

/** A redirect inside the app stays under the secret path (the web app's scope). */
export function prefixLocation(location: string, secret: string): string {
  return location.startsWith('/') &&
    !location.startsWith('//') &&
    !location.startsWith(`/${secret}/`)
    ? `/${secret}${location}`
    : location;
}

/** Headers a client must never choose on a public listener (they mean "a proxy I trust said so"). */
export function scrubHeaders(headers: IncomingMessage['headers']): void {
  for (const name of Object.keys(headers))
    if (/^(x-forwarded-|forwarded$|tailscale-|x-real-ip$)/i.test(name)) delete headers[name];
}

/** Renew at two thirds of the lifetime (53 h of slack on a 160 h certificate). */
export function renewAt(notBefore: number, notAfter: number): number {
  return notBefore + ((notAfter - notBefore) * 2) / 3;
}

function notFound(res: ServerResponse): void {
  res.sendDate = false;
  res.writeHead(404, { 'content-length': '0' });
  res.end();
}

// ── The connector ───────────────────────────────────────────────

export class DirectConnector {
  private state: DirectState;
  private server: https.Server | null = null;
  private readonly challenges = new Map<string, tls.SecureContext>();
  private nameContext: tls.SecureContext | undefined;
  private ipContext: tls.SecureContext | undefined;
  private defaultContext: tls.SecureContext | undefined;
  private defaultCertificate: { key: string; cert: string } | null = null;
  private timer: NodeJS.Timeout | null = null;
  private busy: Promise<unknown> = Promise.resolve();
  /** TCP connections the listener accepted (the relay check counts them). */
  private connections = 0;
  /** The listener's open sockets, upgraded ones too: close() ends them all. closeAllConnections
   *  misses a live WebSocket, and every deploy then waited for systemd's SIGKILL (90 s, 10-22). */
  private readonly sockets = new Set<Duplex>();
  private relayKnown?: Promise<boolean>;
  /** The last enable/probe/maintenance run, for the status endpoint. */
  lastRun: Step[] = [];
  readonly alpn: AlpnChallenges = {
    set: (name, key, cert) =>
      this.challenges.set(name.toLowerCase(), tls.createSecureContext({ key, cert })),
    clear: (name) => void this.challenges.delete(name.toLowerCase()),
  };

  constructor(private readonly deps: DirectDeps) {
    this.state = this.load();
  }

  /** Use the same router and listener for an IP address or a DuckDNS name. */
  configureDuck(duck: DirectDeps['duck'], issue: Issuer): void {
    this.deps.duck = duck;
    this.deps.issue = issue;
  }

  /** The one router entry we own: external 443 to this PC's TLS port. */
  private mapping(lanIp: string): PortMapping {
    return {
      externalPort: EXTERNAL_PORT,
      internalPort: this.deps.port,
      internalClient: lanIp,
      description: 'cld-gui',
    };
  }

  private get now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private log(line: string): void {
    (this.deps.log ?? ((l: string) => console.log(`[cld remote] ${l}`)))(line);
  }

  /** WSL NAT: Windows' portproxy is the way in (asked once; the mode can't change under us). */
  isRelay(): Promise<boolean> {
    return (this.relayKnown ??= (this.deps.relay?.() ?? Promise.resolve(false)).catch(() => false));
  }

  // ── Files ──

  private file(name: string): string {
    return `${this.deps.dir}/${name}`;
  }

  private load(): DirectState {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file('state.json'), 'utf8')) as DirectState;
      if (typeof raw.secret === 'string' && /^[A-Za-z0-9_-]{22}$/.test(raw.secret)) return raw;
    } catch {
      /* first run */
    }
    return { enabled: false, secret: newSecret(), upnp: true };
  }

  private save(): void {
    fs.mkdirSync(this.deps.dir, { recursive: true, mode: 0o700 });
    const tmp = this.file(`state.json.${process.pid}.tmp`);
    fs.writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.file('state.json'));
  }

  private readCertificate(slot: 'name' | 'ip' = 'name'): { key: string; cert: string } | null {
    const prefix = slot === 'ip' ? 'ip-cert' : 'cert';
    try {
      return {
        key: fs.readFileSync(this.file(`${prefix}.key`), 'utf8'),
        cert: fs.readFileSync(this.file(`${prefix}.pem`), 'utf8'),
      };
    } catch {
      return null;
    }
  }

  private refreshCertificateContexts(): void {
    const name = this.readCertificate();
    const ip = this.readCertificate('ip');
    this.nameContext = name ? tls.createSecureContext(name) : undefined;
    this.ipContext = ip ? tls.createSecureContext(ip) : undefined;
    // IP literals send no SNI. In name mode its certificate is the default;
    // without a saved IP certificate, keep serving the name certificate.
    this.defaultCertificate = this.state.name && ip ? ip : name;
    this.defaultContext = this.state.name && ip ? this.ipContext : this.nameContext;
  }

  private writeCertificate(slot: 'name' | 'ip', certificate: Certificate): void {
    fs.mkdirSync(this.deps.dir, { recursive: true, mode: 0o700 });
    const prefix = slot === 'ip' ? 'ip-cert' : 'cert';
    for (const [name, body] of [
      [`${prefix}.key`, certificate.key],
      [`${prefix}.pem`, certificate.cert],
    ]) {
      const tmp = this.file(`${name}.${process.pid}.tmp`);
      fs.writeFileSync(tmp, body, { mode: 0o600 });
      fs.renameSync(tmp, this.file(name));
    }
  }

  private updateServerCertificate(): void {
    this.refreshCertificateContexts();
    if (this.defaultCertificate) this.server?.setSecureContext(this.defaultCertificate);
  }

  private install(certificate: Certificate): void {
    this.writeCertificate('name', certificate);
    this.state.notBefore = certificate.notBefore;
    this.state.notAfter = certificate.notAfter;
    this.state.certFor = certificate.identifier;
    delete this.state.issueFailedAt;
    this.save();
    this.updateServerCertificate();
  }

  private installIp(certificate: Certificate): void {
    this.writeCertificate('ip', certificate);
    this.state.ipNotBefore = certificate.notBefore;
    this.state.ipNotAfter = certificate.notAfter;
    this.state.ipCertFor = certificate.identifier;
    delete this.state.ipIssueFailedAt;
    this.save();
    this.updateServerCertificate();
  }

  // ── What others read ──

  get secret(): string {
    return this.state.secret;
  }

  get enabled(): boolean {
    return this.state.enabled;
  }

  /** The public listener's port (tests listen on 0), null when not listening. */
  listeningPort(): number | null {
    const address = this.server?.address();
    return address && typeof address === 'object' ? address.port : null;
  }

  /** `https://<ip or name>/<secret>/` while direct is on. */
  url(): string | null {
    const host = this.state.name ?? this.state.ip;
    return this.state.enabled && host ? `https://${host}/${this.state.secret}/` : null;
  }

  status() {
    const {
      enabled,
      ip,
      name,
      upnp,
      notBefore,
      notAfter,
      ipNotBefore,
      ipNotAfter,
      ipChangedAt,
      previousIp,
    } = this.state;
    return {
      enabled,
      url: this.url(),
      ip: ip ?? null,
      name: name ?? null,
      upnp,
      lanIp: this.deps.lanIp,
      port: this.deps.port,
      listening: this.server?.listening ?? false,
      certificate:
        notBefore && notAfter
          ? { notBefore, notAfter, renewAt: renewAt(notBefore, notAfter) }
          : null,
      ipCertificate:
        ipNotBefore && ipNotAfter
          ? {
              notBefore: ipNotBefore,
              notAfter: ipNotAfter,
              renewAt: renewAt(ipNotBefore, ipNotAfter),
            }
          : null,
      ipNotBefore: ipNotBefore ?? null,
      ipNotAfter: ipNotAfter ?? null,
      ipChangedAt: ipChangedAt ?? null,
      previousIp: previousIp ?? null,
      lastRun: this.lastRun,
    };
  }

  /** A new secret: every invitation, bookmark and installed web app out there stops working. */
  rotateSecret(): string {
    this.state.secret = newSecret();
    this.save();
    this.log('비밀 주소를 바꿨어요: 다른 기기는 다시 초대해야 해요');
    return this.state.secret;
  }

  // ── The public listener ──

  private async listen(): Promise<void> {
    if (this.server?.listening) return;
    const host = await this.listenHost();
    this.refreshCertificateContexts();
    const server = https.createServer({
      ...(this.defaultCertificate ?? {}),
      // TLS-ALPN-01: Let's Encrypt asks for the reverse name of the IP (RFC 8738),
      // which no browser sends; everyone else gets the real certificate.
      SNICallback: (name, cb) => {
        const requested = name.toLowerCase();
        const challenge = this.challenges.get(requested);
        const duckName = this.state.name ?? this.deps.duck?.name;
        cb(
          null,
          challenge ??
            (duckName && requested === duckName.toLowerCase()
              ? this.nameContext
              : this.defaultContext),
        );
      },
      ALPNProtocols: ['http/1.1', 'acme-tls/1'],
    });
    server.keepAliveTimeout = 30_000;
    server.headersTimeout = 20_000;
    server.requestTimeout = 60_000;
    server.on('connection', (socket) => {
      this.connections += 1;
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
    });
    server.on('secureConnection', (socket) => directSockets.add(socket));
    server.on('request', (req, res) => this.onRequest(req, res));
    server.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head));
    server.on('tlsClientError', () => undefined); // scanners: nothing to log
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.deps.port, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    this.server = server;
  }

  /** The relay's target inside WSL is loopback; else the LAN address. */
  private async listenHost(): Promise<string> {
    if (this.deps.listenHost) return this.deps.listenHost;
    if (await this.isRelay()) return '127.0.0.1';
    return this.deps.lanIp ?? '0.0.0.0';
  }

  private onRequest(req: IncomingMessage, res: ServerResponse): void {
    const verdict = gate(req.url ?? '/', req.headers.cookie, this.state.secret);
    if (!verdict.pass) return notFound(res);
    const secret = this.state.secret;
    // A page that navigates to a bare `/` (the login page after a device-key
    // login) stays inside the installed app's scope, `/<secret>/`.
    const home = !('redirect' in verdict) && !verdict.viaPath && /^\/(\?|$)/.test(verdict.url);
    if ('redirect' in verdict || home) {
      const location = 'redirect' in verdict ? verdict.redirect : `/${secret}${verdict.url}`;
      res.writeHead(302, { location, 'set-cookie': gateSetCookie(secret) });
      return void res.end();
    }
    scrubHeaders(req.headers);
    req.headers['x-forwarded-proto'] = 'https';
    req.url = verdict.url;
    // Keep redirects under the secret path, and hand the gate cookie to a
    // browser that came in by the path.
    const writeHead = res.writeHead.bind(res) as (...args: unknown[]) => ServerResponse;
    (res as { writeHead: (...args: unknown[]) => ServerResponse }).writeHead = (...args) => {
      const headers = args.find((a) => typeof a === 'object' && a !== null && !Array.isArray(a)) as
        Record<string, unknown> | undefined;
      const location = headers?.location ?? res.getHeader('location');
      if (typeof location === 'string') {
        if (headers && 'location' in headers) headers.location = prefixLocation(location, secret);
        else res.setHeader('location', prefixLocation(location, secret));
      }
      if (verdict.viaPath) {
        const own = headers?.['set-cookie'] ?? res.getHeader('set-cookie');
        const cookies = [
          ...(own === undefined ? [] : Array.isArray(own) ? own : [own]),
          gateSetCookie(secret),
        ];
        if (headers && 'set-cookie' in headers) headers['set-cookie'] = cookies;
        else res.setHeader('set-cookie', cookies.map(String));
      }
      return writeHead(...args);
    };
    this.deps.target.emit('request', req, res);
  }

  private onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const verdict = gate(req.url ?? '/', req.headers.cookie, this.state.secret);
    if (!verdict.pass || 'redirect' in verdict) return void socket.destroy();
    scrubHeaders(req.headers);
    req.headers['x-forwarded-proto'] = 'https';
    req.url = verdict.url;
    this.deps.target.emit('upgrade', req, socket, head);
  }

  // ── Steps ──

  /** Read-only: is a direct path possible here? (LAN address, router, NAT.) */
  async probe(): Promise<{
    ok: boolean;
    steps: Step[];
    gateway: Gateway | null;
    ip: string | null;
    nat: NatVerdict | null;
    /** WSL NAT: the address that reaches Windows' portproxy from here. */
    relayHost?: string;
  }> {
    if (await this.isRelay()) return this.probeRelay();
    const steps: Step[] = [];
    const lanIp = this.deps.lanIp;
    if (!lanIp) {
      steps.push({
        ok: false,
        text: koText('lan_ip_missing_check'),
      });
      return { ok: false, steps, gateway: null, ip: null, nat: null };
    }
    steps.push({ ok: true, text: koText('lan_ip_is', { ip: lanIp }) });
    const gateway = await this.deps.findGateway(lanIp).catch(() => null);
    const wanIp = gateway ? await gateway.externalIp().catch(() => null) : null;
    const observed = await this.deps.observedIp().catch(() => null);
    const nat = classifyNat({ gateway: gateway !== null, wanIp, observedIp: observed });
    const ip = observed ?? (wanIp && isPublicIpv4(wanIp) ? wanIp : null);
    if (!gateway)
      steps.push({
        ok: false,
        text: nat.reason,
        fix: koText('fix_upnp_or_forward', { port: EXTERNAL_PORT, lan: lanIp, local: this.deps.port }),
      });
    else steps.push({ ok: nat.kind === 'open', text: nat.reason });
    if (observed) steps.push({ ok: true, text: koText('seen_address', { ip: observed }) });
    const ok = gateway ? nat.kind === 'open' : false;
    return { ok, steps, gateway, ip, nat };
  }

  /**
   * WSL NAT (T-0074): no router step from inside WSL. What matters is the
   * public IP (STUN) and whether Windows holds it itself (modem-direct, no
   * router: nothing to forward) or sits behind a router (one port forward
   * the person adds). Read-only.
   */
  private async probeRelay() {
    const port = this.deps.port;
    const steps: Step[] = [
      {
        ok: true,
        text: koText('wsl_nat_note', { external: EXTERNAL_PORT, port }),
      },
    ];
    const observed = await this.deps.observedIp().catch(() => null);
    const ip = observed && isPublicIpv4(observed) ? observed : null;
    const none = { gateway: null, ip: null, nat: null };
    if (!ip) {
      steps.push({
        ok: false,
        text: observed
          ? koText('seen_not_public', { ip: observed })
          : koText('public_ip_unknown_stun'),
        fix: koText('fix_use_tailscale'),
      });
      return { ok: false, steps, ...none };
    }
    steps.push({ ok: true, text: koText('seen_address', { ip }) });
    const windows = await (this.deps.windowsAddresses?.() ?? Promise.resolve(null)).catch(
      () => null,
    );
    // The home LAN, not WSL's own vEthernet (172.16/12).
    const lan = windows?.find((a) => /^(192\.168|10)\./.test(a));
    let relayHost = ip;
    if (windows?.includes(ip))
      steps.push({
        ok: true,
        text: koText('modem_direct', { ip }),
      });
    else if (lan) {
      relayHost = lan;
      steps.push({
        ok: true,
        text: koText('behind_router_wsl', { lan }),
        fix: koText('fix_forward_once', { port: EXTERNAL_PORT, lan }),
      });
    } else
      steps.push({
        ok: true,
        text: koText('windows_address_unreadable'),
      });
    return { ok: true, steps, gateway: null, ip, nat: null, relayHost };
  }

  /**
   * Does a connection to `host`:443 come out at this listener? It counts
   * what the listener accepts, so only the real relay passes (Windows'
   * portproxy and firewall, WSL's localhost forwarding).
   */
  private async relayReaches(host: string): Promise<Step> {
    const dial = this.deps.dial ?? tcpTouch;
    const gap = this.deps.relayGapMs ?? 1000;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, gap));
      const before = this.connections;
      const reached = await dial(host, EXTERNAL_PORT).then(
        () => true,
        () => false,
      );
      for (let i = 0; reached && i < 10 && this.connections === before; i += 1)
        await new Promise((r) => setTimeout(r, 50));
      if (this.connections > before)
        return {
          ok: true,
          text: koText('windows_relay_ok', { host, external: EXTERNAL_PORT, port: this.deps.port }),
        };
    }
    return {
      ok: false,
      text: koText('windows_relay_missing', { external: EXTERNAL_PORT }),
      admin: relayCommands(this.deps.port).add.join('\n'),
      fix: koText('fix_run_powershell'),
    };
  }

  /**
   * Turn direct on: probe, map 443, listen, get the certificate, test. With
   * `manualForward` the user forwarded the port by hand: no UPnP, the
   * certificate check is the test. Serialized with maintenance.
   */
  enable(
    options: { manualForward?: boolean } = {},
  ): Promise<{ ok: boolean; steps: Step[]; url: string | null }> {
    return this.serial(async () => {
      const probe = await this.probe();
      const steps = [...probe.steps];
      // The status endpoint shows this same list while it grows: the wizard's progress.
      this.lastRun = steps;
      const done = (ok: boolean) => {
        this.lastRun = steps;
        return { ok, steps, url: ok ? this.url() : null };
      };
      const lanIp = this.deps.lanIp ?? '';
      const relay = await this.isRelay();
      const wasEnabled = this.state.enabled;
      if (!lanIp && !relay) return done(false);
      const manual = !relay && options.manualForward === true && !probe.gateway;
      if (!probe.ok && !manual) return done(false);
      const ip = probe.ip;
      if (!ip && !this.deps.duck) {
        steps.push({ ok: false, text: koText('public_ip_unknown') });
        return done(false);
      }
      if (probe.gateway) {
        try {
          await probe.gateway.map(this.mapping(lanIp));
          steps.push({
            ok: true,
            text: koText('router_opened', { external: EXTERNAL_PORT, lan: lanIp, port: this.deps.port }),
          });
        } catch (error) {
          steps.push({
            ok: false,
            text: koText('router_refused', { external: EXTERNAL_PORT, why: (error as Error).message }),
            fix: koText('fix_check_443_rule'),
          });
          return done(false);
        }
      } else if (!relay)
        steps.push({
          ok: true,
          text: koText('manual_forward_trusted', { external: EXTERNAL_PORT, lan: lanIp, port: this.deps.port }),
        });
      // A first try that fails leaves nothing open: the router port and the listener close.
      const rollback = async () => {
        if (this.state.enabled) return;
        await probe.gateway?.unmap(this.mapping(lanIp)).catch(() => undefined);
        await this.close();
        if (probe.gateway)
          steps.push({ ok: true, text: koText('router_closed', { external: EXTERNAL_PORT }) });
      };
      try {
        await this.listen();
        steps.push({
          ok: true,
          text: koText('https_listening', { host: await this.listenHost(), port: this.listeningPort() ?? this.deps.port }),
        });
      } catch (error) {
        steps.push({
          ok: false,
          text: koText('listen_failed', { port: this.deps.port, why: (error as Error).message }),
        });
        await rollback();
        return done(false);
      }
      if (relay) {
        // Before Let's Encrypt looks: a missing relay must not spend its failure budget.
        const reach = await this.relayReaches(probe.relayHost ?? ip ?? '');
        steps.push(reach);
        if (!reach.ok) {
          await rollback();
          return done(false);
        }
      }
      this.state.upnp = probe.gateway !== null;
      if (this.deps.duck) {
        this.state.name = this.deps.duck.name;
        if (ip) await this.deps.duck.client.update(ip).catch(() => undefined);
      } else delete this.state.name;
      const identifier = this.deps.duck?.name ?? ip ?? undefined;
      const { notBefore, notAfter, certFor } = this.state;
      // A redeploy runs enable again: a current certificate for the same name stays
      // (Let's Encrypt allows 5 duplicates a week).
      const current =
        identifier !== undefined &&
        certFor === identifier &&
        notBefore !== undefined &&
        notAfter !== undefined &&
        this.now < renewAt(notBefore, notAfter) &&
        this.readCertificate() !== null;
      if (current)
        steps.push({
          ok: true,
          text: koText('cert_kept', { name: identifier }),
        });
      const certified = current || (await this.certify(ip ?? undefined, steps));
      if (!certified) {
        await rollback();
        return done(false);
      }
      this.setIp(ip ?? this.state.ip);
      if (this.deps.duck && this.state.ip) {
        const { ipCertFor, ipNotBefore, ipNotAfter } = this.state;
        const currentIpCertificate =
          ipCertFor === this.state.ip &&
          ipNotBefore !== undefined &&
          ipNotAfter !== undefined &&
          this.now < renewAt(ipNotBefore, ipNotAfter) &&
          this.readCertificate('ip') !== null;
        if (!currentIpCertificate) await this.certifyIp(this.state.ip, steps);
      }
      this.state.enabled = true;
      this.save();
      this.schedule();
      const url = this.url();
      const test = url ? await (this.deps.selfTest ?? hairpinTest)(url) : null;
      if (test) steps.push(test);
      // Never a switch before the outside check passed: a first try that
      // fails it leaves the current connector as it was (no lock-out).
      if (test && !test.ok && !wasEnabled) {
        this.state.enabled = false;
        this.save();
        this.stopTimer();
        for (const host of [this.state.ip, this.state.name]) if (host) this.deps.hosts.delete(host);
        await rollback();
        steps.push({ ok: false, text: koText('outside_check_failed_keep') });
        return done(false);
      }
      return done(true);
    });
  }

  /** Off: unmap (when ours), stop listening, keep the secret and certificate for next time. */
  disable(): Promise<void> {
    return this.serial(async () => {
      this.state.enabled = false;
      this.save();
      this.stopTimer();
      if (this.state.upnp && this.deps.lanIp) {
        const gateway = await this.deps.findGateway(this.deps.lanIp).catch(() => null);
        await gateway?.unmap(this.mapping(this.deps.lanIp)).catch(() => undefined);
      }
      for (const host of [this.state.ip, this.state.name]) if (host) this.deps.hosts.delete(host);
      await this.close();
    });
  }

  /** At daemon start: when direct was on, listen with the saved certificate and keep it fresh. */
  async resume(): Promise<void> {
    if (!this.state.enabled) return;
    for (const host of [this.state.ip, this.state.name]) if (host) this.deps.hosts.add(host);
    await this.listen().catch((error: Error) => this.log(`HTTPS 대기 실패: ${error.message}`));
    this.schedule(5_000);
  }

  /**
   * Every 10 minutes while on: map 443 again (a rebooted router forgot it),
   * notice a new public IP, renew the certificate at two thirds of its life.
   */
  maintain(): Promise<void> {
    return this.serial(async () => {
      if (!this.state.enabled) return;
      const steps: Step[] = [];
      let wanIp: string | null = null;
      if (this.state.upnp && this.deps.lanIp) {
        const gateway = await this.deps.findGateway(this.deps.lanIp).catch(() => null);
        if (gateway) {
          await gateway
            .map(this.mapping(this.deps.lanIp))
            .catch((error: Error) =>
              steps.push({ ok: false, text: koText('reconnect_failed', { why: error.message }) }),
            );
          const wan = await gateway.externalIp().catch(() => null);
          wanIp = wan && isPublicIpv4(wan) ? wan : null;
        } else
          steps.push({
            ok: false,
            text: koText('router_upnp_silent'),
          });
      }
      // What the internet sees wins over what "the router" says, as in probe():
      // any LAN device can answer SSDP, and a new IP rewrites every invitation.
      const observed = await this.deps.observedIp().catch(() => null);
      const ip = observed && isPublicIpv4(observed) ? observed : wanIp;
      if (ip && this.state.ip && ip !== this.state.ip) {
        this.log(`공인 주소가 바뀌었어요: ${this.state.ip} → ${ip}`);
        this.state.previousIp = this.state.ip;
        this.state.ipChangedAt = this.now;
        this.setIp(ip);
        if (this.deps.duck) await this.deps.duck.client.update(ip).catch(() => undefined);
        this.save();
      }
      const { notBefore, notAfter, certFor, name, ipCertFor, ipNotBefore, ipNotAfter } = this.state;
      // An IP certificate names the old IP after a change; any certificate is due at 2/3.
      const stale = !name && certFor !== this.state.ip;
      const due =
        notBefore !== undefined &&
        notAfter !== undefined &&
        this.now >= renewAt(notBefore, notAfter);
      if (stale || due) await this.certify(name ? undefined : this.state.ip, steps);
      if (name && this.state.ip) {
        const ipStale = ipCertFor !== this.state.ip;
        const ipDue =
          ipNotBefore !== undefined &&
          ipNotAfter !== undefined &&
          this.now >= renewAt(ipNotBefore, ipNotAfter);
        if (ipStale || ipDue) await this.certifyIp(this.state.ip, steps);
      }
      if (steps.length > 0) this.lastRun = steps;
      // Not silent: a renewal that keeps failing ends in an expired certificate.
      for (const step of steps) if (!step.ok) this.log(`점검: ✖ ${step.text}`);
    });
  }

  private setIp(ip: string | undefined): void {
    if (!ip || ip === this.state.ip) {
      if (ip) this.deps.hosts.add(ip);
      if (this.state.name) this.deps.hosts.add(this.state.name);
      return;
    }
    if (this.state.ip) this.deps.hosts.delete(this.state.ip);
    this.state.ip = ip;
    this.deps.hosts.add(ip);
    if (this.state.name) this.deps.hosts.add(this.state.name);
  }

  /** Issue (or renew) and install; at most one failed try per hour. */
  private async certify(ip: string | undefined, steps: Step[]): Promise<boolean> {
    if (
      this.state.issueFailedAt &&
      this.now - this.state.issueFailedAt < ISSUE_RETRY_MS &&
      this.state.notAfter
    ) {
      steps.push({ ok: false, text: koText('cert_cooldown') });
      return false;
    }
    try {
      const certificate = await this.deps.issue({
        ...(this.deps.duck ? { name: this.deps.duck.name } : { ip }),
        alpn: this.alpn,
        log: (line) => this.log(line),
      });
      this.install(certificate);
      const until = new Date(certificate.notAfter).toLocaleString('sv-SE', { hour12: false });
      steps.push({
        ok: true,
        text: koText('cert_issued', { name: certificate.identifier, until }),
      });
      return true;
    } catch (error) {
      this.state.issueFailedAt = this.now;
      this.save();
      steps.push({
        ok: false,
        text: koText('letsencrypt_failed', { external: EXTERNAL_PORT, why: (error as Error).message }),
        fix: koText('fix_443_blocked'),
      });
      return false;
    }
  }

  /** The fallback slot in DuckDNS mode: failure must never affect the name certificate. */
  private async certifyIp(ip: string, steps: Step[]): Promise<boolean> {
    if (this.state.ipIssueFailedAt && this.now - this.state.ipIssueFailedAt < ISSUE_RETRY_MS) {
      steps.push({ ok: false, text: koText('ip_cert_warning') });
      return false;
    }
    try {
      const certificate = await this.deps.issue({
        ip,
        alpn: this.alpn,
        log: (line) => this.log(line),
      });
      this.installIp(certificate);
      const until = new Date(certificate.notAfter).toLocaleString('sv-SE', { hour12: false });
      steps.push({
        ok: true,
        text: koText('cert_issued', { name: certificate.identifier, until }),
      });
      return true;
    } catch {
      this.state.ipIssueFailedAt = this.now;
      this.save();
      steps.push({ ok: false, text: koText('ip_cert_warning') });
      return false;
    }
  }

  private schedule(firstMs = MAINTENANCE_MS): void {
    this.stopTimer();
    const run = (delay: number) => {
      this.timer = setTimeout(() => {
        void this.maintain()
          .catch((error: Error) => this.log(`점검 실패: ${error.message}`))
          .finally(() => run(MAINTENANCE_MS));
      }, delay);
      this.timer.unref();
    };
    run(firstMs);
  }

  private stopTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.busy.then(work, work);
    this.busy = next.catch(() => undefined);
    return next;
  }

  async close(): Promise<void> {
    this.stopTimer();
    const server = this.server;
    this.server = null;
    if (!server) return;
    server.closeAllConnections();
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/**
 * The outside path from this PC: the bare address must answer an empty 404
 * and the secret path the login page, over a certificate Node trusts. Many
 * routers don't loop a LAN request back to their own public address
 * (hairpin); then this says so instead of failing -- Let's Encrypt's check
 * already proved the outside reaches us.
 */
export async function hairpinTest(url: string, ca?: string): Promise<Step> {
  const base = new URL(url);
  const get = (path: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = https.get(
        { host: base.hostname, port: base.port || 443, path, ca, agent: false, timeout: 8000 },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => (body += chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
    });
  try {
    const bare = await get('/');
    const inside = await get(base.pathname);
    if (bare.status !== 404 || bare.body !== '')
      return {
        ok: false,
        text: koText('gate_off', { status: bare.status }),
      };
    if (inside.status !== 200 && inside.status !== 401)
      return { ok: false, text: koText('secret_status', { status: inside.status }) };
    return {
      ok: true,
      text: koText('outside_ok'),
    };
  } catch (error) {
    const message = (error as Error).message;
    if (/certificate|self.signed|altname|CERT/i.test(message))
      return { ok: false, text: koText('cert_untrusted', { why: message }) };
    return {
      ok: true,
      text: koText('hairpin_blocked', { why: message }),
    };
  }
}
