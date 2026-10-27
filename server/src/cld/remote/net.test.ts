/**
 * T-0024 network facts and the UPnP client: NAT classification with injected
 * addresses, the LAN address, STUN against a local fake server, the WSL
 * message, and UPnP against a local fake router (no real SSDP, no real router).
 */
import * as dgram from 'dgram';
import { readFileSync } from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as net from 'net';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  classifyNat,
  detectFirewall,
  firewallCommands,
  firewallRules,
  isCgnatIpv4,
  isPublicIpv4,
  parseIpconfig,
  parseStunResponse,
  pickLanIp,
  relayCommands,
  reverseDnsName,
  sshProbe,
  stunObservedIp,
  stunRequest,
  wslSteps,
} from './net.js';
import {
  findGateway,
  MAX_UPNP_BODY,
  openGateway,
  parseDescription,
  parseSsdpResponse,
  UpnpError,
} from './upnp.js';

type AdminFixtureRequest =
  | { kind: 'relay'; directPort: number; externalPort: number }
  | { kind: 'firewall'; firewall: 'windows' | 'wsl-mirrored'; ports: number[] };
const ADMIN_FIXTURE = JSON.parse(readFileSync(path.join(__dirname, '../../../../cld/desktop/src-tauri/admin-lines.json'), 'utf8')) as {
  requests: { request: AdminFixtureRequest; lines: string[] }[];
};

describe('NAT classification (CGNAT / double NAT detection)', () => {
  it('a public WAN that the internet also sees: open', () => {
    expect(
      classifyNat({ gateway: true, wanIp: '121.134.5.6', observedIp: '121.134.5.6' }).kind,
    ).toBe('open');
    expect(classifyNat({ gateway: true, wanIp: '121.134.5.6', observedIp: null }).kind).toBe(
      'open',
    );
  });
  it('carrier NAT: a 100.64/10 WAN, or a public WAN the internet does not see', () => {
    expect(
      classifyNat({ gateway: true, wanIp: '100.72.1.2', observedIp: '121.134.5.6' }).kind,
    ).toBe('cgnat');
    expect(classifyNat({ gateway: true, wanIp: '121.134.5.6', observedIp: '211.1.2.3' }).kind).toBe(
      'cgnat',
    );
  });
  it('a modem in NAT mode above the router (SKB 192.168.55.x): double NAT', () => {
    expect(
      classifyNat({ gateway: true, wanIp: '192.168.55.10', observedIp: '121.134.5.6' }),
    ).toEqual({
      kind: 'double-nat',
      reason: expect.stringContaining('이중 NAT'),
    });
    expect(classifyNat({ gateway: true, wanIp: '10.0.0.2' }).kind).toBe('double-nat');
  });
  it('no UPnP answer, or no WAN address', () => {
    expect(classifyNat({ gateway: false }).kind).toBe('no-upnp');
    expect(classifyNat({ gateway: true, wanIp: null }).kind).toBe('unknown');
  });
  it('address helpers', () => {
    expect(isCgnatIpv4('100.64.0.1')).toBe(true);
    expect(isCgnatIpv4('100.128.0.1')).toBe(false);
    expect(isPublicIpv4('8.8.8.8')).toBe(true);
    for (const ip of [
      '10.1.1.1',
      '172.20.0.1',
      '192.168.0.1',
      '100.100.1.1',
      '127.0.0.1',
      '0.1.2.3',
      'x',
    ])
      expect(isPublicIpv4(ip), ip).toBe(false);
    expect(reverseDnsName('203.0.113.7')).toBe('7.113.0.203.in-addr.arpa');
  });
});

describe('the LAN address (bind address for lan/direct)', () => {
  const iface = (address: string, internal = false) => ({
    address,
    netmask: '255.255.255.0',
    family: 'IPv4' as const,
    mac: '00:00:00:00:00:00',
    internal,
    cidr: null,
  });
  it('prefers the home router range, skips loopback, VPNs, containers and link-local', () => {
    expect(
      pickLanIp({
        lo: [iface('127.0.0.1', true)],
        tailscale0: [iface('100.64.0.31')],
        docker0: [iface('172.17.0.1')],
        eth0: [iface('172.24.0.10')],
        wlan0: [iface('192.168.0.100')],
        eth1: [iface('169.254.3.4')],
      }),
    ).toBe('192.168.0.100');
  });
  it('WSL NAT mode has only its own 172.x address; nothing at all is null', () => {
    expect(pickLanIp({ eth0: [iface('172.24.0.10')] })).toBe('172.24.0.10');
    expect(pickLanIp({ lo: [iface('127.0.0.1', true)] })).toBeNull();
  });
});

describe('STUN (observed public address)', () => {
  let server: dgram.Socket | undefined;
  afterEach(() => server?.close());

  /** A Binding Success with XOR-MAPPED-ADDRESS, as Google's server sends it. */
  function response(id: Buffer, ip: string, port: number): Buffer {
    const msg = Buffer.alloc(32);
    msg.writeUInt16BE(0x0101, 0);
    msg.writeUInt16BE(12, 2);
    msg.writeUInt32BE(0x2112a442, 4);
    id.copy(msg, 8);
    msg.writeUInt16BE(0x0020, 20);
    msg.writeUInt16BE(8, 22);
    msg[25] = 0x01;
    msg.writeUInt16BE(port ^ 0x2112, 26);
    const n = ip.split('.').reduce((a, p) => a * 256 + Number(p), 0);
    msg.writeUInt32BE((n ^ 0x2112a442) >>> 0, 28);
    return msg;
  }

  it('parses XOR-MAPPED-ADDRESS and refuses another transaction', () => {
    const id = Buffer.alloc(12, 7);
    expect(stunRequest(id).subarray(0, 8).toString('hex')).toBe('000100002112a442');
    expect(parseStunResponse(response(id, '121.134.5.6', 54321), id)).toBe('121.134.5.6');
    expect(parseStunResponse(response(id, '121.134.5.6', 1), Buffer.alloc(12, 8))).toBeNull();
    expect(parseStunResponse(Buffer.from('junk'), id)).toBeNull();
  });

  it('asks a server over UDP (a local fake standing in for stun.l.google.com)', async () => {
    server = dgram.createSocket('udp4');
    server.on('message', (msg, rinfo) => {
      server?.send(
        response(msg.subarray(8, 20), '121.134.5.6', rinfo.port),
        rinfo.port,
        rinfo.address,
      );
    });
    await new Promise<void>((r) => server?.bind(0, '127.0.0.1', r));
    const { port } = server.address();
    expect(await stunObservedIp({ host: '127.0.0.1', port }, 2000)).toBe('121.134.5.6');
  });

  it('times out to null when nobody answers', async () => {
    server = dgram.createSocket('udp4');
    await new Promise<void>((r) => server?.bind(0, '127.0.0.1', r));
    expect(
      await stunObservedIp({ host: '127.0.0.1', port: server.address().port }, 300),
    ).toBeNull();
  });
});

describe('WSL message (Windows-side steps)', () => {
  it('NAT mode: the portproxy relay to 127.0.0.1 first (with its undo), the LAN portproxy, mirrored last', () => {
    const lines = wslSteps('nat', [18240, 18443]).join('\n');
    expect(lines).toContain('WSL NAT 모드');
    expect(lines).toContain(
      'netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=443 connectaddress=127.0.0.1 connectport=18443',
    );
    expect(lines).toContain(
      'Remove-NetFirewallRule -Name cld-gui-443 -ErrorAction SilentlyContinue; New-NetFirewallRule -Name cld-gui-443 -DisplayName "cld-gui 443" -Direction Inbound -Protocol TCP -LocalPort 443 -Action Allow',
    );
    expect(lines).toContain(
      'netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=443 | Out-Null',
    );
    expect(lines).toContain('networkingMode=mirrored');
    expect(lines).toContain(
      '관리자 PowerShell에서 한 번: Remove-NetFirewallHyperVRule -Name cld-gui-18240 -ErrorAction SilentlyContinue; New-NetFirewallHyperVRule -Name cld-gui-18240 -DisplayName "cld-gui 18240" -Direction Inbound -VMCreatorId \'{40E0AC32-46A5-438A-A0B2-2B479E8F2E90}\' -Protocol TCP -LocalPorts 18240',
    );
  });
  it('reads Windows addresses from ipconfig in any language', () => {
    const korean =
      '이더넷 어댑터 이더넷:\r\n   IPv4 \xc1\xd6\xbc\xd2 . . . . . . . . . : 203.0.113.10(\xb1\xe2\xba\xbb)\r\n   서브넷 마스크 . . : 255.255.255.0\r\n' +
      '이더넷 어댑터 vEthernet (WSL):\r\n   IPv4 Address. . . . . . . . . . . : 172.20.0.1\r\n   Default Gateway . . : 121.173.204.1\r\n';
    expect(parseIpconfig(korean)).toEqual(['203.0.113.10', '172.20.0.1']);
    expect(parseIpconfig('')).toEqual([]);
  });
  it('an sshd answers with its banner; a closed port does not', async () => {
    const server = net.createServer((s) => s.end('SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13\r\n'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;
    expect(await sshProbe(port)).toEqual({
      open: true,
      banner: 'SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13',
    });
    await new Promise((r) => server.close(r));
    expect((await sshProbe(port)).open).toBe(false);
  });
  it('mirrored mode: only the firewall rule, no portproxy', () => {
    const lines = wslSteps('mirrored', [18240]);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('-LocalPorts 18240');
    expect(lines.join('\n')).not.toContain('portproxy');
  });
});

describe('REMOTE-XPLAT: the host firewall per platform', () => {
  const run = (answers: Record<string, string | null>) => async (command: string, args: string[]) =>
    answers[[command, ...args].join(' ')] ?? null;
  const detect = (platform: NodeJS.Platform, wslMode: string | null, answers: Record<string, string | null> = {}, files: Record<string, string> = {}) =>
    detectFirewall({ platform, wslMode, run: run(answers), read: (file) => files[file] ?? null });
  it('which firewall is in the way: Windows always, WSL mirrored Hyper-V, WSL NAT none (the relay has its rule)', async () => {
    expect(await detect('win32', null)).toBe('windows');
    expect(await detect('linux', 'mirrored')).toBe('wsl-mirrored');
    expect(await detect('linux', 'nat')).toBeNull();
  });
  it('Linux: ufw only when its own config says ENABLED=yes, firewalld when active, else nothing', async () => {
    expect(await detect('linux', null, {}, { '/etc/ufw/ufw.conf': 'ENABLED=yes\nLOGLEVEL=low\n' })).toBe('ufw');
    // ufw.service reads "active" even when ufw is disabled: that alone is not a firewall.
    expect(await detect('linux', null, { 'systemctl is-active ufw': 'active\n' }, { '/etc/ufw/ufw.conf': 'ENABLED=no\n' })).toBeNull();
    expect(await detect('linux', null, { 'systemctl is-active firewalld': 'active\n' })).toBe('firewalld');
    expect(await detect('linux', null)).toBeNull(); // tool missing: nothing
  });
  it('macOS: the application firewall only when it is on', async () => {
    const q = '/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate';
    expect(await detect('darwin', null, { [q]: 'Firewall is enabled. (State = 1)\n' })).toBe('macos');
    expect(await detect('darwin', null, { [q]: 'Firewall is disabled. (State = 0)\n' })).toBeNull();
    expect(await detect('darwin', null)).toBeNull();
  });
  it('every add is safe to run twice and every remove is quiet when the rule is gone', () => {
    const win = firewallCommands('windows', [18240, 18443]);
    expect(win.add[0]).toBe('Remove-NetFirewallRule -Name cld-gui-18240 -ErrorAction SilentlyContinue; New-NetFirewallRule -Name cld-gui-18240 -DisplayName "cld-gui 18240" -Direction Inbound -Protocol TCP -LocalPort 18240 -Action Allow');
    expect(win.remove).toEqual(['Remove-NetFirewallRule -Name cld-gui-18240 -ErrorAction SilentlyContinue', 'Remove-NetFirewallRule -Name cld-gui-18443 -ErrorAction SilentlyContinue']);
    expect(win.names).toEqual(['cld-gui-18240', 'cld-gui-18443']);
    const mirrored = firewallCommands('wsl-mirrored', [18240]);
    expect(mirrored.add[0]).toMatch(/^Remove-NetFirewallHyperVRule -Name cld-gui-18240 -ErrorAction SilentlyContinue; New-NetFirewallHyperVRule /);
    expect(mirrored.names).toEqual(['hyperv:cld-gui-18240']);
    for (const kind of ['windows', 'wsl-mirrored'] as const)
      for (const line of firewallCommands(kind, [1, 2]).remove) expect(line).toMatch(/-ErrorAction SilentlyContinue$/);
    expect(firewallCommands('ufw', [18240])).toEqual({ add: ['sudo ufw allow 18240/tcp'], remove: ['sudo ufw delete allow 18240/tcp'] });
    expect(firewallCommands('firewalld', [18240, 18443])).toEqual({
      add: ['sudo firewall-cmd --permanent --add-port=18240/tcp --add-port=18443/tcp', 'sudo firewall-cmd --reload'],
      remove: ['sudo firewall-cmd --permanent --remove-port=18240/tcp --remove-port=18443/tcp', 'sudo firewall-cmd --reload'],
    });
    const mac = firewallCommands('macos', [18240], '/Users/a b/.nvm/node');
    expect(mac.add).toEqual([
      "sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add '/Users/a b/.nvm/node'",
      "sudo /usr/libexec/ApplicationFirewall/socketfilterfw --unblockapp '/Users/a b/.nvm/node'",
    ]);
    expect(mac.remove[0]).toMatch(/--remove '\/Users\/a b\/.nvm\/node' \|\| true$/);
    const relay = relayCommands(18443);
    expect(relay.remove).toEqual([
      'netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=443 | Out-Null',
      'Remove-NetFirewallRule -Name cld-gui-443 -ErrorAction SilentlyContinue',
    ]);
  });
  it('reads our Windows rule names back (Hyper-V ones marked); null when PowerShell cannot be asked', async () => {
    expect(await firewallRules(async () => 'cld-gui-443\r\nhyperv:cld-gui-18240\r\n')).toEqual(['cld-gui-443', 'hyperv:cld-gui-18240']);
    expect(await firewallRules(async () => '')).toEqual([]);
    expect(await firewallRules(async () => null)).toBeNull();
  });
});

describe('Windows administrator command fixture', () => {
  it('keeps the desktop app lines identical to the server lines', () => {
    for (const { request, lines } of ADMIN_FIXTURE.requests) {
      const actual = request.kind === 'relay'
        ? relayCommands(request.directPort, request.externalPort).add
        : firewallCommands(request.firewall, request.ports).add;
      expect(actual).toEqual(lines);
    }
  });
});

// ── UPnP ──────────────────────────────────────────────────────────

const IGD1 = (control: string) => `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0"><device>
<deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:1</deviceType>
<deviceList><device><deviceType>urn:schemas-upnp-org:device:WANDevice:1</deviceType>
<deviceList><device><deviceType>urn:schemas-upnp-org:device:WANConnectionDevice:1</deviceType>
<serviceList>
<service><serviceType>urn:schemas-upnp-org:service:WANCommonInterfaceConfig:1</serviceType><controlURL>/ctl/CmnIfCfg</controlURL></service>
<service><serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType><serviceId>urn:upnp-org:serviceId:WANIPConn1</serviceId><controlURL>${control}</controlURL></service>
</serviceList></device></deviceList></device></deviceList></device></root>`;

describe('UPnP client (IGD:1 and IGD:2 routers)', () => {
  it('reads SSDP replies only from a LAN device that names itself', () => {
    const reply = (location: string) =>
      `HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=120\r\nST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\nLOCATION: ${location}\r\n\r\n`;
    expect(parseSsdpResponse(reply('http://192.168.0.1:5000/rootDesc.xml'), '192.168.0.1')).toBe(
      'http://192.168.0.1:5000/rootDesc.xml',
    );
    expect(parseSsdpResponse(reply('http://203.0.113.9/x.xml'), '203.0.113.9')).toBeNull(); // not on the LAN
    expect(parseSsdpResponse(reply('http://192.168.0.66/x.xml'), '192.168.0.1')).toBeNull(); // points elsewhere
    expect(parseSsdpResponse(reply('http://127.0.0.1/x.xml'), '127.0.0.1')).toBeNull();
    expect(parseSsdpResponse('NOTIFY * HTTP/1.1\r\n\r\n', '192.168.0.1')).toBeNull();
  });

  it('finds the WAN connection in an IGD:1 description (most home routers) and in IGD:2', () => {
    expect(parseDescription(IGD1('/ctl/IPConn'), 'http://192.168.0.1:5000/rootDesc.xml')).toEqual({
      serviceType: 'urn:schemas-upnp-org:service:WANIPConnection:1',
      controlUrl: 'http://192.168.0.1:5000/ctl/IPConn',
    });
    const v2 = IGD1('/c2').replace('WANIPConnection:1', 'WANIPConnection:2');
    expect(parseDescription(v2, 'http://192.168.0.1/d.xml')?.serviceType).toBe(
      'urn:schemas-upnp-org:service:WANIPConnection:2',
    );
    expect(
      parseDescription(IGD1('http://203.0.113.9/steal'), 'http://192.168.0.1/d.xml'),
    ).toBeNull();
    expect(parseDescription('<root/>', 'http://192.168.0.1/d.xml')).toBeNull();
  });

  describe('against a fake router', () => {
    let router: http.Server | undefined;
    afterEach(() => router?.close());

    async function fakeRouter(
      answer: (action: string, body: string) => { status: number; body: string },
    ) {
      const calls: Array<{ action: string; body: string }> = [];
      router = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c: Buffer) => (body += c.toString()));
        req.on('end', () => {
          if (req.method === 'GET') return void res.end(IGD1('/ctl/IPConn'));
          const action = /#(\w+)"$/.exec(String(req.headers.soapaction))?.[1] ?? '';
          calls.push({ action, body });
          const out = answer(action, body);
          res.writeHead(out.status, { 'content-type': 'text/xml' }).end(out.body);
        });
      });
      await new Promise<void>((r) => router?.listen(0, '127.0.0.1', r));
      const { port } = router.address() as AddressInfo;
      return { calls, location: `http://127.0.0.1:${port}/rootDesc.xml` };
    }
    const ok = (action: string, inner = '') => ({
      status: 200,
      body: `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action}Response xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1">${inner}</u:${action}Response></s:Body></s:Envelope>`,
    });
    const fault = (code: number, text: string) => ({
      status: 500,
      body: `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>${code}</errorCode><errorDescription>${text}</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>`,
    });
    const mapping = {
      externalPort: 443,
      internalPort: 18443,
      internalClient: '192.168.0.100',
      description: 'cld-gui',
    };

    it('reads the WAN address and maps 443 with a one-hour lease', async () => {
      const { calls, location } = await fakeRouter((action) =>
        action === 'GetExternalIPAddress'
          ? ok(action, '<NewExternalIPAddress>121.134.5.6</NewExternalIPAddress>')
          : action === 'GetSpecificPortMappingEntry'
            ? ok(action, ours)
            : ok(action),
      );
      const gateway = await findGateway({ search: async () => [location] });
      expect(gateway).not.toBeNull();
      expect(await gateway?.externalIp()).toBe('121.134.5.6');
      await gateway?.map(mapping);
      const add = calls.find((c) => c.action === 'AddPortMapping')?.body ?? '';
      for (const field of [
        '<NewExternalPort>443<',
        '<NewInternalPort>18443<',
        '<NewInternalClient>192.168.0.100<',
        '<NewProtocol>TCP<',
        '<NewLeaseDuration>3600<',
        '<NewPortMappingDescription>cld-gui<',
      ])
        expect(add).toContain(field);
      await gateway?.unmap(mapping);
      expect(calls.at(-1)?.action).toBe('DeletePortMapping');
      expect(calls.at(-1)?.body).toContain('<NewExternalPort>443<');
    });

    const ours =
      '<NewInternalPort>18443</NewInternalPort><NewInternalClient>192.168.0.100</NewInternalClient><NewEnabled>1</NewEnabled><NewPortMappingDescription>cld-gui</NewPortMappingDescription><NewLeaseDuration>0</NewLeaseDuration>';

    it("unmap removes only our entry: another device's 443 (or a look-alike) stays", async () => {
      let entry = ours;
      const { calls, location } = await fakeRouter((action) =>
        action === 'GetSpecificPortMappingEntry' ? ok(action, entry) : ok(action),
      );
      const gateway = await openGateway(location);
      for (const other of [
        ours.replace('192.168.0.100', '192.168.0.33'), // a NAS took 443 after ours lapsed
        ours.replace('18443', '443'),
        ours.replace('>cld-gui<', '>nas-web<'),
      ]) {
        entry = other;
        await gateway?.unmap(mapping);
      }
      expect(calls.some((c) => c.action === 'DeletePortMapping')).toBe(false);
      entry = '';
      await gateway?.unmap(mapping); // no entry at all (714): nothing to delete
      expect(calls.some((c) => c.action === 'DeletePortMapping')).toBe(false);
    });

    it('untrusted LAN replies: no redirects, no oversized bodies, no regex blow-up', async () => {
      const redirecting = http.createServer((_req, res) =>
        res.writeHead(302, { location: 'http://127.0.0.1:1/elsewhere' }).end(),
      );
      await new Promise<void>((r) => redirecting.listen(0, '127.0.0.1', r));
      const at = `http://127.0.0.1:${(redirecting.address() as AddressInfo).port}/d.xml`;
      await expect(openGateway(at)).rejects.toThrow();
      redirecting.close();

      const huge = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/xml' });
        res.end(IGD1('/ctl/IPConn') + ' '.repeat(2 * MAX_UPNP_BODY));
      });
      await new Promise<void>((r) => huge.listen(0, '127.0.0.1', r));
      const big = `http://127.0.0.1:${(huge.address() as AddressInfo).port}/d.xml`;
      await expect(openGateway(big)).rejects.toThrow('reply too large');
      huge.close();

      const started = Date.now();
      const { location } = await fakeRouter((action) =>
        ok(action, `<NewExternalIPAddress>${' '.repeat(MAX_UPNP_BODY - 600)}x`),
      );
      await expect((await openGateway(location))?.externalIp()).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(2000);
    });

    it('725 OnlyPermanentLeasesSupported: maps again with a permanent lease', async () => {
      const { calls, location } = await fakeRouter((action, body) =>
        action === 'AddPortMapping' && body.includes('<NewLeaseDuration>3600<')
          ? fault(725, 'OnlyPermanentLeasesSupported')
          : ok(action),
      );
      await (await openGateway(location))?.map(mapping);
      expect(
        calls
          .filter((c) => c.action === 'AddPortMapping')
          .map((c) => /<NewLeaseDuration>(\d+)</.exec(c.body)?.[1]),
      ).toEqual(['3600', '0']);
    });

    it('718 ConflictInMappingEntry: fine when the entry is ours, an error naming the other device when not', async () => {
      let owner = '192.168.0.100';
      const { location } = await fakeRouter((action) =>
        action === 'AddPortMapping'
          ? fault(718, 'ConflictInMappingEntry')
          : ok(
              action,
              `<NewInternalPort>18443</NewInternalPort><NewInternalClient>${owner}</NewInternalClient>`,
            ),
      );
      const gateway = await openGateway(location);
      await expect(gateway?.map(mapping)).resolves.toBeUndefined();
      owner = '192.168.0.33';
      const error = await gateway?.map(mapping).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(UpnpError);
      expect((error as UpnpError).message).toContain('192.168.0.33');
    });

    it('no router answered: null (UPnP off)', async () => {
      expect(await findGateway({ search: async () => [] })).toBeNull();
    });
  });
});
