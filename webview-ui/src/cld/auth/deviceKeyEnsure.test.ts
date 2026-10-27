/**
 * AUTH-PK2: the owner's iPhone kept its cookie but its browser's key was gone; every load
 * then wrote a fresh key under the server's id and a random one, both refused (409), and the
 * random id stayed. Now nothing is written for a session that already is a device, nothing
 * while the store can't be read, and a new key is kept only once the server took it.
 */
import { afterEach, expect, it, vi } from 'vitest';

import { t } from '../../i18n/index.js';
import { deviceStepUp } from '../shell/shellApi.js';
import { type StepUpOutcome, stepUpText } from './authApi.js';
import { ensureDeviceKey, type KeyStore, noteDeviceKeyStep, type StoredDevice } from './deviceKey.js';

afterEach(() => vi.unstubAllGlobals());

/** A store in memory; `broken`: every read fails (IndexedDB's lost connection). */
function memoryStore(broken = false) {
  const slots = new Map<string, StoredDevice>();
  const writes: string[] = [];
  const store: KeyStore = {
    get: async (slot) => {
      if (broken) throw new Error('Connection to Indexed Database server lost');
      return slots.get(slot);
    },
    put: async (slot, device) => {
      writes.push(slot);
      slots.set(slot, device);
    },
    delete: async (slot) => void slots.delete(slot),
  };
  return { store, slots, writes };
}

async function key(id: string): Promise<StoredDevice> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  return { id, privateKey: pair.privateKey };
}

/** The server: each path answers with a status; every call is recorded. */
function server(answers: Record<string, number>) {
  const calls: Array<{ url: string; body?: { deviceId?: string } }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const status = answers[url] ?? 404;
      const body = url === '/login/device/challenge' ? { nonce: 'n' } : { deviceId: 'x' };
      return new Response(status === 200 ? JSON.stringify(body) : '{}', { status });
    }),
  );
  return calls;
}

const known = { deviceId: 'phone-device-id-000000', deviceKeys: true, method: 'short' };
const fresh = { deviceId: null, deviceKeys: true, method: 'short' };

it("a session that is a known device, with this browser's key gone: nothing is written or sent", async () => {
  const { store, slots, writes } = memoryStore();
  const calls = server({ '/api/auth/device': 409 });
  expect(await ensureDeviceKey(known, () => undefined, store)).toBe('');
  expect(writes).toEqual([]);
  expect(calls).toEqual([]);
  expect(slots.size).toBe(0);
  // The step-up says why, instead of a bare false.
  expect(await deviceStepUp({ ...known, keyStepUp: true }, store)).toBe('lostKey');
});

it("another id stored (the old loop's random one): it stays as it is, nothing new is written", async () => {
  const { store, slots, writes } = memoryStore();
  const stray = await key('random-left-behind-0000');
  slots.set('key', stray);
  const calls = server({});
  expect(await ensureDeviceKey(known, () => undefined, store)).toBe('');
  expect(writes).toEqual([]);
  expect(calls).toEqual([]);
  expect(slots.get('key')).toBe(stray);
});

it("a store that can't be read is never written over", async () => {
  const { store, writes } = memoryStore(true);
  const calls = server({ '/api/auth/device': 200 });
  expect(await ensureDeviceKey(fresh, () => undefined, store)).toBe('');
  expect(writes).toEqual([]);
  expect(calls).toEqual([]);
});

it('a fresh login keeps a new key only once the server took it', async () => {
  const { store, slots } = memoryStore();
  const calls = server({ '/api/auth/device': 200 });
  await ensureDeviceKey(fresh, () => undefined, store);
  const sent = calls.find((c) => c.url === '/api/auth/device')?.body?.deviceId;
  expect(sent).toMatch(/^[A-Za-z0-9_-]{22}$/);
  expect(slots.get('key')?.id).toBe(sent);
  expect(slots.has('pending')).toBe(false);
});

it('a refused key is not kept: the stored one stays, no pending key is left behind', async () => {
  for (const status of [409, 403]) {
    const { store, slots } = memoryStore();
    const old = await key('old-device-id-0000000000');
    slots.set('key', old);
    server({ '/login/device/challenge': 200, '/api/auth/device/link': 401, '/api/auth/device': status });
    await ensureDeviceKey(fresh, () => undefined, store);
    expect(slots.get('key')).toBe(old);
    expect(slots.has('pending')).toBe(false);
  }
});

it("a stored key that no longer proves is replaced under a new id, never re-sent under its own", async () => {
  const { store, slots } = memoryStore();
  slots.set('key', await key('old-device-id-0000000000'));
  const calls = server({ '/login/device/challenge': 200, '/api/auth/device/link': 401, '/api/auth/device': 200 });
  await ensureDeviceKey(fresh, () => undefined, store);
  const sent = calls.filter((c) => c.url === '/api/auth/device').map((c) => c.body?.deviceId);
  expect(sent).toHaveLength(1);
  expect(sent[0]).not.toBe('old-device-id-0000000000');
  expect(slots.get('key')?.id).toBe(sent[0]);
});

it.each(['move', 'handoff'])("a %s registers this browser's key under the device's id", async (method) => {
  const { store, slots } = memoryStore();
  const calls = server({ '/api/auth/device': 200 });
  await ensureDeviceKey({ ...known, method }, () => undefined, store);
  expect(calls.map((c) => c.body?.deviceId)).toEqual([known.deviceId]);
  expect(slots.get('key')?.id).toBe(known.deviceId);
});

it('each step-up outcome has its note: a busy limit, a lost key, passkeys required, anything else', async () => {
  const { store, slots } = memoryStore();
  slots.set('key', await key(known.deviceId));
  server({ '/login/device/challenge': 429 });
  expect(await deviceStepUp({ ...known, keyStepUp: true }, store)).toBe('rate');
  server({ '/login/device/challenge': 200, '/api/auth/stepup/device': 403 });
  expect(await deviceStepUp({ ...known, keyStepUp: true }, store)).toBe('lostKey');
  server({ '/login/device/challenge': 200, '/api/auth/stepup/device': 200 });
  expect(await deviceStepUp({ ...known, keyStepUp: true }, store)).toBe('ok');
  expect(await deviceStepUp({ ...known, keyStepUp: false }, store)).toBe('required');
  // A session that still is no device after AuthLayer's step (read again: /api/auth/me).
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...fresh, keyStepUp: true }))));
  expect(await deviceStepUp({ ...fresh, keyStepUp: true }, store)).toBe('noKey');
  const notes: Record<StepUpOutcome, string> = {
    ok: t('stepup.needed'),
    required: t('stepup.passkeyRequired'),
    noKey: t('stepup.needed'),
    lostKey: t('stepup.lostKey'),
    rate: t('stepup.rate'),
    failed: t('stepup.needed'),
  };
  for (const [why, text] of Object.entries(notes)) expect(stepUpText(why as StepUpOutcome)).toBe(text);
});

it("10-28: a `me` read before this page's key linked (the terminal's, at load after a code login) still steps up", async () => {
  const { store, slots } = memoryStore();
  slots.set('key', await key(known.deviceId));
  // AuthLayer's step: until it ends the server still names no device for this session.
  let linked = false;
  let link!: () => void;
  noteDeviceKeyStep(new Promise<void>((resolve) => (link = resolve)).then(() => void (linked = true)));
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      urls.push(url);
      if (url === '/api/auth/me')
        return new Response(JSON.stringify({ ...(linked ? known : fresh), keyStepUp: true }));
      return new Response(JSON.stringify(url === '/login/device/challenge' ? { nonce: 'n' } : { ok: true }));
    }),
  );
  const outcome = deviceStepUp({ ...fresh, keyStepUp: true }, store);
  setTimeout(link, 10);
  expect(await outcome).toBe('ok');
  expect(urls).toEqual(['/api/auth/me', '/login/device/challenge', '/api/auth/stepup/device']);
});
