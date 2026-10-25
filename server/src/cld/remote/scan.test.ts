/**
 * REMOTE-XPLAT: the read-only scan of ways in that already exist, per platform,
 * with fake command output only (found / nothing / tool missing / timeout).
 * Nothing here runs a real command, touches a port or asks a router.
 */
import { describe, expect, it } from 'vitest';

import { parseConnections, parsePortproxy, type ScanDeps, scanExisting, sshdConfigPort } from './scan.js';
import type { Gateway, PortMapping } from './upnp.js';

/** `netsh interface portproxy show v4tov4` on a Korean Windows, as read from WSL (headers mangled by the code page). */
const NETSH = '\r\nipv4 \xbc\xf6\xbd\xc5 \xb4\xeb\xb1\xe2:             ipv4\xbf\xa1 \xbf\xac\xb0\xe1:\r\n\r\n\xc1\xd6\xbc\xd2            \xc6\xf7\xc6\xae        \xc1\xd6\xbc\xd2            \xc6\xf7\xc6\xae\r\n--------------- ----------  --------------- ----------\r\n0.0.0.0         80          172.24.0.10  80\r\n0.0.0.0         2233        172.24.0.10  2233\r\n0.0.0.0         443         127.0.0.1       18443\r\n';

function deps(over: Partial<ScanDeps> & { answers?: Record<string, string | null>; files?: Record<string, string> } = {}): ScanDeps {
  const { answers = {}, files = {}, ...rest } = over;
  return {
    platform: 'linux',
    wslMode: null,
    port: 18240,
    directPort: 18443,
    user: 'choi',
    lanIp: '192.168.0.5',
    ownAddresses: ['127.0.0.1', '192.168.0.5'],
    run: async (command, args) => answers[[command, ...args].join(' ')] ?? null,
    read: (file) => files[file] ?? null,
    sshd: async () => ({ open: false, banner: '' }),
    touch: async () => false,
    windowsAddresses: async () => null,
    gateway: async () => null,
    tailscale: async () => null,
    duckName: null,
    timeoutMs: 200,
    ...rest,
  };
}
const texts = (r: { steps: Array<{ text: string }> }) => r.steps.map((s) => s.text);
const copied = (r: { steps: Array<{ actions?: Array<{ kind: string; text?: string }> }> }) =>
  r.steps.flatMap((s) => s.actions ?? []).filter((a) => a.kind === 'copy').map((a) => a.text);

describe('parsers (real output shapes)', () => {
  it('sshd_config Port, 22 by default', () => {
    expect(sshdConfigPort('#Port 22\nPort 2233\n')).toBe(2233);
    expect(sshdConfigPort('# nothing\n')).toBe(22);
    expect(sshdConfigPort(null)).toBe(22);
  });
  it('established connections from Linux ss, macOS netstat and Windows netstat; listeners left out', () => {
    expect(parseConnections('0      0      172.24.0.10:2233   172.24.176.1:50122\n0 0 [::ffff:192.168.0.5]:22 [::ffff:192.168.0.9]:6000\n')).toEqual([
      { local: '172.24.0.10', localPort: 2233, peer: '172.24.176.1' },
      { local: '192.168.0.5', localPort: 22, peer: '192.168.0.9' },
    ]);
    expect(parseConnections('Active Internet connections (including servers)\ntcp4       0      0  192.168.1.5.22         192.168.1.10.53211     ESTABLISHED\ntcp4  0 0  *.22  *.*  LISTEN\n')).toEqual([
      { local: '192.168.1.5', localPort: 22, peer: '192.168.1.10' },
    ]);
    expect(parseConnections('  TCP    0.0.0.0:22             0.0.0.0:0              LISTENING\r\n  TCP    192.168.0.5:22         192.168.0.9:50000      ESTABLISHED\r\n')).toEqual([
      { local: '192.168.0.5', localPort: 22, peer: '192.168.0.9' },
    ]);
  });
  it('portproxy rows in any Windows language', () => {
    expect(parsePortproxy(NETSH)).toEqual([
      { listenAddress: '0.0.0.0', listenPort: 80, connectAddress: '172.24.0.10', connectPort: 80 },
      { listenAddress: '0.0.0.0', listenPort: 2233, connectAddress: '172.24.0.10', connectPort: 2233 },
      { listenAddress: '0.0.0.0', listenPort: 443, connectAddress: '127.0.0.1', connectPort: 18443 },
    ]);
  });
});

describe('what is already there, per platform', () => {
  it('nothing found (and every tool missing): an empty list, the panel stays as it is', async () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      const r = await scanExisting(deps({ platform }));
      expect(r.steps).toEqual([]);
      expect(r.ssh).toBeUndefined();
    }
    expect((await scanExisting(deps({ wslMode: 'nat', lanIp: null }))).steps).toEqual([]);
  });

  it('Linux: an sshd and the address a session already reached it by; the laptop line names that host and port', async () => {
    const r = await scanExisting(deps({
      files: { '/etc/ssh/sshd_config': 'Port 2222\n' },
      sshd: async (port) => ({ open: port === 2222, banner: 'SSH-2.0-OpenSSH_9.6p1' }),
      answers: { 'ss -Htn state established': '0 0 203.0.113.9:2222 198.51.100.4:51000\n0 0 127.0.0.1:18240 127.0.0.1:40000\n' },
    }));
    expect(texts(r)[0]).toContain('2222번');
    expect(r.steps[0].fix).toContain('198.51.100.4');
    expect(r.ssh).toEqual({ host: '203.0.113.9', port: 2222, user: 'choi' });
    expect(copied(r)).toEqual(['ssh -N -L 18240:127.0.0.1:18240 -p 2222 choi@203.0.113.9']);
    expect(r.steps[0].suggest).toBe('ssh');
  });

  it('macOS: no session yet, the LAN address; the default port needs no -p', async () => {
    const r = await scanExisting(deps({ platform: 'darwin', sshd: async () => ({ open: true, banner: '' }) }));
    expect(copied(r)).toEqual(['ssh -N -L 18240:127.0.0.1:18240 choi@192.168.0.5']);
  });

  it('native Windows: its OpenSSH (port from ProgramData), our firewall rules, portproxy and a running cloudflared', async () => {
    const r = await scanExisting(deps({
      platform: 'win32',
      sshd: async (port) => ({ open: port === 22, banner: 'SSH-2.0-OpenSSH_for_Windows_9.5' }),
      run: async (command, args) => {
        if (command === 'powershell.exe') return 'cld-gui-18240\r\n';
        const answers: Record<string, string> = {
          'netstat -an -p tcp': '  TCP    192.168.0.5:22   192.168.0.9:50000   ESTABLISHED\r\n',
          'tasklist /FI IMAGENAME eq cloudflared.exe /NH /FO CSV': '"cloudflared.exe","4242","Console","1","30,000 K"\r\n',
          'netsh interface portproxy show v4tov4': NETSH,
        };
        return answers[[command, ...args].join(' ')] ?? null;
      },
    }));
    expect(r.ssh).toEqual({ host: '192.168.0.5', port: 22, user: 'choi' });
    const all = texts(r).join('\n');
    expect(all).toContain('cld-gui-18240');
    expect(all).toContain('cloudflared가 이미 돌고 있어요 (1개)');
    expect(all).toContain('Windows가 443번을 127.0.0.1:18443');
  });

  it("WSL NAT (this PC's real shape): the distro's sshd reached through Windows' portproxy, named by Windows' LAN address", async () => {
    const r = await scanExisting(deps({
      wslMode: 'nat',
      lanIp: null,
      ownAddresses: ['127.0.0.1', '172.24.0.10'],
      files: { '/etc/ssh/sshd_config': 'Port 2233\n' },
      sshd: async (port) => ({ open: port === 2233, banner: 'SSH-2.0-OpenSSH_9.6p1 Ubuntu' }),
      windowsAddresses: async () => ['192.168.0.12', '172.24.176.1'],
      answers: { 'netsh.exe interface portproxy show v4tov4': NETSH },
    }));
    expect(r.ssh).toEqual({ host: '192.168.0.12', port: 2233, user: 'choi' });
    expect(copied(r)[0]).toBe('ssh -N -L 18240:127.0.0.1:18240 -p 2233 choi@192.168.0.12');
    const all = texts(r).join('\n');
    // The SSH relay is reported with the SSH card, not again as a stranger's forward.
    expect(all).not.toContain('2233번을 172.24.0.10:2233');
    expect(all).toContain('Windows가 80번을 172.24.0.10:80로 넘기고 있어요');
    const ours = r.steps.find((s) => s.text.includes('443번을 127.0.0.1:18443'));
    expect(ours?.suggest).toBe('direct');
  });

  it("WSL NAT: a distro sshd nothing forwards is reported as unreachable, with no laptop line; Windows' own OpenSSH is offered", async () => {
    const r = await scanExisting(deps({
      wslMode: 'nat',
      lanIp: null,
      sshd: async () => ({ open: true, banner: 'SSH-2.0-OpenSSH_9.6p1' }),
      windowsAddresses: async () => ['10.0.0.7'],
      files: { '/mnt/c/ProgramData/ssh/sshd_config': 'Port 22\n' },
      answers: { 'sc.exe query sshd': 'SERVICE_NAME: sshd\r\n        TYPE               : 10  WIN32_OWN_PROCESS\r\n        STATE              : 4  RUNNING\r\n' },
    }));
    expect(r.steps[0].fix).toContain('NAT 모드');
    expect(r.steps[0].actions).toBeUndefined();
    expect(r.ssh).toEqual({ host: '10.0.0.7', port: 22, user: '<user>' });
  });

  it('Tailscale up, our DuckDNS name, a proxy on 443 and router forwards (ours and a stranger)', async () => {
    const mappings: Record<number, PortMapping> = {
      443: { externalPort: 443, internalPort: 18443, internalClient: '192.168.0.5', description: 'cld-gui' },
      22: { externalPort: 22, internalPort: 22, internalClient: '192.168.0.20', description: 'nas' },
    };
    const gateway = { entry: async (p: number) => mappings[p] ?? null } as unknown as Gateway;
    const r = await scanExisting(deps({
      tailscale: async () => ({ host: 'office.tail1.ts.net', serving: false }),
      duckName: 'myoffice.duckdns.org',
      touch: async (_host, port) => port === 443,
      gateway: async () => gateway,
    }));
    const all = texts(r).join('\n');
    expect(all).toContain('office.tail1.ts.net');
    expect(all).toContain('443번에서 이미 무언가가');
    expect(all).toContain('외부 443번을 192.168.0.5:18443');
    expect(all).toContain('외부 22번을 192.168.0.20:22');
    expect(all).toContain('myoffice.duckdns.org');
    expect(r.steps.find((s) => s.text.includes('192.168.0.5:18443'))?.suggest).toBe('direct');
    expect(r.steps.find((s) => s.text.includes('192.168.0.20:22'))?.suggest).toBeUndefined();
  });

  it('our own quick tunnel is not "already there"; a probe that hangs is skipped within the time box', async () => {
    const started = Date.now();
    const r = await scanExisting(deps({
      ownTunnelPid: 777,
      answers: { 'pgrep -x cloudflared': '777\n' },
      tailscale: () => new Promise(() => undefined),
      sshd: () => new Promise(() => undefined),
    }));
    expect(r.steps).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('the SSH card only asks the SSH probes', async () => {
    const asked: string[] = [];
    await scanExisting(deps({
      sshOnly: true,
      run: async (command) => { asked.push(command); return null; },
      tailscale: async () => { throw new Error('must not ask'); },
      gateway: async () => { throw new Error('must not ask'); },
    }));
    expect(asked).toEqual(['ss']);
  });
});
