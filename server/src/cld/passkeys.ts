/**
 * Passkeys (T-0022): WebAuthn through @simplewebauthn/server (pinned), never
 * hand-rolled. The relying party is the request's own host -- the `ts.net`
 * name, or `localhost` behind an SSH tunnel -- and every RP ID keeps its own
 * credential list in ~/.config/cld-gui/passkeys.json (0600, atomic writes).
 * Discoverable credentials with user verification (Face ID, Windows Hello);
 * the signature counter is checked by the library and stored after each login.
 */
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import * as crypto from 'crypto';
import * as fs from 'fs';

import { koText } from '../../../core/src/cld/serverText.js';
import { readJson, writeJsonAtomic } from './jsonFile.js';

const CEREMONY_TTL_MS = 2 * 60_000;
const MAX_CEREMONIES = 200;
/** S5: a passkey tied to no device is deleted this long after it became so. */
export const UNBOUND_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface RelyingParty {
  rpID: string;
  origin: string;
}

interface StoredPasskey {
  id: string;
  /** COSE public key, base64url. */
  publicKey: string;
  counter: number;
  transports?: string[];
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
  /**
   * S5: the device registration this passkey belongs to, or null ("기기 미지정":
   * every v1 record, or one made by a session with no device key). Revoking the
   * device revokes the passkey.
   */
  deviceId: string | null;
  /** Set while `deviceId` is null: when it became unbound; the 30 days run from here. */
  unboundSince?: number;
}

interface PasskeyFile {
  v: 2;
  /** WebAuthn user handle: one user, the host's owner. */
  userId: string;
  byRp: Record<string, StoredPasskey[]>;
  /**
   * S5: credential ids of revoked devices' passkeys. Synced copies of a
   * credential share its id, so one entry stops them all, and the id can't be
   * registered again.
   */
  revoked: string[];
}

export interface PasskeyView {
  id: string;
  rpID: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
  deviceId: string | null;
  /** When an unbound passkey is deleted. */
  expiresAt?: number;
}

interface Ceremony extends RelyingParty {
  kind: 'register' | 'login';
  challenge: string;
  /** Registration only: the session that asked for it. */
  sessionId?: string;
  expiresAt: number;
}

export class Passkeys {
  private data: PasskeyFile;
  /** passkeys.json could not be read: refuse to overwrite it. */
  private readonly broken: boolean;
  private readonly ceremonies = new Map<string, Ceremony>();

  constructor(private readonly file: string) {
    let data: PasskeyFile | null = null;
    let broken = false;
    try {
      const parsed = readJson(file) as { v?: unknown } | null;
      if (parsed !== null && !isPasskeyFile(parsed)) throw new Error('unknown shape');
      data = parsed === null ? null : parsed.v === 1 ? migrateV1(file, parsed) : parsed;
    } catch {
      // Unreadable, unknown, or a v1 that could not be backed up and rewritten:
      // the file stays exactly as it is, and passkeys stay off.
      broken = true;
      console.warn(`[cld auth] ${file} is unreadable; passkeys stay off until it is fixed`);
    }
    this.broken = broken;
    this.data = data ?? {
      v: 2,
      userId: crypto.randomBytes(32).toString('base64url'),
      byRp: {},
      revoked: [],
    };
    this.prune();
  }

  /** Whether any passkey exists for this RP ID (the login page offers the button then). */
  has(rpID: string): boolean {
    this.prune();
    return (this.data.byRp[rpID]?.length ?? 0) > 0;
  }

  list(): PasskeyView[] {
    this.prune();
    return Object.entries(this.data.byRp).flatMap(([rpID, keys]) =>
      keys.map((key) => view(key, rpID)),
    );
  }

  /** How many passkeys a device's revocation would end. */
  countFor(deviceId: string): number {
    return this.list().filter((key) => key.deviceId === deviceId).length;
  }

  /** Tie a passkey to a device (assigning it, or the device proved itself at login). */
  bind(id: string, deviceId: string): boolean {
    const key = this.find(id);
    if (!key || this.broken) return false;
    key.deviceId = deviceId;
    delete key.unboundSince;
    this.save();
    return true;
  }

  /**
   * S5: a device was revoked. Its passkeys are deleted and their credential
   * ids denied for good, so a synced copy on another device stops working
   * too. The ids go back so open sessions made with them can end.
   */
  revokeDevice(deviceId: string): string[] {
    if (this.broken) return [];
    const ids: string[] = [];
    for (const [rpID, keys] of Object.entries(this.data.byRp)) {
      const left = keys.filter((k) => k.deviceId !== deviceId);
      ids.push(...keys.filter((k) => k.deviceId === deviceId).map((k) => k.id));
      if (left.length) this.data.byRp[rpID] = left;
      else delete this.data.byRp[rpID];
    }
    if (ids.length) {
      this.data.revoked.push(...ids.filter((id) => !this.data.revoked.includes(id)));
      this.save();
    }
    return ids;
  }

  rename(id: string, name: string): boolean {
    const key = this.find(id);
    if (!key || this.broken) return false;
    key.name = name;
    this.save();
    return true;
  }

  remove(id: string): boolean {
    if (this.broken) return false;
    for (const [rpID, keys] of Object.entries(this.data.byRp)) {
      const left = keys.filter((k) => k.id !== id);
      if (left.length === keys.length) continue;
      if (left.length) this.data.byRp[rpID] = left;
      else delete this.data.byRp[rpID];
      this.save();
      return true;
    }
    return false;
  }

  /**
   * A passkey for `device` (the session's registered device, or null). Each
   * device gets its own WebAuthn user and excludes only its own credentials: a
   * synced authenticator (iCloud Keychain, Google Password Manager) refuses a
   * registration that excludes a credential it holds, and replaces one under
   * the same user, so one shared user let only one device ever have a passkey.
   */
  async registrationOptions(
    rp: RelyingParty,
    sessionId: string,
    device: { id: string; label: string; nickname?: string } | null,
  ) {
    const name = device ? `cld-gui · ${device.nickname ?? device.label}` : 'cld-gui';
    const options = await generateRegistrationOptions({
      rpName: 'cld-gui',
      rpID: rp.rpID,
      userName: name,
      userDisplayName: name,
      userID: device
        ? crypto.createHash('sha256').update(`${this.data.userId}:${device.id}`).digest()
        : Buffer.from(this.data.userId, 'base64url'),
      attestationType: 'none',
      excludeCredentials: (this.data.byRp[rp.rpID] ?? [])
        .filter((key) => key.deviceId === (device?.id ?? null))
        .map(({ id, transports }) => ({ id, transports })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    return {
      ceremony: this.begin({ ...rp, kind: 'register', challenge: options.challenge, sessionId }),
      options,
    };
  }

  /** Verify a registration; the stored passkey's view, or an error sentence. */
  async register(
    ceremonyId: unknown,
    response: unknown,
    sessionId: string,
    name: string,
    deviceId: string | null,
  ): Promise<PasskeyView | { error: string }> {
    if (this.broken) return { error: koText('passkeys_unreadable') };
    const ceremony = this.take(ceremonyId, 'register');
    if (!ceremony || ceremony.sessionId !== sessionId)
      return { error: koText('passkey_time_up') };
    if ((this.data.byRp[ceremony.rpID] ?? []).filter((k) => k.deviceId === deviceId).length >= MAX_PER_DEVICE)
      return { error: PASSKEY_CAP };
    try {
      const { verified, registrationInfo } = await verifyRegistrationResponse({
        response: response as RegistrationResponseJSON,
        expectedChallenge: ceremony.challenge,
        expectedOrigin: ceremony.origin,
        expectedRPID: ceremony.rpID,
        requireUserVerification: true,
      });
      if (!verified) return { error: koText('passkey_unverified') };
      const { credential } = registrationInfo;
      const stored: StoredPasskey = {
        id: credential.id,
        publicKey: Buffer.from(credential.publicKey).toString('base64url'),
        counter: credential.counter,
        transports: credential.transports,
        name,
        createdAt: Date.now(),
        lastUsedAt: null,
        deviceId,
        ...(deviceId ? {} : { unboundSince: Date.now() }),
      };
      // S5: a revoked device's credential never comes back, however it is offered.
      if (this.data.revoked.includes(stored.id)) return { error: REVOKED_CREDENTIAL };
      const keys = (this.data.byRp[ceremony.rpID] ??= []);
      if (keys.some((k) => k.id === stored.id)) return { error: koText('passkey_registered') };
      keys.push(stored);
      this.save();
      return view(stored, ceremony.rpID);
    } catch {
      return { error: koText('passkey_unverified') };
    }
  }

  /**
   * `stored`: list this RP's stored credentials (a session's step-up), so an
   * authenticator still holding a deleted one (a synced copy) can't pick it.
   * Without it -- the login page -- the authenticator offers its own passkeys.
   */
  async loginOptions(rp: RelyingParty, sessionId?: string, stored = false) {
    const options = await generateAuthenticationOptions({
      rpID: rp.rpID,
      userVerification: 'required',
      ...(stored
        ? {
            allowCredentials: (this.data.byRp[rp.rpID] ?? []).map(({ id, transports }) => ({ id, transports })),
          }
        : {}),
    });
    return {
      ceremony: this.begin({ ...rp, kind: 'login', challenge: options.challenge, sessionId }),
      options,
    };
  }

  /** Verify a login; the passkey used, or null. The new counter is saved. */
  async login(
    ceremonyId: unknown,
    response: unknown,
    sessionId?: string,
  ): Promise<PasskeyView | null> {
    const ceremony = this.take(ceremonyId, 'login');
    const credentialId = (response as { id?: unknown } | null)?.id;
    if (!ceremony || ceremony.sessionId !== sessionId || typeof credentialId !== 'string')
      return null;
    this.prune();
    if (this.data.revoked.includes(credentialId)) return null;
    // Only this RP ID's list: a passkey made on localhost never logs in on ts.net.
    const key = (this.data.byRp[ceremony.rpID] ?? []).find((k) => k.id === credentialId);
    if (!key) return null;
    try {
      const { verified, authenticationInfo } = await verifyAuthenticationResponse({
        response: response as AuthenticationResponseJSON,
        expectedChallenge: ceremony.challenge,
        expectedOrigin: ceremony.origin,
        expectedRPID: ceremony.rpID,
        credential: {
          id: key.id,
          publicKey: Buffer.from(key.publicKey, 'base64url'),
          counter: key.counter,
          transports: key.transports,
        },
        requireUserVerification: true,
      });
      if (!verified) return null;
      key.counter = authenticationInfo.newCounter;
      key.lastUsedAt = Date.now();
      if (!this.broken) this.save();
      return view(key, ceremony.rpID);
    } catch {
      // Includes a counter that did not go up: a cloned authenticator or a replay.
      return null;
    }
  }

  /** Unbound passkeys older than 30 days go. */
  private prune(): void {
    const now = Date.now();
    let changed = false;
    for (const [rpID, keys] of Object.entries(this.data.byRp)) {
      const left = keys.filter((k) => k.deviceId !== null || expiry(k) > now);
      if (left.length === keys.length) continue;
      changed = true;
      if (left.length) this.data.byRp[rpID] = left;
      else delete this.data.byRp[rpID];
    }
    if (!changed || this.broken) return;
    try {
      this.save();
    } catch (err) {
      console.warn(`[cld auth] could not write ${this.file}: ${String(err)}`);
    }
  }

  private find(id: string): StoredPasskey | undefined {
    return Object.values(this.data.byRp)
      .flat()
      .find((k) => k.id === id);
  }

  private begin(ceremony: Omit<Ceremony, 'expiresAt'>): string {
    const id = crypto.randomBytes(18).toString('base64url');
    this.ceremonies.set(id, { ...ceremony, expiresAt: Date.now() + CEREMONY_TTL_MS });
    // Public endpoint: never more than 200 open ceremonies, oldest dropped.
    for (const key of this.ceremonies.keys()) {
      if (this.ceremonies.size <= MAX_CEREMONIES) break;
      this.ceremonies.delete(key);
    }
    return id;
  }

  /** Single use: a ceremony is gone after its first answer, right or wrong. */
  private take(id: unknown, kind: Ceremony['kind']): Ceremony | undefined {
    if (typeof id !== 'string') return undefined;
    const ceremony = this.ceremonies.get(id);
    this.ceremonies.delete(id);
    if (!ceremony || ceremony.kind !== kind || ceremony.expiresAt <= Date.now()) return undefined;
    return ceremony;
  }

  private save(): void {
    writeJsonAtomic(this.file, this.data);
  }
}

/** Passkeys one device may keep at one address. */
export const MAX_PER_DEVICE = 5;
export const PASSKEY_CAP = koText('passkey_cap', { max: MAX_PER_DEVICE });

export const REVOKED_CREDENTIAL = koText('passkey_revoked');

const expiry = (key: StoredPasskey) => (key.unboundSince ?? key.createdAt) + UNBOUND_TTL_MS;

function view(key: StoredPasskey, rpID: string): PasskeyView {
  const { id, name, createdAt, lastUsedAt, deviceId } = key;
  return {
    id,
    rpID,
    name,
    createdAt,
    lastUsedAt,
    deviceId,
    ...(deviceId === null ? { expiresAt: expiry(key) } : {}),
  };
}

function isPasskeyFile(data: { v?: unknown }): data is PasskeyFile | PasskeyFileV1 {
  const file = data as { v?: unknown; userId?: unknown; byRp?: unknown; revoked?: unknown };
  return (
    (file.v === 1 || file.v === 2) &&
    typeof file.userId === 'string' &&
    typeof file.byRp === 'object' &&
    file.byRp !== null &&
    (file.v === 1 ||
      (Array.isArray(file.revoked) && file.revoked.every((id) => typeof id === 'string')))
  );
}

interface PasskeyFileV1 {
  v: 1;
  userId: string;
  byRp: Record<string, Omit<StoredPasskey, 'deviceId' | 'unboundSince'>[]>;
}

/**
 * S5: v1 records know no device. Keep the v1 file beside the new one (never
 * over an existing copy), then write v2 with every passkey "기기 미지정"; the
 * 30 days run from now. Throws when either step fails, which leaves the
 * original file untouched and passkeys off.
 */
function migrateV1(file: string, old: PasskeyFileV1): PasskeyFile {
  // A copy that is already there (an older migration, or a restored file) is never overwritten.
  for (let n = 0; ; n++) {
    const backup = `${file}.v1${n ? `.${Date.now()}.${n}` : ''}.bak`;
    try {
      fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || n >= 5) throw err;
    }
  }
  const now = Date.now();
  const migrated: PasskeyFile = {
    v: 2,
    userId: old.userId,
    revoked: [],
    byRp: Object.fromEntries(
      Object.entries(old.byRp).map(([rpID, keys]) => [
        rpID,
        keys.map((key) => ({ ...key, deviceId: null, unboundSince: now })),
      ]),
    ),
  };
  writeJsonAtomic(file, migrated);
  console.log(`[cld auth] ${file} migrated to v2; the v1 file is kept beside it as ${file}.v1*.bak`);
  return migrated;
}
