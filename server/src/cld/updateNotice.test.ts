/**
 * P3a: the released-version notice. Fake manager output and a fake installer start; no network,
 * no real install, no real daemon.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CHECK_EVERY_MS,
  managedInstall,
  registerUpdateRoutes,
  RETRY_AFTER_FAIL_MS,
  type UpdateFacts,
  UpdateNotice,
  type UpdateOptions,
} from './updateNotice.js';

const BUNDLE = 'agent-tycoon-daemon-0.2.0-linux-x64.tar.gz';
const found = (extra: object = {}) =>
  JSON.stringify({
    v: 1,
    current: '0.1.0',
    available: '0.2.0',
    failed: false,
    bundle: BUNDLE,
    notes: '- 새 기능\n',
    ...extra,
  });

let dir: string;
let clock: number;
let checks: string[][];
let starts: string[][];
let answer: () => Promise<string>;
let facts: UpdateFacts;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-update-'));
  clock = 1_000_000;
  checks = [];
  starts = [];
  answer = async () => found();
  facts = { sessions: 2, jobs: 1, worktrees: 3, merging: false };
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const notice = (o: Partial<UpdateOptions> = {}) =>
  new UpdateNotice({
    configDir: dir,
    root: '/fake/root',
    version: '0.1.0',
    serviceKind: 'systemd',
    managerPath: '/fake/manager.mjs',
    readOnly: false,
    facts: () => facts,
    now: () => clock,
    check: (args) => {
      checks.push(args);
      return answer();
    },
    start: (args) => {
      starts.push(args);
      return 4242;
    },
    alive: () => true,
    ...o,
  });

describe('the check', () => {
  it('a newer release shows the notice with its notes; the signature fields keep two things apart', async () => {
    const v = await notice().view(true);
    expect(v.available).toEqual({ version: '0.2.0', notes: '- 새 기능\n' });
    expect(v.signature).toEqual({
      canVerify: true,
      release: 'verified',
      officialKey: false,
      osCodeSigning: false,
    });
    expect(checks[0]).toContain('--check');
    expect(checks[0]).toContain('--json');
  });

  it('the same or an older release shows nothing, and says nothing is verified', async () => {
    answer = async () => found({ available: null, bundle: BUNDLE });
    const v = await notice().view(true);
    expect(v.available).toBeNull();
    expect(v.signature.release).toBe('unknown');
    expect(v.signature.canVerify).toBe(true); // the capability does not depend on a release
  });

  it('a failed check is quiet: no notice, no error out of view()', async () => {
    answer = async () => {
      throw new Error('HTTP 404');
    };
    const v = await notice().view(true);
    expect(v.available).toBeNull();
    expect(v.install).toBeNull();
  });

  it('a release that failed here before, or a bundle name that is not ours, is not offered', async () => {
    answer = async () => found({ failed: true });
    expect((await notice().view(true)).available).toBeNull();
    fs.rmSync(path.join(dir, 'update-notice.json'), { force: true });
    answer = async () => found({ bundle: '../../evil.tar.gz' });
    expect((await notice().view(true)).available).toBeNull();
  });

  it('asks at most every 8 h (a few times a day), after a failure every 6 h, and only when a page asks', async () => {
    const n = notice();
    await n.view(true);
    await n.view(true);
    clock += CHECK_EVERY_MS - 1;
    await n.view(true);
    expect(checks).toHaveLength(1);
    clock += 1;
    await n.view(true);
    expect(checks).toHaveLength(2);
    answer = async () => {
      throw new Error('offline');
    };
    clock += CHECK_EVERY_MS;
    await n.view(true);
    expect(checks).toHaveLength(3);
    clock += RETRY_AFTER_FAIL_MS - 1;
    await n.view(true);
    expect(checks).toHaveLength(3);
    clock += 1;
    await n.view(true);
    expect(checks).toHaveLength(4);
  });

  it('a daemon restart does not check again at once (the answer is kept), and a failed check keeps a known notice', async () => {
    await notice().view(true);
    const again = notice();
    expect((await again.view(true)).available?.version).toBe('0.2.0');
    expect(checks).toHaveLength(1);
    answer = async () => {
      throw new Error('offline');
    };
    clock += CHECK_EVERY_MS;
    expect((await again.view(true)).available?.version).toBe('0.2.0');
  });

  it('after the update (this daemon is now 0.2.0) the old notice is gone', async () => {
    await notice().view(true);
    answer = async () => found({ available: null, current: '0.2.0' });
    const v = await notice({ version: '0.2.0' }).view(true);
    expect(v.available).toBeNull();
  });

  it('a source install is not managed: nothing is asked, nothing is shown', async () => {
    const n = notice({ root: null });
    const v = await n.view(true);
    expect([v.managed, v.canInstall, v.signature.canVerify]).toEqual([false, false, false]);
    expect(checks).toHaveLength(0);
  });
});

describe('the install', () => {
  it('starts the existing update path for the offered bundle, detached, and says what keeps running', async () => {
    const n = notice();
    const before = await n.view(true);
    expect(before.canInstall).toBe(true);
    expect(before.facts).toEqual({ sessions: 2, jobs: 1, worktrees: 3, merging: false });
    expect(n.install('0.2.0', 'phone')).toEqual({ ok: true, to: '0.2.0' });
    expect(starts[0]).toEqual([
      '/fake/manager.mjs',
      'update',
      '--from',
      `https://github.com/agent-tycoon/agent-tycoon/releases/latest/download/${BUNDLE}`,
      '--root',
      '/fake/root',
    ]);
    expect((await n.view(true)).install).toMatchObject({ state: 'running', to: '0.2.0' });
  });

  it('refuses a version the notice did not offer', async () => {
    const n = notice();
    await n.view(true);
    expect(n.install('9.9.9', 'x')).toMatchObject({ ok: false, code: 'changed' });
    expect(n.install(undefined, 'x')).toMatchObject({ ok: false, code: 'changed' });
    expect(starts).toHaveLength(0);
  });

  it('postpones for a merge in progress and says why; sessions, jobs and worktrees alone never postpone', async () => {
    const n = notice();
    await n.view(true);
    facts = { ...facts, merging: true };
    const r = n.install('0.2.0', 'x');
    expect(r).toMatchObject({ ok: false, code: 'merging' });
    expect((r as { error: string }).error).toContain('병합');
    expect(starts).toHaveLength(0);
    facts = { sessions: 5, jobs: 4, worktrees: 9, merging: false };
    expect(n.install('0.2.0', 'x').ok).toBe(true);
  });

  it('a second press while one runs is postponed, not doubled', async () => {
    const n = notice();
    await n.view(true);
    expect(n.install('0.2.0', 'x').ok).toBe(true);
    expect(n.install('0.2.0', 'x')).toMatchObject({ ok: false, code: 'running' });
    expect(starts).toHaveLength(1);
  });

  it('a service that would take the updater down with the daemon is terminal-only', async () => {
    const n = notice({ serviceKind: 'launchd' });
    const v = await n.view(true);
    expect([v.canInstall, v.terminalOnly]).toEqual([false, true]);
    expect(n.install('0.2.0', 'x')).toMatchObject({ ok: false, code: 'terminal_only' });
  });

  it('reports the result from the new daemon: its own version is the target, or the install failed (with the log tail)', async () => {
    const started = notice();
    await started.view(true);
    started.install('0.2.0', 'x');
    // the daemon restarted as 0.2.0 and the installer is gone
    const done = await notice({ version: '0.2.0', alive: () => false }).view(true);
    expect(done.install).toMatchObject({ state: 'done', to: '0.2.0' });

    fs.rmSync(path.join(dir, 'update-notice.json'));
    const again = notice();
    await again.view(true);
    again.install('0.2.0', 'x');
    fs.writeFileSync(path.join(dir, 'update.log'), '✔ ok\n✖ download failed (HTTP 404)\n');
    const failed = await notice({ alive: () => false }).view(true);
    expect(failed.install?.state).toBe('failed');
    expect(failed.install?.message).toContain('download failed');
    expect(failed.install?.message).toContain('지금 버전은 그대로');
  });
});

describe('routes', () => {
  type Kind = { host: boolean; remote: boolean };
  async function app(opts: { readOnly?: boolean; kind?: Kind; fresh?: boolean } = {}) {
    const n = notice({ readOnly: !!opts.readOnly });
    await n.view(true);
    const server = Fastify();
    registerUpdateRoutes(
      server,
      async () => undefined,
      n,
      !!opts.readOnly,
      () => !!opts.fresh,
      () => opts.kind ?? { host: false, remote: false },
    );
    const post = (payload: object) =>
      server.inject({
        method: 'POST',
        url: '/api/cld/update/install',
        headers: { origin: 'http://localhost:80', host: 'localhost:80' },
        payload,
      });
    return { n, server, post };
  }

  it('a read-only client sees the notice but cannot install', async () => {
    const { server, post } = await app({ readOnly: true });
    const view = (await server.inject({ url: '/api/cld/update' })).json();
    expect(view.available.version).toBe('0.2.0');
    expect(view.canInstall).toBe(false);
    expect((await post({ version: '0.2.0' })).statusCode).toBe(403);
    expect(starts).toHaveLength(0);
  });

  it('the host token may install even in a read-only daemon, with no step-up', async () => {
    const { post } = await app({ readOnly: true, kind: { host: true, remote: false } });
    expect((await post({ version: '0.2.0' })).statusCode).toBe(200);
  });

  it('a remote device needs a fresh step-up; this PC does not', async () => {
    const remote = await app({ kind: { host: false, remote: true }, fresh: false });
    const refused = await remote.post({ version: '0.2.0' });
    expect([refused.statusCode, refused.json()]).toEqual([403, { error: 'stepup' }]);
    expect(starts).toHaveLength(0);
    const proved = await app({ kind: { host: false, remote: true }, fresh: true });
    expect((await proved.post({ version: '0.2.0' })).statusCode).toBe(200);
    starts.length = 0;
    fs.rmSync(path.join(dir, 'update-notice.json')); // the first install is "running" in the file
    const local = await app({ kind: { host: false, remote: false } });
    expect((await local.post({ version: '0.2.0' })).statusCode).toBe(200);
  });

  it('an unknown standing counts as a remote device', async () => {
    const n = notice();
    await n.view(true);
    const server = Fastify();
    registerUpdateRoutes(server, async () => undefined, n, false);
    const r = await server.inject({
      method: 'POST',
      url: '/api/cld/update/install',
      headers: { origin: 'http://localhost:80', host: 'localhost:80' },
      payload: { version: '0.2.0' },
    });
    expect(r.statusCode).toBe(403);
  });

  it('a postponed install answers 409 with the reason', async () => {
    const { post } = await app();
    facts = { ...facts, merging: true };
    const r = await post({ version: '0.2.0' });
    expect([r.statusCode, r.json().code]).toEqual([409, 'merging']);
  });
});

describe('managedInstall', () => {
  it('knows an install by <root>/versions/<v> beside an install.json, and nothing else', () => {
    const root = path.join(dir, 'root');
    const ver = path.join(root, 'versions', '0.1.0');
    fs.mkdirSync(path.join(ver, 'cld', 'release'), { recursive: true });
    fs.writeFileSync(path.join(ver, 'cld', 'release', 'version.json'), '{"version":"0.1.0"}');
    expect(managedInstall(ver)).toBeNull(); // no install.json yet
    fs.writeFileSync(
      path.join(root, 'install.json'),
      '{"current":"0.1.0","service":{"kind":"systemd"}}',
    );
    expect(managedInstall(ver)).toEqual({
      root: fs.realpathSync(root),
      serviceKind: 'systemd',
      version: '0.1.0',
    });
    expect(managedInstall(root)).toBeNull(); // a checkout is not under versions/
  });
});
