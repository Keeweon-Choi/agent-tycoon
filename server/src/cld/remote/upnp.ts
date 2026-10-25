/**
 * A minimal UPnP Internet Gateway Device client (T-0024): find the router,
 * read its WAN address, add and remove one TCP port mapping.
 *
 * Why not @achingbrain/nat-port-mapper (the spec's pick): its 4.0.5 searches
 * only for InternetGatewayDevice:2 and speaks only WANIPConnection:2
 * (dist/src/upnp/discovery.js, internet-gateway-service-4.js), so routers that
 * announce IGD:1 -- most home routers -- are never found; and its unmap()
 * deletes the external port named by the *local* port. IGD:1's
 * AddPortMapping is also part of IGD:2, so this client speaks v1 to both.
 *
 * ponytail: UPnP IGD only. NAT-PMP/PCP (Apple, some OpenWrt) are not tried;
 * add them when a user's router speaks only those.
 */
import * as dgram from 'dgram';

import { koText } from '../../../../core/src/cld/serverText.js';
import { isPrivateIpv4 } from './net.js';

export const SSDP = { host: '239.255.255.250', port: 1900 };
const SEARCH_TARGET = 'urn:schemas-upnp-org:device:InternetGatewayDevice:1';
/** The WAN connection services, best first (WANIPConnection:2 still offers v1's actions). */
const SERVICES = [
  'urn:schemas-upnp-org:service:WANIPConnection:2',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANPPPConnection:1',
];

export class UpnpError extends Error {
  constructor(
    readonly code: number | null,
    message: string,
  ) {
    super(message);
  }
}

export interface PortMapping {
  externalPort: number;
  internalPort: number;
  internalClient: string;
  description: string;
}

/** The router, once found. */
export interface Gateway {
  /** Where its description lives (for logs). */
  location: string;
  externalIp(): Promise<string>;
  /** Map external TCP `externalPort` to `internalClient:internalPort`; refreshes when it is ours. */
  map(mapping: PortMapping): Promise<void>;
  /** Remove the mapping only when the router's entry is ours (client, port, description). */
  unmap(mapping: PortMapping): Promise<void>;
  /** Read-only: the router's TCP mapping on `externalPort`, null when there is none. */
  entry?(externalPort: number): Promise<PortMapping | null>;
}

/** Sends M-SEARCH and yields LOCATION urls (test seam). */
export type SsdpSearch = (options: {
  bindAddress?: string;
  timeoutMs: number;
}) => Promise<string[]>;

/** One SSDP response's LOCATION header, when the responder is on our side of the router. */
export function parseSsdpResponse(text: string, from: string): string | null {
  if (!/^HTTP\/1\.[01] 200/i.test(text)) return null;
  const location = /^location:\s*(\S+)\s*$/im.exec(text)?.[1];
  if (!location) return null;
  try {
    const url = new URL(location);
    // Only the device that answered, and only a LAN address: a stray SSDP
    // reply must not send our SOAP requests to the internet or to localhost.
    if (url.protocol !== 'http:' || url.hostname !== from || !isPrivateIpv4(from)) return null;
    if (from.startsWith('127.')) return null;
    return url.href;
  } catch {
    return null;
  }
}

export const ssdpSearch: SsdpSearch = ({ bindAddress, timeoutMs }) =>
  new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const found = new Set<string>();
    const message = Buffer.from(
      `M-SEARCH * HTTP/1.1\r\nHOST: ${SSDP.host}:${SSDP.port}\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${SEARCH_TARGET}\r\n\r\n`,
    );
    const timers: NodeJS.Timeout[] = [];
    const finish = () => {
      for (const t of timers) clearTimeout(t);
      socket.close();
      resolve([...found]);
    };
    socket.on('error', finish);
    socket.on('message', (msg, rinfo) => {
      const location = parseSsdpResponse(msg.toString('utf8'), rinfo.address);
      if (location) found.add(location);
    });
    socket.bind({ address: bindAddress, port: 0 }, () => {
      // Retransmit: routers drop searches and UDP drops datagrams.
      for (const at of [0, 700, 1600])
        timers.push(setTimeout(() => socket.send(message, SSDP.port, SSDP.host, () => {}), at));
    });
    timers.push(setTimeout(finish, timeoutMs));
  });

const xmlEscape = (s: string) =>
  s.replace(
    /[<>&'"]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c] ?? c,
  );

/** The WAN connection service's control URL from a device description. */
export function parseDescription(
  xml: string,
  location: string,
): { serviceType: string; controlUrl: string } | null {
  const base = /<URLBase>\s*([^<\s]+)\s*<\/URLBase>/i.exec(xml)?.[1] ?? location;
  const services = [...xml.matchAll(/<service>([\s\S]*?)<\/service>/gi)].map((m) => ({
    type: /<serviceType>\s*([^<\s]+)\s*<\/serviceType>/i.exec(m[1])?.[1] ?? '',
    control: /<controlURL>\s*([^<\s]+)\s*<\/controlURL>/i.exec(m[1])?.[1] ?? '',
  }));
  for (const wanted of SERVICES) {
    const service = services.find((s) => s.type === wanted && s.control);
    if (!service) continue;
    try {
      const url = new URL(service.control, base);
      // The control URL must stay on the device that described itself.
      if (url.protocol !== 'http:' || url.hostname !== new URL(location).hostname) return null;
      return { serviceType: wanted, controlUrl: url.href };
    } catch {
      return null;
    }
  }
  return null;
}

function soapEnvelope(serviceType: string, action: string, args: Array<[string, string]>): string {
  const body = args.map(([k, v]) => `<${k}>${xmlEscape(v)}</${k}>`).join('');
  return `<?xml version="1.0"?>\r\n<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${serviceType}">${body}</u:${action}></s:Body></s:Envelope>`;
}

// `[^<]*` then trim: no nested lazy/greedy whitespace groups to backtrack over.
const tag = (xml: string, name: string) =>
  new RegExp(`<(?:\\w+:)?${name}>([^<]*)</(?:\\w+:)?${name}>`, 'i').exec(xml)?.[1].trim();

/** Router replies are untrusted LAN input: real ones are a few KB. */
export const MAX_UPNP_BODY = 64 * 1024;

async function cappedText(response: Response): Promise<string> {
  if (Number(response.headers.get('content-length') ?? 0) > MAX_UPNP_BODY)
    throw new UpnpError(null, 'reply too large');
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_UPNP_BODY) {
      await reader.cancel();
      throw new UpnpError(null, 'reply too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The gateway at `location`, or null when it has no WAN connection service. */
export async function openGateway(
  location: string,
  fetchFn: typeof fetch = fetch,
  timeoutMs = 4000,
): Promise<Gateway | null> {
  // No redirects: they could send us (and our SOAP body) off the device that answered.
  const response = await fetchFn(location, {
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) return null;
  const service = parseDescription(await cappedText(response), location);
  if (!service) return null;
  const call = async (action: string, args: Array<[string, string]> = []) => {
    const res = await fetchFn(service.controlUrl, {
      method: 'POST',
      headers: {
        'content-type': 'text/xml; charset="utf-8"',
        soapaction: `"${service.serviceType}#${action}"`,
      },
      body: soapEnvelope(service.serviceType, action, args),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await cappedText(res);
    if (!res.ok) {
      const code = Number(tag(text, 'errorCode'));
      throw new UpnpError(
        Number.isInteger(code) && code > 0 ? code : null,
        tag(text, 'errorDescription') ?? `HTTP ${res.status}`,
      );
    }
    return text;
  };
  const add = (m: PortMapping, lease: number) =>
    call('AddPortMapping', [
      ['NewRemoteHost', ''],
      ['NewExternalPort', String(m.externalPort)],
      ['NewProtocol', 'TCP'],
      ['NewInternalPort', String(m.internalPort)],
      ['NewInternalClient', m.internalClient],
      ['NewEnabled', '1'],
      ['NewPortMappingDescription', m.description],
      ['NewLeaseDuration', String(lease)],
    ]);
  const specificEntry = (externalPort: number) =>
    call('GetSpecificPortMappingEntry', [
      ['NewRemoteHost', ''],
      ['NewExternalPort', String(externalPort)],
      ['NewProtocol', 'TCP'],
    ]).catch(() => '');
  return {
    location,
    async entry(externalPort) {
      const found = await specificEntry(externalPort);
      const internalClient = tag(found, 'NewInternalClient');
      if (!internalClient) return null;
      return {
        externalPort,
        internalPort: Number(tag(found, 'NewInternalPort')),
        internalClient,
        description: tag(found, 'NewPortMappingDescription') ?? '',
      };
    },
    async externalIp() {
      const ip = tag(await call('GetExternalIPAddress'), 'NewExternalIPAddress');
      if (!ip) throw new UpnpError(null, 'no NewExternalIPAddress');
      return ip;
    },
    async map(m) {
      try {
        await add(m, 3600);
      } catch (error) {
        if (!(error instanceof UpnpError)) throw error;
        // 725 OnlyPermanentLeasesSupported: many ISP routers; re-map keeps it fresh anyway.
        if (error.code === 725) return void (await add(m, 0));
        // 718 ConflictInMappingEntry: fine when the entry is already ours.
        if (error.code === 718) {
          const entry = await specificEntry(m.externalPort);
          const client = tag(entry, 'NewInternalClient');
          if (
            client === m.internalClient &&
            tag(entry, 'NewInternalPort') === String(m.internalPort)
          )
            return;
          throw new UpnpError(
            718,
            koText('port_taken', { port: m.externalPort, client: client ?? koText('unknown_device') }),
          );
        }
        throw error;
      }
    },
    async unmap(m) {
      // DeletePortMapping names only the external port: check first that the
      // entry there is still ours, not another device's that took 443 since.
      const entry = await specificEntry(m.externalPort);
      if (
        tag(entry, 'NewInternalClient') !== m.internalClient ||
        tag(entry, 'NewInternalPort') !== String(m.internalPort) ||
        tag(entry, 'NewPortMappingDescription') !== m.description
      )
        return;
      await call('DeletePortMapping', [
        ['NewRemoteHost', ''],
        ['NewExternalPort', String(m.externalPort)],
        ['NewProtocol', 'TCP'],
      ]);
    },
  };
}

/** The first answering gateway on the LAN, or null when none answers in time. */
export async function findGateway(
  options: {
    bindAddress?: string;
    timeoutMs?: number;
    search?: SsdpSearch;
    fetchFn?: typeof fetch;
  } = {},
): Promise<Gateway | null> {
  const locations = await (options.search ?? ssdpSearch)({
    bindAddress: options.bindAddress,
    timeoutMs: options.timeoutMs ?? 3500,
  });
  for (const location of locations) {
    const gateway = await openGateway(location, options.fetchFn).catch(() => null);
    if (gateway) return gateway;
  }
  return null;
}
