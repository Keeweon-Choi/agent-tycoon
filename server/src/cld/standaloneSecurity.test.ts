import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { AgentStateStore } from '../agentStateStore.js';
import { createHttpServer, type HttpServerHandle } from '../httpServer.js';

describe('standalone security routes', () => {
  let server: HttpServerHandle | undefined;

  afterEach(async () => {
    await server?.app.close();
  });

  async function start(): Promise<HttpServerHandle> {
    server = await createHttpServer({
      embedded: false,
      host: '127.0.0.1',
      token: 'test-server-token',
      store: new AgentStateStore(),
      staticDir: process.cwd(),
      listen: false,
    });
    return server;
  }

  it('does not accept token URLs as a browser session and removes terminal routes', async () => {
    const { app } = await start();

    const root = await app.inject('/?token=test-server-token');
    const terminal = await app.inject('/terminal/x');

    expect(root.statusCode).toBe(401);
    expect(root.body).toContain('로그인 코드');
    expect(terminal.statusCode).toBe(404);
  });

  it('exchanges a Bearer-minted code for a strict HTTPS session cookie', async () => {
    const { app } = await start();
    const codeResponse = await app.inject({
      method: 'POST',
      url: '/api/login-code',
      headers: { authorization: 'Bearer test-server-token' },
    });
    const { code } = codeResponse.json<{ code: string }>();
    const login = await app.inject({
      url: `/login?code=${encodeURIComponent(code)}`,
      headers: { 'x-forwarded-proto': 'https' },
    });

    expect(codeResponse.statusCode).toBe(200);
    expect(login.statusCode).toBe(303);
    expect(login.headers.location).toBe('/');
    expect(login.headers['set-cookie']).toContain('HttpOnly; SameSite=Strict; Path=/');
    expect(login.headers['set-cookie']).toContain('Secure');
  });

  it('rejects a WebSocket upgrade without a cookie or Bearer token', async () => {
    server = await createHttpServer({
      embedded: false,
      host: '127.0.0.1',
      token: 'test-server-token',
      store: new AgentStateStore(),
    });
    const { port } = server;
    const status = await new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/ws`);
      const timeout = setTimeout(() => {
        socket.terminate();
        reject(new Error('timed out waiting for WebSocket rejection'));
      }, 2_000);
      // The auth preHandler answers 401 before the upgrade completes.
      socket.once('unexpected-response', (_req, res) => {
        clearTimeout(timeout);
        resolve(res.statusCode ?? 0);
        socket.terminate();
      });
      socket.once('open', () => {
        clearTimeout(timeout);
        resolve(101);
      });
      socket.once('error', () => undefined);
    });

    expect(status).toBe(401);
  });
});
