import Fastify from 'fastify';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { expect, it } from 'vitest';

import { agtyHooks } from '../hooks.js';
import { startRemote } from './index.js';

it('POST setup returns only the selected option; unknown and read-only requests are refused', async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agty-setup-api-'));
  const prior = {
    registerRoutes: agtyHooks.registerRoutes, onListening: agtyHooks.onListening,
    canonicalUrl: agtyHooks.canonicalUrl, verifiedOutsideUrl: agtyHooks.verifiedOutsideUrl,
  };
  const remote = startRemote({
    connector: 'local', allowedHosts: [], readOnly: true, configDir,
    token: { current: 'host-token' },
    deps: {
      lanIp: null, wslMode: async () => null, tailscaleServe: async () => null,
      setupCommand: async () => null,
      setupFacts: async () => ({
        natKind: 'cgnat', upnp: false, wslMode: null, relayReady: false,
        tailscaleInstalled: false, tailscaleLoggedIn: false, cloudflaredInstalled: false,
        platform: 'linux',
      }),
    },
  });
  const app = Fastify();
  try {
    agtyHooks.registerRoutes?.(app, async (request, reply) => {
      if (request.headers.authorization !== 'Bearer host-token' && request.headers.cookie !== 'agty_session=valid')
        void reply.code(401).send('unauthorized');
    });
    await app.ready();
    Object.defineProperty(app.server, 'address', { value: () => ({ port: 18256 }), configurable: true });
    agtyHooks.onListening?.({ app, allowedHostnames: new Set() });
    const post = (choice: string, headers: Record<string, string>) => app.inject({
      method: 'POST', url: '/api/agty/connector/setup', headers, payload: { choice },
    });
    const host = { authorization: 'Bearer host-token', host: 'localhost:18256' };
    for (const [choice, text] of [
      ['local', '이 PC'], ['lan', 'LAN'], ['direct', 'CGNAT'], ['ssh', 'SSH'],
      ['duckdns', 'CGNAT'], ['tailscale', 'Tailscale'], ['tunnel', 'cloudflared'],
    ]) {
      const response = await post(choice, host);
      expect(response.statusCode, choice).toBe(200);
      expect(JSON.stringify(response.json().steps), choice).toContain(text);
    }
    expect((await post('wrong', host)).statusCode).toBe(400);
    expect((await post('tailscale', {
      cookie: 'agty_session=valid', host: 'outside.example', origin: 'http://outside.example',
    })).statusCode).toBe(403);
  } finally {
    await remote.dispose();
    await app.close();
    for (const key of Object.keys(prior) as Array<keyof typeof prior>) {
      if (prior[key]) Object.assign(agtyHooks, { [key]: prior[key] });
      else delete agtyHooks[key];
    }
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});
