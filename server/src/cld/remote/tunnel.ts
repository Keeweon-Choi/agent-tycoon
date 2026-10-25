import { spawn } from 'child_process';
import type { IncomingMessage, ServerResponse } from 'http';
import * as http from 'http';
import type { AddressInfo } from 'net';

import { koText } from '../../../../core/src/cld/serverText.js';
import { publicSockets } from '../auth.js';
import { type ForwardTarget,gate, gateSetCookie, prefixLocation, scrubHeaders } from './direct.js';

export interface QuickTunnel {
  url: string;
  /** cloudflared's pid and the local port it forwards to, for the exposure ledger (S6). */
  pid?: number;
  localPort?: number;
  close(): Promise<void>;
}

/** cloudflared's argv after the program name; core exposureLedger tunnelArgv must stay the same. */
export function cloudflaredArgs(localPort: number): string[] {
  return ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${localPort}`];
}

/** An HTTP listener for cloudflared with the same secret-path and public-login gates as direct. */
export async function quickTunnel(target: ForwardTarget, secret: string): Promise<QuickTunnel> {
  const server = http.createServer();
  const sockets = new Set<import('net').Socket>();
  server.on('connection', (socket) => {
    publicSockets.add(socket);
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.on('request', (req, res) => forwardRequest(req, res, target, secret));
  server.on('upgrade', (req, socket, head) => {
    const verdict = gate(req.url ?? '/', req.headers.cookie, secret);
    if (!verdict.pass || 'redirect' in verdict) return void socket.destroy();
    scrubHeaders(req.headers);
    req.headers['x-forwarded-proto'] = 'https';
    req.url = verdict.url;
    target.emit('upgrade', req, socket, head);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const port = (server.address() as AddressInfo).port;
  const child = spawn('cloudflared', cloudflaredArgs(port), { stdio: ['ignore', 'pipe', 'pipe'] });
  const close = async () => {
    child.kill();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  try {
    const host = await tunnelName(child);
    return { url: `https://${host}/${secret}/`, pid: child.pid, localPort: port, close };
  } catch (error) {
    await close();
    throw error;
  }
}

function tunnelName(child: ReturnType<typeof spawn>): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => finish(new Error(koText('tunnel_timeout'))), 20_000);
    const finish = (error?: Error, host?: string) => {
      clearTimeout(timer);
      child.off('error', failed);
      child.off('exit', exited);
      if (error) reject(error);
      else resolve(host!);
    };
    const failed = (error: Error) => finish(error);
    const exited = () => finish(new Error(koText('tunnel_exited')));
    const read = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-8192);
      const host = /https:\/\/([a-z0-9-]+\.trycloudflare\.com)\b/i.exec(output)?.[1];
      if (host) finish(undefined, host);
    };
    child.on('error', failed);
    child.on('exit', exited);
    child.stdout?.on('data', read);
    child.stderr?.on('data', read);
  });
}

function forwardRequest(req: IncomingMessage, res: ServerResponse, target: ForwardTarget, secret: string): void {
  const verdict = gate(req.url ?? '/', req.headers.cookie, secret);
  if (!verdict.pass) { res.writeHead(404, { 'content-length': '0' }); res.end(); return; }
  if ('redirect' in verdict) { res.writeHead(302, { location: verdict.redirect, 'set-cookie': gateSetCookie(secret) }); res.end(); return; }
  scrubHeaders(req.headers);
  req.headers['x-forwarded-proto'] = 'https';
  req.url = verdict.url;
  const writeHead = res.writeHead.bind(res) as (...args: unknown[]) => ServerResponse;
  (res as { writeHead: (...args: unknown[]) => ServerResponse }).writeHead = (...args) => {
    const headers = args.find((a) => typeof a === 'object' && a !== null && !Array.isArray(a)) as Record<string, unknown> | undefined;
    const location = headers?.location ?? res.getHeader('location');
    if (typeof location === 'string') {
      if (headers && 'location' in headers) headers.location = prefixLocation(location, secret);
      else res.setHeader('location', prefixLocation(location, secret));
    }
    if (verdict.viaPath) {
      const own = headers?.['set-cookie'] ?? res.getHeader('set-cookie');
      const cookies = [...(own === undefined ? [] : Array.isArray(own) ? own : [own]), gateSetCookie(secret)];
      if (headers && 'set-cookie' in headers) headers['set-cookie'] = cookies;
      else res.setHeader('set-cookie', cookies.map(String));
    }
    return writeHead(...args);
  };
  target.emit('request', req, res);
}
