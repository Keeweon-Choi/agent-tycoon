import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { createAgentState } from './agentState.js';
import { AgentStateStore } from './agentStateStore.js';
import { SERVER_HEALTH_PROTOCOL_VERSION } from './constants.js';
import {
  agentCreatedMessage,
  createHttpServer,
  entryModuleSrc,
  type HttpServerHandle,
  webBuildFromStaticDir,
} from './httpServer.js';

describe('agentCreated', () => {
  const agent = createAgentState({
    id: 4,
    sessionId: 'cld:engine:eta',
    isExternal: false,
    projectDir: '',
    jsonlFile: '',
    directoryName: 'eta',
  });

  it("carries the character's planned chair, so a restart's late roster finds it", () => {
    expect(agentCreatedMessage(4, agent, 'seat:name:eta')).toMatchObject({
      type: 'agentCreated',
      id: 4,
      directoryName: 'eta',
      seatId: 'seat:name:eta',
    });
    expect(agentCreatedMessage(4, agent).seatId).toBeUndefined();
  });
});

describe('standalone web build marker', () => {
  it.each([
    ['a leading dot path', '<script type="module" src="./assets/index-ABC.js"></script>'],
    ['a root path', '<script type="module" src="/assets/index-ABC.js"></script>'],
    ['crossorigin before src', '<script type="module" crossorigin src="/assets/index-ABC.js"></script>'],
    ['crossorigin after src', '<script src="./assets/index-ABC.js" crossorigin type="module"></script>'],
  ])('%s is normalized', (_name, indexHtml) => {
    expect(entryModuleSrc(indexHtml)).toBe('assets/index-ABC.js');
  });

  it('uses the first module script and ignores pages without one', () => {
    expect(
      entryModuleSrc(
        '<script type="module" src="/assets/first.js"></script><script type="module" src="/assets/second.js"></script>',
      ),
    ).toBe('assets/first.js');
    expect(entryModuleSrc('<script src="/assets/not-a-module.js"></script>')).toBeUndefined();
  });

  it('returns undefined when index.html is missing', () => {
    const staticDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-web-build-'));
    try {
      expect(webBuildFromStaticDir(staticDir)).toBeUndefined();
    } finally {
      fs.rmSync(staticDir, { recursive: true, force: true });
    }
  });
});

describe('/api/health', () => {
  let server: HttpServerHandle | undefined;
  const token = 'test-server-token';

  afterEach(async () => {
    await server?.app.close();
  });

  async function health(headers?: Record<string, string>) {
    server = await createHttpServer({
      embedded: true,
      token,
      store: new AgentStateStore(),
      listen: false,
    });
    return server.app.inject({ method: 'GET', url: '/api/health', headers });
  }

  const publicHealth = {
    status: 'ok',
    service: 'cld-gui',
    version: process.env.CLD_GUI_VERSION ?? '',
    protocol: SERVER_HEALTH_PROTOCOL_VERSION,
    os: expect.stringMatching(/^(win32|wsl|linux|darwin)$/), // P7
  };

  it('returns exactly the public health fields without a token', async () => {
    expect((await health()).json()).toEqual(publicHealth);
  });

  it('returns diagnostics to the valid host Bearer token', async () => {
    const body = (await health({ authorization: `Bearer ${token}` })).json<{
      pid: number;
      uptime: number;
    }>();
    expect(body).toMatchObject(publicHealth);
    expect(body.pid).toBe(process.pid);
    expect(body.uptime).toEqual(expect.any(Number));
  });

  it('does not return diagnostics to a wrong token', async () => {
    expect((await health({ authorization: 'Bearer wrong-token' })).json()).toEqual(publicHealth);
  });
});
