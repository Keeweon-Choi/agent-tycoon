/**
 * T-0039 Web Push: RFC 8291 encryption (the RFC's own test vector), the VAPID
 * signature, push.json (made once 0600, an unreadable file kept and push
 * off), a revoked device's subscription removed, a 410 removing it, the
 * rules per device (kinds, cooldown, not while it looks), and a payload that
 * carries no transcript text.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { noticeTarget, noticeUrl, parseNoticeUrl, pushTag } from '../../../core/src/cld/notices.js';
import { LOOKING_FRESH_MS } from '../../../core/src/constants.js';
import { AgentStateStore } from '../agentStateStore.js';
import { StandaloneAuth } from './auth.js';
import { SoftDevice } from './authTestKit.js';
import type { WsSend } from './hooks.js';
import {
  DEFAULT_PUSH_SUBJECT,
  encryptPayload,
  parsePushSubscribe,
  PUSH_COALESCE_MS,
  PUSH_PREVIEW_MAX,
  PUSH_SKIP_LOG_MS,
  type PushPayload,
  PushService,
  PushStore,
  replyPreview,
  vapidAuthorization,
} from './push.js';
import type { RoomRef } from './transcriptView.js';

const u = (s: string) => Buffer.from(s, 'base64url');
const hkdf = (ikm: Buffer, salt: Buffer, info: Buffer | string, len: number) =>
  Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from(info), len));

/** The receiving browser's side of RFC 8291. */
function decrypt(body: Buffer, ua: crypto.ECDH, auth: Buffer): Buffer {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const record = body.subarray(21 + idlen);
  const ikm = hkdf(
    ua.computeSecret(asPublic),
    auth,
    Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic]),
    32,
  );
  const d = crypto.createDecipheriv(
    'aes-128-gcm',
    hkdf(ikm, salt, 'Content-Encoding: aes128gcm\0', 16),
    hkdf(ikm, salt, 'Content-Encoding: nonce\0', 12),
  );
  d.setAuthTag(record.subarray(-16));
  const plain = Buffer.concat([d.update(record.subarray(0, -16)), d.final()]);
  expect(plain.at(-1)).toBe(2);
  return plain.subarray(0, -1);
}

describe('RFC 8291 / 8292 (IR-PUSH-001)', () => {
  it('reproduces the RFC 8291 Appendix A message byte for byte', () => {
    const sender = crypto.createECDH('prime256v1');
    sender.setPrivateKey(u('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'));
    const body = encryptPayload(
      u('V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24'),
      u('BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'),
      u('BTBZMqHH6r4Tts7J_aSIgg'),
      { salt: u('DGv6ra1nlYgDCS1FRnbzlw'), sender },
    );
    expect(body.toString('base64url')).toBe(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    );
  });

  it('a VAPID header the push service can verify with the public key', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-push-'));
    const store = new PushStore(path.join(dir, 'push.json'));
    const auth = vapidAuthorization('https://push.example/abc', store.vapid!, 'mailto:a@b.c', 0);
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(auth)!;
    expect(m[4]).toBe(store.vapid!.publicKey);
    expect(JSON.parse(u(m[2]).toString())).toEqual({
      aud: 'https://push.example',
      exp: 12 * 3600,
      sub: 'mailto:a@b.c',
    });
    const pub = u(m[4]);
    const key = crypto.createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: pub.subarray(1, 33).toString('base64url'),
        y: pub.subarray(33).toString('base64url'),
      },
      format: 'jwk',
    });
    expect(
      crypto.verify(
        'sha256',
        Buffer.from(`${m[1]}.${m[2]}`),
        { key, dsaEncoding: 'ieee-p1363' },
        u(m[3]),
      ),
    ).toBe(true);
  });
});

describe('push.json', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-push-'));
  });

  it('is made once, 0600, and read back the same', () => {
    const file = path.join(dir, 'cfg', 'push.json');
    const a = new PushStore(file);
    expect(a.available).toBe(true);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(new PushStore(file).vapid).toEqual(a.vapid);
  });

  it('the VAPID subject (T-0063): push.json wins, else the public host, else the mailto default', () => {
    const file = path.join(dir, 'push.json');
    const host = 'cld-gui.tailnet-example.ts.net';
    expect(new PushStore(file).subject).toBe(DEFAULT_PUSH_SUBJECT);
    expect(new PushStore(file, host).subject).toBe(`https://${host}`);
    const saved = JSON.parse(fs.readFileSync(file, 'utf-8'));
    fs.writeFileSync(file, JSON.stringify({ ...saved, subject: 'mailto:ops@localhost' }));
    expect(new PushStore(file, host).subject).toBe('mailto:ops@localhost');
  });

  it('an unreadable file is kept as it is and push is off', () => {
    const file = path.join(dir, 'push.json');
    fs.writeFileSync(file, '{ not json');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const store = new PushStore(file);
    expect(store.available).toBe(false);
    expect(fs.readFileSync(file, 'utf-8')).toBe('{ not json');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

/** A browser's subscription: its keys, and what pushSubscribe sends. */
function browser(endpoint = 'https://push.example/sub/1') {
  const ua = crypto.createECDH('prime256v1');
  ua.generateKeys();
  const auth = crypto.randomBytes(16);
  return {
    ua,
    auth,
    msg: {
      type: 'pushSubscribe',
      endpoint,
      p256dh: ua.getPublicKey().toString('base64url'),
      auth: auth.toString('base64url'),
      kinds: ['turnEnd', 'attention', 'job'], // an old client: it knew no `reply`, and sent no `kindsOff`
      subagents: false,
    },
  };
}

function setup(status = 201) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-push-'));
  const store = new PushStore(path.join(dir, 'push.json'));
  const agents = new AgentStateStore();
  const visible = new Set<WsSend>();
  /** U-49: when a visible page last said so (absent: just now). */
  const looked = new Map<WsSend, number>();
  const posts: Array<{ url: string; body: Buffer; headers: Record<string, string> }> = [];
  /** C3: the room each character's newest turn answers (absent: a one-to-one turn). */
  const rooms: Record<number, RoomRef> = {};
  /** U-49: the last assistant text of each character's newest turn (absent: none). */
  const texts: Record<number, string> = {};
  const fetchFn = (async (url: string, init: RequestInit) => {
    posts.push({
      url,
      body: Buffer.from(init.body as Uint8Array),
      headers: init.headers as Record<string, string>,
    });
    return new Response(null, { status });
  }) as unknown as typeof fetch;
  const service = new PushService({
    store,
    agents,
    lookedAt: (s) => (visible.has(s) ? (looked.get(s) ?? Date.now()) : null),
    describe: (id) =>
      id === 10 || id === 11
        ? { name: id === 10 ? 'boss' : 'chief', who: 'orchestrator', lead: true } // U-49: a messenger conversation
        : id === 7
          ? { name: 'lead', who: 'orchestrator' }
          : id === 8
            ? { name: 'veteran', who: 'orchestrator' }
            : { name: 'scout', who: 'teammate' },
    agentIdOf: (name) => (name === 'lead' ? 7 : null),
    turn: (id) => ({ room: rooms[id] ?? null, text: texts[id] ?? null }),
    fetchFn,
  });
  const replies: Record<string, unknown>[] = [];
  const send: WsSend = (m) => replies.push(m);
  return { dir, store, agents, visible, looked, posts, service, send, replies, rooms, texts };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('PushService', () => {
  it('subscribes a privileged device; refuses others and bad subscriptions', () => {
    const t = setup();
    const b = browser();
    t.service.opened(t.send, 'dev-1');
    expect(t.service.onClientMessage(b.msg, t.send, false)).toBe(true);
    expect(t.store.list()).toHaveLength(0);
    expect(t.replies.at(-1)).toMatchObject({ type: 'pushState', subscribed: false });
    t.service.onClientMessage({ ...b.msg, endpoint: 'http://push.example/x' }, t.send, true);
    expect(t.store.list()).toHaveLength(0);
    t.service.onClientMessage(b.msg, t.send, true);
    expect(t.store.get('dev-1')).toMatchObject({ endpoint: b.msg.endpoint, kinds: b.msg.kinds });
    expect(t.replies.at(-1)).toMatchObject({ subscribed: true, available: true });
    expect(fs.statSync(path.join(t.dir, 'push.json')).mode & 0o777).toBe(0o600);
    expect(parsePushSubscribe({ ...b.msg, p256dh: 'AAAA' })).toBeNull();
  });

  it('pushes only to a device that is not looking, with no transcript text', async () => {
    const t = setup();
    const b = browser();
    t.service.opened(t.send, 'dev-1');
    t.service.onClientMessage(b.msg, t.send, true);
    t.visible.add(t.send);
    t.agents.broadcast({ type: 'agentStatus', id: 7, status: 'waiting' });
    expect(t.posts).toHaveLength(0);
    t.visible.delete(t.send);
    t.agents.broadcast({
      type: 'officeEvent',
      ts: new Date().toISOString(),
      kind: 'job_end',
      name: 'lead',
      summary: '작업 끝: lead (exit 0)',
      ref: 'pid:4242',
      preview: 'SECRET transcript line',
    });
    await flush();
    expect(t.posts).toHaveLength(1);
    expect(t.posts[0].url).toBe(b.msg.endpoint);
    expect(t.posts[0].headers['Content-Encoding']).toBe('aes128gcm');
    const payload = JSON.parse(decrypt(t.posts[0].body, b.ua, b.auth).toString()) as PushPayload;
    expect(payload).toEqual({
      title: '🏁 lead',
      body: '작업 끝: lead (exit 0)',
      agentId: 7,
      url: '/?open=job&id=pid%3A4242', // T-0043: the job's card
      tag: 'job:pid:4242',
    });
    expect(JSON.stringify(payload)).not.toContain('SECRET');
  });

  it('never pushes an owner sent message from the office feed', async () => {
    const t = setup();
    const b = browser();
    t.service.opened(t.send, 'dev-1');
    t.service.onClientMessage(b.msg, t.send, true);
    t.agents.broadcast({
      type: 'officeEvent',
      ts: new Date().toISOString(),
      kind: 'send',
      source: 'gui:phone',
      name: null,
      summary: 'owner message',
    });
    await flush();
    expect(t.posts).toEqual([]);
  });

  it('T-0091: the engine giving up on a session is one push that opens its character', async () => {
    const t = setup();
    const b = browser();
    t.service.opened(t.send, 'dev-1');
    t.service.onClientMessage(b.msg, t.send, true);
    t.agents.broadcast({
      type: 'officeEvent',
      ts: new Date().toISOString(),
      kind: 'orch_giveup',
      name: 'lead',
      summary: 'lead: 자꾸 꺼져서 다시 띄우지 않아요 (세션을 켜지 못했어요)',
    });
    await flush();
    expect(t.posts).toHaveLength(1);
    const payload = JSON.parse(decrypt(t.posts[0].body, b.ua, b.auth).toString()) as PushPayload;
    expect(payload.body).toContain('자꾸 꺼져서 다시 띄우지 않아요');
    expect(payload.url).toBe('/?agent=7');
  });

  it('per device: its kinds, orchestrator-only turn ends, the cooldown', async () => {
    const t = setup();
    const b = browser();
    t.service.opened(t.send, 'dev-1');
    t.service.onClientMessage({ ...b.msg, kinds: ['turnEnd'] }, t.send, true);
    t.agents.broadcast({ type: 'agentToolPermission', id: 7 }); // attention: off here
    t.agents.broadcast({ type: 'agentStatus', id: 9, status: 'waiting' }); // a teammate
    t.agents.broadcast({ type: 'agentStatus', id: 7, status: 'waiting' });
    t.agents.broadcast({ type: 'agentStatus', id: 7, status: 'waiting' }); // cooldown
    await flush();
    expect(t.posts).toHaveLength(1);
    const payload = JSON.parse(decrypt(t.posts[0].body, b.ua, b.auth).toString()) as PushPayload;
    expect(payload).toMatchObject({ title: '🔔 lead', body: '일을 마쳤어요' });
  });

  describe('C3: one notification per channel event', () => {
    const payloads = (t: ReturnType<typeof setup>, b: ReturnType<typeof browser>) =>
      t.posts.map((p) => JSON.parse(decrypt(p.body, b.ua, b.auth).toString()) as PushPayload);
    const subscribed = () => {
      const t = setup();
      const b = browser();
      t.service.opened(t.send, 'dev-1');
      t.service.onClientMessage(b.msg, t.send, true);
      return { t, b };
    };
    const POST1: RoomRef = { name: '출시팀', id: 'room0001', post: 'post0001' };
    const POST2: RoomRef = { ...POST1, post: 'post0002' };

    it('a room post both members answer (`@a @b`) without text: one short notice per member, for the room, none for a DM', async () => {
      const { t, b } = subscribed();
      t.rooms[7] = POST1;
      t.rooms[8] = POST1;
      t.agents.broadcast({ type: 'agentStatus', id: 7, status: 'waiting' });
      t.agents.broadcast({ type: 'agentStatus', id: 8, status: 'waiting' });
      await flush();
      const got = payloads(t, b);
      expect(got).toMatchObject([
        { title: '🔔 출시팀 · lead', body: '일을 마쳤어요', agentId: null, url: '/?open=room&room=room0001' },
        { title: '🔔 출시팀 · veteran', body: '일을 마쳤어요', agentId: null, url: '/?open=room&room=room0001' },
      ]);
      expect(new Set(got.map((p) => p.tag)).size).toBe(2); // one tray slot per member
    });

    it('a second post notifies again; the same member answering the same post again does not', async () => {
      const { t, b } = subscribed();
      const clock = vi.spyOn(Date, 'now');
      try {
        const at = (ms: number) => clock.mockReturnValue(1_800_000_000_000 + ms);
        at(0);
        t.rooms[7] = POST1;
        t.agents.broadcast({ type: 'agentStatus', id: 7, status: 'waiting' }); // post 1: first end
        at(PUSH_COALESCE_MS + 1_000);
        t.agents.broadcast({ type: 'agentStatus', id: 7, status: 'waiting' }); // post 1: the same member again
        at(2 * PUSH_COALESCE_MS + 2_000);
        t.rooms[7] = POST2;
        t.agents.broadcast({ type: 'agentStatus', id: 7, status: 'waiting' }); // post 2, minutes before its cooldown ends
        await flush();
        expect(payloads(t, b).map((p) => p.title)).toEqual(['🔔 출시팀 · lead', '🔔 출시팀 · lead']);
        expect(t.posts).toHaveLength(2);
      } finally {
        clock.mockRestore();
      }
    });

    it('a DM turn is one push for that lead, as before', async () => {
      const { t, b } = subscribed();
      t.agents.broadcast({ type: 'agentStatus', id: 7, status: 'waiting' });
      await flush();
      expect(payloads(t, b)).toEqual([
        { title: '🔔 lead', body: '일을 마쳤어요', agentId: 7, url: '/?agent=7', tag: 'turnEnd' },
      ]);
    });

    it("a room turn that asks (permission, question) is still the character's ask", async () => {
      const { t, b } = subscribed();
      t.rooms[7] = POST1;
      t.agents.broadcast({ type: 'agentToolPermission', id: 7 });
      await flush();
      expect(payloads(t, b).map((p) => p.title)).toEqual(['🔐 lead']);
    });

    it("PERM-PROMPT: a sub-agent's permission names it (its staff name)", async () => {
      const { t, b } = subscribed();
      t.agents.broadcast({ type: 'agentToolPermission', id: 7, asker: 'no-such-name' });
      await flush();
      expect(payloads(t, b)).toMatchObject([{ title: '🔐 lead', body: 'no-such-name의 허락을 기다려요' }]);
    });

    it('a room named like a character id does not share its cooldown', async () => {
      const { t, b } = subscribed();
      t.rooms[7] = { name: '8', id: 'room0008' };
      t.agents.broadcast({ type: 'agentStatus', id: 7, status: 'waiting' }); // the room "8"
      t.service.notify('question', 8, 'veteran', '답을 기다려요', 'orchestrator');
      t.service.notify('turnEnd', 8, 'veteran', '일을 마쳤어요', 'orchestrator'); // agent 8's own
      await flush();
      expect(payloads(t, b).map((p) => p.title)).toEqual(['🔔 8 · lead', '✋ veteran', '🔔 veteran']);
    });

    it('a name only (a turn the messenger did not type, found by the transcript) still notifies once per member', async () => {
      const { t, b } = subscribed();
      t.rooms[7] = { name: '출시팀', id: 'room0001' };
      t.agents.broadcast({ type: 'agentStatus', id: 7, status: 'waiting' });
      t.agents.broadcast({ type: 'agentStatus', id: 8, status: 'waiting' });
      await flush();
      expect(payloads(t, b)).toHaveLength(2); // lead, and veteran (its turn is not the room's here)
    });

    it('asks the room only when a push can go out, and waits for an answer from a transcript read', async () => {
      const t = setup();
      const asked: number[] = [];
      const agents = new AgentStateStore();
      const late = new PushService({
        store: t.store,
        agents,
        lookedAt: () => null,
        describe: () => ({ name: 'lead', who: 'orchestrator' }),
        agentIdOf: () => 7,
        turn: (id) => {
          asked.push(id);
          return new Promise((resolve) =>
            setTimeout(
              () =>
                resolve({ room: { name: '출시팀', id: 'room0001', post: 'post0001' }, text: null }),
              5,
            ),
          );
        },
        fetchFn: (async (url: string, init: RequestInit) => {
          t.posts.push({ url, body: Buffer.from(init.body as Uint8Array), headers: {} });
          return new Response(null, { status: 201 });
        }) as unknown as typeof fetch,
      });
      agents.broadcast({ type: 'agentStatus', id: 7, status: 'waiting' });
      expect(asked).toEqual([]); // nobody subscribed: no transcript is read for it
      const b = browser();
      late.opened(t.send, 'dev-1');
      late.onClientMessage(b.msg, t.send, true);
      agents.broadcast({ type: 'agentStatus', id: 7, status: 'waiting' });
      expect(asked).toEqual([7]);
      expect(t.posts).toHaveLength(0); // still reading
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(t.posts).toHaveLength(1);
      late.dispose();
    });
  });

  it('FR-NTF-006: turn ends of remote-control orchestrators can be left to the Claude app', async () => {
    const t = setup();
    const b = browser();
    t.service.opened(t.send, 'dev-1');
    t.service.onClientMessage({ ...b.msg, remoteTurnEnds: false }, t.send, true);
    t.service.notify('turnEnd', 7, 'lead', '일을 마쳤어요', 'orchestrator', true);
    t.service.notify('permission', 7, 'lead', '허락을 기다려요', 'orchestrator', true);
    t.service.notify('turnEnd', 8, 'veteran', '일을 마쳤어요', 'orchestrator', false);
    await flush();
    const titles = t.posts.map(
      (p) => (JSON.parse(decrypt(p.body, b.ua, b.auth).toString()) as PushPayload).title,
    );
    expect(titles).toEqual(['🔐 lead', '🔔 veteran']);
  });

  it('a 410 from the push service removes the subscription', async () => {
    const t = setup(410);
    t.service.opened(t.send, 'dev-1');
    t.service.onClientMessage(browser().msg, t.send, true);
    t.agents.broadcast({ type: 'agentStatus', id: 7, status: 'waiting' });
    await flush();
    await flush();
    expect(t.posts).toHaveLength(1);
    expect(t.store.list()).toHaveLength(0);
  });

  it('revoking the device (or ending its session) removes its subscription', () => {
    const t = setup();
    const auth = new StandaloneAuth({});
    const earlier: string[] = []; // another observer (the shells, T-0052) keeps hearing it
    auth.onRowGone = (id) => earlier.push(id);
    t.service.useAuth(auth);
    const a = auth.createSession('link', 'phone');
    const b = auth.createSession('link', 'laptop');
    const rowA = auth.rowIdOf(a.id)!;
    const rowB = auth.rowIdOf(b.id)!;
    const sendB: WsSend = () => undefined;
    t.service.opened(t.send, rowA);
    t.service.opened(sendB, rowB);
    t.service.onClientMessage(browser('https://push.example/a').msg, t.send, true);
    t.service.onClientMessage(browser('https://push.example/b').msg, sendB, true);
    expect(t.store.list()).toHaveLength(2);
    auth.revoke(rowA);
    expect(t.store.list().map((s) => s.device)).toEqual([rowB]);
    expect(earlier).toEqual([rowA]);
  });
});

describe('where a notice opens (T-0043): the target and its push url', () => {
  it('C3: a room: its conversation, by id, and nothing else a url may carry', () => {
    const room = { open: 'room', room: 'room0001' } as const;
    expect(noticeUrl(room)).toBe('/?open=room&room=room0001');
    expect(parseNoticeUrl(noticeUrl(room))).toEqual(room);
    expect(parseNoticeUrl('?open=room')).toBeNull();
    expect(parseNoticeUrl('?open=room&room=%3Cscript%3E')).toBeNull();
    // A name with characters a name url refuses never reaches a url: the id addresses the room.
    expect(parseNoticeUrl('?open=room&room=a%26b')).toBeNull();
  });

  it('a lead: its conversation (a background permission ask: with the terminal hint)', () => {
    const chat = noticeTarget({ cause: 'turnEnd', agentId: 7, lead: 'alpha app' });
    expect(chat).toEqual({ open: 'chat', lead: 'alpha app' });
    expect(noticeUrl(chat)).toBe('/?open=chat&lead=alpha+app');
    const timed = noticeTarget({
      cause: 'turnEnd',
      agentId: 7,
      lead: 'alpha app',
      at: 1800000000000,
    });
    expect(noticeUrl(timed)).toBe('/?open=chat&lead=alpha+app&at=1800000000000');
    expect(parseNoticeUrl(noticeUrl(timed))).toEqual(timed);
    const named = { ...timed, id: '1800000000000-abcd1234-2' };
    expect(noticeUrl(named)).toBe(
      '/?open=chat&lead=alpha+app&at=1800000000000&id=1800000000000-abcd1234-2',
    );
    expect(parseNoticeUrl(noticeUrl(named))).toEqual(named);
    expect(parseNoticeUrl('?open=chat&lead=alpha&id=%3Cb%3E')).toEqual({ open: 'chat', lead: 'alpha' });
    const ask = noticeTarget({ cause: 'permission', agentId: 7, lead: 'beta', background: true });
    expect(noticeUrl(ask)).toBe('/?open=chat&lead=beta&terminal=1');
    expect(parseNoticeUrl('?open=chat&lead=beta&terminal=1')).toEqual(ask);
    expect(noticeTarget({ cause: 'question', agentId: 7, lead: 'beta', background: true })).toEqual(
      { open: 'chat', lead: 'beta' },
    );
  });

  it('a job end: its card; a Codex end: its task; anyone else: the character', () => {
    const job = noticeTarget({
      cause: 'job',
      agentId: 7,
      event: { kind: 'job_end', ref: 'pid:42' },
    });
    expect(noticeUrl(job)).toBe('/?open=job&id=pid%3A42');
    expect(parseNoticeUrl('?open=job&id=pid%3A42')).toEqual(job);
    const codex = noticeTarget({
      cause: 'job',
      agentId: null,
      event: { kind: 'codex_end', ref: 'c1' },
    });
    expect(codex).toEqual({ open: 'codex', id: 'c1' });
    expect(noticeTarget({ cause: 'turnEnd', agentId: 9 })).toEqual({ open: 'agent', agentId: 9 });
    expect(noticeUrl({ open: 'agent', agentId: 9 })).toBe('/?agent=9');
    expect(parseNoticeUrl('?agent=9')).toEqual({ open: 'agent', agentId: 9 });
    expect(noticeUrl(noticeTarget({ cause: 'turnEnd', agentId: null }))).toBe('/');
    expect(parseNoticeUrl('?open=rm%20-rf')).toBeNull();
  });

  it('the url parser takes known kinds and safe names only (it is typable by anyone)', () => {
    expect(parseNoticeUrl('?open=chat&lead=%EB%B0%B1%EC%97%94%EB%93%9C%20%ED%8C%80')).toEqual({
      open: 'chat',
      lead: '백엔드 팀',
    });
    for (const bad of [
      '?open=chat',
      '?open=chat&lead=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E',
      '?open=chat&lead=a%22b',
      '?open=chat&lead=a%0Ab',
      '?open=chat&lead=../x',
      `?open=chat&lead=${'x'.repeat(81)}`,
      '?open=job&id=%22%5D%2C%5Bdata-x',
      '?open=codex&id=-rf',
      '?open=settings',
      '?open=javascript:alert(1)',
      '?agent=1e3',
      '?agent=3;x',
    ])
      expect(parseNoticeUrl(bad), bad).toBeNull();
    expect(parseNoticeUrl('?open=job')).toEqual({ open: 'job', id: null });
    expect(parseNoticeUrl('?agent=-1000000001')).toEqual({ open: 'agent', agentId: -1000000001 });
    expect(parseNoticeUrl('')).toBeNull();
  });
});

describe('nobody to push to: said once in a while, never silently', () => {
  it('logs one line per window with the count, not one per notice', () => {
    const t = setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (let i = 0; i < 5; i++)
      t.service.notify('permission', 7, 'lead', 'x', 'orchestrator', false, 1000 + i);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(
      '1 notice(s) not pushed: no device has push notifications on',
    );
    t.service.notify('job', null, '작업', 'x', 'orchestrator', false, 1000 + PUSH_SKIP_LOG_MS);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1][0]).toContain('5 notice(s)'); // 4 held back + this one
    warn.mockRestore();
  });

  it('an event nobody is subscribed for goes through the broadcast path too', () => {
    const t = setup();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    t.agents.broadcast({ type: 'agentToolPermission', id: 7 });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('the device list can tell which devices have push on', () => {
    const t = setup();
    t.service.opened(t.send, 'dev-1');
    expect(t.service.subscribedDevices().has('dev-1')).toBe(false);
    t.service.onClientMessage(browser().msg, t.send, true);
    expect(t.service.subscribedDevices().has('dev-1')).toBe(true);
  });
});

describe('no notification bombs, no lost asks', () => {
  const payloads = (t: ReturnType<typeof setup>, b: ReturnType<typeof browser>) =>
    t.posts.map((p) => JSON.parse(decrypt(p.body, b.ua, b.auth).toString()) as PushPayload);

  it('tags: the same event again shares a tag; different asks and jobs never do', () => {
    const office = { open: 'office' } as const;
    expect(pushTag('permission', 7, 'lead', office)).toBe(pushTag('permission', 7, 'lead', office));
    expect(pushTag('permission', 7, 'lead', office)).not.toBe(
      pushTag('permission', 8, 'scout', office),
    );
    expect(pushTag('question', 7, 'lead', office)).toBe(pushTag('permission', 7, 'lead', office));
    expect(pushTag('turnEnd', 7, 'lead', office)).toBe(pushTag('turnEnd', 8, 'scout', office)); // a burst: one slot
    const job = (id: string) => pushTag('job', null, '작업', { open: 'job', id });
    expect(job('pid:1')).toBe(job('pid:1'));
    expect(job('pid:1')).not.toBe(job('pid:2'));
  });

  it('a burst of turn ends is one push; an ask in the middle of it is never held back', async () => {
    const t = setup();
    const b = browser();
    t.service.opened(t.send, 'dev-1');
    t.service.onClientMessage({ ...b.msg, subagents: true }, t.send, true);
    const at = 1_000_000;
    t.service.notify('turnEnd', 7, 'lead', '일을 마쳤어요', 'orchestrator', false, at);
    t.service.notify('turnEnd', 8, 'veteran', '일을 마쳤어요', 'orchestrator', false, at + 1000);
    t.service.notify(
      'permission',
      8,
      'veteran',
      '허락을 기다려요',
      'orchestrator',
      false,
      at + 2000,
    );
    t.service.notify('permission', 9, 'scout', '허락을 기다려요', 'orchestrator', false, at + 3000);
    t.service.notify(
      'turnEnd',
      9,
      'scout',
      '일을 마쳤어요',
      'orchestrator',
      false,
      at + PUSH_COALESCE_MS + 1,
    );
    await flush();
    expect(payloads(t, b).map((p) => `${p.tag}`)).toEqual([
      'turnEnd',
      'attention:8',
      'attention:9',
      'turnEnd',
    ]);
  });

  it('a second ask for the same character a minute later still goes out (the screen keeps 5 minutes)', async () => {
    const t = setup();
    const b = browser();
    t.service.opened(t.send, 'dev-1');
    t.service.onClientMessage(b.msg, t.send, true);
    t.service.notify('permission', 7, 'lead', '허락을 기다려요', 'orchestrator', false, 0);
    t.service.notify('permission', 7, 'lead', '허락을 기다려요', 'orchestrator', false, 30_000); // too soon
    t.service.notify('permission', 7, 'lead', '허락을 기다려요', 'orchestrator', false, 61_000);
    await flush();
    expect(payloads(t, b).map((p) => p.tag)).toEqual(['attention:7', 'attention:7']);
  });
});

describe('O3 (T16): a new device is news to every other device', () => {
  /** An auth with a config dir, the service composed onto it, and devices old-1/old-2 subscribed. */
  async function arrange() {
    const t = setup();
    const auth = new StandaloneAuth({ configDir: t.dir });
    t.service.useAuth(auth);
    const old = [browser('https://push.example/old/1'), browser('https://push.example/old/2')];
    const looking: WsSend = () => undefined;
    t.service.opened(looking, 'old-1');
    t.service.onClientMessage({ ...old[0].msg, kinds: [] }, looking, true); // every notice kind off
    t.visible.add(looking); // and its page is open
    const quiet: WsSend = () => undefined;
    t.service.opened(quiet, 'old-2');
    t.service.onClientMessage(old[1].msg, quiet, true);
    const device = await SoftDevice.create();
    const session = auth.createSession('short', 'iPhone · Safari', undefined, undefined, 'phone');
    return { t, auth, old, device, session };
  }
  const payloadFor = (t: ReturnType<typeof setup>, b: ReturnType<typeof browser>) =>
    t.posts
      .filter((p) => p.url === b.msg.endpoint)
      .map((p) => JSON.parse(decrypt(p.body, b.ua, b.auth).toString()) as PushPayload);

  it('goes to every other subscribed device whatever its settings, and never to the new one', async () => {
    const { t, auth, old, device, session } = await arrange();
    // The new device subscribed too, under its session handle and under its key.
    for (const [row, endpoint] of [
      [session.handle, 'https://push.example/new/session'],
      [device.id, 'https://push.example/new/key'],
    ] as const) {
      const send: WsSend = () => undefined;
      t.service.opened(send, row);
      t.service.onClientMessage({ ...browser(endpoint).msg, kinds: [] }, send, true);
    }
    const result = auth.registerDevice(
      session,
      device.id,
      await device.publicKey(),
      'https://office.tail0000.ts.net',
      { via: 'lan', peer: '192.168.0.9' },
    );
    expect('device' in result).toBe(true);
    await flush();
    expect(t.posts.map((p) => p.url).sort()).toEqual([old[0].msg.endpoint, old[1].msg.endpoint]);
    const [first] = payloadFor(t, old[0]);
    expect(first).toMatchObject({
      title: '🔐 새 기기가 들어왔어요: iPhone · Safari',
      body: '휴대폰 · {time} · 같은 공유기(LAN)에서',
      url: '/?open=security',
      agentId: null,
      at: expect.any(Number),
    });
    expect(parseNoticeUrl(first.url)).toEqual({ open: 'security' });
    expect(payloadFor(t, old[1])).toHaveLength(1);
    // No secret and no peer address: who, what kind, when, how it came in.
    expect(JSON.stringify(first)).not.toContain('192.168');
  });

  it('a second event is its own notification, never folded into the first', async () => {
    const { t, auth, old, device, session } = await arrange();
    await auth.registerDevice(session, device.id, await device.publicKey(), 'https://office.tail0000.ts.net');
    auth.announceDevice({
      id: device.id,
      label: 'iPhone · Safari',
      kind: 'phone',
      event: 'passkey',
      at: Date.now() + 1,
    });
    await flush();
    const tags = payloadFor(t, old[1]).map((p) => p.tag);
    expect(tags).toHaveLength(2);
    expect(new Set(tags).size).toBe(2);
  });

  it('the new device\'s own name is masked and one line in the notification', async () => {
    const { t, auth, old } = await arrange();
    const rude = await SoftDevice.create();
    const rudeSession = auth.createSession('short', 'token=SECRET\nline two', undefined, undefined, 'phone');
    await auth.registerDevice(rudeSession, rude.id, await rude.publicKey(), 'https://office.tail0000.ts.net');
    await flush();
    const [payload] = payloadFor(t, old[0]);
    expect(payload.title).not.toContain('SECRET');
    expect(payload.title).not.toContain('\n');
  });

  it('a replaced key or an added passkey reaches the device\'s old browser; only the acting session is left out', async () => {
    const t = setup();
    const auth = new StandaloneAuth({ configDir: t.dir });
    t.service.useAuth(auth);
    const old = browser('https://push.example/old-browser');
    const acting = browser('https://push.example/acting-session');
    const sendOld: WsSend = () => undefined;
    const sendActing: WsSend = () => undefined;
    t.service.opened(sendOld, 'device-row-1');
    t.service.onClientMessage(old.msg, sendOld, true);
    t.service.opened(sendActing, 'session-handle-9');
    t.service.onClientMessage(acting.msg, sendActing, true);
    for (const event of ['replaced', 'passkey'] as const) {
      t.posts.length = 0;
      auth.announceDevice({
        id: 'device-row-1',
        label: 'iPhone · Safari',
        kind: 'phone',
        event,
        at: Date.now(),
        handle: 'session-handle-9',
      });
      await flush();
      expect(t.posts.map((p) => p.url), event).toEqual([old.msg.endpoint]);
    }
  });

  it('an unexpected kind or event still reads as a sentence, never "undefined"', async () => {
    const { t, auth, old } = await arrange();
    auth.announceDevice({
      id: 'x',
      label: 'Thing',
      kind: 'toaster' as never,
      event: 'strange' as never,
      via: 'orbit' as never,
      at: 1,
    });
    await flush();
    const [payload] = payloadFor(t, old[0]);
    expect(JSON.stringify(payload)).not.toContain('undefined');
    expect(payload.body).toContain('{time}');
  });

  it('push is off (no VAPID keys): nothing is sent and nothing breaks', async () => {
    const t = setup();
    fs.writeFileSync(path.join(t.dir, 'push.json'), '{"not":"a push file"}');
    const store = new PushStore(path.join(t.dir, 'push.json'));
    const service = new PushService({ store, agents: t.agents, lookedAt: () => null, describe: () => null, agentIdOf: () => null });
    expect(() => service.notifyDevice({ id: 'a', label: 'b', kind: 'phone', event: 'new', at: 1 })).not.toThrow();
  });
});

describe('U-49: a message from an agent is a push with its text', () => {
  const payloads = (t: ReturnType<typeof setup>, b: ReturnType<typeof browser>) =>
    t.posts.map((p) => JSON.parse(decrypt(p.body, b.ua, b.auth).toString()) as PushPayload);
  /** A client that knows `reply` (it sends `kindsOff`), unless `msg` overrides. */
  const subscribed = (msg: Record<string, unknown> = {}) => {
    const t = setup();
    const b = browser();
    t.service.opened(t.send, 'dev-1');
    t.service.onClientMessage(
      { ...b.msg, kinds: ['turnEnd', 'attention', 'job', 'reply'], kindsOff: [], ...msg },
      t.send,
      true,
    );
    return { t, b };
  };
  const turnEnd = (t: ReturnType<typeof setup>, id: number) =>
    t.agents.broadcast({ type: 'agentStatus', id, status: 'waiting' });

  it('a Lead turn with text: one push, titled by the Lead, with a masked preview, opening its chat', async () => {
    const { t, b } = subscribed();
    t.texts[10] =
      '배포를 끝냈어요.\n\n  token=ghp_abcdefghijklmnopqrstuvwxyz0123 로 확인했고\npassword: hunter2';
    turnEnd(t, 10);
    await flush();
    const [p, ...more] = payloads(t, b);
    expect(more).toEqual([]); // one buzz: the generic turn end is replaced
    expect(p.title).toBe('boss');
    expect(p.body).toBe('배포를 끝냈어요. token=*** 로 확인했고 password: ***');
    expect(p.agentId).toBe(10);
    expect(p.tag).toBe('reply:10');
    const target = parseNoticeUrl(p.url);
    expect(target).toMatchObject({ open: 'chat', lead: 'boss' });
    expect(JSON.stringify(p)).not.toMatch(/hunter2|abcdefghijklmnop/);
  });

  it('the preview is one line of at most 120 characters, and the payload stays small', async () => {
    expect(replyPreview('가'.repeat(500))).toHaveLength(PUSH_PREVIEW_MAX);
    expect(replyPreview('가'.repeat(500))!.endsWith('…')).toBe(true);
    // Masked before the cut: a token across the 120-character edge never shows its head.
    expect(replyPreview('가'.repeat(100) + ' 키는 ghp_' + 'a'.repeat(36))).not.toMatch(/ghp_/);
    expect(replyPreview('짧은 말')).toBe('짧은 말');
    expect(replyPreview('   \n ')).toBeNull();
    expect(replyPreview(null)).toBeNull();
    const { t, b } = subscribed();
    t.texts[10] = '긴 답 '.repeat(2000);
    turnEnd(t, 10);
    await flush();
    expect(t.posts).toHaveLength(1);
    const json = JSON.stringify(payloads(t, b)[0]);
    expect(json.length).toBeLessThan(3 * 1024);
    expect(payloads(t, b)[0].body.length).toBeLessThanOrEqual(PUSH_PREVIEW_MAX);
  });

  it('a turn with no text (only tools) keeps the plain turn-end push, once', async () => {
    const { t, b } = subscribed();
    turnEnd(t, 10);
    await flush();
    expect(payloads(t, b).map((p) => [p.title, p.body, p.tag])).toEqual([
      ['🔔 boss', '일을 마쳤어요', 'turnEnd'],
    ]);
  });

  it('three replies from one Lead in a burst are all sent under one tag (the newest replaces); two Leads never share', async () => {
    const { t, b } = subscribed();
    for (const text of ['하나', '둘', '셋']) {
      t.texts[10] = text;
      turnEnd(t, 10);
    }
    t.texts[11] = '다른 사람';
    turnEnd(t, 11);
    await flush();
    const got = payloads(t, b);
    expect(got.map((p) => p.body)).toEqual(['하나', '둘', '셋', '다른 사람']); // none lost to the cooldown or the burst window
    expect(got.map((p) => p.tag)).toEqual(['reply:10', 'reply:10', 'reply:10', 'reply:11']);
  });

  it('the same message reported twice for one turn end (hook and idle timer) is one push', async () => {
    const { t } = subscribed();
    t.texts[10] = '끝났어요';
    turnEnd(t, 10);
    turnEnd(t, 10);
    await flush();
    expect(t.posts).toHaveLength(1);
  });

  it('asks and jobs keep their rules: a message does not touch the ask cooldown or its tag', async () => {
    const { t, b } = subscribed();
    t.texts[10] = '질문이 있어요';
    turnEnd(t, 10);
    t.agents.broadcast({ type: 'agentToolPermission', id: 10 });
    await flush();
    expect(payloads(t, b).map((p) => p.tag)).toEqual(['reply:10', 'attention:10']);
  });

  it('메시지 off: the message is not pushed; the device still gets the plain turn end', async () => {
    const { t, b } = subscribed({ kinds: ['turnEnd', 'attention', 'job'], kindsOff: ['reply'] });
    t.texts[10] = '비밀 아님';
    turnEnd(t, 10);
    await flush();
    expect(payloads(t, b).map((p) => [p.title, p.body])).toEqual([['🔔 boss', '일을 마쳤어요']]);
    const both = subscribed({ kinds: ['attention', 'job'], kindsOff: ['turnEnd', 'reply'] });
    both.t.texts[10] = '둘 다 꺼짐';
    turnEnd(both.t, 10);
    await flush();
    expect(both.t.posts).toHaveLength(0);
  });

  it('a row saved before `reply` existed gets messages; its own earlier choices stay', async () => {
    // The old client: kinds listed, no kindsOff. `reply` is on until the user turns it off.
    const old = subscribed({ kinds: ['attention', 'job'], kindsOff: undefined });
    expect(old.t.store.get('dev-1')!.off).toBeUndefined();
    old.t.texts[10] = '옛 기기';
    turnEnd(old.t, 10);
    old.t.texts[11] = '완료는 꺼 둔 기기';
    turnEnd(old.t, 11);
    await flush();
    expect(payloads(old.t, old.b).map((p) => p.body)).toEqual(['옛 기기', '완료는 꺼 둔 기기']);
    // ... and its turn-end-off still holds for a turn with no text.
    delete old.t.texts[10];
    turnEnd(old.t, 10);
    await flush();
    expect(old.t.posts).toHaveLength(2);
    // A new client that turned messages off is not mistaken for an old row.
    const off = subscribed({ kinds: ['turnEnd', 'attention', 'job'], kindsOff: ['reply'] });
    expect(off.t.store.get('dev-1')!.off).toEqual(['reply']);
  });

  it('looking means a page that said so within 30 s: fresh = no push, stale = push', async () => {
    const { t } = subscribed();
    t.visible.add(t.send);
    t.looked.set(t.send, Date.now() - 5_000);
    t.texts[10] = '보고 있는 중';
    turnEnd(t, 10);
    await flush();
    expect(t.posts).toHaveLength(0); // the page shows it (an in-app notice)
    // A suspended phone page: its socket is open and its last report is old.
    t.looked.set(t.send, Date.now() - LOOKING_FRESH_MS - 1_000);
    t.texts[11] = '정지된 화면';
    turnEnd(t, 11);
    await flush();
    expect(t.posts).toHaveLength(1);
    t.visible.delete(t.send); // hidden: pushed as before
    t.texts[10] = '숨은 화면';
    turnEnd(t, 10);
    await flush();
    expect(t.posts).toHaveLength(2);
  });

  it('a room reply: titled "<room> · <member>", with the preview, opening the room', async () => {
    const { t, b } = subscribed();
    t.rooms[10] = { name: '출시팀', id: 'room0001', post: 'post0001' };
    t.rooms[11] = t.rooms[10];
    t.texts[10] = '제가 맡을게요';
    t.texts[11] = '저는 검토할게요';
    turnEnd(t, 10);
    turnEnd(t, 11);
    await flush();
    const got = payloads(t, b);
    expect(got.map((p) => [p.title, p.body, p.agentId, p.url])).toEqual([
      ['출시팀 · boss', '제가 맡을게요', null, '/?open=room&room=room0001'],
      ['출시팀 · chief', '저는 검토할게요', null, '/?open=room&room=room0001'],
    ]);
    expect(new Set(got.map((p) => p.tag)).size).toBe(2); // one slot per member in the room
  });

  it('ROOM-NOTICE: one member wrote text, the other only used tools: a preview and a short line, each naming its member', async () => {
    const { t, b } = subscribed();
    t.rooms[10] = { name: '출시팀', id: 'room0001', post: 'post0001' };
    t.rooms[11] = t.rooms[10];
    t.texts[10] = '제가 맡을게요';
    turnEnd(t, 10);
    turnEnd(t, 11);
    await flush();
    expect(payloads(t, b).map((p) => [p.title, p.body])).toEqual([
      ['출시팀 · boss', '제가 맡을게요'],
      ['🔔 출시팀 · chief', '일을 마쳤어요'],
    ]);
  });

  it('a Worker (an engine character, not a teammate) is pushed like a Lead; a teammate follows the sub-agent setting', async () => {
    // describe() answers 'orchestrator' for engine Workers (only a Claude teammate has a leadAgentId).
    const off = subscribed();
    off.t.texts[9] = '팀원의 말'; // a teammate ('scout')
    turnEnd(off.t, 9);
    await flush();
    expect(off.t.posts).toHaveLength(0);
    const on = subscribed({ subagents: true });
    on.t.texts[9] = '팀원의 말';
    turnEnd(on.t, 9);
    await flush();
    expect(payloads(on.t, on.b).map((p) => p.title)).toEqual(['scout']);
  });

  it('a transcript that cannot be read still gives the plain turn end', async () => {
    const t = setup();
    const b = browser();
    const agents = new AgentStateStore();
    const svc = new PushService({
      store: t.store,
      agents,
      lookedAt: () => null,
      describe: () => ({ name: 'boss', who: 'orchestrator', lead: true }),
      agentIdOf: () => 10,
      turn: () => Promise.reject(new Error('gone')),
      fetchFn: (async (url: string, init: RequestInit) => {
        t.posts.push({ url, body: Buffer.from(init.body as Uint8Array), headers: {} });
        return new Response(null, { status: 201 });
      }) as unknown as typeof fetch,
    });
    svc.opened(t.send, 'dev-1');
    svc.onClientMessage(b.msg, t.send, true);
    agents.broadcast({ type: 'agentStatus', id: 10, status: 'waiting' });
    await new Promise((r) => setTimeout(r, 5));
    expect(payloads(t, b).map((p) => p.title)).toEqual(['🔔 boss']);
    svc.dispose();
  });

  it('observability: a line per batch without content, counters in push.json', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { t } = subscribed();
    t.texts[10] = '내용은 로그에 없어요';
    turnEnd(t, 10);
    await flush();
    t.visible.add(t.send);
    turnEnd(t, 11); // no text, looking: nothing goes out
    const lines = log.mock.calls.map((c) => String(c[0]));
    log.mockRestore();
    expect(lines).toContain('[cld push] sent reply to 1 device(s)');
    expect(lines.join('\n')).not.toContain('내용은');
    t.service.dispose(); // the counters are saved
    const saved = JSON.parse(fs.readFileSync(path.join(t.dir, 'push.json'), 'utf-8'));
    expect(saved.stats).toMatchObject({ 'sent.reply': 1, 'skipped.turnEnd.device-looking': 1 });
  });
});
