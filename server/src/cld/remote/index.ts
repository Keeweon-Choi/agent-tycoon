/**
 * cld remote (T-0024): how devices outside this PC reach the office.
 *
 * Connectors (`--connector`, else `connector` in ~/.config/cld-gui/config.json):
 * - local: loopback only (the host's own browser, SSH tunnels);
 * - lan: plus this PC's LAN address, plain http (codes and QR; no passkeys);
 * - tailscale: loopback behind `tailscale serve`/Funnel (the installer sets it up);
 * - direct: lan plus a public HTTPS listener behind the router (direct.ts).
 *
 * Every connector but local adds listeners that hand their requests to the
 * one Fastify server, so the peer address stays the real one and every
 * non-loopback request is public (auth.ts isPublicRequest). Invitations
 * carry ONE canonical address per host (cldHooks.canonicalUrl): different
 * addresses are different sites to a browser (cookies, storage, the
 * installed web app).
 */
import { execFile } from 'child_process';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as os from 'os';
import * as path from 'path';
import type { Duplex } from 'stream';

import { koText, refused } from '../../../../core/src/cld/serverText.js';
import { CUT_GRACE_MS } from '../../constants.js';
import { bearerTokenValid } from '../../wsAuth.js';
import { auditLog } from '../audit.js';
import { isDirectRequest, isFunnelRequest, isLocalRequest, isPublicListener, isPublicRequest, publicSockets } from '../auth.js';
import { sameOriginRequest } from '../authRoutes.js';
import { cldHooks } from '../hooks.js';
import { STEPUP_REQUIRED } from '../shell/gate.js';
import { acmeDirectory, acmeIssuer, type Certificate, duckDns } from './acme.js';
import { customPreferred, type CustomRecord, customSelfTest, parseCustomUrl, readCustom, writeCustom } from './custom.js';
import {
  DIRECT_PORT,
  DirectConnector,
  type DirectDeps,
  hairpinTest,
  scrubHeaders,
  type Step,
  tcpTouch,
} from './direct.js';
import {
  detectFirewall,
  firewallCommands,
  firewallRules,
  pickLanIp,
  relayCommands,
  sshProbe,
  stunObservedIp,
  windowsAddresses,
  wslSteps,
} from './net.js';
import { scanExisting } from './scan.js';
import { runRemoteSetup, type SetupOutcome } from './setup.js';
import { outsideSelfTest, readRemoteTest, type RemoteTestResult, saveRemoteTest } from './setupTest.js';
import { type QuickTunnel, quickTunnel } from './tunnel.js';
import { findGateway } from './upnp.js';

type SetupFact = import('../../../../core/src/remoteSetupPlan.mjs', { with: { 'resolution-mode': 'import' } }).SetupFact;
type RemoteChoice = import('../../../../core/src/remoteSetupPlan.mjs', { with: { 'resolution-mode': 'import' } }).RemoteChoice;
type ExposureEntry = import('../../../../core/src/exposureLedger.mjs', { with: { 'resolution-mode': 'import' } }).ExposureEntry;
const ledgerLib = () => import('../../../../core/src/exposureLedger.mjs');

function commandOutput(command: string, args: string[], timeout = 5000): Promise<string | null> {
  return new Promise((resolve) => execFile(command, args, { timeout }, (error, stdout) => resolve(error ? null : stdout)));
}

async function installed(command: string): Promise<boolean> {
  return (await commandOutput(process.platform === 'win32' ? 'where' : 'which', [command])) !== null;
}

/** The Mac App Store / standalone app's CLI, not on PATH unless the person linked it. */
const MAC_TAILSCALE = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

export const CONNECTORS = ['local', 'lan', 'tailscale', 'direct'] as const;
export type Connector = (typeof CONNECTORS)[number];
export const isConnector = (value: unknown): value is Connector =>
  (CONNECTORS as readonly unknown[]).includes(value);
export const TAILSCALE_AUTOLOGIN_RETIRED =
  koText('tailscale_autologin_retired');

/** Recognize prior installer spellings without ever using their values. */
export function hasLegacyTailscaleTrust(config: unknown): boolean {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return false;
  return Object.keys(config).some((key) =>
    /(?:tailscale.*(?:trust|user)|(?:trust|user).*tailscale)/i.test(key),
  );
}

/** Plain words for "the last resorts" (the status endpoint and the installer print them). */
export const FALLBACKS = {
  ssh: koText('fallback_ssh'),
  tailscale:
    koText('fallback_tailscale'),
  remoteControl:
    koText('fallback_remote_control'),
};

export interface CanonicalFacts {
  connector: Connector;
  port: number;
  directUrl: string | null;
  tailscaleHost: string | null;
  lanIp: string | null;
  /** O6: the user's own address, once its self-test passed (it wins: they set it up on purpose). */
  customUrl?: string | null;
}

/**
 * The one address for invitations, ending in `/`: the direct URL (secret
 * path included) or the Tailscale name when that path is set up, else the
 * LAN URL, else localhost. An outside path wins even at home, so a device
 * pairs once and keeps working when it leaves.
 */
export function canonicalUrl(f: CanonicalFacts): string {
  if (f.customUrl) return f.customUrl;
  const local = `http://localhost:${f.port}/`;
  const lan = f.lanIp ? `http://${f.lanIp}:${f.port}/` : null;
  if (f.connector === 'direct') return f.directUrl ?? lan ?? local;
  if (f.connector === 'tailscale') return f.tailscaleHost ? `https://${f.tailscaleHost}/` : local;
  if (f.connector === 'lan') return lan ?? local;
  return local;
}

/** Where each connector listens, besides 127.0.0.1:<port> (bind address per connector). */
export function listenPlan(
  connector: Connector,
  lanIp: string | null,
  port: number,
  directPort: number,
): Array<{ kind: 'lan' | 'direct'; host: string; port: number }> {
  if (!lanIp || connector === 'local' || connector === 'tailscale') return [];
  const plan: Array<{ kind: 'lan' | 'direct'; host: string; port: number }> = [
    { kind: 'lan', host: lanIp, port },
  ];
  if (connector === 'direct') plan.push({ kind: 'direct', host: lanIp, port: directPort });
  return plan;
}

/** How a request reached the office (S6): the connection a change could cut. */
export type Exposure = 'local' | 'lan' | 'direct' | 'tailscale' | 'funnel' | 'tunnel';
export interface ExposureState {
  connector: Connector;
  funnel?: boolean;
  tunnel?: boolean;
}

/**
 * The exposures a state keeps open: the listen plan, direct's listener, and
 * what the ledger rules keep (serve/Funnel for tailscale, the quick tunnel).
 * The switch code closes exactly the rest, so "would this cut me?" and "what
 * gets closed" can't disagree.
 */
export function keptExposures(
  state: ExposureState,
  lanIp: string | null,
  port: number,
  directPort: number,
): Set<Exposure> {
  const kept = new Set<Exposure>(['local']);
  for (const listener of listenPlan(state.connector, lanIp, port, directPort)) kept.add(listener.kind);
  if (state.connector === 'direct') kept.add('direct');
  if (state.connector === 'tailscale') kept.add('tailscale');
  if (state.connector === 'tailscale' && state.funnel) kept.add('funnel');
  if (state.tunnel) kept.add('tunnel');
  return kept;
}

/** The ledger file: 0600, written whole through a temp file and a rename. */
function writeLedger(configDir: string, ledger: unknown): void {
  const file = path.join(configDir, 'exposure.json');
  fs.mkdirSync(configDir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** /proc/<pid>/<file>, null when there is none (gone, or not Linux). */
function readProc(pid: number, file: 'stat' | 'cmdline'): string | null {
  try {
    return fs.readFileSync(`/proc/${pid}/${file}`, 'utf8');
  } catch {
    return null;
  }
}

function killPid(pid: number): void {
  try {
    process.kill(pid);
  } catch {
    /* gone already */
  }
}

/** `wslinfo --networking-mode` (nat, mirrored), null outside WSL. */
function detectWslMode(): Promise<string | null> {
  if (process.platform !== 'linux' || !/microsoft/i.test(os.release()))
    return Promise.resolve(null);
  return new Promise((resolve) =>
    execFile('wslinfo', ['--networking-mode'], { timeout: 3000 }, (error, stdout) =>
      resolve(error ? 'nat' : stdout.trim() || 'nat'),
    ),
  );
}

function readJson(file: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Write `key` into the installer's config.json, keeping every other field. */
function writeConfigKey(configDir: string, key: string, value: unknown): void {
  const file = path.join(configDir, 'config.json');
  const config = { ...readJson(file), [key]: value };
  fs.mkdirSync(configDir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

export interface RemoteOptions {
  /** --connector; when absent, config.json's `connector`, else local. */
  connector?: Connector;
  /** --port; unset: the port the server got. */
  port?: number;
  directPort?: number;
  /** The --allowed-host names: the first is the Tailscale (serve/Funnel) name. */
  allowedHosts: readonly string[];
  /** --read-only: sessions may read the status but not enable or test. */
  readOnly: boolean;
  /** ~/.config/cld-gui */
  configDir: string;
  /** The host token, known once the server started (the installer's Bearer requests). */
  token: { current?: string };
  /** A legacy command-line trust option was present and was ignored. */
  legacyTailscaleTrust?: boolean;
  /** Test seam: a fake router, STUN, issuer and self-test, and where to listen. */
  deps?: Partial<
    Pick<
      DirectDeps,
      | 'findGateway'
      | 'observedIp'
      | 'issue'
      | 'selfTest'
      | 'listenHost'
      | 'windowsAddresses'
      | 'dial'
      | 'relayGapMs'
    >
  > & {
    lanIp?: string | null;
    wslMode?: () => Promise<string | null>;
    /** The relay check passes when true: it touches our own listener instead of Windows. */
    relayUp?: () => boolean;
    sshd?: (port: number) => Promise<{ open: boolean; banner: string }>;
    /** `tailscale serve status --json`, parsed; null when it can't be asked. */
    tailscaleServe?: () => Promise<unknown>;
    setupFacts?: () => Promise<SetupFact>;
    setupSelfTest?: (url: string) => Promise<RemoteTestResult>;
    setupCommand?: (command: string, args: string[]) => Promise<string | null>;
    setupTunnel?: (target: http.Server, secret: string) => Promise<QuickTunnel>;
    /** O6: the custom address self-test's fetch. */
    customFetch?: Parameters<typeof customSelfTest>[1];
    /** /proc/<pid>/stat or cmdline (tests: a fake /proc). */
    procFile?: (pid: number, file: 'stat' | 'cmdline') => string | null;
    /** Kill an earlier daemon's cloudflared (only after isOurTunnel said it still is ours). */
    killTunnel?: (pid: number) => void;
    /** The OS the daemon runs on (tests: a fake platform); WSL is wslMode on top of linux. */
    platform?: NodeJS.Platform;
    /** Read a host file (/etc/ufw/ufw.conf, sshd_config); null when unreadable. */
    readFile?: (file: string) => string | null;
    /** Runners: the whole read-only scan's answer. */
    scan?: () => Promise<Step[]>;
  };
}

/** The sshd port the laptop app (T-0023) connects to: config.json `sshPort`, else 22. */
const SSH_PORT = 22;

/**
 * From `tailscale serve status --json`: does tailscaled's HTTPS proxy serve
 * this daemon (and is Funnel on for it)? The installer's funnelServing, HTTP form only.
 */
export function tailscaleServing(
  status: unknown,
  port: number,
): { host: string; funnel: boolean } | null {
  const s = status as {
    Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
    AllowFunnel?: Record<string, boolean>;
  } | null;
  const targets = [
    `http://127.0.0.1:${port}`,
    `http://127.0.0.1:${port}/`,
    `http://localhost:${port}`,
  ];
  for (const [hostPort, web] of Object.entries(s?.Web ?? {})) {
    if (!hostPort.endsWith(':443') || !targets.includes(web?.Handlers?.['/']?.Proxy ?? ''))
      continue;
    return { host: hostPort.slice(0, -4), funnel: s?.AllowFunnel?.[hostPort] === true };
  }
  return null;
}

function tailscaleServeStatus(command = 'tailscale'): Promise<unknown> {
  return new Promise((resolve) =>
    execFile(command, ['serve', 'status', '--json'], { timeout: 5000 }, (error, stdout) => {
      try {
        resolve(error ? null : (JSON.parse(stdout) as unknown));
      } catch {
        resolve(null);
      }
    }),
  );
}

/**
 * Browser runners only (cld/test/run-access.ts): CLD_GUI_TEST_REMOTE names a
 * JSON file of network facts, read on every use so a run can change them
 * mid-way. Nothing real is asked: no router, STUN, CA, Windows or Tailscale.
 * The installer never sets it.
 */
export function testRemoteDeps(file: string | undefined): RemoteOptions['deps'] {
  if (!file) return undefined;
  const facts = () =>
    readJson(file) as {
      wsl?: string | null;
      observedIp?: string | null;
      windows?: string[] | null;
      relay?: boolean;
      selfTest?: Step;
      cert?: Omit<Certificate, 'identifier'>;
      ssh?: { open: boolean; banner: string };
      tailscale?: unknown;
      setup?: SetupFact;
      testResult?: RemoteTestResult;
      existing?: Step[];
    };
  return {
    wslMode: async () => facts().wsl ?? null,
    findGateway: async () => null,
    observedIp: async () => facts().observedIp ?? null,
    windowsAddresses: async () => facts().windows ?? null,
    relayUp: () => facts().relay === true,
    relayGapMs: 50,
    issue: async (request) => {
      const cert = facts().cert;
      if (!cert) throw new Error('Connection refused (fake validation)');
      return { ...cert, identifier: request.ip ?? request.name ?? '' };
    },
    selfTest: async () => facts().selfTest ?? { ok: true, text: koText('fake_outside_check') },
    sshd: async () => facts().ssh ?? { open: false, banner: '' },
    // Nothing served is `{}`; null would mean "status unreadable".
    tailscaleServe: async () => facts().tailscale ?? {},
    setupFacts: async () => facts().setup ?? {
      natKind: 'unknown', upnp: false, wslMode: facts().wsl ?? null,
      relayReady: facts().relay === true, tailscaleInstalled: false,
      tailscaleLoggedIn: false, cloudflaredInstalled: false,
    },
    setupCommand: async (command, args) => {
      if (command === 'tailscale' && args[0] === 'status')
        return facts().setup?.tailscaleLoggedIn
          ? JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'office.test.ts.net.' } }) : null;
      if (command === 'tailscale' && (args[0] === 'serve' || args[0] === 'funnel')) return '';
      return null;
    },
    setupSelfTest: async (url) => facts().testResult ?? {
      ok: true, url, checkedAt: Date.now(), steps: [
        { ok: true, text: koText('setup_health_ok') },
        { ok: true, text: koText('setup_login_ok') },
        { ok: true, text: koText('setup_ws_refused') },
      ],
    },
    setupTunnel: async (_target, secret) => ({ url: `https://fake.trycloudflare.com/${secret}/`, close: async () => undefined }),
    killTunnel: () => undefined,
    scan: async () => facts().existing ?? [],
  };
}

/** Wires cld remote into the server through cldHooks; call before server.start(). */
export function startRemote(opts: RemoteOptions): {
  readonly direct: DirectConnector | null;
  dispose(): Promise<void>;
} {
  const config = readJson(path.join(opts.configDir, 'config.json'));
  if (opts.legacyTailscaleTrust || hasLegacyTailscaleTrust(config))
    console.warn(`[cld auth] ${TAILSCALE_AUTOLOGIN_RETIRED}`);
  let connector: Connector =
    opts.connector ?? (isConnector(config.connector) ? config.connector : 'local');
  const lanIp =
    opts.deps?.lanIp !== undefined
      ? opts.deps.lanIp
      : typeof config.lanIp === 'string' && config.lanIp
        ? config.lanIp
        : pickLanIp();
  const directPort =
    opts.directPort ??
    (Number.isInteger(config.directPort) ? (config.directPort as number) : DIRECT_PORT);
  const tlsDir = path.join(opts.configDir, 'tls');
  const ddns = readJson(path.join(tlsDir, 'ddns.json'));
  let duck =
    typeof ddns.name === 'string' && typeof ddns.token === 'string'
      ? { name: ddns.name, client: duckDns(ddns.name, ddns.token) }
      : undefined;
  // The networking mode can't change under a running daemon: ask wslinfo once.
  let wslKnown: Promise<string | null> | undefined;
  const wslMode = opts.deps?.wslMode ?? (() => (wslKnown ??= detectWslMode()));
  let tailscaleHost = opts.allowedHosts.find((h) => /\.ts\.net\.?$/i.test(h)) ?? null;
  const sshPort = Number.isInteger(config.sshPort) ? (config.sshPort as number) : SSH_PORT;
  /** The person picked a way in (or "나중에"): the start screen stops asking. */
  let accessChosen = config.accessChosen === true;
  const relayMode = async () => (await wslMode()) === 'nat';
  let port = opts.port ?? 0;
  const listeners: http.Server[] = [];
  /** The LAN listener's open sockets, upgraded ones too: closeAllConnections() doesn't reach those. */
  const lanSockets = new Set<Duplex>();
  let direct: DirectConnector | null = null;
  let app: FastifyInstance | null = null;
  let setupRun: SetupOutcome | null = null;
  let setupBusy = false;
  let tunnel: QuickTunnel | null = null;
  /** O6: the user's own HTTPS/VPN address (custom-url.json); the daemon opens nothing for it. */
  let custom: CustomRecord | null = readCustom(opts.configDir);
  /** S6: config.json `funnel` (tailscale serves the internet, not only the tailnet). */
  let funnel = config.funnel === true;
  /** The quick tunnel passed its check and no connector change came after it. */
  let tunnelWanted = false;
  const cutTimers = new Set<NodeJS.Timeout>();
  const ledgerFile = path.join(opts.configDir, 'exposure.json');
  const runCommand = opts.deps?.setupCommand ?? commandOutput;
  const killTunnel = opts.deps?.killTunnel ?? killPid;
  const procFile = opts.deps?.procFile ?? readProc;
  const platform = opts.deps?.platform ?? process.platform;
  const readFile = opts.deps?.readFile ?? readText;
  const state = (): ExposureState => ({ connector, funnel, tunnel: tunnelWanted });
  const kept = (s: ExposureState) => keptExposures(s, lanIp, port, directPort);
  const audit = auditLog(opts.configDir);
  /** O3: the logged-in device behind a request (httpServer hands this over with the routes). */
  let actorOf: ((request: FastifyRequest) => string | undefined) | undefined;
  const exposure = (what: string, on: boolean, reason: string) => {
    audit.write({ kind: 'exposure', detail: `${what} ${on ? 'on' : 'off'}` });
    console.log(`[cld remote] ${what} ${on ? 'on' : 'off'} (${reason})`);
  };

  /** Close a quick tunnel and take its name off the Host allowlist. */
  const closeQuickTunnel = async (closing: QuickTunnel) => {
    await closing.close();
    cldHooks.dropRemoteHost?.(new URL(closing.url).hostname);
  };

  const customHost = () => (custom ? parseCustomUrl(custom.url) : null);
  /** Take the custom name off the Host allowlist, unless another connector answers to the same name. */
  const dropCustomHost = (record: CustomRecord) => {
    const parsed = parseCustomUrl(record.url);
    if (!parsed.ok) return;
    const d = direct?.status();
    const shared = [tailscaleHost, lanIp, d?.ip, d?.name, tunnel ? new URL(tunnel.url).hostname : null];
    if (!shared.some((name) => name?.toLowerCase() === parsed.host.toLowerCase())) cldHooks.dropRemoteHost?.(parsed.host);
  };
  /** Remote access turned off: the address stays on the card but is neither preferred nor an allowed Host. */
  const switchOffCustom = (reason: string) => {
    if (!custom?.active) return;
    dropCustomHost(custom);
    custom = { ...custom, active: false, test: null };
    writeCustom(opts.configDir, custom);
    exposure('custom address', false, reason);
  };

  const facts = (): CanonicalFacts => ({
    connector,
    port,
    directUrl: direct?.url() ?? null,
    tailscaleHost,
    lanIp,
    customUrl: customPreferred(custom) ?? null,
  });
  cldHooks.canonicalUrl = () => canonicalUrl(facts());
  // No trailing slash, like the canonical address: links are built as `${url}/login?...`.
  const verifiedOutsideUrl = () => outsideUrl()?.replace(/\/+$/, '');
  const outsideUrl = () => {
    const own = customPreferred(custom);
    if (own) return own;
    if (connector === 'direct' && direct?.enabled && direct.url()) return direct.url() ?? undefined;
    const saved = readRemoteTest(opts.configDir);
    if (!saved?.ok) return undefined;
    const active = [connector === 'direct' ? direct?.url() : null,
      connector === 'tailscale' && tailscaleHost ? `https://${tailscaleHost}/` : null, tunnel?.url];
    return active.includes(saved.url) ? saved.url : undefined;
  };
  cldHooks.verifiedOutsideUrl = verifiedOutsideUrl;

  const startLan = (fastify: FastifyInstance, reason: string) => {
    if (!lanIp || listeners.length > 0) return;
    exposure('lan', true, reason);
    const server = http.createServer();
    server.keepAliveTimeout = 30_000;
    server.headersTimeout = 20_000;
    // Public by this listener, whatever the peer (T-0074: a portproxy relays from 127.0.0.1).
    server.on('connection', (socket) => {
      publicSockets.add(socket);
      lanSockets.add(socket);
      socket.once('close', () => lanSockets.delete(socket));
    });
    server.on('request', (req, res) => {
      scrubHeaders(req.headers);
      fastify.server.emit('request', req, res);
    });
    server.on('upgrade', (req, socket, head) => {
      scrubHeaders(req.headers);
      fastify.server.emit('upgrade', req, socket, head);
    });
    server.on('error', (error) =>
      console.warn(`[cld remote] LAN ${lanIp}:${port}: ${error.message}`),
    );
    server.listen(port, lanIp, () => console.log(`[cld remote] LAN: http://${lanIp}:${port}/`));
    listeners.push(server);
  };
  /** `now`: drop open connections too; else in-flight requests (this switch's own) finish. */
  const stopLan = (reason?: string, now = false) => {
    if (reason && listeners.length > 0) exposure('lan', false, reason);
    for (const server of listeners.splice(0)) {
      server.close();
      if (now) server.closeAllConnections();
      else server.closeIdleConnections();
    }
    // Upgraded sockets (/ws, chat, shell) live outside the server's own bookkeeping. reconcile never
    // closes the listener a request is still answering on (`skip`), so ending them all is safe.
    for (const socket of lanSockets) socket.destroy();
    lanSockets.clear();
  };

  cldHooks.onListening = ({ app: fastify, allowedHostnames }) => {
    app = fastify;
    port = (fastify.server.address() as AddressInfo).port;
    if (lanIp) allowedHostnames.add(lanIp);
    const own = custom?.active ? customHost() : null;
    if (own?.ok) cldHooks.allowRemoteHost?.(own.host);
    direct = new DirectConnector({
      dir: tlsDir,
      lanIp,
      port: directPort,
      target: fastify.server,
      hosts: allowedHostnames,
      findGateway: (bindAddress) => findGateway({ bindAddress }),
      observedIp: () => stunObservedIp(),
      issue: acmeIssuer({
        dir: tlsDir,
        directoryUrl: acmeDirectory(process.env.CLD_GUI_ACME_DIRECTORY),
        duck: duck?.client,
      }),
      duck,
      relay: relayMode,
      windowsAddresses,
      ...opts.deps,
      ...(opts.deps?.relayUp
        ? {
            dial: async () => {
              if (!opts.deps?.relayUp?.()) throw new Error('connection refused');
              await tcpTouch('127.0.0.1', direct?.listeningPort() ?? 0);
            },
          }
        : {}),
    });
    const plan = listenPlan(connector, lanIp, port, directPort);
    if (plan.some((l) => l.kind === 'lan')) startLan(fastify, 'startup');
    if (plan.some((l) => l.kind === 'direct')) void direct.resume();
    // Switched away (the installer's --connector): close the router's port too.
    else if (direct.enabled) void closeDirect(`startup, connector ${connector}`);
    // What an earlier run opened that this connector does not want (S6, T10).
    void revertLedger(null, 'startup').catch((error: Error) =>
      console.warn(`[cld remote] exposure ledger at startup: ${error.message}`),
    );
    // The secret path never goes to the journal; the installer and the app show it.
    const shown = canonicalUrl(facts()).replaceAll(direct.secret, '<비밀 경로>');
    console.log(`[cld remote] connector ${connector}: ${shown}`);
  };

  const isHost = (request: FastifyRequest) =>
    !isPublicRequest(request.headers, request.socket) &&
    !!opts.token.current &&
    bearerTokenValid(request.headers.authorization, opts.token.current);
  const localPage = isLocalRequest;
  /** A logged-in device's change must come from its own page (a sibling *.ts.net page shares the site). */
  const fromPage = (request: FastifyRequest, reply: FastifyReply) => {
    if (isHost(request) || sameOriginRequest(request)) return true;
    void reply.code(403).send({ error: 'forbidden origin' });
    return false;
  };
  /** Changing the connector: the host, or a logged-in device when actions are allowed. */
  const mayAct = (request: FastifyRequest, reply: FastifyReply) => {
    if (!fromPage(request, reply)) return false;
    if (isHost(request) || !opts.readOnly) return true;
    void reply.code(403).send({ ...refused('remote_read_only') });
    return false;
  };

  const tsCommand = async () => {
    if ((await wslMode()) && (await installed('tailscale.exe'))) return 'tailscale.exe';
    if (platform === 'darwin' && !(await installed('tailscale')) && fs.existsSync(MAC_TAILSCALE)) return MAC_TAILSCALE;
    return 'tailscale';
  };
  const serveStatus = async () => (opts.deps?.tailscaleServe ?? (async () => tailscaleServeStatus(await tsCommand())))();
  const serving = async () => tailscaleServing(await serveStatus(), port);

  /** S6 exposure ledger: one entry per slot, re-read each time (the installer writes it too). */
  const ledger = async () => {
    const lib = await ledgerLib();
    let text: string | null = null;
    try { text = fs.readFileSync(ledgerFile, 'utf8'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`[cld remote] exposure ledger: cannot read ${ledgerFile}: ${(error as Error).message}; left as is`);
        return { lib, current: null };
      }
    }
    const current = lib.parseLedger(text);
    if (current) return { lib, current };
    // Broken, newer or unknown: it may record a live exposure, so it is kept (moved aside), never overwritten.
    const aside = lib.badLedgerPath(ledgerFile);
    try { fs.renameSync(ledgerFile, aside); }
    catch (error) {
      console.warn(`[cld remote] exposure ledger: ${ledgerFile} is not one this version reads and could not be moved aside (${(error as Error).message}); left as is, nothing recorded`);
      return { lib, current: null };
    }
    console.warn(`[cld remote] exposure ledger: ${ledgerFile} is not one this version reads; moved to ${aside}. Check what it records (tailscale serve status, cloudflared, Windows portproxy) and undo it by hand`);
    return { lib, current: lib.emptyLedger() };
  };
  const record = async (entry: ExposureEntry) => {
    const { lib, current } = await ledger();
    if (!current) return;
    try { writeLedger(opts.configDir, lib.addEntry(current, entry)); }
    catch (error) { console.warn(`[cld remote] exposure ledger: ${(error as Error).message}`); }
  };
  const forget = async (entry: ExposureEntry) => {
    const { lib, current } = await ledger();
    if (!current) return;
    try { writeLedger(opts.configDir, lib.removeEntry(current, entry)); }
    catch (error) { console.warn(`[cld remote] exposure ledger: ${(error as Error).message}`); }
  };
  /** Our https:443 handler now: null (none), 'foreign' (it proxies elsewhere), 'unknown' (status unreadable), or ours. */
  const handler443 = async (forPort = port): Promise<null | 'foreign' | 'unknown' | { host: string; funnel: boolean }> => {
    const status = await serveStatus();
    if (status === null || status === undefined) return 'unknown';
    const ours = tailscaleServing(status, forPort);
    if (ours) return ours;
    const web = (status as { Web?: Record<string, unknown> } | null)?.Web ?? {};
    return Object.keys(web).some((hostPort) => hostPort.endsWith(':443')) ? 'foreign' : null;
  };
  /**
   * Drive our https:443 handler to serve-only or Funnel in place, reading
   * `tailscale serve status --json` after every command. Serve and Funnel are
   * one handler: on tailscale 1.104.2 `funnel --https=443 off` was seen to
   * remove the WHOLE handler, so a switch is never "set up the new, revert the
   * old". Whether `serve --bg` on a funneled port clears Funnel is not known;
   * both outcomes end right. UNVERIFIED against the real binary: the tests use
   * a fake modelled on what was observed. A handler that is not ours (or one
   * we cannot read) is never touched, and every command that succeeded is in
   * the ledger before anything is verified: a failed check never leaves an
   * exposure nobody recorded (later changes, startup and uninstall revert it).
   */
  const convergeTailscale = async (wantFunnel: boolean, host: string): Promise<{ host: string } | { step: Step }> => {
    const cmd = await tsCommand();
    const target = `http://127.0.0.1:${port}`;
    const failed = (text: string): { step: Step } => ({ step: { ok: false, text } });
    const run = async (args: string[], recordAs?: boolean) => {
      const out = await runCommand(cmd, args);
      if (out !== null && recordAs !== undefined)
        await record({ kind: 'tailscale', host, port, funnel: recordAs, by: 'daemon', at: Date.now() });
      return out;
    };
    const before = await handler443();
    if (before === 'foreign') return failed(koText('ts_foreign'));
    if (before === 'unknown') return failed(koText('ts_unreadable'));
    if (wantFunnel) {
      if ((await run(['funnel', '--bg', '--https=443', target], true)) === null)
        return { step: { ok: false, text: koText('ts_funnel_failed'), actions: [
          { kind: 'open', url: 'https://login.tailscale.com/admin/acls/file', label: koText('ts_open_console') },
        ] } };
    } else {
      // Recorded as Funnel when it was Funnel before: `serve --bg` may leave Funnel on.
      if ((await run(['serve', '--bg', '--https=443', target], before?.funnel === true)) === null)
        return failed(koText('ts_serve_failed'));
      const after = await handler443();
      if (after && after !== 'foreign' && after !== 'unknown' && after.funnel) {
        // Still public: Funnel off (this may drop the whole handler), then Serve again if it went.
        if ((await run(['funnel', '--https=443', 'off'])) === null) return failed(koText('ts_funnel_off_failed'));
        if ((await handler443()) === null && (await run(['serve', '--bg', '--https=443', target], false)) === null)
          return failed(koText('ts_serve_again_failed'));
      }
    }
    const live = await handler443();
    if (live && live !== 'foreign' && live !== 'unknown')
      await record({ kind: 'tailscale', host: live.host, port, funnel: live.funnel, by: 'daemon', at: Date.now() });
    if (!live || live === 'foreign' || live === 'unknown' || live.funnel !== wantFunnel)
      return failed(wantFunnel ? koText('ts_funnel_unverified') : koText('ts_serve_unverified'));
    return { host: live.host };
  };
  /** The host firewall in front of `ports` here, its commands, and our Windows rules as they stand (null: unreadable or not Windows). */
  const hostFirewall = async (ports: number[]) => {
    const kind = await detectFirewall({ platform, wslMode: await wslMode(), run: runCommand, read: readFile });
    if (!kind) return null;
    const commands = firewallCommands(kind, ports);
    return { kind, commands, rules: commands.names ? await firewallRules(runCommand) : null };
  };
  /** Ports the person said they opened in a firewall we cannot read (config.json `firewallAck`). */
  const firewallAck = () => {
    const ack = readJson(path.join(opts.configDir, 'config.json')).firewallAck as { kind?: unknown; ports?: unknown } | undefined;
    return ack && typeof ack.kind === 'string' && Array.isArray(ack.ports) ? { kind: ack.kind, ports: ack.ports.filter(Number.isInteger) as number[] } : null;
  };
  /**
   * Everything outside closed: what this PC could not undo itself, as steps
   * with the exact commands (the firewall rules the person added, a router
   * forward made by hand). The portproxy comes from the ledger (revertLedger).
   */
  const leftBehind = async (handForward: boolean): Promise<Step[]> => {
    const steps: Step[] = [];
    const fw = await hostFirewall([port, directPort]).catch(() => null);
    const ack = firewallAck();
    let remove: string[] = [];
    if (fw?.commands.names && fw.rules) {
      const present = fw.commands.names.map((name, i) => (fw.rules ?? []).includes(name) ? i : -1).filter((i) => i >= 0);
      remove = present.map((i) => fw.commands.remove[i]);
    } else if (fw?.commands.names) {
      // Unreadable: every line, each quiet when its rule is not there.
      remove = fw.commands.remove;
      if (ack) writeConfigKey(opts.configDir, 'firewallAck', null);
    } else if (fw && ack?.kind === fw.kind && ack.ports.length) {
      remove = firewallCommands(fw.kind, ack.ports).remove;
      writeConfigKey(opts.configDir, 'firewallAck', null);
    }
    if (fw && remove.length)
      steps.push({
        ok: false,
        text: koText('firewall_left'),
        guide: koText(fw.commands.names ? 'run_admin_powershell' : 'run_terminal'),
        actions: [{ kind: 'copy', text: remove.join('\n'), label: koText('copy_undo_command') }],
      });
    if (handForward) steps.push({ ok: false, text: koText('router_forward_left') });
    return steps;
  };
  const closeDirect = async (reason: string) => {
    if (!direct?.enabled) return;
    await direct.disable();
    exposure('direct', false, reason);
  };
  /**
   * Undo every ledger entry the current state does not want. Serve/Funnel goes
   * off only while it still proxies to the port we recorded (someone else's
   * serve config is never touched); with tailscale still the connector it is
   * reconfigured in place instead (convergeTailscale). A portproxy needs an
   * administrator, so it comes back as a step with the commands. `skip`: the
   * request's own way in.
   */
  const revertLedger = async (skip: Exposure | null, reason: string): Promise<Step[]> => {
    const { lib, current } = await ledger();
    const steps: Step[] = [];
    for (const entry of current ? lib.unwantedEntries(current, state()) : []) {
      if (entry.kind === 'tailscale') {
        if (skip === 'tailscale' || skip === 'funnel') continue;
        const live = await handler443(entry.port);
        if (live === 'unknown') {
          console.warn(`[cld remote] tailscale: serve status unreadable (${reason}); kept in the ledger`);
          continue;
        }
        if (!live || live === 'foreign') {
          console.log(`[cld remote] tailscale: https 443 no longer points at port ${entry.port}; left as is (${reason})`);
        } else if (connector === 'tailscale' && entry.port === port) {
          // The same handler with the other Funnel flag: reconfigure in place, never off.
          const done = await convergeTailscale(funnel, entry.host);
          if ('step' in done) {
            console.warn(`[cld remote] tailscale: ${done.step.text} (${reason}); kept in the ledger`);
            continue;
          }
          await record({ ...entry, funnel, at: Date.now() });
          exposure(funnel ? 'tailscale funnel' : 'tailscale serve', true, `${reason}, reconfigured in place`);
          continue;
        } else {
          // Off by what is live, not what was recorded. UNVERIFIED against the real
          // binary: on 1.104.2 `funnel --https=443 off` was seen to drop the whole handler.
          const what = live.funnel ? 'tailscale funnel' : 'tailscale serve';
          const off = await runCommand(await tsCommand(), lib.tailscaleOffArgs({ ...entry, funnel: live.funnel }));
          const left = await handler443(entry.port);
          if (off === null || left === 'unknown' || (left && left !== 'foreign')) {
            console.warn(`[cld remote] ${what}: could not turn it off (${reason}); kept in the ledger`);
            continue;
          }
          exposure(what, false, reason);
        }
      } else if (entry.kind === 'tunnel') {
        if (skip === 'tunnel') continue;
        if (tunnel && tunnel.url === entry.url) {
          await closeQuickTunnel(tunnel);
          tunnel = null;
        } else if (entry.pid && lib.isOurTunnel(entry, { stat: procFile(entry.pid, 'stat'), cmdline: procFile(entry.pid, 'cmdline') })) {
          killTunnel(entry.pid);
        } else {
          // Most likely a reused pid (our child dies with the daemon): never kill it.
          console.log(`[cld remote] tunnel: pid ${entry.pid ?? '?'} is not our cloudflared any more; entry dropped, nothing killed (${reason})`);
          await forget(entry);
          continue;
        }
        exposure('tunnel', false, reason);
      } else {
        const remove = relayCommands(entry.directPort, entry.externalPort).remove.join('\n');
        steps.push({
          ok: false,
          text: koText('portproxy_cannot_remove'),
          guide: koText('run_admin_powershell'),
          actions: [{ kind: 'copy', text: remove, label: koText('copy_undo_command') }],
        });
        exposure('portproxy', false, `${reason}; Windows 관리자 PowerShell 에서 실행: ${remove.replaceAll('\n', ' ; ')}`);
      }
      await forget(entry);
    }
    return steps;
  };
  /** Close what the current state does not keep, except `skip`. */
  const reconcile = async (skip: Exposure | null, reason: string): Promise<Step[]> => {
    const keep = kept(state());
    const closing = (what: Exposure) => what !== skip && !keep.has(what);
    // Everything this PC listened on outside is going: say what only the person can undo.
    const allClosing = !keep.has('lan') && !keep.has('direct') && (listeners.length > 0 || !!direct?.enabled);
    const handForward = closing('direct') && !!direct?.enabled && !direct.status().upnp;
    if (closing('lan')) stopLan(reason);
    if (closing('direct')) await closeDirect(reason);
    const steps = await revertLedger(skip, reason);
    if (allClosing) steps.push(...(await leftBehind(handForward)));
    if (closing('tunnel') && tunnel) {
      await closeQuickTunnel(tunnel);
      tunnel = null;
      exposure('tunnel', false, reason);
    }
    return steps;
  };
  /**
   * After a change: close the rest now; the request's own way in only
   * CUT_GRACE_MS later, so the answer reaches the page and it can move.
   */
  const settle = async (via: Exposure, reason: string): Promise<Step[]> => {
    const steps = await reconcile(via, reason);
    if (!kept(state()).has(via)) {
      const timer = setTimeout(() => {
        cutTimers.delete(timer);
        void reconcile(null, `${reason}, after the grace`).catch((error: Error) =>
          console.warn(`[cld remote] closing ${via}: ${error.message}`),
        );
      }, CUT_GRACE_MS);
      cutTimers.add(timer);
    }
    return steps;
  };
  /** Which exposure a request came through; a forged Host only changes whether we ask. */
  const viaOf = (request: FastifyRequest): Exposure => {
    const socket = request.socket as { localPort?: number } | undefined;
    // The listener decides first: headers are the client's, and may only ADD a question.
    if (isDirectRequest(socket)) return 'direct';
    if (isPublicListener(socket))
      // The LAN listener or the quick tunnel's own (told apart by the port it accepted on).
      return tunnel?.localPort !== undefined && socket?.localPort === tunnel.localPort ? 'tunnel' : 'lan';
    // The loopback main listener: this PC, or a proxy (tailscale serve) named by its Host.
    const host = (request.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
    if (tailscaleHost && host === tailscaleHost.toLowerCase())
      return isFunnelRequest(request.headers) ? 'funnel' : 'tailscale';
    if (tunnel && host === new URL(tunnel.url).hostname) return 'tunnel';
    if (lanIp && host === lanIp) return 'lan';
    return 'local';
  };
  /**
   * S6: a change that would close the request's own way in needs
   * `confirmCut: true`; without it, 409 and nothing changes. Returns the way
   * in, or null once it answered.
   */
  const guardCut = (request: FastifyRequest, reply: FastifyReply, target: ExposureState, to: string): Exposure | null => {
    const via = viaOf(request);
    if (kept(target).has(via) || (request.body as { confirmCut?: unknown } | undefined)?.confirmCut === true) return via;
    void reply.code(409).send({ error: 'cut', via, to });
    return null;
  };
  /** The read-only scan (scan.ts) over this daemon's own seams. */
  const existing = async (sshOnly: boolean) => {
    const mode = await wslMode();
    const own = Object.values(os.networkInterfaces()).flat().map((i) => i?.address).filter((a): a is string => !!a);
    return scanExisting({
      platform,
      wslMode: mode,
      port,
      directPort,
      user: os.userInfo().username,
      lanIp: mode === 'nat' ? null : lanIp,
      ownAddresses: own,
      run: runCommand,
      read: readFile,
      sshd: opts.deps?.sshd ?? sshProbe,
      touch: (host, p) => (opts.deps?.dial ?? tcpTouch)(host, p).then(() => true, () => false),
      windowsAddresses: async () => (await (opts.deps?.windowsAddresses ?? windowsAddresses)()) ?? null,
      gateway: async () => (lanIp ? (opts.deps?.findGateway ?? ((ip: string) => findGateway({ bindAddress: ip })))(lanIp) : null),
      tailscale: async () => {
        const text = await runCommand(await tsCommand(), ['status', '--json']);
        const status = text ? (JSON.parse(text) as { BackendState?: string; Self?: { DNSName?: string } }) : null;
        const host = status?.BackendState === 'Running' ? status.Self?.DNSName?.replace(/\.$/, '') : undefined;
        return host ? { host, serving: !!(await serving()) } : null;
      },
      duckName: duck?.name ?? null,
      ownTunnelPid: tunnel?.pid,
      sshOnly,
    });
  };
  const sshStatus = async () => ({
    port: sshPort,
    ...(await (opts.deps?.sshd ?? sshProbe)(sshPort)),
    user: os.userInfo().username,
  });

  /** `access`: the 접속 방식 screen's live checks too (sshd, tailscale serve). */
  const status = async (request: FastifyRequest, access: boolean) => {
    const mode = await wslMode();
    const savedTest = readRemoteTest(opts.configDir);
    const activeUrls = [connector === 'direct' ? direct?.url() : null,
      connector === 'tailscale' && tailscaleHost ? `https://${tailscaleHost}/` : null, tunnel?.url];
    return {
      connector,
      canonicalUrl: canonicalUrl(facts()),
      lanUrl: lanIp ? `http://${lanIp}:${port}/` : null,
      tailscaleHost,
      direct: direct?.status() ?? null,
      wsl: mode ? { mode, steps: wslSteps(mode, [port, directPort]) } : null,
      fallbacks: FALLBACKS,
      setup: setupRun,
      custom: custom && { url: custom.url, active: custom.active, test: custom.test, preferred: !!customPreferred(custom) },
      remoteTest: savedTest && activeUrls.includes(savedTest.url) ? savedTest : null,
      /** This device may switch connectors (the same gate as enable). */
      mayAct: isHost(request) || !opts.readOnly,
      maySetup: isHost(request) || localPage(request) || !opts.readOnly,
      /** Show the start screen: nothing but this PC and the LAN chosen yet. */
      start: !accessChosen && (connector === 'local' || connector === 'lan'),
      ...(access
        ? {
            relay: mode === 'nat' ? relayCommands(directPort) : null,
            ssh: await sshStatus(),
            tailscale: tailscaleHost ? { host: tailscaleHost, serving: await serving() } : null,
          }
        : {}),
    };
  };
  const choose = (wanted: Connector, why: { route: string; via: Exposure; request: FastifyRequest }, nextFunnel = false) => {
    const from = connector === 'tailscale' && funnel ? 'tailscale funnel' : connector;
    connector = wanted;
    funnel = wanted === 'tailscale' && nextFunnel;
    tunnelWanted = false;
    if (wanted === 'local') switchOffCustom(`connector ${from} → local`);
    accessChosen = true;
    writeConfigKey(opts.configDir, 'connector', wanted);
    writeConfigKey(opts.configDir, 'funnel', funnel);
    writeConfigKey(opts.configDir, 'accessChosen', true);
    const to = funnel ? 'tailscale funnel' : wanted;
    audit.write({ kind: 'connector', detail: `${from}>${to}`, ...actorContext(why.request) });
    console.log(`[cld remote] connector ${from} → ${to} (${why.route}; via ${why.via}${isHost(why.request) ? '; host token' : ''})`);
  };

  /** O3: who asked and how the request came in, for the record. */
  const actorContext = (request: FastifyRequest) => {
    const via = viaOf(request);
    return {
      by: isHost(request) ? 'host' : actorOf?.(request),
      via: via === 'local' ? ('local' as const) : via === 'lan' ? ('lan' as const) : ('remote' as const),
      peer: request.socket.remoteAddress,
    };
  };

  const previous = cldHooks.registerRoutes;
  cldHooks.registerRoutes = (fastify, auth, stepUpFresh, actor) => {
    actorOf = actor;
    previous?.(fastify, auth, stepUpFresh, actor);
    /** S1: opening something wider (or a new secret path) needs a fresh step-up; the host's Bearer token does not. True: it answered. */
    const needStepUp = (request: FastifyRequest, reply: FastifyReply, target: ExposureState | 'always') => {
      const now = kept(state());
      const wider = target === 'always' || [...kept(target)].some((e) => !now.has(e));
      if (!wider || isHost(request) || stepUpFresh?.(request)) return false;
      void reply.code(403).send({ error: STEPUP_REQUIRED });
      return true;
    };
    fastify.get<{ Querystring: { access?: string } }>(
      '/api/cld/connector',
      { preHandler: auth },
      async (request) => status(request, request.query.access === '1'),
    );

    // "나중에" on the start screen: stop asking; the connector stays.
    fastify.post('/api/cld/connector/chosen', { preHandler: auth }, async (request, reply) => {
      if (!fromPage(request, reply)) return reply;
      if (!localPage(request) && !mayAct(request, reply)) return reply;
      accessChosen = true;
      writeConfigKey(opts.configDir, 'accessChosen', true);
      return { ok: true };
    });

    fastify.post('/api/cld/connector/probe', { preHandler: auth }, async (request, reply) => {
      if (!mayAct(request, reply)) return reply;
      if (!direct) return reply.code(503).send({ ...refused('still_starting') });
      const probe = await direct.probe();
      const wsl = await wslMode();
      return {
        ok: probe.ok,
        steps: probe.steps,
        nat: probe.nat,
        wsl,
        relay: wsl === 'nat' ? relayCommands(directPort) : null,
      };
    });

    fastify.post<{
      Body: { connector?: unknown; options?: { manualForward?: unknown }; confirmCut?: unknown } | undefined;
    }>('/api/cld/connector/enable', { preHandler: auth }, async (request, reply) => {
      if (!mayAct(request, reply)) return reply;
      const wanted = request.body?.connector;
      if (!isConnector(wanted))
        return reply.code(400).send({ error: 'connector: local|lan|tailscale|direct' });
      if (!direct || !app) return reply.code(503).send({ ...refused('still_starting') });
      const target = { connector: wanted, funnel: wanted === 'tailscale' && funnel };
      if (needStepUp(request, reply, target)) return reply;
      const via = guardCut(request, reply, target, wanted);
      if (!via) return reply;
      let result: { ok: boolean; steps: Step[]; url?: string | null };
      let nextFunnel = false;
      const setup = {
        ok: false,
        text: koText('ts_setup_on_host'),
        admin: 'node cld/install/install.mjs --remote --connector tailscale',
      };
      if (wanted === 'tailscale') {
        // Back to an existing `tailscale serve`: only once it still serves this
        // daemon. Setting it up (the CLI, the service's --allowed-host flag)
        // lives with the installer.
        const live = tailscaleHost ? await serving() : null;
        if (live) {
          nextFunnel = live.funnel;
          // The ledger follows what is live, or the settle below would undo it.
          const recorded = (await ledger()).current?.entries.find((e) => e.kind === 'tailscale');
          if (recorded?.kind === 'tailscale' && recorded.funnel !== live.funnel) await record({ ...recorded, funnel: live.funnel });
          result = {
            ok: true,
            steps: [
              {
                ok: true,
                text: koText(live.funnel ? 'ts_serving_funnel' : 'ts_serving', { host: live.host }),
              },
            ],
          };
        } else
          result = {
            ok: false,
            steps: [
              ...(tailscaleHost
                ? [
                    {
                      ok: false,
                      text: koText('ts_not_serving_host', { host: tailscaleHost }),
                    },
                  ]
                : []),
              setup,
            ],
          };
      } else if (wanted === 'direct') {
        result = await direct.enable({
          manualForward: request.body?.options?.manualForward === true,
        });
        // The LAN only once direct is really on (not behind WSL NAT, where
        // nothing reaches it): a failed try changes no exposure.
        if (result.ok) exposure('direct', true, 'enable');
        if (result.ok && !(await relayMode())) startLan(app, 'enable direct');
        if (result.ok && (await relayMode()))
          await record({ kind: 'portproxy', externalPort: 443, directPort, by: 'user', at: Date.now() });
      } else if (wanted === 'lan' && (await relayMode())) {
        result = {
          ok: false,
          steps: [
            {
              ok: false,
              text: koText('wsl_nat_lan'),
              fix: wslSteps('nat', [port, directPort]).slice(1).join('\n'),
            },
          ],
        };
      } else if (wanted === 'lan' && !lanIp) {
        result = { ok: false, steps: [{ ok: false, text: koText('lan_ip_missing') }] };
      } else {
        // Only the listeners the new connector has stay open (settle below).
        if (wanted === 'lan') startLan(app, 'enable lan');
        result = { ok: true, steps: [{ ok: true, text: koText('connector_is', { name: wanted }) }] };
      }
      if (result.ok) {
        choose(wanted, { route: 'enable', via, request }, nextFunnel);
        result.steps.push(...(await settle(via, `enable ${wanted}`)));
      }
      return { ...result, connector, url: canonicalUrl(facts()) };
    });

    fastify.post('/api/cld/connector/selftest', { preHandler: auth }, async (request, reply) => {
      if (!mayAct(request, reply)) return reply;
      const url = direct?.url();
      if (connector === 'direct' && url)
        return { steps: [await (opts.deps?.selfTest ?? hairpinTest)(url)] };
      if (connector === 'tailscale') {
        const live = await serving();
        return {
          steps: [
            live
              ? { ok: true, text: koText('ts_serving_short', { host: live.host }) }
              : { ok: false, text: koText('ts_not_serving') },
          ],
        };
      }
      return {
        steps: [{ ok: true, text: koText('connector_check_installer', { name: connector }) }],
      };
    });

    fastify.post<{ Body: { choice?: RemoteChoice; duckdnsName?: string; duckdnsToken?: string; confirmCut?: boolean; firewallDone?: boolean } | undefined }>(
      '/api/cld/connector/setup', { preHandler: auth }, async (request, reply) => {
        if (!fromPage(request, reply)) return reply;
        if (!localPage(request) && !mayAct(request, reply)) return reply;
        const { REMOTE_CHOICES } = await import('../../../../core/src/remoteSetupPlan.mjs');
        const choice = request.body?.choice;
        if (!choice || !REMOTE_CHOICES.includes(choice)) return reply.code(400).send({ ...refused('pick_connector') });
        if (setupBusy) return reply.code(409).send({ ...refused('already_checking') });
        if (!direct || !app) return reply.code(503).send({ ...refused('still_starting') });
        // The state this choice ends in, for the cut guard (ssh changes nothing here).
        const target: ExposureState | null =
          choice === 'ssh' ? null
          // The temporary address replaces the other outside paths: only this PC + the tunnel (a restart leaves local).
          : choice === 'tunnel' ? { connector: 'local', tunnel: true }
          : { connector: choice === 'duckdns' ? 'direct' : choice === 'funnel' ? 'tailscale' : choice, funnel: choice === 'funnel' };
        // S-22: a new DuckDNS name or token repoints future invitations, even when direct is already on.
        const duckChange = choice === 'duckdns' && !!(request.body?.duckdnsName || request.body?.duckdnsToken);
        if (target && needStepUp(request, reply, duckChange ? 'always' : target)) return reply;
        const via = target ? guardCut(request, reply, target, choice) : viaOf(request);
        if (!via) return reply;
        const why = { route: `setup ${choice}`, via, request };
        const cleanup: Step[] = [];
        setupBusy = true;
        setupRun = { ok: false, steps: [] };
        try {
          const command = runCommand;
          const mode = await wslMode();
          const tailscaleCommand = await tsCommand();
          const probe = (choice === 'direct' || choice === 'duckdns') && !opts.deps?.setupFacts ? await direct.probe() : null;
          const tsText = await command(tailscaleCommand, ['status', '--json']);
          let ts: { BackendState?: string; Self?: { DNSName?: string; CapMap?: Record<string, unknown> } } = {};
          try { ts = JSON.parse(tsText ?? '{}') as typeof ts; } catch { /* not logged in */ }
          const live = await serving();
          const relayText = mode === 'nat' ? await command('netsh.exe', ['interface', 'portproxy', 'show', 'v4tov4']) : null;
          // The firewall in front of the listener this choice opens: Windows rules are read back, the rest acknowledged.
          const fw = choice === 'lan' || choice === 'direct' || choice === 'duckdns'
            ? await hostFirewall(choice === 'lan' ? [port] : [port, directPort]) : null;
          const fwPorts = choice === 'lan' ? [port] : [port, directPort];
          // Confirmed by hand: any rule nothing here can read back (Linux, Mac, a Windows whose PowerShell did not answer).
          const unreadable = !!fw && (!fw.commands.names || fw.rules === null);
          if (fw && unreadable && request.body?.firewallDone === true) {
            const before = firewallAck();
            writeConfigKey(opts.configDir, 'firewallAck', { kind: fw.kind, ports: [...new Set([...(before?.kind === fw.kind ? before.ports : []), ...fwPorts])] });
          }
          const acked = firewallAck();
          const firewall = fw && {
            kind: fw.kind,
            add: fw.commands.add,
            ready: !unreadable
              ? fw.commands.names!.every((name) => fw.rules!.includes(name))
              : acked?.kind === fw.kind && fwPorts.every((p) => acked.ports.includes(p)),
            // A Windows rule we could not read back is confirmed by hand, like a Linux or Mac one.
            confirm: unreadable,
          };
          const sshScan = choice === 'ssh' ? await existing(true) : null;
          const facts: SetupFact = await (opts.deps?.setupFacts?.() ?? Promise.resolve({
            existingWorking: connector === 'direct' && direct.enabled ? (direct.status().name ? 'duckdns' : 'direct') : connector === 'tailscale' && live ? (live.funnel ? 'funnel' : 'tailscale') : tunnel ? 'tunnel' : null,
            duckdnsConfigured: !!duck,
            natKind: mode ? (probe?.ip ? 'open' : 'unknown') : (probe?.nat?.kind ?? 'unknown'),
            upnp: mode ? probe?.ok === true : probe?.gateway !== null,
            wslMode: mode,
            relayReady: mode === 'nat' && !!relayText && new RegExp(`\\b443\\s+127\\.0\\.0\\.1\\s+${directPort}\\b`).test(relayText),
            wslInstructions: mode === 'nat' ? relayCommands(directPort).add.join('\n') : undefined,
            firewall,
            tailscaleInstalled: tsText !== null || await installed(tailscaleCommand),
            tailscaleLoggedIn: ts.BackendState === 'Running' && !!ts.Self?.DNSName,
            tailscaleFunnelAllowed: ['funnel', 'https'].every((cap) => cap in (ts.Self?.CapMap ?? {})),
            cloudflaredInstalled: await installed('cloudflared'),
            tailscaleWindows: tailscaleCommand === 'tailscale.exe',
          }));
          facts.platform ??= mode ? 'wsl' : platform;
          facts.port ??= port;
          // The SSH card: an SSH server already answering (the scan) is what the laptop line names.
          if (sshScan?.ssh && facts.sshFound === undefined)
            Object.assign(facts, { sshFound: true, sshHost: sshScan.ssh.host, sshPort: sshScan.ssh.port, sshUser: sshScan.ssh.user });
          facts.sshUser ??= mode ? '<user>' : os.userInfo().username;
          facts.sshHost ??= direct.url() ? new URL(direct.url()!).hostname : (mode !== 'nat' && lanIp) || '<host>';
          const previousDuck = duck;
          if (choice === 'duckdns') {
            const name = request.body?.duckdnsName?.trim().toLowerCase();
            const token = request.body?.duckdnsToken?.trim();
            if (name || token) {
              if (!name || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.duckdns\.org$/.test(name) || !token || !/^[a-zA-Z0-9-]{8,128}$/.test(token))
                return reply.code(400).send({ ...refused('duckdns_check') });
              fs.mkdirSync(tlsDir, { recursive: true, mode: 0o700 });
              fs.writeFileSync(path.join(tlsDir, 'ddns.json'), JSON.stringify({ name, token }), { mode: 0o600 });
              const client = duckDns(name, token);
              duck = { name, client };
              direct.configureDuck(duck, opts.deps?.issue ?? acmeIssuer({ dir: tlsDir, directoryUrl: acmeDirectory(process.env.CLD_GUI_ACME_DIRECTORY), duck: client }));
              facts.duckdnsConfigured = true;
            }
          }
          const outcome = await runRemoteSetup(facts, choice, async (kind) => {
            if (kind === 'switch') {
              if (choice === 'lan' && !lanIp) return { ok: false, steps: [{ ok: false, text: koText('lan_ip_missing') }] };
              if (choice === 'lan' && mode === 'nat') return { ok: false, steps: [{ ok: false, text: koText('wsl_nat_needs_forward') }] };
              if (choice === 'lan') startLan(app!, 'setup lan');
              choose(choice as 'local' | 'lan', why);
              cleanup.push(...(await settle(via, `setup ${choice}`)));
              return { ok: true, connector: choice as 'local' | 'lan' };
            }
            if (kind === 'keep') {
              if (facts.existingWorking === 'direct' || facts.existingWorking === 'duckdns')
                return { ok: true, url: direct!.url() ?? undefined, connector: facts.existingWorking };
              if ((facts.existingWorking === 'tailscale' || facts.existingWorking === 'funnel') && tailscaleHost)
                return { ok: true, url: `https://${tailscaleHost}/`, connector: facts.existingWorking };
              return { ok: !!tunnel, url: tunnel?.url, connector: 'tunnel' };
            }
            if (kind === 'direct') {
              const chosenDuck = choice === 'duckdns' ? duck : undefined;
              direct!.configureDuck(chosenDuck, opts.deps?.issue ?? acmeIssuer({
                dir: tlsDir, directoryUrl: acmeDirectory(process.env.CLD_GUI_ACME_DIRECTORY), duck: chosenDuck?.client,
              }));
              const result = await direct!.enable();
              if (result.ok) exposure('direct', true, `setup ${choice}`);
              return { ok: result.ok, url: result.ok ? direct!.url() ?? undefined : undefined, connector: choice === 'duckdns' ? 'duckdns' : 'direct', steps: result.steps };
            }
            if (kind === 'tailscale-serve' || kind === 'tailscale-funnel') {
              const wantFunnel = kind === 'tailscale-funnel';
              const host = ts.Self?.DNSName?.replace(/\.$/, '');
              if (!host || !/\.ts\.net$/i.test(host)) return { ok: false, steps: [{ ok: false, text: koText('ts_name_missing') }] };
              // Every command that succeeded is recorded inside convergeTailscale, before any check.
              const done = await convergeTailscale(wantFunnel, host);
              if ('step' in done || done.host !== host) {
                // Back to what the current state wants (in place, or off when tailscale is not the
                // connector); an unreadable status keeps the entry for a later change, startup or uninstall.
                await revertLedger(null, 'failed set-up');
                return { ok: false, steps: ['step' in done ? done.step : { ok: false, text: koText('ts_name_differs', { host: done.host }) }] };
              }
              cldHooks.allowRemoteHost?.(host);
              tailscaleHost = host;
              exposure(wantFunnel ? 'tailscale funnel' : 'tailscale serve', true, `setup ${choice}`);
              return { ok: true, url: `https://${host}/`, connector: wantFunnel ? 'funnel' : 'tailscale' };
            }
            if (kind === 'tunnel') {
              const opened = await (opts.deps?.setupTunnel ?? quickTunnel)(app!.server, direct!.secret);
              tunnel = opened;
              const { procStartTime } = await ledgerLib();
              const startTime = opened.pid ? procStartTime(procFile(opened.pid, 'stat')) : null;
              await record({
                kind: 'tunnel', url: opened.url, by: 'daemon', at: Date.now(),
                ...(opened.pid ? { pid: opened.pid } : {}),
                ...(opened.localPort ? { localPort: opened.localPort } : {}),
                ...(startTime ? { startTime } : {}),
              });
              exposure('tunnel', true, 'setup tunnel');
              cldHooks.allowRemoteHost?.(new URL(opened.url).hostname);
              return { ok: true, url: opened.url, connector: 'tunnel', steps: [{ ok: true, text: koText('tunnel_public') }] };
            }
            return { ok: false, steps: [{ ok: false, text: koText('connector_start_failed') }] };
          }, async (url, kind) => {
            let result: RemoteTestResult;
            // Direct (Let's Encrypt reached it) and Tailscale (serve status shows our handler) are proven
            // elsewhere: an address this PC cannot reach itself is "unknown from here". The tunnel is not.
            try { result = await (opts.deps?.setupSelfTest ?? ((u: string) => outsideSelfTest(u, { setUpProven: kind !== 'tunnel' })))(url); }
            catch (error) { result = { ok: false, url, checkedAt: Date.now(), steps: [{ ok: false, text: koText('setup_outside_failed', { why: (error as Error).message }) }] }; }
            try { saveRemoteTest(opts.configDir, result); }
            catch (error) {
              result = { ...result, ok: false, steps: [...result.steps, { ok: false, text: koText('check_save_failed', { why: (error as Error).message }) }] };
            }
            if (!result.ok && kind === 'direct' && connector !== 'direct') await closeDirect('failed self-test');
            if (!result.ok && kind === 'tunnel' && tunnel) {
              const failed = tunnel;
              await closeQuickTunnel(failed);
              tunnel = null;
              await forget({ kind: 'tunnel', url: failed.url, by: 'daemon', at: 0 });
              exposure('tunnel', false, 'failed self-test');
            }
            // A serve/Funnel that failed its check: back to what the state wants (off, or reconfigured in place).
            if (!result.ok && (kind === 'tailscale-serve' || kind === 'tailscale-funnel'))
              await revertLedger(null, 'failed self-test');
            return result;
          }, (line) => setupRun?.steps.push(line));
          outcome.steps.push(...cleanup);
          if (choice === 'direct' && outcome.ok && previousDuck) {
            duck = undefined;
            fs.unlinkSync(path.join(tlsDir, 'ddns.json'));
          }
          if ((choice === 'direct' || choice === 'duckdns') && !outcome.ok) {
            duck = previousDuck;
            direct.configureDuck(previousDuck, opts.deps?.issue ?? acmeIssuer({
              dir: tlsDir, directoryUrl: acmeDirectory(process.env.CLD_GUI_ACME_DIRECTORY), duck: previousDuck?.client,
            }));
          }
          if (outcome.ok && (outcome.connector === 'direct' || outcome.connector === 'duckdns')) {
            startLan(app, `setup ${choice}`);
            choose('direct', why);
            if (await relayMode()) await record({ kind: 'portproxy', externalPort: 443, directPort, by: 'user', at: Date.now() });
            outcome.steps.push(...(await settle(via, `setup ${choice}`)));
          }
          if (outcome.ok && (outcome.connector === 'tailscale' || outcome.connector === 'funnel')) {
            choose('tailscale', why, outcome.connector === 'funnel');
            writeConfigKey(opts.configDir, 'allowedHosts', [...new Set([...opts.allowedHosts, tailscaleHost])]);
            outcome.steps.push(...(await settle(via, `setup ${choice}`)));
          }
          if (outcome.ok && outcome.connector === 'tunnel') {
            choose('local', why);
            tunnelWanted = true;
            outcome.steps.push(...(await settle(via, 'setup tunnel')));
          }
          setupRun = outcome;
          return outcome;
        } catch (error) {
          const outcome = { ok: false, steps: [...(setupRun?.steps ?? []), { ok: false, text: koText('remote_check_failed', { why: (error as Error).message }) }] };
          setupRun = outcome;
          return outcome;
        } finally { setupBusy = false; }
      },
    );

    // REMOTE-XPLAT: the ways in this PC already has (read-only), offered before anything new opens.
    // It names other machines (who is SSH'd in, the router's forwards): a remote device needs a fresh step-up.
    let scanning: Promise<Step[]> | null = null;
    fastify.get('/api/cld/connector/existing', { preHandler: auth }, async (request) => {
      if (!(isHost(request) || localPage(request) || (!opts.readOnly && stepUpFresh?.(request)))) return { found: [] };
      if (opts.deps?.scan) return { found: await opts.deps.scan() };
      // One scan at a time, whoever asks: a client in a loop cannot fan out processes.
      scanning ??= existing(false).then((r) => r.steps).finally(() => { scanning = null; });
      return { found: await scanning };
    });

    // O6: the user's own HTTPS/VPN address. Record, test, forget; nothing is opened. Every change is the
    // DuckDNS card's gate: a page of our own, actions allowed, and a fresh step-up from a remote device.
    const customGate = (request: FastifyRequest, reply: FastifyReply) =>
      mayAct(request, reply) && !needStepUp(request, reply, 'always');
    fastify.post<{ Body: { url?: unknown } | undefined }>('/api/cld/connector/custom', { preHandler: auth }, async (request, reply) => {
      if (!customGate(request, reply)) return reply;
      const parsed = parseCustomUrl(request.body?.url);
      if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
      if (custom && custom.url !== parsed.url) dropCustomHost(custom);
      // Saved means usable as a Host (the page must be reachable under it to run the test from there); preferred only after a pass.
      custom = { url: parsed.url, active: true, test: custom?.url === parsed.url ? custom.test : null };
      writeCustom(opts.configDir, custom);
      cldHooks.allowRemoteHost?.(parsed.host);
      audit.write({ kind: 'exposure', detail: 'custom address on', ...actorContext(request) });
      return { ok: true, custom: { ...custom, preferred: !!customPreferred(custom) }, url: canonicalUrl(facts()) };
    });
    fastify.delete('/api/cld/connector/custom', { preHandler: auth }, async (request, reply) => {
      if (!customGate(request, reply)) return reply;
      if (custom) {
        dropCustomHost(custom);
        custom = null;
        writeCustom(opts.configDir, null);
        audit.write({ kind: 'exposure', detail: 'custom address off', ...actorContext(request) });
      }
      return { ok: true, url: canonicalUrl(facts()) };
    });
    fastify.post('/api/cld/connector/custom/test', { preHandler: auth }, async (request, reply) => {
      if (!mayAct(request, reply)) return reply;
      if (!custom) return reply.code(404).send({ error: 'none' });
      // A pass turns an address that was switched off back on: that is widening, so it asks for the step-up first.
      if (!custom.active && needStepUp(request, reply, 'always')) return reply;
      const tested = custom;
      const verdict = await customSelfTest(tested.url, opts.deps?.customFetch);
      // The card may have changed under the fetch: the verdict belongs to the address it asked.
      if (custom?.url !== tested.url) return reply.code(409).send({ error: 'changed' });
      const reactivate = verdict === 'ok' && !custom.active;
      custom = { ...custom, active: custom.active || reactivate, test: { verdict, checkedAt: Date.now() } };
      writeCustom(opts.configDir, custom);
      if (reactivate) {
        const parsed = parseCustomUrl(custom.url);
        if (parsed.ok) cldHooks.allowRemoteHost?.(parsed.host);
        audit.write({ kind: 'exposure', detail: 'custom address on', ...actorContext(request) });
      }
      return { verdict, custom: { ...custom, preferred: !!customPreferred(custom) }, url: canonicalUrl(facts()) };
    });

    // The security panel: a new secret path re-pairs every other device.
    fastify.post('/api/cld/connector/rotate', { preHandler: auth }, async (request, reply) => {
      if (!mayAct(request, reply) || needStepUp(request, reply, 'always')) return reply;
      if (!direct?.enabled) return reply.code(404).send({ ...refused('direct_off') });
      direct.rotateSecret();
      audit.write({ kind: 'tokenRotated', detail: 'path', ...actorContext(request) });
      return { url: direct.url() };
    });
  };

  return {
    /** The direct connector, once the server listens (tests). */
    get direct() {
      return direct;
    },
    async dispose() {
      // Stopping is not reverting: what the config wants survives a restart.
      for (const timer of cutTimers) clearTimeout(timer);
      cutTimers.clear();
      await tunnel?.close();
      await direct?.close();
      stopLan(undefined, true);
      if (cldHooks.verifiedOutsideUrl === verifiedOutsideUrl) delete cldHooks.verifiedOutsideUrl;
    },
  };
}
