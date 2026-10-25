/**
 * Network facts for the remote connectors (T-0024): which LAN address to
 * listen on, the address the internet sees (STUN), what kind of NAT is in the
 * way, and the Windows-side steps WSL needs. Pure functions plus one small
 * STUN client; nothing here changes the router or the machine.
 */
import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as dgram from 'dgram';
import * as net from 'net';
import * as os from 'os';

import { koText } from '../../../../core/src/cld/serverText.js';

// ── Address ranges ──────────────────────────────────────────────

function v4(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4 || parts.some((p) => !/^\d{1,3}$/.test(p) || Number(p) > 255)) return null;
  return parts.reduce((n, p) => n * 256 + Number(p), 0);
}

function inRange(ip: string, base: string, bits: number): boolean {
  const n = v4(ip);
  const b = v4(base);
  if (n === null || b === null) return false;
  const size = 2 ** (32 - bits);
  return Math.floor(n / size) === Math.floor(b / size);
}

/** RFC 1918, plus link-local and loopback: never an address the internet can reach. */
export function isPrivateIpv4(ip: string): boolean {
  return (
    inRange(ip, '10.0.0.0', 8) ||
    inRange(ip, '172.16.0.0', 12) ||
    inRange(ip, '192.168.0.0', 16) ||
    inRange(ip, '169.254.0.0', 16) ||
    inRange(ip, '127.0.0.0', 8)
  );
}

/** RFC 6598 shared address space: the carrier's NAT (and Tailscale's own addresses). */
export function isCgnatIpv4(ip: string): boolean {
  return inRange(ip, '100.64.0.0', 10);
}

export function isPublicIpv4(ip: string): boolean {
  return v4(ip) !== null && !isPrivateIpv4(ip) && !isCgnatIpv4(ip) && !inRange(ip, '0.0.0.0', 8);
}

/** RFC 8738: the SNI a TLS-ALPN-01 validator sends for an IP identifier. */
export function reverseDnsName(ip: string): string {
  return `${ip.split('.').reverse().join('.')}.in-addr.arpa`;
}

// ── The LAN interface ───────────────────────────────────────────

/** Interfaces that are never "the home network": containers, VPNs, tunnels. */
const NOT_LAN = /^(docker|br-|veth|virbr|vmnet|vboxnet|tailscale|utun|tun|tap|zt|wg|ham)/i;

/**
 * The address the LAN reaches this machine on: a private IPv4 on a real
 * interface, 192.168/16 first (home routers), then 10/8, then 172.16/12 (also
 * WSL's NAT range, the least likely to be the LAN). Null when there is none.
 */
export function pickLanIp(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces(),
): string | null {
  const rank = (ip: string) =>
    inRange(ip, '192.168.0.0', 16) ? 0 : inRange(ip, '10.0.0.0', 8) ? 1 : 2;
  const found: string[] = [];
  for (const [name, list] of Object.entries(interfaces)) {
    if (NOT_LAN.test(name)) continue;
    for (const info of list ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      if (!isPrivateIpv4(info.address) || inRange(info.address, '169.254.0.0', 16)) continue;
      if (inRange(info.address, '127.0.0.0', 8)) continue;
      found.push(info.address);
    }
  }
  return found.sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

// ── NAT ─────────────────────────────────────────────────────────

export type NatKind = 'open' | 'no-upnp' | 'cgnat' | 'double-nat' | 'unknown';

export interface NatVerdict {
  kind: NatKind;
  /** One Korean sentence for ✔/✖ lines. */
  reason: string;
}

/**
 * Can the internet reach a port this router maps? Compares the router's own
 * WAN address (UPnP GetExternalIPAddress) with the address the internet sees
 * (STUN). A private or 100.64/10 WAN, or a WAN that differs from what the
 * internet sees, means another NAT sits above the router, and a mapping on
 * this router alone never receives anything.
 */
export function classifyNat(facts: {
  gateway: boolean;
  wanIp?: string | null;
  observedIp?: string | null;
}): NatVerdict {
  const { gateway, wanIp, observedIp } = facts;
  if (!gateway)
    return { kind: 'no-upnp', reason: koText('nat_no_upnp') };
  if (!wanIp) return { kind: 'unknown', reason: koText('nat_no_wan') };
  if (isCgnatIpv4(wanIp))
    return {
      kind: 'cgnat',
      reason: koText('nat_cgnat', { ip: wanIp }),
    };
  if (isPrivateIpv4(wanIp))
    return {
      kind: 'double-nat',
      reason: koText('nat_double', { ip: wanIp }),
    };
  if (observedIp && observedIp !== wanIp)
    return {
      kind: 'cgnat',
      reason: koText('nat_mismatch', { wan: wanIp, seen: observedIp }),
    };
  return { kind: 'open', reason: koText('nat_open', { ip: wanIp }) };
}

// ── STUN (RFC 8489 Binding) ─────────────────────────────────────

const MAGIC = 0x2112a442;
export const GOOGLE_STUN = { host: 'stun.l.google.com', port: 19302 };

export function stunRequest(transactionId: Buffer): Buffer {
  const header = Buffer.alloc(20);
  header.writeUInt16BE(0x0001, 0); // Binding Request
  header.writeUInt16BE(0, 2); // no attributes
  header.writeUInt32BE(MAGIC, 4);
  transactionId.copy(header, 8);
  return header;
}

/** The mapped IPv4 address from a Binding Success response, or null. */
export function parseStunResponse(msg: Buffer, transactionId: Buffer): string | null {
  if (msg.length < 20 || msg.readUInt16BE(0) !== 0x0101 || msg.readUInt32BE(4) !== MAGIC)
    return null;
  if (!msg.subarray(8, 20).equals(transactionId)) return null;
  let offset = 20;
  const end = Math.min(msg.length, 20 + msg.readUInt16BE(2));
  let mapped: string | null = null;
  while (offset + 4 <= end) {
    const type = msg.readUInt16BE(offset);
    const length = msg.readUInt16BE(offset + 2);
    const value = msg.subarray(offset + 4, offset + 4 + length);
    if ((type === 0x0020 || type === 0x0001) && value.length >= 8 && value[1] === 0x01) {
      const raw = value.readUInt32BE(4);
      const n = type === 0x0020 ? (raw ^ MAGIC) >>> 0 : raw;
      const ip = [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
      if (type === 0x0020) return ip; // XOR-MAPPED-ADDRESS wins
      mapped = ip;
    }
    offset += 4 + length + ((4 - (length % 4)) % 4);
  }
  return mapped;
}

/**
 * The IPv4 address the internet sees for this machine, from one STUN server
 * (no account, no relay). Retransmits like RFC 8489 asks, since UDP drops.
 * Null on timeout.
 */
export function stunObservedIp(
  server: { host: string; port: number } = GOOGLE_STUN,
  timeoutMs = 3000,
): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = dgram.createSocket('udp4');
    const id = crypto.randomBytes(12);
    const request = stunRequest(id);
    const timers: NodeJS.Timeout[] = [];
    let done = false;
    const finish = (ip: string | null) => {
      if (done) return;
      done = true;
      for (const t of timers) clearTimeout(t);
      socket.close();
      resolve(ip);
    };
    socket.on('error', () => finish(null));
    socket.on('message', (msg) => {
      const ip = parseStunResponse(msg, id);
      if (ip) finish(ip);
    });
    for (const at of [0, 500, 1500])
      timers.push(setTimeout(() => socket.send(request, server.port, server.host, () => {}), at));
    timers.push(setTimeout(() => finish(null), timeoutMs));
  });
}

// ── WSL ─────────────────────────────────────────────────────────

/** One Windows Defender inbound rule, safe to run again: an earlier run's rule of the same name is replaced. */
function windowsRule(port: number): string {
  return `Remove-NetFirewallRule -Name cld-gui-${port} -ErrorAction SilentlyContinue; New-NetFirewallRule -Name cld-gui-${port} -DisplayName "cld-gui ${port}" -Direction Inbound -Protocol TCP -LocalPort ${port} -Action Allow`;
}

/**
 * WSL NAT without mirrored mode (T-0074): Windows takes TCP `externalPort`
 * and portproxy hands it to 127.0.0.1:`directPort`, which WSL's localhost
 * forwarding carries into the daemon's direct listener. That target never
 * changes when WSL's NAT address does. Admin PowerShell, once; `remove` undoes it.
 * Both lists are safe to run twice: `add` replaces, `remove` is quiet when nothing is there.
 */
export function relayCommands(
  directPort: number,
  externalPort = 443,
): { add: string[]; remove: string[] } {
  return {
    add: [
      `netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=${externalPort} connectaddress=127.0.0.1 connectport=${directPort}`,
      windowsRule(externalPort),
    ],
    remove: [
      `netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=${externalPort} | Out-Null`,
      `Remove-NetFirewallRule -Name cld-gui-${externalPort} -ErrorAction SilentlyContinue`,
    ],
  };
}

/** Microsoft's VMCreatorId for WSL (learn.microsoft.com/windows/wsl/networking). */
const WSL_VM_CREATOR = '{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}';
const MAC_FIREWALL = '/usr/libexec/ApplicationFirewall/socketfilterfw';
const shQuote = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`);

/**
 * The host firewall in front of the daemon's own listeners (LAN, direct):
 * native Windows (Defender), WSL mirrored (Hyper-V's firewall), Linux with
 * ufw or firewalld switched on, macOS with its application firewall on. WSL
 * NAT has none of its own (the relay's rule covers it) and neither has a
 * Linux or Mac with no firewall on.
 */
export type FirewallKind = 'windows' | 'wsl-mirrored' | 'ufw' | 'firewalld' | 'macos';

/**
 * What a person runs once (Windows kinds: admin PowerShell, one line per port;
 * the rest: a terminal, sudo). Every line is safe to run twice, and `remove`
 * does not fail when the rule is already gone. `names`: the Windows rule names
 * `firewallRules()` reads back (Hyper-V ones prefixed `hyperv:`).
 */
export function firewallCommands(
  kind: FirewallKind,
  ports: number[],
  nodePath: string = process.execPath,
): { add: string[]; remove: string[]; names?: string[] } {
  switch (kind) {
    case 'windows':
      return {
        add: ports.map(windowsRule),
        remove: ports.map((p) => `Remove-NetFirewallRule -Name cld-gui-${p} -ErrorAction SilentlyContinue`),
        names: ports.map((p) => `cld-gui-${p}`),
      };
    case 'wsl-mirrored':
      return {
        add: ports.map((p) => `Remove-NetFirewallHyperVRule -Name cld-gui-${p} -ErrorAction SilentlyContinue; New-NetFirewallHyperVRule -Name cld-gui-${p} -DisplayName "cld-gui ${p}" -Direction Inbound -VMCreatorId '${WSL_VM_CREATOR}' -Protocol TCP -LocalPorts ${p}`),
        remove: ports.map((p) => `Remove-NetFirewallHyperVRule -Name cld-gui-${p} -ErrorAction SilentlyContinue`),
        names: ports.map((p) => `hyperv:cld-gui-${p}`),
      };
    case 'ufw':
      return {
        add: ports.map((p) => `sudo ufw allow ${p}/tcp`),
        remove: ports.map((p) => `sudo ufw delete allow ${p}/tcp`),
      };
    case 'firewalld':
      return {
        add: [`sudo firewall-cmd --permanent ${ports.map((p) => `--add-port=${p}/tcp`).join(' ')}`, 'sudo firewall-cmd --reload'],
        remove: [`sudo firewall-cmd --permanent ${ports.map((p) => `--remove-port=${p}/tcp`).join(' ')}`, 'sudo firewall-cmd --reload'],
      };
    case 'macos':
      // Per program, not per port: the Node that runs the daemon.
      return {
        add: [`sudo ${MAC_FIREWALL} --add ${shQuote(nodePath)}`, `sudo ${MAC_FIREWALL} --unblockapp ${shQuote(nodePath)}`],
        remove: [`sudo ${MAC_FIREWALL} --remove ${shQuote(nodePath)} || true`],
      };
  }
}

type RunCommand = (command: string, args: string[]) => Promise<string | null>;

/** Which host firewall is in the way here (read-only: a config file and one status query). */
export async function detectFirewall(facts: {
  platform: NodeJS.Platform;
  wslMode: string | null;
  run: RunCommand;
  read: (file: string) => string | null;
}): Promise<FirewallKind | null> {
  if (facts.wslMode === 'mirrored') return 'wsl-mirrored';
  if (facts.wslMode) return null;
  if (facts.platform === 'win32') return 'windows';
  if (facts.platform === 'darwin')
    return /is enabled|State = [12]/i.test((await facts.run(MAC_FIREWALL, ['--getglobalstate'])) ?? '') ? 'macos' : null;
  if (facts.platform !== 'linux') return null;
  // `systemctl is-active ufw` says active even with ufw disabled: its own config says whether it filters.
  if (/^\s*ENABLED\s*=\s*yes\b/m.test(facts.read('/etc/ufw/ufw.conf') ?? '')) return 'ufw';
  return (await facts.run('systemctl', ['is-active', 'firewalld']))?.trim() === 'active' ? 'firewalld' : null;
}

/**
 * Our Windows firewall rules as they stand (`cld-gui*`, Hyper-V ones as
 * `hyperv:<name>`), read without administrator rights from Windows or from
 * WSL; null when PowerShell can't be asked.
 */
export async function firewallRules(run: RunCommand): Promise<string[] | null> {
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "try { @(Get-NetFirewallRule -Name 'cld-gui*' -ErrorAction SilentlyContinue).Name } catch {}; try { @(Get-NetFirewallHyperVRule -Name 'cld-gui*' -ErrorAction SilentlyContinue) | ForEach-Object { 'hyperv:' + $_.Name } } catch {}"]);
  return out === null ? null : out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

/** IPv4 addresses in `ipconfig.exe` output, in any Windows language (the label keeps "IPv4"). */
export function parseIpconfig(text: string): string[] {
  const found = text
    .split(/\r?\n/)
    .filter((line) => /IPv4/i.test(line))
    .map((line) => /(\d{1,3}(?:\.\d{1,3}){3})/.exec(line)?.[1])
    .filter((ip): ip is string => !!ip && v4(ip) !== null);
  return [...new Set(found)];
}

/** Windows' own IPv4 addresses from inside WSL (interop), null when it can't be asked. */
export function windowsAddresses(): Promise<string[] | null> {
  return new Promise((resolve) =>
    execFile('ipconfig.exe', [], { timeout: 5000, encoding: 'latin1' }, (error, stdout) =>
      resolve(error ? null : parseIpconfig(stdout)),
    ),
  );
}

/** Whether an sshd answers on 127.0.0.1:`port`, and its banner ("SSH-2.0-OpenSSH_9.6p1 …"). */
export function sshProbe(
  port: number,
  timeoutMs = 1500,
): Promise<{ open: boolean; banner: string }> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let banner = '';
    const done = (open: boolean) => {
      socket.destroy();
      resolve({ open, banner: banner.split(/\r?\n/)[0]?.slice(0, 80) ?? '' });
    };
    socket.setTimeout(timeoutMs, () => done(banner.startsWith('SSH-')));
    socket.on('data', (chunk) => {
      banner += chunk.toString('latin1');
      if (banner.includes('\n')) done(banner.startsWith('SSH-'));
    });
    socket.on('error', () => done(false));
  });
}

/**
 * What Windows needs before anything outside the PC reaches a daemon inside
 * WSL. In NAT mode (the default) the router and the LAN only see Windows;
 * mirrored mode shares Windows' addresses, and then only Hyper-V's firewall
 * is in the way. Both need an administrator once, so these are printed, never
 * run. NAT mode leads with portproxy: mirrored mode does not start on every
 * PC (T-0074: "ID 0" errors).
 */
export function wslSteps(mode: string, ports: number[]): string[] {
  const rule = firewallCommands('wsl-mirrored', ports).add.join(' ; ');
  if (mode === 'mirrored')
    return [
      koText('wsl_mirrored'),
      koText('admin_ps_once', { command: rule }),
    ];
  const [port, directPort = port] = ports;
  const relay = relayCommands(directPort);
  return [
    koText('wsl_nat_guide_head'),
    koText('wsl_nat_step1', { command: relay.add.join(' ; ') }),
    koText('wsl_nat_undo', { command: relay.remove.join(' ; ') }),
    koText('wsl_nat_step2', { port }),
    koText('wsl_nat_step3'),
    koText('admin_ps_once_indented', { command: rule }),
  ];
}
