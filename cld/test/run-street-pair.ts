/**
 * MHO v1b (ADR-0020): two daemons as two PCs. A (the laptop) pairs with B (the desktop) through an
 * https proxy in front of B, as `tailscale serve` stands in front of a real one: B sees a loopback
 * peer with forwarded headers, so it is not "this PC" to B. The proxy's certificate comes from a
 * test CA that only daemon A trusts (NODE_EXTRA_CA_CERTS), so A's https check is the real one, no
 * loopback exception. The proxy's log is B's request log.
 *
 * Checks: pair; the token crosses once (the pairing reply), every later request is signed and
 * carries neither the token nor the key; nobody watching -> no summary call; A's streetState shows
 * B's agents; B's fake claude asks a permission -> A shows waiting; secrets planted in B's
 * conversation never reach A's frames; both security windows' 옆 건물 sections (photos); B stopped
 * -> off; B back, the pairing deleted on B -> unpaired; watch off -> no call.
 * Temp HOMEs, ports 19300-19302, the fake claude in each; only our daemons are stopped. Uses
 * dist/ (`node esbuild.js` and the webview build first). Photos: cld/artifacts/feat-multi-host-v1b/.
 *
 *   npx tsx cld/test/run-street-pair.ts
 */
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import { WebSocket } from 'ws';

import { configDirectory } from '../../server/src/cld/configPath.js';
import { testCa } from '../../server/src/cld/remote/testKit.js';
import {
  assertPortFree,
  type Daemon,
  hostToken,
  launchBrowser,
  makeFakeHome,
  REPO_ROOT,
  startDaemon,
  topBarButton,
  waitForDaemon,
} from '../../server/src/cld/testHome.js';

const PORT_A = 19300;
const PORT_B = 19301;
const PORT_PROXY = 19302;
const URL_B = `https://127.0.0.1:${PORT_PROXY}`;
/** One round of asking is 10 s (STREET_POLL_MS): a change shows within two rounds. */
const SHOW_MS = 25_000;
const DEADLINE_MS = 240_000;
const SECRET = 'SECRET-MARKER-street-9q';
const ALPHA = 'a0000001-0000-4000-8000-000000000001';
const OUT = path.join(REPO_ROOT, 'cld/artifacts/feat-multi-host-v1b');

/** A live Claude session file B's daemon reads without a viewer: this runner's own pid stands in
 *  for the claude process (Linux: its start time in /proc, as sessionFromFile checks). */
function liveSessionFile(home: string): void {
  const stat = fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8');
  const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  const dir = path.join(home, '.claude/sessions');
  fs.mkdirSync(dir, { recursive: true });
  const row = { pid: process.pid, procStart, sessionId: ALPHA, cwd: '/work/alpha', kind: 'interactive', name: 'alpha-orchestrator', status: 'busy', startedAt: Date.now() };
  fs.writeFileSync(path.join(dir, `${process.pid}.json`), JSON.stringify(row));
}

const t0 = Date.now();
const since = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what} (${since()})`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Neighbour {
  hostId: string;
  state: string;
  reason?: string;
  waiting: number;
  agents: Array<{ name: string; state: string }>;
}

async function main() {
  await assertPortFree(PORT_A, PORT_B, PORT_PROXY);
  const homes: string[] = [];
  const daemons: Daemon[] = [];
  let proxy: https.Server | null = null;
  let socket: WebSocket | null = null;
  const deadline = setTimeout(() => {
    console.error('aborted: deadline');
    for (const d of daemons) d.child.kill('SIGKILL');
    process.exit(1);
  }, DEADLINE_MS);

  try {
    // ── Two homes, each its own host id and name ──
    const ids = { a: randomUUID(), b: randomUUID() };
    const fakes = (['a', 'b'] as const).map((side) => {
      const fake = makeFakeHome({ claude: 'S-8' });
      homes.push(fake.home);
      const dir = configDirectory(fake.home);
      fs.mkdirSync(dir, { recursive: true });
      const name = side === 'a' ? 'Laptop A' : 'Desk B';
      fs.writeFileSync(path.join(dir, 'host.json'), JSON.stringify({ v: 1, hostId: ids[side], createdAt: new Date().toISOString(), name }));
      return fake;
    });
    const [fakeA, fakeB] = fakes;
    liveSessionFile(fakeB.home);
    const ca = await testCa();
    const caFile = path.join(fakeA.home, 'test-ca.pem');
    fs.writeFileSync(caFile, ca.cert);

    // ── B, and the https proxy in front of it (B's request log) ──
    const startB = async () => {
      const d = startDaemon(fakeB, PORT_B, ['--no-terminal']);
      daemons.push(d);
      await waitForDaemon(PORT_B, d.child.pid!, 60_000, fakeB.home);
      return d;
    };
    let b = await startB();
    const tokenB = hostToken(fakeB.home)!;
    const requests: string[] = [];
    /** Everything A sent through the proxy (to look for a credential), and the pairing reply. */
    const sent: string[] = [];
    let pairReply = '';
    const leaf = await ca.issue('127.0.0.1');
    proxy = https.createServer({ key: leaf.key, cert: leaf.cert }, (req, res) => {
      const route = `${req.method} ${(req.url ?? '').split('?')[0]}`;
      requests.push(route);
      const body: Buffer[] = [];
      req.on('data', (c: Buffer) => body.push(c));
      req.on('end', () => sent.push(`${route} ${JSON.stringify(req.headers)} ${Buffer.concat(body).toString()}`));
      const up = http.request(
        {
          host: '127.0.0.1',
          port: PORT_B,
          method: req.method,
          path: req.url,
          headers: { ...req.headers, 'x-forwarded-for': '192.0.2.44', 'x-forwarded-proto': 'https' },
        },
        (r) => {
          res.writeHead(r.statusCode ?? 502, r.headers);
          // The first pairing's reply (the second, refused, attempt answers too).
          if (route === 'POST /api/street/pair' && !pairReply) {
            let text = '';
            r.on('data', (c: Buffer) => (text += c.toString()));
            r.on('end', () => (pairReply ||= text));
          }
          r.pipe(res);
        },
      );
      up.on('error', () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      req.pipe(up);
    });
    await new Promise<void>((r) => proxy!.listen(PORT_PROXY, '127.0.0.1', r));
    const summaryCalls = () => requests.filter((r) => r === 'GET /api/street/summary').length;

    // ── A, trusting the test CA ──
    const a = startDaemon(fakeA, PORT_A, ['--no-terminal'], { NODE_EXTRA_CA_CERTS: caFile });
    daemons.push(a);
    await waitForDaemon(PORT_A, a.child.pid!, 60_000, fakeA.home);
    const tokenA = hostToken(fakeA.home)!;
    const onA = (url: string, init: RequestInit = {}) =>
      fetch(`http://127.0.0.1:${PORT_A}${url}`, {
        ...init,
        headers: { authorization: `Bearer ${tokenA}`, ...(init.body ? { 'content-type': 'application/json' } : {}) },
      });
    const onB = (url: string, init: RequestInit = {}) =>
      fetch(`http://127.0.0.1:${PORT_B}${url}`, {
        ...init,
        headers: { authorization: `Bearer ${tokenB}`, ...(init.body ? { 'content-type': 'application/json' } : {}) },
      });

    // ── Pairing ──
    const http1 = await onA('/api/street/neighbours', { method: 'POST', body: JSON.stringify({ url: `http://127.0.0.1:${PORT_B}`, code: '12345678' }) });
    check(http1.status === 400 && (await http1.json()).errorCode === 'street_https_only', 'A refuses plain http to another PC, with its reason');
    const { code } = (await (await onB('/api/street/pair-code', { method: 'POST' })).json()) as { code: string };
    const paired = await onA('/api/street/neighbours', { method: 'POST', body: JSON.stringify({ url: URL_B, code }) });
    const pairedBody = (await paired.json()) as { neighbour?: { hostId: string } };
    check(paired.status === 200 && pairedBody.neighbour?.hostId === ids.b, `A paired with B over https, B pinned by its host id (${paired.status} ${JSON.stringify(pairedBody).slice(0, 300)}; proxy saw ${requests.join(', ')})`);
    const again = await onA('/api/street/neighbours', { method: 'POST', body: JSON.stringify({ url: URL_B, code }) });
    check(again.status === 400, 'the pair code works once');
    const listB = (await (await onB('/api/street')).json()) as { readers: Array<{ hostId: string; name: string }> };
    check(listB.readers.length === 1 && listB.readers[0].hostId === ids.a && listB.readers[0].name === 'Laptop A', "B's 옆 건물 row names A");
    const fileB = path.join(configDirectory(fakeB.home), 'street.json');
    check((fs.statSync(fileB).mode & 0o777) === 0o600, "B's street.json is 0600");

    // A secret in B's conversation, written now: B's watcher reads it long before the permission
    // below (a user line read after it would start a new turn and end the wait).
    const transcript = path.join(fakeB.home, '.claude/projects/-work-alpha', `${ALPHA}.jsonl`);
    check(fs.existsSync(transcript), "B's alpha transcript exists");
    fs.appendFileSync(transcript, `${JSON.stringify({ type: 'user', message: { role: 'user', content: `token ${SECRET}` } })}\n`);

    // ── Nobody watching: no summary call ──
    await sleep(12_000);
    check(summaryCalls() === 0, `nobody watching: ${summaryCalls()} summary calls in B's request log over 12 s`);

    // ── A client watches the street ──
    const frames: string[] = [];
    let latest: Neighbour | undefined;
    socket = new WebSocket(`ws://127.0.0.1:${PORT_A}/ws`, {
      headers: { authorization: `Bearer ${tokenA}`, origin: `http://127.0.0.1:${PORT_A}` },
    });
    socket.on('message', (data) => {
      const text = String(data);
      frames.push(text);
      try {
        const m = JSON.parse(text) as { type?: string; neighbours?: Neighbour[] };
        if (m.type === 'streetState') latest = m.neighbours?.find((n) => n.hostId === ids.b);
      } catch {
        // not JSON
      }
    });
    await new Promise<void>((resolve, reject) => {
      socket!.once('open', () => resolve());
      socket!.once('error', reject);
    });
    socket.send(JSON.stringify({ type: 'streetWatch', on: true }));
    const waitFor = async (what: string, ok: (n: Neighbour) => boolean, ms = SHOW_MS) => {
      const start = Date.now();
      for (const end = start + ms; Date.now() < end; await sleep(250)) {
        if (a.child.exitCode !== null) throw new Error('daemon A exited');
        if (latest && ok(latest)) return check(true, `${what} in ${((Date.now() - start) / 1000).toFixed(1)} s`);
      }
      throw new Error(`timed out (${ms} ms): ${what}; last ${JSON.stringify(latest)}; ${summaryCalls()} summary calls`);
    };
    await waitFor("A's streetState shows B online with its agents", (n) => n.state === 'online' && n.agents.length > 0);
    console.log(`   B's agents: ${latest!.agents.map((x) => `${x.name}:${x.state}`).join(', ')}`);

    // ── The token crossed once; every later request is signed (ADR-0020 M1) ──
    const pairToken = (JSON.parse(pairReply) as { token?: string }).token ?? '';
    check(/^[A-Za-z0-9_-]{43}$/.test(pairToken), 'the pairing reply carried the street token');
    const pairAt = sent.findIndex((s) => s.startsWith('POST /api/street/pair '));
    const later = sent.slice(pairAt + 1);
    const signedCalls = later.filter((s) => s.startsWith('GET /api/street/summary'));
    check(signedCalls.length > 0 && signedCalls.every((s) => /"authorization":"Street [0-9a-f-]{36}\.\d+\./.test(s)), `every summary request is signed (${signedCalls.length})`);
    check(!later.some((s) => s.includes(pairToken)), `none of the ${later.length} requests after pairing carries the token`);

    // ── B's fake claude asks a permission; secrets in its prompt and tool ──
    const hook = (event: Record<string, unknown>) =>
      onB('/api/hooks/claude', { method: 'POST', body: JSON.stringify({ session_id: ALPHA, cwd: '/work/alpha', ...event }) });
    await hook({ hook_event_name: 'UserPromptSubmit', prompt: `the key is ${SECRET}` });
    await hook({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: `echo ${SECRET}` } });
    await hook({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: `echo ${SECRET}` } });
    await waitFor('B asks a permission -> A shows it waiting', (n) => n.waiting >= 1 && n.agents.some((x) => x.state === 'waiting'));
    const ownSummary = await (await onB('/api/street/summary')).text();
    check(!ownSummary.includes(SECRET), "B's own summary carries none of the secret planted in its conversation");
    check(!frames.join('\n').includes(SECRET), `none of A's ${frames.length} socket frames carries the secret`);
    check(!frames.join('\n').includes(tokenB), "none of A's frames carries B's host token");

    // ── Photos: the 옆 건물 section in both security windows ──
    fs.mkdirSync(OUT, { recursive: true });
    const browser = await launchBrowser();
    try {
      for (const [name, daemon, file] of [
        ['B', b, '01-b-security-reader-row.png'],
        ['A', a, '02-a-security-neighbour.png'],
      ] as const) {
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        const page = await ctx.newPage();
        await page.goto(await daemon.loginUrl());
        await topBarButton(page, '보안', 30_000);
        const section = page.getByTestId('street-section');
        await section.waitFor({ timeout: 15_000 });
        await section.scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(OUT, file) });
        check(await section.isVisible(), `${name}'s 옆 건물 section photographed (${file})`);
        await ctx.close();
      }
    } finally {
      await browser.close();
    }

    // ── B stops: off ──
    await b.stop();
    await waitFor('B stopped -> A shows off', (n) => n.state === 'off');

    // ── B back; its owner deletes the pairing: unpaired ──
    b = await startB();
    await waitFor('B back -> A shows online again', (n) => n.state === 'online');
    const del = await onB(`/api/street/readers/${ids.a}`, { method: 'DELETE' });
    check(del.status === 200, "B's owner deletes the 옆 건물 row");
    await waitFor('deleted on B -> A shows unpaired', (n) => n.state === 'unpaired');

    // ── Watching stops: no more calls ──
    socket.send(JSON.stringify({ type: 'streetWatch', on: false }));
    await sleep(1000);
    const before = summaryCalls();
    await sleep(12_000);
    check(summaryCalls() === before, `watch off: no summary call over 12 s (${before} in all while watched)`);
    check(!frames.join('\n').includes(SECRET), `still none of A's ${frames.length} frames carries the secret`);
  } finally {
    clearTimeout(deadline);
    socket?.close();
    proxy?.close();
    for (const d of daemons) await d.stop();
    for (const home of homes) fs.rmSync(home, { recursive: true, force: true });
  }
}

main().then(
  () => console.log(`PASS run-street-pair (${since()}, ${os.platform()})`),
  (err: unknown) => {
    console.error(err);
    process.exit(1);
  },
);
