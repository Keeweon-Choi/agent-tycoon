/**
 * MHO v1b (ADR-0020): the street token opens the summary route and nothing else; pairing (code once,
 * expiry, limits, the step-up), https only, the pinned host id, revoking, the summary's caps, and no
 * secret crossing. Host B is a real standalone server (authTestKit, the real gate); host A's Street
 * reaches it through a fetch that injects into B, so A and B run their real code end to end.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { STREET_GATE } from '../../../core/src/cld/street.js';
import { STREET_AGENTS_MAX, STREET_NAME_MAX, STREET_PAIRS_MAX } from '../../../core/src/constants.js';
import { createAgentState } from '../agentState.js';
import { type AuthServer, funnel, makeFakeDist, proveSession, startAuthServer, stopAuthServer, TOKEN } from './authTestKit.js';
import { STEPUP_REQUIRED } from './shell/gate.js';

/** Requests on the LAN's plain-http listener (the socket marker is the only input, auth.ts). */
const lan = vi.hoisted(() => ({ on: false }));
vi.mock('./auth.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./auth.js')>();
  return { ...real, isLanRequest: (socket: object | undefined) => lan.on || real.isLanRequest(socket) };
});
import { Street, streetAgents, streetAuthorization, streetKey, type StreetOptions } from './street.js';

/** Every route Fastify is told about, in registration order (the gate must cover each). */
const routes = vi.hoisted(() => [] as Array<{ method: string; url: string }>);
vi.mock('fastify', async (importOriginal) => {
  const real = await importOriginal<typeof import('fastify')>();
  const make = ((opts?: Parameters<typeof real.default>[0]) => {
    const app = real.default(opts);
    routes.length = 0;
    app.addHook('onRoute', (r) => {
      for (const method of [r.method].flat()) routes.push({ method, url: r.url });
    });
    return app;
  }) as typeof real.default;
  return { ...real, default: make };
});

const HOST_A = '1a2b3c4d-0000-4000-8000-00000000000a';
const HOST_B = '5e6f7a8b-0000-4000-8000-00000000000b';
const HOST_C = '9c9c9c9c-0000-4000-8000-00000000000c';
const URL_B = 'https://desk.example.ts.net';
const SECRET = 'SECRET-MARKER-7f3a';

let dist: ReturnType<typeof makeFakeDist>;
let homes: string[] = [];
let servers: AuthServer[] = [];
let ip = 0;
/** A request from another PC (through a proxy that names it): each from its own address, so the
 *  per-client limiter never decides a test that is about something else. */
const outside = () => funnel(`198.51.${Math.floor(++ip / 250) % 250}.${ip % 250}`);

const tempHome = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-street-'));
  homes.push(home);
  return home;
};

/** Host B's office: one agent waiting with secrets planted in everything but its name. */
function agentsOfB() {
  const lead = createAgentState({
    id: 1,
    sessionId: `s-${SECRET}`,
    isExternal: false,
    projectDir: `/home/owner/${SECRET}/proj`,
    jsonlFile: `/home/owner/.claude/projects/${SECRET}.jsonl`,
    directoryName: 'alpha-lead',
  });
  lead.activeToolIds.add('t1');
  lead.activeToolStatuses.set('t1', `Running: curl -H "Authorization: ${SECRET}"`);
  lead.lastAssistantText = `the password is ${SECRET}`;
  lead.permissionSent = true;
  const worker = createAgentState({ id: 2, sessionId: 'w', isExternal: false, projectDir: '', jsonlFile: '', directoryName: 'beta' });
  return streetAgents([lead, worker], () => ({ state: 'running' as const, busy: false }), () => false);
}

function street(home: string, hostId: string, name: string, extra: Partial<StreetOptions> = {}) {
  return new Street({
    home,
    self: () => ({ hostId, hostName: name }),
    version: '9.9.9',
    agents: () => agentsOfB(),
    broadcast: () => undefined,
    ...extra,
  });
}

async function hostB(extra: Partial<StreetOptions> = {}) {
  const s = street(tempHome(), HOST_B, 'Desk B', extra);
  const server = await startAuthServer(dist.staticDir, { street: s, hostId: HOST_B });
  servers.push(server);
  return { street: s, server };
}

/** One request A sent and what came back, whole (to look for a credential in it). */
type Wire = { url: string; init?: RequestInit; reply: string };

/** A's network, wired to B's injector: A's own code makes every request (no redirect, caps). */
function toB(server: AuthServer, calls: string[] = [], wire: Wire[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url.pathname);
    const res = await server.app.inject({
      method: (init?.method ?? 'GET') as 'GET',
      url: url.pathname + url.search,
      headers: { ...outside(), ...(init?.headers as Record<string, string>) },
      payload: init?.body as string | undefined,
    });
    wire.push({ url: String(input), init, reply: res.body });
    return new Response(res.statusCode === 204 ? null : res.body, { status: res.statusCode });
  }) as typeof fetch;
}

/** A request from A (HOST_A) to B signed with the key made from the pairing token. */
const signed = (token: string, method = 'GET', pathname = '/api/street/summary', now = Date.now(), target = HOST_B) => ({
  authorization: streetAuthorization(streetKey(token), HOST_A, target, method, pathname, now),
});

const pairCode = async (server: AuthServer) =>
  (
    await server.app.inject({ method: 'POST', url: '/api/street/pair-code', headers: { authorization: `Bearer ${TOKEN}` } })
  ).json<{ code: string }>().code;

const pairDirect = (server: AuthServer, code: string, hostId = HOST_A) =>
  server.app.inject({
    method: 'POST',
    url: '/api/street/pair',
    headers: { ...outside(), 'content-type': 'application/json' },
    payload: { code, hostId, name: 'Laptop A' },
  });

beforeEach(() => {
  dist = makeFakeDist();
  ip = 0;
  lan.on = false;
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const s of servers) await stopAuthServer(s);
  servers = [];
  for (const home of [...homes, dist.root]) fs.rmSync(home, { recursive: true, force: true });
  homes = [];
});

describe('the street key (ADR-0020)', () => {
  /** Every route, with and without a request signed for it, from another PC: where do they differ? */
  async function walk(server: AuthServer, token: string) {
    const seen = new Set<string>();
    const differ: string[] = [];
    for (const { method, url } of [...routes]) {
      const target = url.replace(/:[^/]+/g, 'x').replace(/\*/g, 'x');
      const key = `${method} ${target}`;
      if (seen.has(key) || method === 'OPTIONS') continue;
      seen.add(key);
      const send = (headers: Record<string, string>) =>
        server.app.inject({ method: method as 'GET', url: target, headers: { ...outside(), ...headers } });
      const without = await send({});
      const withToken = await send(signed(token, method, target));
      if (withToken.statusCode !== without.statusCode) differ.push(`${key} ${without.statusCode}->${withToken.statusCode}`);
      else if (withToken.statusCode !== 401 && !PUBLIC.test(target)) differ.push(`${key} ${withToken.statusCode}`);
    }
    return { differ, count: seen.size };
  }
  /** What a client with no session may load anyway (standaloneRouteIsPublic), and the 404 traps. */
  const PUBLIC = /^\/(x|login(\/.*)?|api\/health|api\/street\/pair|terminal\/x|manifest\.webmanifest|favicon\.ico|sw\.js)$/;

  it('opens GET /api/street/summary and nothing else of the whole route table, /ws included', async () => {
    const { server } = await hostB();
    const pair = (await pairDirect(server, await pairCode(server))).json<{ token: string }>();
    const { differ, count } = await walk(server, pair.token);
    expect(count).toBeGreaterThan(40);
    expect(differ).toEqual(['GET /api/street/summary 401->200']);
    // The socket, as a WebSocket handshake.
    const ws = await server.app.inject({
      url: '/ws',
      headers: { ...outside(), ...signed(pair.token, 'GET', '/ws'), connection: 'upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' },
    });
    expect(ws.statusCode).toBe(401);
  });

  it('negative control: a gate widened in a test build is caught by the same walk', async () => {
    const { server } = await hostB();
    const pair = (await pairDirect(server, await pairCode(server))).json<{ token: string }>();
    vi.spyOn(STREET_GATE, 'opens').mockReturnValue(true);
    const { differ } = await walk(server, pair.token);
    expect(differ.length).toBeGreaterThan(1);
    expect(differ.some((line) => line.startsWith('GET /cld/characters/x'))).toBe(true);
  });

  it('is not the host token, and the pairing token itself or a made-up one opens nothing', async () => {
    const { server } = await hostB();
    const forged = 'A'.repeat(43);
    const res = await server.app.inject({ url: '/api/street/summary', headers: { ...outside(), ...signed(forged) } });
    expect(res.statusCode).toBe(401);
    const { token } = (await pairDirect(server, await pairCode(server))).json<{ token: string }>();
    const bearer = await server.app.inject({ url: '/api/street/summary', headers: { ...outside(), authorization: `Bearer ${token}` } });
    expect(bearer.statusCode).toBe(401);
    // This host's own token from this PC reads its own summary (the CLI); never from outside.
    const own = await server.app.inject({ url: '/api/street/summary', headers: { authorization: `Bearer ${TOKEN}` } });
    expect(own.statusCode).toBe(200);
    const fromOutside = await server.app.inject({ url: '/api/street/summary', headers: { ...outside(), authorization: `Bearer ${TOKEN}` } });
    expect(fromOutside.statusCode).toBe(401);
  });
});

describe('a signed summary request (ADR-0020 M1)', () => {
  it('is refused when old, from the future, for another path or host, or with another key', async () => {
    const { server } = await hostB();
    const { token } = (await pairDirect(server, await pairCode(server))).json<{ token: string }>();
    const read = (headers: Record<string, string>) =>
      server.app.inject({ url: '/api/street/summary', headers: { ...outside(), ...headers } });
    expect((await read(signed(token))).statusCode).toBe(200);
    expect((await read(signed(token, 'GET', '/api/street/summary', Date.now() - 3 * 60_000))).statusCode).toBe(401);
    expect((await read(signed(token, 'GET', '/api/street/summary', Date.now() + 3 * 60_000))).statusCode).toBe(401);
    expect((await read(signed(token, 'GET', '/api/street'))).statusCode).toBe(401);
    expect((await read(signed(token, 'POST'))).statusCode).toBe(401);
    expect((await read(signed(token, 'GET', '/api/street/summary', Date.now(), HOST_C))).statusCode).toBe(401);
    expect((await read(signed('B'.repeat(43)))).statusCode).toBe(401);
    // A signature one character off.
    const good = signed(token).authorization;
    const bad = good.slice(0, -1) + (good.endsWith('A') ? 'B' : 'A');
    expect((await read({ authorization: bad })).statusCode).toBe(401);
  });
});

describe('pairing on the host that is read (B)', () => {
  it('a pair code needs a fresh step-up (or this PC host token), never a cookie alone', async () => {
    const { server } = await hostB();
    const session = server.auth.createSession('short', 'Phone');
    const cookie = `${server.auth.cookieName}=${session.id}`;
    const local = { cookie, host: '127.0.0.1', origin: 'http://127.0.0.1' };
    const stale = await server.app.inject({ method: 'POST', url: '/api/street/pair-code', headers: local });
    expect(stale.statusCode).toBe(403);
    expect(stale.json()).toEqual({ error: STEPUP_REQUIRED });
    proveSession(server.auth, session.id);
    const fresh = await server.app.inject({ method: 'POST', url: '/api/street/pair-code', headers: local });
    expect(fresh.statusCode).toBe(200);
    expect(fresh.json<{ code: string }>().code).toMatch(/^\d{8}$/);
    const outsideBearer = await server.app.inject({ method: 'POST', url: '/api/street/pair-code', headers: { ...outside(), authorization: `Bearer ${TOKEN}` } });
    expect(outsideBearer.statusCode).toBe(401);
  });

  it('a code works once, one code at a time, and not after 5 minutes', async () => {
    const { server } = await hostB();
    const first = await pairCode(server);
    const second = await pairCode(server);
    expect((await pairDirect(server, first)).statusCode).toBe(401); // the new one ended it
    expect((await pairDirect(server, second)).statusCode).toBe(200);
    expect((await pairDirect(server, second)).statusCode).toBe(401); // used up
    const third = await pairCode(server);
    const later = Date.now() + 5 * 60_000 + 1;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    expect((await pairDirect(server, third)).statusCode).toBe(401);
  });

  it('10 wrong codes a minute block that client, even with the right code; the wrong ones do not end it', async () => {
    const { server } = await hostB();
    const code = await pairCode(server);
    const wrong = code === '00000000' ? '11111111' : '00000000';
    const from = funnel('203.0.113.9');
    const send = (c: string) =>
      server.app.inject({ method: 'POST', url: '/api/street/pair', headers: { ...from, 'content-type': 'application/json' }, payload: { code: c, hostId: HOST_A } });
    for (let i = 0; i < 10; i++) expect((await send(wrong)).statusCode).toBe(401);
    expect((await send(code)).statusCode).toBe(429);
    expect((await pairDirect(server, code)).statusCode).toBe(200); // another client, the same code
  });

  it('20 wrong codes in 10 minutes from anywhere lock pairing for everyone', async () => {
    const { server } = await hostB();
    const code = await pairCode(server);
    for (let i = 0; i < 20; i++) expect((await pairDirect(server, String(10_000_000 + i))).statusCode).toBe(401);
    expect((await pairDirect(server, code)).statusCode).toBe(429);
  });

  it('guesses while no code is out do not lock pairing (L1)', async () => {
    const { server } = await hostB();
    for (let i = 0; i < 30; i++) expect((await pairDirect(server, String(10_000_000 + i))).statusCode).toBe(401);
    expect((await pairDirect(server, await pairCode(server))).statusCode).toBe(200);
  });

  it('a code cannot take over a reader that is already paired (L2)', async () => {
    const { street: s, server } = await hostB();
    const { token } = (await pairDirect(server, await pairCode(server))).json<{ token: string }>();
    const code = await pairCode(server);
    const takeover = await pairDirect(server, code);
    expect(takeover.statusCode).toBe(409);
    expect(takeover.json().errorCode).toBe('street_reader_exists');
    // The first reader still reads, and the code is still good for a new host.
    expect((await server.app.inject({ url: '/api/street/summary', headers: { ...outside(), ...signed(token) } })).statusCode).toBe(200);
    expect((await pairDirect(server, code, HOST_C)).statusCode).toBe(200);
    expect(s.lists().readers.map((r) => r.hostId)).toEqual([HOST_A, HOST_C]);
  });

  it('pair and summary refuse the LAN plain-http listener (L4)', async () => {
    const { server } = await hostB();
    const code = await pairCode(server);
    lan.on = true;
    expect((await pairDirect(server, code)).statusCode).toBe(403);
    lan.on = false;
    const { token } = (await pairDirect(server, code)).json<{ token: string }>();
    lan.on = true;
    const res = await server.app.inject({ url: '/api/street/summary', headers: { ...outside(), ...signed(token) } });
    expect(res.statusCode).toBe(403);
    expect(res.json().errorCode).toBe('street_https_only');
  });

  it('one summary per reader every 2 seconds (L5)', async () => {
    const { server } = await hostB();
    const { token } = (await pairDirect(server, await pairCode(server))).json<{ token: string }>();
    const read = () => server.app.inject({ url: '/api/street/summary', headers: { ...outside(), ...signed(token) } });
    expect((await read()).statusCode).toBe(200);
    expect((await read()).statusCode).toBe(429);
    const later = Date.now() + 2_001;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    expect((await read()).statusCode).toBe(200);
  });

  it('keeps the key, never the token, 0600, and deleting the row revokes it at once', async () => {
    const { street: s, server } = await hostB();
    const { token } = (await pairDirect(server, await pairCode(server))).json<{ token: string; hostId: string }>();
    const file = path.join(homes[0], '.config/agent-tycoon/street.json');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file, 'utf8')).not.toContain(token);
    expect(s.lists().readers).toEqual([expect.objectContaining({ hostId: HOST_A, name: 'Laptop A' })]);
    const read = () => server.app.inject({ url: '/api/street/summary', headers: { ...outside(), ...signed(token) } });
    expect((await read()).statusCode).toBe(200);
    const del = await server.app.inject({ method: 'DELETE', url: `/api/street/readers/${HOST_A}`, headers: { authorization: `Bearer ${TOKEN}` } });
    expect(del.statusCode).toBe(200);
    expect((await read()).statusCode).toBe(401);
  });

  it('refuses its own host id and more than the cap of readers', async () => {
    const { server } = await hostB();
    expect((await pairDirect(server, await pairCode(server), HOST_B)).json().errorCode).toBe('street_self');
    for (let i = 0; i < STREET_PAIRS_MAX; i++) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      expect((await pairDirect(server, await pairCode(server), id)).statusCode).toBe(200);
    }
    expect((await pairDirect(server, await pairCode(server), HOST_C)).statusCode).toBe(409);
  });
});

describe('the summary', () => {
  it("an agent is off only when its office row says so (a Claude session's row has no `alive`)", () => {
    const one = createAgentState({ id: 1, sessionId: 's', isExternal: false, projectDir: '', jsonlFile: '', directoryName: 'a' });
    const rows = (state: 'running' | 'off') => streetAgents([one], () => ({ state, busy: null }), () => false);
    expect(rows('running')).toEqual([{ name: 'a', state: 'idle' }]);
    expect(rows('off')).toEqual([{ name: 'a', state: 'off' }]);
  });

  it('names and states only: capped, trimmed, masked, waiting ones kept', async () => {
    const many = Array.from({ length: 250 }, (_, i) => ({ name: `agent ${i} ${'x'.repeat(100)}`, state: 'idle' as const }));
    // Built at run time: the export gate refuses a token-shaped literal anywhere in the source.
    many.push({ name: `last\u202e\u0000one ${['sk', 'ant', 'api03'].join('-')}-${'A'.repeat(40)}`, state: 'waiting' as never });
    const s = street(tempHome(), HOST_B, `Desk\nB ${'y'.repeat(80)}`, { agents: () => many });
    const summary = s.summary()!;
    expect(summary.agents).toHaveLength(STREET_AGENTS_MAX);
    expect(summary.waiting).toBe(1);
    expect(summary.agents[0].state).toBe('waiting');
    expect(summary.agents[0].name).not.toMatch(/[\u0000-\u001f\u202e]/);
    expect(summary.agents[0].name).not.toContain('AAAAAAAAAAAAAAAAAAAA');
    expect([...summary.name].length).toBeLessThanOrEqual(STREET_NAME_MAX);
    expect(summary.name.startsWith('Desk B')).toBe(true);
    expect(Object.keys(summary).sort()).toEqual(['agents', 'hostId', 'name', 'v', 'version', 'waiting']);
    expect(Object.keys(summary.agents[1]).sort()).toEqual(['name', 'state']);
  });
});

describe('the host that reads (A)', () => {
  async function paired(extraA: Partial<StreetOptions> = {}) {
    const b = await hostB();
    const calls: string[] = [];
    const wire: Wire[] = [];
    const frames: Array<Record<string, unknown>> = [];
    const homeA = tempHome();
    const a = street(homeA, HOST_A, 'Laptop A', {
      fetch: toB(b.server, calls, wire),
      broadcast: (m) => frames.push(m),
      ...extraA,
    });
    const added = await a.addNeighbour(URL_B, await pairCode(b.server));
    expect(added).toHaveProperty('neighbour');
    return { a, b, calls, frames, wire, homeA };
  }

  it('the token crosses once, in the pairing reply: no request after it carries the token or the key', async () => {
    const { a, wire, homeA } = await paired();
    const pairing = wire.findIndex((w) => w.url.endsWith('/api/street/pair'));
    const { token } = JSON.parse(wire[pairing].reply) as { token: string };
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    a.watch(() => undefined, true);
    await a.pollAll();
    const after = wire.slice(pairing + 1);
    expect(after.some((w) => w.url.includes('/api/street/summary'))).toBe(true);
    const sent = JSON.stringify(after.map((w) => [w.url, w.init?.headers, w.init?.body]));
    expect(sent).not.toContain(token);
    expect(sent).not.toContain(streetKey(token));
    expect(sent).toMatch(/Street 1a2b3c4d-0000-4000-8000-00000000000a\.\d+\./);
    // At rest on A: the key, not the token.
    expect(fs.readFileSync(path.join(homeA, '.config/agent-tycoon/street.json'), 'utf8')).not.toContain(token);
    a.dispose();
  });

  it('pairs over https, reads B, and no secret of B ever reaches the frames of A', async () => {
    const { a, frames } = await paired();
    const sent: Array<Record<string, unknown>> = [];
    a.watch((m) => sent.push(m), true);
    await a.pollAll();
    const state = a.stateMessage().neighbours[0];
    expect(state).toMatchObject({ hostId: HOST_B, name: 'Desk B', state: 'online', version: '9.9.9', waiting: 1, url: URL_B });
    expect(state.agents).toEqual([
      { name: 'alpha-lead', state: 'waiting' },
      { name: 'beta', state: 'idle' },
    ]);
    const everything = JSON.stringify([frames, sent, a.lists()]);
    expect(everything).not.toContain(SECRET);
    expect(everything).not.toMatch(/token/i);
    a.dispose();
  });

  it('refuses plain http to another PC before any call, with its reason', async () => {
    const fetchSpy = vi.fn();
    const a = street(tempHome(), HOST_A, 'Laptop A', { fetch: fetchSpy as never });
    const r = await a.addNeighbour('http://192.168.0.10:18240', '12345678');
    expect(r).toMatchObject({ status: 400, errorCode: 'street_https_only' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await a.addNeighbour('https://user:pw@desk.example', '12345678')).toMatchObject({ errorCode: 'street_url_bad' });
  });

  it('pins the host id: another host answering at that address is dropped, and cannot pair there', async () => {
    const { a, b } = await paired();
    // B's address now answers as C, a host that takes any token (a fake B in front of it).
    const c = await hostB({ self: () => ({ hostId: HOST_C, hostName: 'Imposter' }) });
    const fake = { v: 1, hostId: HOST_C, name: 'Desk B', version: '1', agents: [{ name: 'x', state: 'waiting' }] };
    let asked = 0;
    (a as unknown as { fetchFn: typeof fetch }).fetchFn = (async () => (asked++, new Response(JSON.stringify(fake)))) as never;
    await a.pollAll();
    expect(a.stateMessage().neighbours[0]).toMatchObject({ state: 'unpaired', reason: 'other_host', agents: [], name: 'Desk B' });
    // Polling stops at once: the next signed request would go to whoever holds the address now.
    await a.pollAll();
    expect(asked).toBe(1);
    (a as unknown as { fetchFn: typeof fetch }).fetchFn = toB(c.server);
    expect(await a.addNeighbour(URL_B, await pairCode(c.server))).toMatchObject({ status: 409, errorCode: 'street_other_host' });
    expect(b.street.lists().readers).toHaveLength(1);
  });

  it('another address answering as a paired neighbour cannot replace it (L3)', async () => {
    const { a, b } = await paired();
    const before = a.lists().neighbours;
    // B's owner deleted A's row, so B pairs again; A still refuses the second address.
    await b.server.app.inject({ method: 'DELETE', url: `/api/street/readers/${HOST_A}`, headers: { authorization: `Bearer ${TOKEN}` } });
    const r = await a.addNeighbour('https://other.example.net', await pairCode(b.server));
    expect(r).toMatchObject({ status: 409, errorCode: 'street_known_elsewhere', errorParams: { url: URL_B } });
    expect(a.lists().neighbours).toEqual(before);
  });

  it('shows unpaired once B deletes the row, and asks no more', async () => {
    const { a, b, calls } = await paired();
    await b.server.app.inject({ method: 'DELETE', url: `/api/street/readers/${HOST_A}`, headers: { authorization: `Bearer ${TOKEN}` } });
    await a.pollAll();
    expect(a.stateMessage().neighbours[0].state).toBe('unpaired');
    const before = calls.length;
    await a.pollAll();
    expect(calls.length).toBe(before);
  });

  const answer = (status: number, body: unknown = '', headers: Record<string, string> = {}) =>
    Promise.resolve(new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers }));
  const setFetch = (a: Street, f: (url: string) => Promise<Response>) => {
    (a as unknown as { fetchFn: typeof fetch }).fetchFn = ((u: string) => f(String(u))) as typeof fetch;
  };

  it('old version (no street route), off (refused or 502) and unreachable (moved address, timeout, tls)', async () => {
    const { a } = await paired();
    const set = (f: (url: string) => Promise<Response>) => setFetch(a, f);
    set((u) => (u.endsWith('/api/health') ? answer(200, { status: 'ok', version: '0.1' }) : answer(404)));
    await a.pollAll();
    expect(a.stateMessage().neighbours[0].state).toBe('old');
    // A rotated secret path: 404 for everything, health included (L6).
    set(() => answer(404));
    await a.pollAll();
    expect(a.stateMessage().neighbours[0]).toMatchObject({ state: 'unreachable', reason: 'network' });
    // Too soon for it: what was shown stands.
    set(() => answer(429));
    await a.pollAll();
    expect(a.stateMessage().neighbours[0]).toMatchObject({ state: 'unreachable', reason: 'network' });
    set(() => answer(502));
    await a.pollAll();
    expect(a.stateMessage().neighbours[0].state).toBe('off');
    set(() => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })));
    await a.pollAll();
    expect(a.stateMessage().neighbours[0].state).toBe('off');
    set(() => Promise.reject(Object.assign(new TypeError('fetch failed'), { cause: { code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' } })));
    await a.pollAll();
    expect(a.stateMessage().neighbours[0]).toMatchObject({ state: 'unreachable', reason: 'tls' });
    set(() => Promise.reject(new DOMException('timed out', 'TimeoutError')));
    await a.pollAll();
    expect(a.stateMessage().neighbours[0]).toMatchObject({ state: 'unreachable', reason: 'timeout' });
    expect(a.stateMessage().neighbours[0].lastSeen).toBeNull();
  });

  it('a 401 is not asked again: old daemon, or a clock too far off (L8)', async () => {
    const old = await paired();
    let asked = 0;
    setFetch(old.a, (u) => (asked++, u.endsWith('/api/health') ? answer(200, { status: 'ok' }) : answer(401, 'unauthorized')));
    await old.a.pollAll();
    expect(old.a.stateMessage().neighbours[0].state).toBe('old');
    const after = asked;
    await old.a.pollAll();
    await old.a.pollAll();
    expect(asked).toBe(after);

    const skewed = await paired();
    const date = new Date(Date.now() + 10 * 60_000).toUTCString();
    setFetch(skewed.a, () => answer(401, 'unauthorized', { date }));
    await skewed.a.pollAll();
    expect(skewed.a.stateMessage().neighbours[0]).toMatchObject({ state: 'unreachable', reason: 'clock' });
  });

  it('a pair code for an old daemon says so', async () => {
    const a = street(tempHome(), HOST_A, 'Laptop A', {
      fetch: (async (u: string) =>
        new Response(String(u).endsWith('/api/health') ? '{"status":"ok"}' : 'unauthorized', {
          status: String(u).endsWith('/api/health') ? 200 : 401,
        })) as never,
    });
    expect(await a.addNeighbour(URL_B, '12345678')).toMatchObject({ errorCode: 'street_pair_old' });
  });

  it('asks only while some client watches, and stops at once when none does', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { a, calls } = await paired({ pollMs: 1000 });
    const summaries = () => calls.filter((c) => c === '/api/street/summary').length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(summaries()).toBe(0);
    const one = vi.fn();
    const two = vi.fn();
    a.watch(one, true);
    a.watch(two, true);
    await vi.advanceTimersByTimeAsync(3000);
    const watched = summaries();
    expect(watched).toBeGreaterThanOrEqual(3);
    expect(one).toHaveBeenCalledWith(expect.objectContaining({ type: 'streetState' }));
    a.unwatch(one);
    a.onClientMessage({ type: 'streetWatch', on: false }, two);
    await vi.advanceTimersByTimeAsync(5000);
    expect(summaries()).toBe(watched);
  });

  it('streetEnter answers the address of B only', async () => {
    const { a } = await paired();
    const send = vi.fn();
    a.onClientMessage({ type: 'streetEnter', hostId: HOST_B }, send);
    expect(send).toHaveBeenCalledWith({ type: 'streetEnterResult', hostId: HOST_B, url: URL_B });
    a.onClientMessage({ type: 'streetEnter', hostId: HOST_C }, send);
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'streetEnterResult', errorCode: 'street_unknown' }));
  });

  it('a street.json it cannot read is kept as it is and nothing pairs', async () => {
    const home = tempHome();
    const file = path.join(home, '.config/agent-tycoon/street.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"v":1,"neighbours":"no"}');
    const s = street(home, HOST_B, 'Desk B', { log: () => undefined });
    expect(s.pair('12345678', { hostId: HOST_A })).toMatchObject({ status: 401 });
    s.createPairCode();
    expect(await s.addNeighbour(URL_B, '12345678')).toMatchObject({ errorCode: 'street_no_identity' });
    expect(fs.readFileSync(file, 'utf8')).toBe('{"v":1,"neighbours":"no"}');
  });
});
