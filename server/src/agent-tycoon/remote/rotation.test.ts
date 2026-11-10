import Fastify from 'fastify';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { expect, it } from 'vitest';

import { agtyHooks } from '../hooks.js';
import { startRemote } from './index.js';

it('refuses secret-path rotation from a read-only browser session before touching the connector', async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agty-rotation-'));
  const previous = agtyHooks.registerRoutes;
  const previousCanonical = agtyHooks.canonicalUrl;
  const previousListening = agtyHooks.onListening;
  const remote = startRemote({
    connector: 'local',
    allowedHosts: [],
    readOnly: true,
    configDir,
    token: {},
    deps: { lanIp: null, wslMode: async () => null },
  });
  const app = Fastify();
  try {
    agtyHooks.registerRoutes?.(app, async (request, reply) => {
      if (request.headers.cookie !== 'agty_session=valid') void reply.code(401).send('unauthorized');
    });
    await app.ready();
    const headers = {
      host: 'localhost:18240',
      origin: 'http://localhost:18240',
      cookie: 'agty_session=valid',
    };
    const readonly = await app.inject({
      method: 'POST',
      url: '/api/agty/connector/rotate',
      headers,
    });
    expect(readonly.statusCode).toBe(403);
    expect(readonly.json().error).toContain('읽기 전용');
    const foreign = await app.inject({
      method: 'POST',
      url: '/api/agty/connector/rotate',
      headers: { ...headers, origin: 'https://elsewhere.example' },
    });
    expect(foreign.statusCode).toBe(403);
  } finally {
    await app.close();
    await remote.dispose();
    agtyHooks.registerRoutes = previous;
    agtyHooks.canonicalUrl = previousCanonical;
    agtyHooks.onListening = previousListening;
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});
