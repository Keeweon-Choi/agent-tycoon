/**
 * "이미 있는 길" (REMOTE-XPLAT): a READ-ONLY look at the ways in this PC
 * already has, offered before anything new is opened. An SSH server already
 * answering (and the address people already reach it by), Tailscale already
 * logged in, a cloudflared already running, something already on 443/80, the
 * router's existing forwards (UPnP read), Windows' portproxy entries and our
 * firewall rules (show only), a DuckDNS name of ours. Nothing here starts,
 * stops or changes anything; each probe is time-boxed and a missing tool is
 * simply nothing found.
 */
import { koText } from '../../../../core/src/cld/serverText.js';
import type { Step } from './direct.js';
import { firewallRules } from './net.js';
import type { Gateway } from './upnp.js';

type Run = (command: string, args: string[]) => Promise<string | null>;

export interface ScanDeps {
  platform: NodeJS.Platform;
  /** `wslinfo --networking-mode` (nat, mirrored), null outside WSL. */
  wslMode: string | null;
  /** The daemon's port: what an SSH tunnel carries. */
  port: number;
  directPort: number;
  user: string;
  lanIp: string | null;
  /** This machine's (or distro's) own addresses: a portproxy target that is one of them points here. */
  ownAddresses: string[];
  run: Run;
  read: (file: string) => string | null;
  sshd: (port: number) => Promise<{ open: boolean; banner: string }>;
  /** A TCP connect and close, true when something accepted. */
  touch: (host: string, port: number) => Promise<boolean>;
  windowsAddresses: () => Promise<string[] | null>;
  /** The router (UPnP); never asked from WSL NAT, whose SSDP never reaches the LAN. */
  gateway: () => Promise<Gateway | null>;
  tailscale: () => Promise<{ host: string; serving: boolean } | null>;
  duckName: string | null;
  /** Our own quick tunnel's cloudflared: not "already there". */
  ownTunnelPid?: number;
  timeoutMs?: number;
  /** The SSH card's set-up: only the SSH probes. */
  sshOnly?: boolean;
}

export interface ScanResult {
  steps: Step[];
  /** The first SSH server found that a laptop can reach: what the SSH card pre-fills. */
  ssh?: { host: string; port: number; user: string };
}

/** A probe's answer, or null when it failed or took longer than `ms`. */
function box<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(null); },
    );
  });
}

/** `Port` from an sshd_config (the first one), 22 when none is set or the file is unreadable. */
export function sshdConfigPort(text: string | null): number {
  const port = Number(/^\s*Port\s+(\d{1,5})\s*$/im.exec(text ?? '')?.[1]);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : 22;
}

function endpoint(token: string): { host: string; port: number } | null {
  // Linux ss / Windows netstat: host:port, [v6]:port; macOS netstat: a.b.c.d.port.
  const m = /^\[?([0-9a-fA-F:.]+?)(?:%\w+)?\]?[:.](\d{1,5})$/.exec(token);
  if (!m || !/[.:]/.test(m[1])) return null;
  return { host: m[1].replace(/^::ffff:/i, ''), port: Number(m[2]) };
}

/**
 * Open TCP connections from `ss -Htn state established` (Linux) or
 * `netstat -an -p tcp` (macOS, Windows, any language): the local address a
 * peer reached, and the peer. Listeners (peer port 0) are left out.
 */
export function parseConnections(text: string): Array<{ local: string; localPort: number; peer: string }> {
  const found: Array<{ local: string; localPort: number; peer: string }> = [];
  for (const line of text.split(/\r?\n/)) {
    const ends = line.trim().split(/\s+/).map(endpoint).filter((e): e is { host: string; port: number } => !!e);
    if (ends.length < 2 || ends[1].port === 0) continue;
    found.push({ local: ends[0].host, localPort: ends[0].port, peer: ends[1].host });
  }
  return found;
}

/** Rows of `netsh interface portproxy show v4tov4`, in any Windows language. */
export function parsePortproxy(text: string): Array<{ listenAddress: string; listenPort: number; connectAddress: string; connectPort: number }> {
  return text
    .split(/\r?\n/)
    .map((line) => /^\s*(\S+)\s+(\d{1,5})\s+(\S+)\s+(\d{1,5})\s*$/.exec(line))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ listenAddress: m[1], listenPort: Number(m[2]), connectAddress: m[3], connectPort: Number(m[4]) }));
}

const LOOPBACK = /^(127\.|::1$|localhost$)/;
const homeLan = (addresses: string[] | null) => addresses?.find((a) => /^(192\.168|10)\./.test(a)) ?? null;

/** What is already there, as steps the access panel lists (empty: nothing found). */
export async function scanExisting(deps: ScanDeps): Promise<ScanResult> {
  const all = !deps.sshOnly;
  const ms = deps.timeoutMs ?? 4000;
  const { sshTunnelCommand } = await import('../../../../core/src/remoteSetupPlan.mjs');
  const windowsSide = deps.platform === 'win32' || !!deps.wslMode;
  const netsh = deps.platform === 'win32' ? 'netsh' : 'netsh.exe';
  const sshConfig = deps.platform === 'win32'
    ? `${process.env.ProgramData ?? 'C:\\ProgramData'}\\ssh\\sshd_config`
    : '/etc/ssh/sshd_config';
  const sshPort = sshdConfigPort(deps.read(sshConfig));
  const connectionsCommand: [string, string[]] = deps.platform === 'linux'
    ? ['ss', ['-Htn', 'state', 'established']]
    : ['netstat', ['-an', '-p', 'tcp']];

  const [sshd, connections, proxies, rules, windowsSsh, windowsAddrs, tailscale, cloudflared, listening, router] = await Promise.all([
    box(deps.sshd(sshPort), ms),
    box(deps.run(...connectionsCommand), ms),
    windowsSide ? box(deps.run(netsh, ['interface', 'portproxy', 'show', 'v4tov4']), ms) : null,
    windowsSide && all ? box(firewallRules(deps.run), ms) : null,
    deps.wslMode ? box(deps.run('sc.exe', ['query', 'sshd']), ms) : null,
    deps.wslMode ? box(deps.windowsAddresses(), ms) : null,
    all ? box(deps.tailscale(), ms) : null,
    !all ? null : box(deps.platform === 'win32'
      ? deps.run('tasklist', ['/FI', 'IMAGENAME eq cloudflared.exe', '/NH', '/FO', 'CSV'])
      : deps.run('pgrep', ['-x', 'cloudflared']), ms),
    all ? box(Promise.all([443, 80].map(async (p) => ((await deps.touch('127.0.0.1', p)) ? p : null))), ms) : null,
    deps.wslMode === 'nat' || !all ? null : box((async () => {
      const gateway = await deps.gateway();
      if (!gateway?.entry) return null;
      const ports = [...new Set([443, 22, sshPort])];
      return Promise.all(ports.map((p) => gateway.entry!(p).catch(() => null)));
    })(), ms + 2000),
  ]);

  const found: Step[] = [];
  let ssh: ScanResult['ssh'];
  const portproxy = parsePortproxy(proxies ?? '');
  const usedProxies = new Set<number>();
  const sessions = parseConnections(connections ?? '').filter((c) => !LOOPBACK.test(c.peer));
  const sshCard = (text: string, host: string, port: number, user: string, fix?: string): Step => {
    ssh ??= { host, port, user };
    return {
    ok: true,
    text,
    ...(fix ? { fix } : {}),
    guide: koText('use_ssh'),
    actions: [{ kind: 'copy', text: sshTunnelCommand({ port: deps.port, sshPort: port, user, host }), label: koText('label_ssh_cmd') }],
    suggest: 'ssh',
    };
  };

  // SSH on this machine (or, in WSL, this distro).
  if (sshd?.open) {
    const text = koText('found_ssh', { port: sshPort, banner: sshd.banner || 'SSH' });
    const inbound = sessions.filter((c) => c.localPort === sshPort);
    const sessionNote = inbound.length
      ? koText('found_ssh_sessions', { peers: [...new Set(inbound.map((c) => c.peer))].join(', ') })
      : undefined;
    if (deps.wslMode === 'nat') {
      // Only Windows can hand it in: a portproxy whose target is this distro's sshd.
      const relay = portproxy.find((p) => p.connectPort === sshPort && (deps.ownAddresses.includes(p.connectAddress) || LOOPBACK.test(p.connectAddress)));
      if (relay) {
        usedProxies.add(relay.listenPort);
        found.push(sshCard(text, homeLan(windowsAddrs) ?? '<host>', relay.listenPort, deps.user,
          [koText('found_ssh_wsl_relay', { listen: relay.listenPort, port: sshPort }), sessionNote].filter(Boolean).join('\n')));
      } else found.push({ ok: true, text, fix: koText('found_ssh_wsl_unreachable', { port: sshPort }) });
    } else {
      const host = inbound.find((c) => !LOOPBACK.test(c.local))?.local ?? deps.lanIp ?? '<host>';
      found.push(sshCard(text, host, sshPort, deps.user, sessionNote));
    }
  }
  // WSL: Windows' own OpenSSH Server, whose 127.0.0.1 reaches the daemon in WSL.
  if (windowsSsh && /\bRUNNING\b/.test(windowsSsh)) {
    const port = sshdConfigPort(deps.read('/mnt/c/ProgramData/ssh/sshd_config'));
    found.push(sshCard(koText('found_ssh_windows', { port }), homeLan(windowsAddrs) ?? '<host>', port, '<user>'));
  }

  if (tailscale)
    found.push({
      ok: true,
      text: koText(tailscale.serving ? 'found_tailscale_serving' : 'found_tailscale', { host: tailscale.host }),
      guide: koText(tailscale.serving ? 'use_tailscale_serving' : 'use_tailscale'),
      suggest: 'tailscale',
    });

  const tunnels = (cloudflared ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => (deps.platform === 'win32' ? /^"?cloudflared\.exe/i.test(l) : /^\d+$/.test(l) && Number(l) !== deps.ownTunnelPid));
  if (tunnels.length)
    found.push({ ok: true, text: koText('found_cloudflared', { count: tunnels.length }), guide: koText('use_cloudflared', { port: deps.port }) });

  const busy = (listening ?? []).filter((p): p is number => p !== null);
  if (busy.length)
    found.push({ ok: true, text: koText('found_proxy', { ports: busy.join(', ') }), guide: koText('use_proxy', { port: deps.port }) });

  for (const mapping of router ?? []) {
    if (!mapping) continue;
    const ours = mapping.description === 'cld-gui';
    found.push({
      ok: true,
      text: koText('found_router', { external: mapping.externalPort, client: mapping.internalClient, internal: mapping.internalPort }),
      guide: koText(ours ? 'use_router_ours' : 'use_router'),
      ...(ours ? { suggest: 'direct' as const } : {}),
    });
  }

  for (const proxy of portproxy) {
    if (usedProxies.has(proxy.listenPort)) continue;
    const ours = proxy.listenPort === 443 && LOOPBACK.test(proxy.connectAddress) && proxy.connectPort === deps.directPort;
    found.push({
      ok: true,
      text: koText('found_portproxy', { listen: proxy.listenPort, target: `${proxy.connectAddress}:${proxy.connectPort}` }),
      guide: koText(ours ? 'use_portproxy_ours' : 'use_portproxy'),
      ...(ours ? { suggest: 'direct' as const } : {}),
    });
  }
  if (rules?.length)
    found.push({ ok: true, text: koText('found_firewall', { names: rules.join(', ') }), guide: koText('use_firewall') });

  if (deps.duckName && all)
    found.push({ ok: true, text: koText('found_duckdns', { name: deps.duckName }), guide: koText('use_duckdns'), suggest: 'duckdns' });
  return { steps: found, ...(ssh ? { ssh } : {}) };
}
