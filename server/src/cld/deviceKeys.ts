/**
 * Silent device keys (T-0034). After any login the web app makes a
 * non-extractable ECDSA P-256 key and keeps it in IndexedDB with a random
 * device id; the host keeps only the public key (JWK), here, in
 * ~/.config/cld-gui/devices.json (0600, atomic writes, never written over
 * when it can't be read). A device whose session is gone signs a
 * single-use 60 s nonce and gets a new session with no input.
 *
 * - One key per device id: the same id registering again replaces its key
 *   (a move to another address, a lost key), so it stays one row.
 * - At most 20 devices; a key unused for 180 days (sliding) is dropped.
 * - A key works only on the origin it was registered on.
 * - "패스키(생체 인증) 필수" (`passkeyRequired`) turns logins by key off;
 *   keys are kept, and still say which device a session is.
 */
import * as crypto from 'crypto';

import { koText } from '../../../core/src/cld/serverText.js';
import type { DeviceKind } from './auth.js';
import { readJson, writeJsonAtomic } from './jsonFile.js';

const CHALLENGE_TTL_MS = 60_000;
const MAX_CHALLENGES = 200;
export const MAX_DEVICES = 20;
export const DEVICE_UNUSED_MS = 180 * 24 * 60 * 60 * 1000;
/** What the web app makes: 16 random bytes, base64url (longer is fine). */
const DEVICE_ID = /^[A-Za-z0-9_-]{22,64}$/;
/** A P-256 coordinate: 32 bytes, base64url. */
const COORDINATE = /^[A-Za-z0-9_-]{43}$/;

export const DEVICE_ERRORS = {
  full: koText('devices_full', { max: MAX_DEVICES }),
  taken: koText('device_id_taken'),
  bad: koText('device_key_invalid'),
  unreadable: koText('devices_unreadable'),
} as const;

export interface PublicJwk {
  kty: 'EC';
  crv: 'P-256';
  x: string;
  y: string;
}

export interface DeviceKey {
  /** Chosen by the device (random); stable across logins and moves. */
  id: string;
  label: string;
  /** O1: a name the owner gave it; shown instead of `label`. */
  nickname?: string;
  /** O2: derived from the User-Agent when this key was first registered. */
  kind?: DeviceKind;
  publicKey: PublicJwk;
  /** Where it was registered, e.g. https://office.tail0000.ts.net; it logs in there only. */
  origin: string;
  createdAt: number;
  lastUsedAt: number;
}

interface DeviceFile {
  v: 1;
  passkeyRequired: boolean;
  devices: DeviceKey[];
}

export type RegisterResult =
  { device: DeviceKey; isNew: boolean } | { status: number; error: string };

export class DeviceKeys {
  private data: DeviceFile;
  /** devices.json could not be read: device keys stay off and the file is kept as it is. */
  readonly broken: boolean;
  private readonly challenges = new Map<string, { origin: string; expiresAt: number }>();

  constructor(private readonly file: string) {
    let data: DeviceFile | null = null;
    let broken = false;
    try {
      const parsed = readJson(file);
      if (parsed !== null && !isDeviceFile(parsed)) throw new Error('unknown shape');
      data = parsed as DeviceFile | null;
    } catch {
      broken = true;
      console.warn(`[cld auth] ${file} is unreadable; device keys stay off until it is fixed`);
    }
    this.broken = broken;
    this.data = data ?? { v: 1, passkeyRequired: false, devices: [] };
    this.prune();
  }

  get passkeyRequired(): boolean {
    return this.data.passkeyRequired;
  }

  setPasskeyRequired(on: boolean): boolean {
    if (this.broken) return false;
    this.data.passkeyRequired = on;
    this.save();
    return true;
  }

  list(): readonly DeviceKey[] {
    this.prune();
    return this.data.devices;
  }

  get(id: string): DeviceKey | undefined {
    return this.list().find((d) => d.id === id);
  }

  remove(id: string): boolean {
    const left = this.data.devices.filter((d) => d.id !== id);
    if (this.broken || left.length === this.data.devices.length) return false;
    this.data.devices = left;
    this.save();
    return true;
  }

  setNickname(id: string, nickname: string): boolean {
    const device = this.get(id);
    if (!device || this.broken) return false;
    device.nickname = nickname;
    this.save();
    return true;
  }

  /** The device was used (its session, or its key): it is kept another 180 days. */
  touch(id: string): void {
    const device = this.get(id);
    if (!device || this.broken) return;
    device.lastUsedAt = Date.now();
    this.save();
  }

  /**
   * Register a device's public key. A known id is replaced only when
   * `mayReplace` (the asking session already belongs to that device);
   * otherwise it is someone else's. A new id needs a free slot.
   */
  register(
    id: unknown,
    publicKey: unknown,
    origin: string,
    label: string,
    mayReplace: boolean,
    kind: DeviceKind = 'unknown',
  ): RegisterResult {
    if (this.broken) return { status: 503, error: DEVICE_ERRORS.unreadable };
    const jwk = publicJwk(publicKey);
    // The origin comes from the Host header; the device list parses it.
    if (typeof id !== 'string' || !DEVICE_ID.test(id) || !jwk || !isOrigin(origin))
      return { status: 400, error: DEVICE_ERRORS.bad };
    const now = Date.now();
    const known = this.get(id);
    if (known && !mayReplace) return { status: 409, error: DEVICE_ERRORS.taken };
    if (known) {
      Object.assign(known, { publicKey: jwk, origin, lastUsedAt: now, kind });
      this.save();
      return { device: known, isNew: false };
    }
    if (this.data.devices.length >= MAX_DEVICES) return { status: 403, error: DEVICE_ERRORS.full };
    const device: DeviceKey = {
      id,
      label,
      kind,
      publicKey: jwk,
      origin,
      createdAt: now,
      lastUsedAt: now,
    };
    this.data.devices.push(device);
    this.save();
    return { device, isNew: true };
  }

  /** A nonce to sign: single use, 60 s, for this origin only. */
  challenge(origin: string): { nonce: string; expiresIn: number } {
    const nonce = crypto.randomBytes(32).toString('base64url');
    this.challenges.set(nonce, { origin, expiresAt: Date.now() + CHALLENGE_TTL_MS });
    // Public endpoint: never more than 200 open, oldest dropped.
    for (const key of this.challenges.keys()) {
      if (this.challenges.size <= MAX_CHALLENGES) break;
      this.challenges.delete(key);
    }
    return { nonce, expiresIn: CHALLENGE_TTL_MS / 1000 };
  }

  /**
   * One proof of a device key. The nonce is used up first, right or wrong;
   * it must be live and issued to `origin`, the device registered on
   * `origin`, and the signature over the nonce good. The device, or null.
   */
  verify(id: unknown, nonce: unknown, signature: unknown, origin: string): DeviceKey | null {
    if (typeof nonce !== 'string') return null;
    const challenge = this.challenges.get(nonce);
    this.challenges.delete(nonce);
    if (!challenge || challenge.expiresAt <= Date.now() || challenge.origin !== origin) return null;
    const device = typeof id === 'string' ? this.get(id) : undefined;
    if (!device || device.origin !== origin || typeof signature !== 'string') return null;
    if (!verifySignature(device.publicKey, Buffer.from(nonce), Buffer.from(signature, 'base64url')))
      return null;
    this.touch(device.id);
    return device;
  }

  /** Keys unused for 180 days go. */
  private prune(): void {
    const now = Date.now();
    const kept = this.data.devices.filter((d) => now - d.lastUsedAt < DEVICE_UNUSED_MS);
    if (kept.length === this.data.devices.length || this.broken) return;
    this.data.devices = kept;
    this.save();
  }

  /** A failed write is logged; the next write carries the change. */
  private save(): void {
    try {
      writeJsonAtomic(this.file, this.data);
    } catch (err) {
      console.error(`[cld auth] could not write ${this.file}: ${String(err)}`);
    }
  }
}

/**
 * ECDSA P-256 with SHA-256. WebCrypto signs IEEE P1363 (r‖s, 64 bytes); other
 * signers use DER. Both are taken: the wrong decoding only fails.
 */
export function verifySignature(jwk: PublicJwk, data: Buffer, signature: Buffer): boolean {
  const key = crypto.createPublicKey({ key: { ...jwk }, format: 'jwk' });
  for (const dsaEncoding of ['ieee-p1363', 'der'] as const) {
    try {
      if (crypto.verify('sha256', data, { key, dsaEncoding }, signature)) return true;
    } catch {
      // Not this encoding.
    }
  }
  return false;
}

/** A P-256 public key as a JWK, or null. Never a private key; the point must be on the curve. */
function publicJwk(raw: unknown): PublicJwk | null {
  const k = raw as Record<string, unknown> | null;
  if (typeof k !== 'object' || k === null || 'd' in k) return null;
  if (k.kty !== 'EC' || k.crv !== 'P-256') return null;
  if (typeof k.x !== 'string' || typeof k.y !== 'string') return null;
  if (!COORDINATE.test(k.x) || !COORDINATE.test(k.y)) return null;
  const jwk: PublicJwk = { kty: 'EC', crv: 'P-256', x: k.x, y: k.y };
  try {
    crypto.createPublicKey({ key: { ...jwk }, format: 'jwk' });
  } catch {
    return null;
  }
  return jwk;
}

/** `http(s)://host[:port]` exactly as URL would print it. */
function isOrigin(origin: string): boolean {
  try {
    return new URL(origin).origin === origin;
  } catch {
    return false;
  }
}

function isDeviceFile(data: unknown): data is DeviceFile {
  const file = data as DeviceFile | null;
  return (
    file?.v === 1 &&
    typeof file.passkeyRequired === 'boolean' &&
    Array.isArray(file.devices) &&
    file.devices.every(
      (d: DeviceKey | null) =>
        typeof d?.id === 'string' &&
        DEVICE_ID.test(d.id) &&
        typeof d.label === 'string' &&
        (d.nickname === undefined || typeof d.nickname === 'string') &&
        (d.kind === undefined || ['phone', 'tablet', 'desktop', 'unknown'].includes(d.kind)) &&
        typeof d.origin === 'string' &&
        publicJwk(d.publicKey) !== null &&
        [d.createdAt, d.lastUsedAt].every(Number.isFinite),
    )
  );
}
