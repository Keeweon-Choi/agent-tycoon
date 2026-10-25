import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import { AgentStateStore } from '../agentStateStore.js';
import { createHttpServer, type HttpServerHandle } from '../httpServer.js';
import { cldHooks } from './hooks.js';

const TOKEN = 'test-server-token';

describe('cld hooks in the upstream /ws route and logger', () => {
  let server: HttpServerHandle | undefined;

  afterEach(async () => {
    await server?.app.close();
    server = undefined;
    for (const k of Object.keys(cldHooks)) delete (cldHooks as Record<string, unknown>)[k];
  });

  const start = async (listen = true) =>
    (server = await createHttpServer({
      embedded: false,
      host: '127.0.0.1',
      token: TOKEN,
      store: new AgentStateStore(),
      listen,
    }));

  /** Open a socket and wait until the server closed it or we did. */
  const connect = (port: number, headers: Record<string, string>) =>
    new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/ws`, {
        headers: { authorization: `Bearer ${TOKEN}`, ...headers },
      });
      ws.once('open', () => resolve(ws));
      ws.once('error', reject);
    });

  it('a socket that passes the gate opens and closes with the same send', async () => {
    const opened = vi.fn();
    const closed = vi.fn();
    Object.assign(cldHooks, { onClientOpened: opened, onClientClosed: closed });
    const { port } = await start();
    const ws = await connect(port, {});
    await vi.waitFor(() => expect(opened).toHaveBeenCalledTimes(1));
    expect(closed).not.toHaveBeenCalled();
    ws.close();
    await vi.waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
    expect(closed.mock.calls[0][0]).toBe(opened.mock.calls[0][0]);
  });

  it('a socket refused by the gate calls neither hook', async () => {
    const opened = vi.fn();
    const closed = vi.fn();
    Object.assign(cldHooks, { onClientOpened: opened, onClientClosed: closed });
    const { port } = await start();
    const ws = await connect(port, { origin: 'http://evil.example' });
    const code = await new Promise<number>((resolve) => ws.once('close', resolve));
    expect(code).not.toBe(1000);
    expect(opened).not.toHaveBeenCalled();
    expect(closed).not.toHaveBeenCalled();
  });

  it('logLevel sets the Fastify level; unset keeps info', async () => {
    cldHooks.logLevel = 'warn';
    expect((await start(false)).app.log.level).toBe('warn');
    await server!.app.close();
    delete cldHooks.logLevel;
    expect((await start(false)).app.log.level).toBe('info');
  });
});
