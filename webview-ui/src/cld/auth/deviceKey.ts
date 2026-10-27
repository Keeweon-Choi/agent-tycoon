/**
 * This browser's device key (T-0034): a non-extractable ECDSA P-256 key in
 * IndexedDB, next to a random device id. The private key can sign but can't
 * be read out, not even by this page's own script; the server keeps only
 * the public key. The login page uses it for the silent re-login, the app
 * registers it after any login. Any step can fail (no IndexedDB, no
 * WebCrypto outside a secure context, a private window): this browser then
 * has no device key and logs in the normal way.
 */

import { serverText } from '../serverText.js';

const DB_NAME = 'cld-gui';
const STORE = 'device';
const KEY = 'key';
/** A new key waits here until the server took it; only then does it become `key`. */
const PENDING = 'pending';

export interface StoredDevice {
  id: string;
  privateKey: CryptoKey;
}

/** What /api/auth/me says about this session's device. */
export interface DeviceState {
  /** The device this session is (a move gives one before this browser holds its key). */
  deviceId: string | null;
  /** The server keeps device keys. */
  deviceKeys: boolean;
  /** How this session logged in: only a move or a handoff brings a known device's key to this browser. */
  method: string;
}

/** Where the key is kept: this origin's IndexedDB. A read or write that fails throws. */
export interface KeyStore {
  get(slot: string): Promise<unknown>;
  put(slot: string, device: StoredDevice): Promise<void>;
  delete(slot: string): Promise<void>;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, 1);
    open.onupgradeneeded = () => open.result.createObjectStore(STORE);
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}

/** One request in one transaction; resolves once the transaction is done (a write is kept). */
async function inStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = run(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request.result as T);
      tx.onerror = tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export const idbStore: KeyStore = {
  get: (slot) => inStore('readonly', (s) => s.get(slot)),
  put: async (slot, device) => void (await inStore('readwrite', (s) => s.put(device, slot))),
  delete: async (slot) => void (await inStore('readwrite', (s) => s.delete(slot))),
};

function asDevice(value: unknown): StoredDevice | null {
  const v = value as Partial<StoredDevice> | undefined;
  return typeof v?.id === 'string' && v.privateKey instanceof CryptoKey
    ? { id: v.id, privateKey: v.privateKey }
    : null;
}

/** The device key kept here, or null (none, or it can't be read). */
export async function loadDevice(store: KeyStore = idbStore): Promise<StoredDevice | null> {
  try {
    if (!globalThis.crypto?.subtle) return null;
    return asDevice(await store.get(KEY));
  } catch {
    return null;
  }
}

/** This device was signed out: its key is gone on the server, so it goes here too. */
export async function forgetDevice(store: KeyStore = idbStore): Promise<void> {
  try {
    await store.delete(KEY);
  } catch {
    // Nothing to forget, or no storage: the next login proves or replaces it.
  }
}

/** A server nonce signed by this device's key (the proof /login/device and the passkey login take), or null. */
export async function signChallenge(
  device: StoredDevice,
): Promise<{ deviceId: string; nonce: string; signature: string } | { status: number }> {
  const challenge = await fetch('/login/device/challenge', { credentials: 'same-origin' });
  if (!challenge.ok) return { status: challenge.status };
  const { nonce } = (await challenge.json()) as { nonce: string };
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    device.privateKey,
    new TextEncoder().encode(nonce),
  );
  return { deviceId: device.id, nonce, signature: base64url(signature) };
}

/** Challenge, sign, POST to `url` (/login/device or /api/auth/device/link). */
export async function proveDevice(device: StoredDevice, url: string): Promise<Response> {
  const proof = await signChallenge(device);
  if ('status' in proof) return new Response(null, { status: proof.status });
  return postJson(url, proof);
}

/** AuthLayer's first step on this page: its /api/auth/me, then ensureDeviceKey. */
let keyStep: Promise<unknown> = Promise.resolve();

/** AuthLayer hands over that step: until it ends, a read of /api/auth/me may still name no device. */
export function noteDeviceKeyStep(step: Promise<unknown>): void {
  keyStep = step.catch(() => undefined);
}

/** Resolves once AuthLayer's first step ended (at once where there is none). */
export const deviceKeySettled = (): Promise<unknown> => keyStep;

/**
 * After any login: make sure this session is a device whose key this
 * browser holds. A key it already has is proved (the same device logging in
 * again by code); otherwise a new key is made -- under the id the server gave
 * this session when that is a move to this address or a handoff into this
 * Home-Screen app, else under a new random
 * id -- and kept only once the server took it.
 *
 * Never written: anything while the store can't be read (a lost connection
 * must not bury the key it holds), and any key for a session that already is
 * a device whose key is not here -- the server refuses that from a cookie
 * (409), so the step-up says what to do instead (`deviceStepUp`: lostKey).
 * `ownId` hears each id before it is used, so this device can skip the
 * new-device notice about itself. Resolves to a sentence for the user, or ''.
 */
export async function ensureDeviceKey(
  me: DeviceState,
  ownId: (id: string) => void,
  store: KeyStore = idbStore,
): Promise<string> {
  if (!me.deviceKeys || !globalThis.crypto?.subtle) return '';
  try {
    const stored = asDevice(await store.get(KEY));
    if (stored && stored.id === me.deviceId) return '';
    if (me.deviceId && me.method !== 'move' && me.method !== 'handoff') return '';
    if (stored && !me.deviceId) {
      ownId(stored.id);
      const linked = await proveDevice(stored, '/api/auth/device/link');
      // Busy (429) or offline: next time, rather than a second key now.
      if (linked.ok || linked.status !== 401) return '';
    }
    const id = me.deviceId ?? newDeviceId();
    ownId(id);
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
      'sign',
      'verify',
    ]);
    const { kty, crv, x, y } = await crypto.subtle.exportKey('jwk', pair.publicKey);
    // Kept aside first, and read back: a browser that can't keep a key would
    // register a new device on every load, and a key the server knows but
    // this browser lost is only a dead row.
    const device = { id, privateKey: pair.privateKey };
    await store.put(PENDING, device);
    if (asDevice(await store.get(PENDING))?.id !== id) return '';
    const res = await postJson('/api/auth/device', { deviceId: id, publicKey: { kty, crv, x, y } });
    if (res.ok) await store.put(KEY, device);
    await store.delete(PENDING);
    if (res.ok || res.status === 409) return '';
    const body = (await res.json().catch(() => ({}))) as { error?: unknown };
    return typeof body.error === 'string' ? serverText(body as { error: string }) : '';
  } catch {
    // No device key here: logins still work, without the silent re-login.
  }
  return '';
}

function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** 16 random bytes: what the server takes as a device id. */
function newDeviceId(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(16)));
}

function base64url(data: ArrayBuffer | Uint8Array): string {
  let text = '';
  for (const byte of new Uint8Array(data)) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
