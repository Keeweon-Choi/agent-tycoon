/**
 * Test helpers for the login tests (T-0022, T-0034): a fake dist/ (app +
 * login page), a standalone server on it, the headers tailscaled adds, a
 * software passkey authenticator and a software device key. Never used at
 * runtime.
 */
import { type CBORType, encodeCBOR } from '@levischuck/tiny-cbor';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { AgentStateStore } from '../agentStateStore.js';
import { createHttpServer, type HttpServerHandle } from '../httpServer.js';
import { StandaloneAuth } from './auth.js';
import { cldHooks } from './hooks.js';
import type { ShellRegistry } from './shell/registry.js';

export const TOKEN = 'test-server-token';
export const HOST = 'office.tail0000.ts.net';
export const OWNER = 'owner@localhost';

/** What tailscaled's HTTP proxy adds to a Funnel request (serve.go). */
export const funnel = (ip = '203.0.113.7') => ({
  host: HOST,
  'tailscale-funnel-request': '?1',
  'x-forwarded-for': ip,
  'x-forwarded-proto': 'https',
});

/** What it adds to a tailnet request from the owner's device. */
export const tailnet = {
  host: HOST,
  'tailscale-user-login': OWNER,
  'x-forwarded-for': '100.64.0.9',
};

/** A dist/ with webview/ (the app) and login/ (the login page's files). */
export function makeFakeDist(): { root: string; staticDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cld-dist-'));
  const staticDir = path.join(root, 'webview');
  const files: Record<string, string> = {
    'webview/index.html': '<!doctype html><div id="root"></div>',
    'webview/manifest.webmanifest': '{}',
    'webview/sw.js': 'self.addEventListener("install", () => {});',
    'webview/icons/icon-256.png': 'png',
    'webview/fonts/FSPixelSansUnicode-Regular.ttf': 'ttf',
    'webview/fonts/galmuri/Galmuri11.woff2': 'woff2',
    'webview/fonts/galmuri/Galmuri11-Bold.woff2': 'woff2',
    'webview/fonts/galmuri/OFL.txt': 'ofl',
    'webview/assets/index-abc.js': 'app()',
    'webview/assets/sheet.png': 'png',
    'login/login.js': 'login()',
    'login/login.css': 'main{}',
  };
  for (const [file, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), body);
  }
  return { root, staticDir };
}

export interface AuthServer extends HttpServerHandle {
  auth: StandaloneAuth;
  /** Everything broadcast to logged-in clients. */
  broadcasts: Array<Record<string, unknown>>;
}

/**
 * A standalone server (no listener unless `listen`) behind the fake serve name. `configDir`
 * turns passkeys on (a temp dir, never ~/.config/cld-gui).
 */
export async function startAuthServer(
  staticDir: string,
  options: {
    configDir?: string;
    allowApprovalRequests?: boolean;
    allowedHosts?: string[];
    allowTerminal?: boolean;
    shellRegistry?: ShellRegistry;
    shellHome?: string;
    listen?: boolean;
    /** Exercise legacy HTTP options without restoring their authentication effect. */
    legacyTailscaleTrust?: boolean;
  } = {},
): Promise<AuthServer> {
  const auth = new StandaloneAuth(options);
  // A cld route that would answer 200 if the gate let the request through.
  cldHooks.registerRoutes = (app) => {
    app.get('/cld/characters/:file', async () => 'sheet');
  };
  const store = new AgentStateStore();
  const broadcasts: Array<Record<string, unknown>> = [];
  store.on('broadcast', (message: Record<string, unknown>) => broadcasts.push(message));
  const server = await createHttpServer({
    embedded: false,
    host: '127.0.0.1',
    token: TOKEN,
    store,
    staticDir,
    listen: options.listen ?? false,
    allowedHosts: options.allowedHosts ?? [HOST],
    ...(options.legacyTailscaleTrust ? { trustedTailscaleUsers: [OWNER] } : {}),
    auth,
    allowTerminal: options.allowTerminal,
    shellRegistry: options.shellRegistry,
    shellHome: options.shellHome,
  });
  return { ...server, auth, broadcasts };
}

export async function stopAuthServer(server: AuthServer | undefined): Promise<void> {
  await server?.app.close();
  delete cldHooks.registerRoutes;
}

/** S1: a fresh step-up on a session (a cookie header or a bare id), as a device-key or passkey proof leaves it. */
export function proveSession(auth: StandaloneAuth, cookie: string): string {
  const session = auth.session(/cld_session=([^;\s]+)/.exec(cookie)?.[1] ?? cookie);
  if (!session) throw new Error('no such session');
  session.shellProofAt = Date.now();
  return cookie;
}

/** `cld_session=…` from a Set-Cookie header, for the next request. */
export function cookieOf(setCookie: string | string[] | undefined): string {
  return String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0];
}

/** A form POST /login, as the login page sends it. */
export const formLogin = (code: string, headers: Record<string, string> = funnel()) => ({
  method: 'POST' as const,
  url: '/login',
  headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
  payload: new URLSearchParams({ code }).toString(),
});

/**
 * A software passkey authenticator (ES256, "none" attestation): what
 * navigator.credentials.create()/get() would return. CBOR from
 * @levischuck/tiny-cbor, the encoder @simplewebauthn/server itself uses.
 */
export class SoftAuthenticator {
  private readonly keys: Array<{
    id: Buffer;
    rpID: string;
    privateKey: crypto.KeyObject;
    counter: number;
    userHandle: string;
  }> = [];

  /** `credentialId`: offer an id again (a synced copy, or a revoked one coming back). */
  register(
    options: { rp: { id?: string }; challenge: string; user: { id: string } },
    origin: string,
    credentialId?: string,
  ): Record<string, unknown> {
    const rpID = options.rp.id ?? '';
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' });
    const cose = encodeCBOR(
      new Map<number, CBORType>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, Buffer.from(jwk.x ?? '', 'base64url')],
        [-3, Buffer.from(jwk.y ?? '', 'base64url')],
      ]),
    );
    const id = credentialId ? Buffer.from(credentialId, 'base64url') : crypto.randomBytes(16);
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(id.length);
    const authData = Buffer.concat([
      sha256(rpID),
      Buffer.from([0x45]), // user present, user verified, attested credential data
      Buffer.alloc(4), // counter 0
      Buffer.alloc(16), // AAGUID
      idLength,
      id,
      Buffer.from(cose),
    ]);
    const attestationObject = encodeCBOR(
      new Map<string, CBORType>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]),
    );
    this.keys.push({ id, rpID, privateKey, counter: 0, userHandle: options.user.id });
    return {
      id: id.toString('base64url'),
      rawId: id.toString('base64url'),
      type: 'public-key',
      response: {
        clientDataJSON: clientDataJSON('webauthn.create', options.challenge, origin),
        attestationObject: Buffer.from(attestationObject).toString('base64url'),
        transports: ['internal'],
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }

  /** An assertion with this RP ID's passkey; `counter` overrides the next value (replays). */
  login(
    options: { rpId?: string; challenge: string },
    origin: string,
    counter?: number,
  ): Record<string, unknown> {
    const key = this.keys.find((k) => k.rpID === options.rpId);
    if (!key) throw new Error(`no passkey for ${options.rpId}`);
    key.counter = counter ?? key.counter + 1;
    const count = Buffer.alloc(4);
    count.writeUInt32BE(key.counter);
    const authData = Buffer.concat([sha256(key.rpID), Buffer.from([0x05]), count]);
    const clientData = clientDataJSON('webauthn.get', options.challenge, origin);
    const signature = crypto.sign(
      'sha256',
      Buffer.concat([authData, sha256(Buffer.from(clientData, 'base64url'))]),
      key.privateKey,
    );
    return {
      id: key.id.toString('base64url'),
      rawId: key.id.toString('base64url'),
      type: 'public-key',
      response: {
        clientDataJSON: clientData,
        authenticatorData: authData.toString('base64url'),
        signature: signature.toString('base64url'),
        userHandle: key.userHandle,
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    };
  }
}

/**
 * A browser's device key (T-0034), made the way the web app makes it:
 * WebCrypto ECDSA P-256, not extractable, signing in IEEE P1363.
 */
export class SoftDevice {
  private constructor(
    readonly id: string,
    private readonly keys: crypto.webcrypto.CryptoKeyPair,
  ) {}

  /** A new key; `id` keeps a device's id (a move: same device, new key). */
  static async create(id = crypto.randomBytes(16).toString('base64url')): Promise<SoftDevice> {
    const { subtle } = crypto.webcrypto;
    const keys = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, [
      'sign',
      'verify',
    ]);
    return new SoftDevice(id, keys);
  }

  async publicKey(): Promise<Record<string, unknown>> {
    const { kty, crv, x, y } = await crypto.webcrypto.subtle.exportKey('jwk', this.keys.publicKey);
    return { kty, crv, x, y };
  }

  async sign(nonce: string): Promise<string> {
    const signature = await crypto.webcrypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      this.keys.privateKey,
      Buffer.from(nonce),
    );
    return Buffer.from(signature).toString('base64url');
  }
}

/**
 * S5: a logged-in session that IS a registered device (what a passkey is
 * registered under). `origin` is where its key works.
 */
export async function deviceSession(
  auth: StandaloneAuth,
  origin: string,
  label = 'iPhone · Safari',
): Promise<{ device: SoftDevice; id: string; cookie: string }> {
  const device = await SoftDevice.create();
  const result = auth.devices!.register(device.id, await device.publicKey(), origin, label, false);
  if ('error' in result) throw new Error(result.error);
  const session = auth.createSession('short', label, device.id);
  return { device, id: session.id, cookie: `cld_session=${session.id}` };
}

/** S5: the device-key proof a login page sends beside a passkey assertion. */
export async function deviceProof(
  server: AuthServer,
  device: SoftDevice,
  headers: Record<string, string>,
): Promise<{ deviceId: string; nonce: string; signature: string }> {
  const res = await server.app.inject({ url: '/login/device/challenge', headers });
  const { nonce } = res.json<{ nonce: string }>();
  return { deviceId: device.id, nonce, signature: await device.sign(nonce) };
}

function sha256(data: string | Buffer): Buffer {
  return crypto.createHash('sha256').update(data).digest();
}

/** base64url of the client data JSON the browser would sign over. */
function clientDataJSON(type: string, challenge: string, origin: string): string {
  return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false })).toString(
    'base64url',
  );
}
