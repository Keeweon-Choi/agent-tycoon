import Fastify from 'fastify';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { expect, it } from 'vitest';

import { cldHooks } from '../hooks.js';
import { startRemote } from './index.js';

it('the remote wrapper hands every registerRoutes argument on, kindOf included', async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-route-chain-'));
  const prior = { registerRoutes: cldHooks.registerRoutes, onListening: cldHooks.onListening };
  let seen: unknown[] = [];
  cldHooks.registerRoutes = (...args: unknown[]) => {
    seen = args;
  };
  const remote = startRemote({
    connector: 'local', allowedHosts: [], readOnly: true, configDir,
    token: { current: 'host-token' },
    deps: { lanIp: null, wslMode: async () => null, tailscaleServe: async () => null, setupCommand: async () => null },
  });
  const app = Fastify();
  try {
    const auth = async () => undefined;
    const stepUpFresh = () => false;
    const actorOf = () => 'device';
    const kindOf = () => ({ host: true, remote: false });
    cldHooks.registerRoutes?.(app, auth, stepUpFresh, actorOf, kindOf);
    expect(seen).toEqual([app, auth, stepUpFresh, actorOf, kindOf]);
  } finally {
    await remote.dispose();
    await app.close();
    for (const key of Object.keys(prior) as Array<keyof typeof prior>) {
      if (prior[key]) Object.assign(cldHooks, { [key]: prior[key] });
      else delete cldHooks[key];
    }
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});
