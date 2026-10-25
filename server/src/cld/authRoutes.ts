/**
 * The standalone session gate and the routes that make sessions (T-0002,
 * T-0022). Without a session a client may load only the login page (and its
 * login calls), the health check and what a browser fetches without cookies
 * to install the web app; everything else answers 401. See
 * cld/docs/design/security.md.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as fs from 'fs';
import * as path from 'path';

import { koText, refused } from '../../../core/src/cld/serverText.js';
import { textIn } from '../../../core/src/cld/serverText.js';
import { CHAT_WS_PREFIX } from '../../../core/src/constants.js';
import { bearerTokenValid, normalizeHostname } from '../wsAuth.js';
import { AUDIT_PAGE, type AuditContext } from './audit.js';
import {
  cleanLabel,
  clientAddress,
  CODE_TTL_MS,
  codeKey,
  deviceKind,
  deviceName,
  ipKey,
  isDirectRequest,
  isFunnelRequest,
  isLanRequest,
  isLocalRequest,
  isLoopbackPeer,
  isPublicListener,
  isPublicRequest,
  isShortCode,
  requestIsHttps,
  type Session,
  sessionCookie,
  sessionIdFromCookie,
  type StandaloneAuth,
  validNickname,
} from './auth.js';
import { type ApprovalNetwork, DeviceApprovals, isTailscaleAddress } from './deviceApproval.js';
import { cldHooks } from './hooks.js';
import { LOGIN_ERRORS, type LoginPageOptions, pageLanguage, sendEnterPage, sendLoginPage } from './loginPage.js';
import type { RelyingParty } from './passkeys.js';
import { STEPUP_REQUIRED } from './shell/gate.js';

export interface StandaloneAuthRouteOptions {
  /** The host's Bearer token (CLI and installer, over loopback). */
  token: string;
  auth: StandaloneAuth;
  /** --allowed-host names: the `tailscale serve` (and Funnel) name. */
  allowedHosts: readonly string[];
  /** dist/login: the login page's script and style. */
  loginAssetsDir?: string;
  /** --allow-chat (T-0014). Off: /cld/attach/* answers 404, like /terminal/*. */
  chat: boolean;
  /** Host opt-in for device shells. */
  allowTerminal: boolean;
  /** To every logged-in client (approval requests). */
  broadcast: (message: Record<string, unknown>) => void;
}

/** A device-key proof: the signature (base64url) over the nonce from /login/device/challenge. */
interface DeviceProof {
  deviceId?: unknown;
  nonce?: unknown;
  signature?: unknown;
}

const SHORT_LOCK_KEY = ['short'];
const DIRECT_LOCK_KEY = ['direct'];
/** Login routes the direct listener never offers (T-0024): device keys and codes only. */
const DIRECT_REFUSED = /^\/login\/(passkey|approval)(\/|$)/;
const LOGIN_ASSETS: Record<string, string> = {
  'login.js': 'text/javascript; charset=utf-8',
  'login.css': 'text/css; charset=utf-8',
};

export function registerStandaloneAuth(
  app: FastifyInstance,
  opts: StandaloneAuthRouteOptions,
): void {
  const { auth, token } = opts;
  // The serve name(s), read live: a name added at run time (allowRemoteHost) counts at
  // once. Never the daemon's whole Host allowlist: loopback is not a serve name.
  const trustedHosts = () =>
    new Set(
      opts.allowedHosts.map(normalizeHostname).filter((name): name is string => name !== null),
    );
  // Passkeys live under these RP IDs: the serve name(s) and localhost.
  const rpHosts = () => new Set([...trustedHosts(), 'localhost']);
  const passkeys = auth.passkeys;
  const recentAssertions = new Map<string, number>();
  const noteAssertion = (hash: string) => {
    recentAssertions.delete(hash);
    recentAssertions.set(hash, Date.now());
    if (recentAssertions.size > 1000)
      recentAssertions.delete(recentAssertions.keys().next().value!);
  };
  const devices = auth.devices;
  const approvals = auth.allowApprovalRequests ? new DeviceApprovals(opts.broadcast) : undefined;
  /** S1: a dangerous action needs a fresh step-up on its session; false once it answered. */
  const stepUp = (session: Session, reply: FastifyReply) => {
    if (auth.stepUpFresh(session)) return true;
    void reply.code(403).send({ error: STEPUP_REQUIRED });
    return false;
  };
  /** Silent re-login by device key: a readable store, and passkeys not required. */
  const deviceLoginOn = () => !!devices && !devices.broken && !devices.passkeyRequired;
  const keyStepUpRefused = () => auth.keyStepUpRefused();
  /** A passkey tap by this session in the last 5 minutes (a step-up or the passkey login). */
  const tappedRecently = (session: Session) =>
    Date.now() - (recentAssertions.get(session.hash) ?? 0) < 5 * 60_000;
  /** This session's device has a passkey of its own at this address. */
  const ownPasskeyHere = (session: Session, request: FastifyRequest) => {
    const rp = relyingParty(request, rpHosts());
    return (
      !!rp &&
      !!session.deviceId &&
      !!passkeys?.list().some((k) => k.rpID === rp.rpID && k.deviceId === session.deviceId)
    );
  };
  /** That tap was this device's own passkey at this address. */
  const tappedOwnHere = (session: Session, request: FastifyRequest) => {
    const rp = relyingParty(request, rpHosts());
    return (
      tappedRecently(session) &&
      !!rp &&
      !!session.deviceId &&
      !!passkeys
        ?.list()
        .some(
          (k) => k.id === session.shellPasskeyId && k.rpID === rp.rpID && k.deviceId === session.deviceId,
        )
    );
  };
  auth.onNewDevice = (notice) => opts.broadcast({ type: 'newDeviceLogin', ...notice });
  /** O3: the device a session is, as the record names it. */
  const deviceOf = (session: Session) => ({
    id: auth.rowId(session),
    label: auth.actorLabel(session),
    kind: session.kind,
  });

  /** O5: an automatic move goes only where the host's outside check passed (no allowlist fallback). */
  const autoMoveTarget = () => moveTarget(cldHooks.verifiedOutsideUrl?.(), undefined, []);

  // The gate. Root hooks run for every route, child plugins and 404s included.
  app.addHook('preHandler', async (request, reply) => {
    const pathname = request.url.split('?')[0];
    // ADR-0009: answer before @fastify/websocket can complete an upgrade.
    if (pathname.startsWith('/terminal/')) return reply.code(404).send();
    if (pathname.startsWith(`${CHAT_WS_PREFIX}/`) && !opts.chat) return reply.code(404).send();
    if (
      (pathname === '/api/shell' ||
        pathname.startsWith('/api/shell/') ||
        pathname.startsWith('/cld/shell/')) &&
      !opts.allowTerminal
    )
      return reply.code(404).send();
    if (isDirectRequest(request.socket) && DIRECT_REFUSED.test(pathname))
      return reply.code(404).send();
    if (standaloneRouteIsPublic(pathname)) return;
    if (standaloneRequestAuthorized(request, token, auth)) return;
    // A wrong Bearer token is a guess at the host credential: rate-limited.
    if (request.headers.authorization !== undefined) {
      const keys = [ipKey(requestClient(request))];
      if (auth.limiter.blocked(keys)) return tooManyAttempts(reply);
      auth.limiter.fail(keys);
    }
    reply.code(401).type('text/plain').send('unauthorized');
  });

  app.get('/', async (request, reply) => {
    const cookie = sessionIdFromCookie(request.headers.cookie);
    // Normal sessions slide on every use; LAN sessions keep their fixed
    // shorter expiry, and each response's cookie Max-Age matches it.
    const session = auth.session(cookie);
    if (session) setSessionCookie(request, reply, cookie as string, session);
    else if (!hostBearerValid(request, token)) return page(request, reply, 401);
    return reply.sendFile('index.html');
  });

  // ── One-time codes ──────────────────────────────────────────

  // Links and QR codes: /login?code=. The form: POST /login.
  app.get<{ Querystring: { code?: unknown } }>('/login', async (request, reply) =>
    attemptCode(request, reply, request.query.code),
  );
  app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: 1024 },
      (_request, body, done) => done(null, Object.fromEntries(new URLSearchParams(String(body)))),
    );
    scope.post<{ Body: { code?: unknown } | undefined }>('/login', async (request, reply) =>
      attemptCode(request, reply, request.body?.code),
    );
  });

  app.get<{ Params: { file: string } }>('/login/:file', async (request, reply) => {
    const type = LOGIN_ASSETS[request.params.file];
    if (!type || !opts.loginAssetsDir) return reply.code(404).send();
    try {
      const body = await fs.promises.readFile(path.join(opts.loginAssetsDir, request.params.file));
      return reply.type(type).header('cache-control', 'no-cache').send(body);
    } catch {
      return reply.code(404).send();
    }
  });

  // Host only (CLI, installer): the global gate already refused a Funnel
  // request's Bearer token. {short:true}: 8 digits for 5 minutes;
  // {qr:true}: a link code for 10 minutes; neither: the 60 s link code.
  app.post<{ Body: { short?: unknown; qr?: unknown } | undefined }>(
    '/api/login-code',
    async (request, reply) => {
      if (!hostBearerValid(request, token)) return reply.code(401).send('unauthorized');
      const kind =
        request.body?.short === true ? 'short' : request.body?.qr === true ? 'qr' : 'link';
      // `url`: where the new device opens it -- the canonical address (T-0024).
      auth.audit.write({ kind: 'loginCodeCreated', detail: kind, by: 'host', ...contextOf(request) });
      return { ...auth.createLoginCode(kind), url: publicOrigin(request, opts.allowedHosts) };
    },
  );

  // "기기 추가" on a logged-in device: a short code to type and a QR link,
  // one credential, 5 minutes. `url` is where the new device opens it (the
  // canonical address); the QR holds the link with its code.
  app.post('/api/auth/device-code', async (request, reply) => {
    const session = sessionFor(request, reply, auth);
    if (!session || !stepUp(session, reply)) return reply;
    const { short, link, expiresIn, id } = auth.createDeviceCodes(session, contextOf(request));
    const url = publicOrigin(request, opts.allowedHosts);
    return { code: short, url, link: `${url}/login?code=${link}`, expiresIn, id };
  });

  // O1: the invitation just issued, as its issuing session follows it. A
  // session that issued it (issuing took the step-up) may watch and cancel it
  // without another: neither can widen anyone's access, and a poll must not
  // raise a passkey prompt. Never the code or the link; unknown ids and other
  // sessions' invitations are one 404.
  app.get<{ Params: { id: string } }>('/api/auth/device-invite/:id', async (request, reply) => {
    const session = sessionFor(request, reply, auth);
    if (!session) return reply;
    const status = auth.inviteStatus(session, request.params.id);
    if (!status) return reply.code(404).send();
    reply.header('cache-control', 'no-store');
    return status;
  });

  app.post<{ Params: { id: string } }>('/api/auth/device-invite/:id/cancel', async (request, reply) => {
    const session = sessionFor(request, reply, auth);
    if (!session) return reply;
    const status = auth.cancelInvite(session, request.params.id, contextOf(request));
    if (!status) return reply.code(404).send();
    return { ok: true, ...status };
  });

  app.post<{ Params: { id: string }; Body: { name?: unknown } | undefined }>(
    '/api/auth/device-invite/:id/nickname',
    async (request, reply) => {
      // Writes to the device registry: a fresh step-up, unlike status and cancel.
      const session = sessionFor(request, reply, auth);
      if (!session || !stepUp(session, reply)) return reply;
      const name = validNickname(request.body?.name);
      if (!name) return reply.code(400).send({ ...refused('device_name_rule') });
      if (!auth.nameInviteDevice(session, request.params.id, name)) return reply.code(404).send();
      return { ok: true, name };
    },
  );

  // S3: the Safari page a QR logged in (O5: or a move, manual or automatic, brought)
  // asks for a code for the Home-Screen app of the same phone: 8 digits, 2 minutes,
  // once. It answers this request only, and the record names who, which device, where.
  app.post('/api/auth/handoff-code', async (request, reply) => {
    const session = sessionFor(request, reply, auth);
    if (!session) return reply;
    const issued = auth.createHandoffCode(session);
    if (!issued) return reply.code(403).send({ ...refused('not_from_here') });
    auth.audit.write({
      kind: 'handoffCodeCreated',
      device: deviceOf(session),
      by: auth.actorLabel(session),
      detail: requestOrigin(request),
      ...contextOf(request),
    });
    reply.header('cache-control', 'no-store');
    return issued;
  });

  // ── Device keys (T-0034) ────────────────────────────────────

  // A nonce to sign: for the silent re-login and for proving a key while logged in.
  // A session's nonces count per session (devices behind one address must not lock each
  // other out); without one, per client. Neither is the per-client block failed proofs feed.
  app.get('/login/device/challenge', async (request, reply) => {
    if (!devices || devices.broken) return reply.code(404).send();
    const session = auth.session(sessionIdFromCookie(request.headers.cookie));
    const limiter = session ? auth.sessionChallengeLimiter : auth.challengeLimiter;
    const keys = [session ? `session:${session.hash}` : ipKey(requestClient(request))];
    if (limiter.blocked(keys)) {
      if (session) auth.audit.stepUpFailed(deviceOf(session), contextOf(request));
      return reply.code(429).send({ error: LOGIN_ERRORS.tooMany });
    }
    limiter.fail(keys);
    return devices.challenge(requestOrigin(request));
  });

  // The login page's silent re-login: no session, a signed nonce.
  app.post<{ Body: DeviceProof | undefined }>('/login/device', async (request, reply) => {
    if (!deviceLoginOn()) return reply.code(404).send();
    // Per client only, like passkeys: a device id is no secret to guess.
    const keys = [ipKey(requestClient(request))];
    if (auth.limiter.blocked(keys)) return reply.code(429).send({ error: LOGIN_ERRORS.tooMany });
    const device = proveDevice(request, request.body);
    if (!device) {
      auth.limiter.fail(keys);
      return reply.code(401).send({ ...refused('device_login_failed') });
    }
    console.log(`[cld auth] "${device.label}" logged back in with its device key`);
    const session = auth.deviceLogin(device, sessionLifetime(request));
    setSessionCookie(request, reply, session.id, session);
    return { ok: true };
  });

  // A logged-in page holding a known key (a code login on a device that has
  // one): this session becomes that device instead of a new row.
  app.post<{ Body: DeviceProof | undefined }>('/api/auth/device/link', async (request, reply) => {
    const session = sessionFor(request, reply, auth);
    if (!session) return reply;
    if (!devices || devices.broken) return reply.code(404).send();
    const keys = [ipKey(requestClient(request))];
    if (auth.limiter.blocked(keys)) return reply.code(429).send({ error: LOGIN_ERRORS.tooMany });
    const device = proveDevice(request, request.body);
    if (!device) {
      auth.limiter.fail(keys);
      return reply.code(401).send({ ...refused('device_key_unverified') });
    }
    auth.linkDevice(session, device.id);
    return { deviceId: device.id };
  });

  app.post<{ Body: DeviceProof | undefined }>('/api/auth/stepup/device', async (request, reply) => {
    const session = sessionFor(request, reply, auth);
    if (!session) return reply;
    // "패스키 필수" also means a passkey for a shell: the key alone is not enough.
    if (keyStepUpRefused()) return reply.code(403).send({ ...refused('verify_with_passkey') });
    const keys = [ipKey(requestClient(request))];
    if (auth.limiter.blocked(keys)) {
      auth.audit.stepUpFailed(deviceOf(session), contextOf(request));
      return reply.code(429).send({ error: LOGIN_ERRORS.tooMany });
    }
    const device = proveDevice(request, request.body);
    if (!device || !session.deviceId || device.id !== session.deviceId) {
      auth.limiter.fail(keys);
      auth.audit.stepUpFailed(deviceOf(session), contextOf(request));
      return reply.code(403).send({ ...refused('device_key_unverified') });
    }
    auth.provedStepUp(session, 'key');
    auth.audit.write({ kind: 'stepUpPassed', device: deviceOf(session), detail: 'key', ...contextOf(request) });
    return { ok: true };
  });

  // The web app's public key after any login (the private key never leaves the device).
  app.post<{ Body: { deviceId?: unknown; publicKey?: unknown } | undefined }>(
    '/api/auth/device',
    async (request, reply) => {
      const session = sessionFor(request, reply, auth);
      if (!session) return reply;
      const origin = requestOrigin(request);
      const result = auth.registerDevice(
        session,
        request.body?.deviceId,
        request.body?.publicKey,
        origin,
        contextOf(request),
      );
      if ('error' in result) return reply.code(result.status).send({ error: result.error });
      console.log(
        `[cld auth] device key ${result.isNew ? 'registered' : 'replaced'}: "${result.device.label}" (${origin})`,
      );
      return { deviceId: result.device.id };
    },
  );

  // Take this device to the canonical address: a single-use 5-minute code
  // bound to its device id. There it registers a new key under the same id,
  // which removes the key it has here.
  // O5 (F-5): `{ auto: <url> }` is a page moving itself with no hands. Only to the
  // address the host verified from outside (never the allowlist fallback), only the
  // one /api/auth/me told that page (it changed: refused), only on a step-up this
  // device's own key just proved, with a 60-second code. Every one is in the record.
  app.post<{ Body: { auto?: unknown } | undefined }>('/api/auth/move-code', async (request, reply) => {
    const session = sessionFor(request, reply, auth);
    if (!session || !stepUp(session, reply)) return reply;
    const auto = request.body?.auto;
    const target =
      auto === undefined
        ? moveTarget(cldHooks.verifiedOutsideUrl?.(), cldHooks.canonicalUrl?.(), opts.allowedHosts)
        : autoMoveTarget();
    const deviceId = session.deviceId;
    const refuse = (status: number, why: 'target' | 'changed' | 'key', code: Parameters<typeof refused>[0]) => {
      if (auto !== undefined)
        auth.audit.write({ kind: 'moveRefused', device: deviceOf(session), detail: why, ...contextOf(request) });
      return reply.code(status).send({ ...refused(code) });
    };
    if (
      !target ||
      !deviceId ||
      !devices?.get(deviceId) ||
      sameOrigin(target, requestOrigin(request))
    )
      return refuse(400, 'target', 'move_no_target');
    if (auto !== undefined && auto !== target) return refuse(409, 'changed', 'move_target_changed');
    if (auto !== undefined && session.shellProofBy !== 'key') return refuse(403, 'key', 'device_key_unverified');
    const { code, expiresIn } = auth.createMoveCode(deviceId, auto === undefined ? undefined : CODE_TTL_MS.link);
    auth.audit.write({
      kind: 'moveCodeCreated',
      device: deviceOf(session),
      detail: auto === undefined ? 'manual' : 'auto',
      ...contextOf(request),
    });
    // The origin only: the direct address's path is its secret (T-0024), never logged.
    console.log(`[cld auth] ${auto === undefined ? '' : 'automatic '}move code for "${session.label}" to ${new URL(target).origin}`);
    return { url: `${target}/login?code=${code}`, expiresIn };
  });

  // "패스키(생체 인증) 필수": no silent re-login by device key while it is on.
  app.post<{ Body: { passkeyRequired?: unknown } | undefined }>(
    '/api/auth/settings',
    async (request, reply) => {
      const on = request.body?.passkeyRequired;
      // The last resort: the host's own token (never from outside) can always turn it off.
      if (on === false && request.headers.authorization !== undefined && hostBearerValid(request, token)) {
        if (!devices?.setPasskeyRequired(false)) return reply.code(400).send({ ...refused('setting_change_failed') });
        console.log('[cld auth] passkey required off, by the host token');
        auth.audit.write({ kind: 'passkeyRequired', detail: 'off', by: 'host', ...contextOf(request) });
        return { passkeyRequired: false };
      }
      const session = sessionFor(request, reply, auth);
      if (!session) return reply;
      // On: this device's own passkey at this address, just tapped -- a cookie alone
      // must not be able to lock every address without a passkey (an IP address) out.
      if (on === true && !tappedOwnHere(session, request))
        return reply.code(409).send({ ...refused('passkey_required_on_here') });
      if (on === false && !tappedRecently(session)) {
        // With no passkey anywhere nobody could tap one: a fresh step-up (the device key) instead.
        if (passkeys?.list().length) return reply.code(403).send({ ...refused('passkey_required_off') });
        if (!stepUp(session, reply)) return reply;
      }
      if (typeof on !== 'boolean' || !devices?.setPasskeyRequired(on))
        return reply.code(400).send({ ...refused('setting_change_failed') });
      // On: a key proof taken while it was off must not outlive it.
      if (on) auth.dropKeyProofs();
      console.log(`[cld auth] passkey required ${on ? 'on' : 'off'}, from "${session.label}"`);
      auth.audit.write({
        kind: 'passkeyRequired',
        detail: on ? 'on' : 'off',
        device: deviceOf(session),
        ...contextOf(request),
      });
      return { passkeyRequired: on };
    },
  );

  // ── Passkeys ────────────────────────────────────────────────

  app.post('/login/passkey/options', async (request, reply) => {
    const rp = relyingParty(request, rpHosts());
    if (!passkeys || !rp)
      return reply.code(404).send({ ...refused('passkey_not_here') });
    return passkeys.loginOptions(rp);
  });

  app.post<{
    Body: { ceremony?: unknown; response?: unknown; device?: unknown } | undefined;
  }>(
    '/login/passkey',
    async (request, reply) => {
      if (!passkeys) return reply.code(404).send();
      // Per client only: a credential ID is no secret to guess, and blocking
      // one would only let a stranger lock its owner out.
      const keys = [ipKey(requestClient(request))];
      if (auth.limiter.blocked(keys)) return reply.code(429).send({ error: LOGIN_ERRORS.tooMany });
      const used = await passkeys.login(request.body?.ceremony, request.body?.response);
      if (!used) {
        auth.limiter.fail(keys);
        return reply.code(401).send({ ...refused('passkey_login_failed') });
      }
      // S5: a legacy (unbound) passkey alone makes no session; this browser must
      // also prove a registered device key, and the passkey is tied to it.
      const session = auth.passkeyLogin(
        used,
        proveDevice(request, request.body?.device),
        sessionLifetime(request),
        contextOf(request),
      );
      if (!session) return reply.code(401).send({ error: LOGIN_ERRORS.passkeyUnbound });
      noteAssertion(session.hash);
      setSessionCookie(request, reply, session.id, session);
      return { ok: true };
    },
  );

  app.get('/api/auth/passkeys', async (request, reply) => {
    if (!sessionFor(request, reply, auth)) return reply;
    return {
      rpID: passkeys ? (relyingParty(request, rpHosts())?.rpID ?? null) : null,
      passkeys: passkeys?.list() ?? [],
    };
  });

  app.post('/api/auth/passkeys/verify/options', async (request, reply) => {
    const session = sessionFor(request, reply, auth);
    if (!session) return reply;
    const rp = relyingParty(request, rpHosts());
    if (!passkeys || !rp || !passkeys.has(rp.rpID))
      return reply.code(404).send({ ...refused('passkey_not_here') });
    // Only credentials still stored: a synced copy of a deleted one is not offered.
    return passkeys.loginOptions(rp, session.hash, true);
  });

  app.post<{ Body: { ceremony?: unknown; response?: unknown } | undefined }>(
    '/api/auth/passkeys/verify',
    async (request, reply) => {
      const session = sessionFor(request, reply, auth);
      if (!session) return reply;
      if (!passkeys) return reply.code(404).send();
      const used = await passkeys.login(
        request.body?.ceremony,
        request.body?.response,
        session.hash,
      );
      if (!used) {
        auth.audit.stepUpFailed(deviceOf(session), contextOf(request));
        return reply.code(403).send({ ...refused('passkey_verify_failed') });
      }
      noteAssertion(session.hash);
      session.shellPasskeyId = used.id;
      auth.provedStepUp(session, 'passkey');
      auth.audit.write({ kind: 'stepUpPassed', device: deviceOf(session), detail: 'passkey', ...contextOf(request) });
      return { ok: true };
    },
  );

  app.post('/api/auth/passkeys/options', async (request, reply) => {
    const session = sessionFor(request, reply, auth);
    if (!session || !stepUp(session, reply)) return reply;
    const rp = relyingParty(request, rpHosts());
    if (!passkeys || !rp)
      return reply.code(404).send({ ...refused('passkey_not_here') });
    // S5: made for the device this session is, so each device keeps its own passkey.
    const device = session.deviceId ? devices?.get(session.deviceId) : undefined;
    return passkeys.registrationOptions(rp, session.hash, device ?? null);
  });

  app.post<{ Body: { ceremony?: unknown; response?: unknown; name?: unknown } | undefined }>(
    '/api/auth/passkeys',
    async (request, reply) => {
      const session = sessionFor(request, reply, auth);
      if (!session || !stepUp(session, reply)) return reply;
      if (!passkeys) return reply.code(404).send();
      const result = await passkeys.register(
        request.body?.ceremony,
        request.body?.response,
        session.hash,
        cleanLabel(request.body?.name, requestLabel(request)),
        // S5: tied to the device this session is, when it has a key.
        (session.deviceId && devices?.get(session.deviceId)?.id) || null,
      );
      if ('error' in result) return reply.code(400).send(result);
      console.log(`[cld auth] passkey registered: "${result.name}" (${result.rpID})`);
      // Under 필수 the first passkey ends the key's step-ups: proofs taken by key end with them.
      auth.dropKeyProofs();
      // A new credential is news to the other devices: a stolen cookie alone
      // can add one, and it outlives that cookie's revoke (it is also a shell
      // step-up, T-0052).
      auth.announceDevice(
        {
          ...deviceOf(session),
          kind: session.kind ?? 'unknown',
          event: 'passkey',
          handle: session.handle,
          at: Date.now(),
          by: auth.actorLabel(session),
          ...contextOf(request),
        },
        koText('audit_passkey_added', { name: result.name }),
      );
      return { passkey: result };
    },
  );

  app.patch<{ Params: { id: string }; Body: { name?: unknown } | undefined }>(
    '/api/auth/passkeys/:id',
    async (request, reply) => {
      if (!sessionFor(request, reply, auth)) return reply;
      const name = cleanLabel(request.body?.name, '');
      if (!name || !passkeys?.rename(request.params.id, name)) return reply.code(404).send();
      return { ok: true };
    },
  );

  // S5: give an unbound ("기기 미지정") passkey a device. Rebinding a bound one is not offered.
  app.post<{ Params: { id: string }; Body: { deviceId?: unknown } | undefined }>(
    '/api/auth/passkeys/:id/device',
    async (request, reply) => {
      const session = sessionFor(request, reply, auth);
      if (!session || !stepUp(session, reply)) return reply;
      const deviceId = request.body?.deviceId;
      const key = passkeys?.list().find((k) => k.id === request.params.id);
      if (!key || typeof deviceId !== 'string' || !devices?.get(deviceId))
        return reply.code(404).send();
      if (key.deviceId !== null) return reply.code(409).send({ ...refused('passkey_already_bound') });
      passkeys!.bind(key.id, deviceId);
      console.log('[cld auth] passkey assigned to a device');
      return { ok: true };
    },
  );

  app.delete<{ Params: { id: string } }>('/api/auth/passkeys/:id', async (request, reply) => {
    const session = sessionFor(request, reply, auth);
    if (!session || !stepUp(session, reply)) return reply;
    const removed = passkeys?.list().find((key) => key.id === request.params.id);
    if (!passkeys?.remove(request.params.id)) return reply.code(404).send();
    const owner = removed?.deviceId ? devices?.get(removed.deviceId) : undefined;
    auth.audit.write({
      kind: 'passkeyRemoved',
      device: owner ? { id: owner.id, label: owner.nickname ?? owner.label, kind: owner.kind } : deviceOf(session),
      by: auth.actorLabel(session),
      ...contextOf(request),
    });
    console.log('[cld auth] passkey removed');
    return { ok: true };
  });

  // ── Sessions ────────────────────────────────────────────────

  app.get('/api/auth/me', async (request, reply) => {
    const session = sessionFor(request, reply, auth);
    if (!session) return reply;
    const rp = relyingParty(request, rpHosts());
    const id = auth.rowId(session);
    const canonical = moveTarget(
      cldHooks.verifiedOutsideUrl?.(),
      cldHooks.canonicalUrl?.(),
      opts.allowedHosts,
    );
    const outside = autoMoveTarget();
    return {
      method: session.method,
      label: session.label,
      passkeys: !!passkeys && !!rp,
      passkeyHere: !!passkeys && !!rp && passkeys.has(rp.rpID),
      // This device's own passkey here: what turning 필수 on takes.
      ownPasskeyHere: ownPasskeyHere(session, request),
      approvals: !!approvals,
      // T-0034: this device's row, its registered device key (if any), and
      // where it could move to.
      id,
      deviceId: id === session.deviceId ? id : null,
      deviceKeys: !!devices && !devices.broken,
      passkeyRequired: devices?.passkeyRequired ?? false,
      // The device key may prove a step-up (false: 필수 is on and a passkey exists, so only a tap can).
      keyStepUp: !keyStepUpRefused(),
      handoff: auth.mayHandoff(session),
      moveTo: canonical && !sameOrigin(canonical, requestOrigin(request)) ? canonical : null,
      // O5: where this keyed device moves by itself (only a host-verified outside address).
      autoMoveTo:
        outside && session.deviceId && !sameOrigin(outside, requestOrigin(request)) ? outside : null,
    };
  });

  app.get('/api/auth/sessions', async (request, reply) => {
    if (!sessionFor(request, reply, auth)) return reply;
    const pushing = cldHooks.pushDevices?.();
    return {
      sessions: auth
        .listSessions(sessionIdFromCookie(request.headers.cookie))
        .map((row) => (pushing ? { ...row, push: pushing.has(row.id) } : row)),
    };
  });

  // O3: the security record, newest first, a page at a time. A session only (the
  // device list's rule): no cookie, no lines. `since` is the total the first page
  // saw, so lines written meanwhile do not shift the next page.
  app.get<{ Querystring: { skip?: string; since?: string } }>('/api/auth/audit', async (request, reply) => {
    if (!sessionFor(request, reply, auth)) return reply;
    const count = (raw: string | undefined) => (/^\d{1,9}$/.test(raw ?? '') ? Number(raw) : undefined);
    const skip = count(request.query.skip) ?? 0;
    const since = count(request.query.since);
    const { lines, total } = auth.audit.read(skip, AUDIT_PAGE, since);
    reply.header('cache-control', 'no-store');
    return { lines, total };
  });

  // O2: only persisted device rows are nameable. A keyless session has no
  // durable device identity to carry a nickname to its next login.
  app.post<{ Params: { id: string }; Body: { name?: unknown } | undefined }>(
    '/api/auth/sessions/:id/nickname',
    async (request, reply) => {
      const session = sessionFor(request, reply, auth);
      if (!session || !stepUp(session, reply)) return reply;
      const name = validNickname(request.body?.name);
      if (!name) return reply.code(400).send({ ...refused('device_name_rule') });
      if (!auth.nameDevice(request.params.id, name)) return reply.code(404).send();
      return { ok: true, name };
    },
  );

  // One row of the device list: a device's key and sessions, or a session.
  app.delete<{ Params: { id: string } }>('/api/auth/sessions/:id', async (request, reply) => {
    const session = sessionFor(request, reply, auth);
    if (!session) return reply;
    // Signing this device out is not a step-up matter; signing out another is. Nor is
    // one that ends passkeys under 필수: the last ones gone, every device key steps up again.
    const own = request.params.id === auth.rowId(session);
    // On the device revoke() will remove: a session handle names its session's device.
    const dropsPasskeys =
      !!devices?.passkeyRequired && !!passkeys?.countFor(auth.revokeTarget(request.params.id));
    if ((!own || dropsPasskeys) && !stepUp(session, reply)) return reply;
    const gone = auth.rowOf(request.params.id, sessionIdFromCookie(request.headers.cookie));
    if (!auth.revoke(request.params.id)) return reply.code(404).send();
    auth.audit.write({
      kind: 'deviceRevoked',
      device: { id: gone?.id ?? request.params.id, label: gone?.label ?? '', kind: gone?.kind },
      by: auth.actorLabel(session),
      ...contextOf(request),
    });
    const self = !auth.validSession(sessionIdFromCookie(request.headers.cookie));
    console.log(
      `[cld auth] signed out a device${self ? ' (its own)' : ''} from "${session.label}"`,
    );
    if (self) reply.header('Set-Cookie', clearedCookie(request));
    return { ok: true };
  });

  app.post('/api/auth/sessions/revoke-others', async (request, reply) => {
    const session = sessionFor(request, reply, auth);
    if (!session || !stepUp(session, reply)) return reply;
    const count = auth.revokeOthers(sessionIdFromCookie(request.headers.cookie));
    auth.audit.write({ kind: 'revokeOthers', detail: count, by: auth.actorLabel(session), ...contextOf(request) });
    console.log(`[cld auth] signed out ${count} other session(s) from "${session.label}"`);
    return { count };
  });

  // ── New-device approval (off unless --allow-approval-requests) ──

  app.post<{ Body: { label?: unknown } | undefined }>('/login/approval', async (request, reply) => {
    if (!approvals) return reply.code(404).send();
    const ip = requestClient(request);
    // Every request counts: each one puts a dialog on the owner's devices.
    const keys = [`approval:${ip}`];
    if (auth.limiter.blocked(keys)) return reply.code(429).send({ error: LOGIN_ERRORS.tooMany });
    auth.limiter.fail(keys);
    const agent = requestLabel(request);
    const created = approvals.create({
      label: cleanLabel(request.body?.label, agent),
      agent,
      ip,
      network: requestNetwork(request),
    });
    if (!created) return reply.code(429).send({ error: LOGIN_ERRORS.tooMany });
    return created;
  });

  app.post<{ Body: { secret?: unknown } | undefined }>(
    '/login/approval/poll',
    async (request, reply) => {
      if (!approvals) return reply.code(404).send();
      const keys = [ipKey(requestClient(request))];
      if (auth.limiter.blocked(keys)) return reply.code(429).send({ error: LOGIN_ERRORS.tooMany });
      const result = approvals.poll(request.body?.secret);
      if (result.state === 'gone') auth.limiter.fail(keys);
      if (result.state === 'approved') {
        const session = auth.createSession(
          'approval',
          result.label,
          undefined,
          sessionLifetime(request),
          deviceKind(request.headers['user-agent']),
          contextOf(request),
        );
        setSessionCookie(request, reply, session.id, session);
      }
      return {
        state: result.state,
        ...(result.state === 'pending' ? { expiresIn: result.expiresIn } : {}),
      };
    },
  );

  app.get('/api/auth/approvals', async (request, reply) => {
    if (!sessionFor(request, reply, auth)) return reply;
    return { approvals: approvals?.pending() ?? [] };
  });

  app.post<{ Params: { id: string }; Body: { approve?: unknown; code?: unknown } | undefined }>(
    '/api/auth/approvals/:id',
    async (request, reply) => {
      const session = sessionFor(request, reply, auth);
      if (!session) return reply;
      // Approving adds a device; denying needs nothing.
      if (request.body?.approve === true && !stepUp(session, reply)) return reply;
      if (!approvals) return reply.code(404).send();
      const result = approvals.answer(
        request.params.id,
        request.body?.approve === true,
        request.body?.code,
        `"${session.label}"`,
      );
      if (result === 'approved' || result === 'refused')
        auth.audit.write({
          kind: 'approvalAnswered',
          detail: result,
          by: auth.actorLabel(session),
          ...contextOf(request),
        });
      return { result };
    },
  );

  // The host CLI approves by the code it was told: cld-gui-login --approve.
  app.post<{ Body: { code?: unknown } | undefined }>(
    '/api/device-approval',
    async (request, reply) => {
      if (!hostBearerValid(request, token)) return reply.code(401).send('unauthorized');
      if (!approvals) return reply.code(404).send({ error: 'off' });
      const code = typeof request.body?.code === 'string' ? request.body.code : '';
      const keys = [ipKey(requestClient(request)), codeKey(code)];
      if (auth.limiter.blocked(keys)) return reply.code(429).send({ error: LOGIN_ERRORS.tooMany });
      if (!approvals.approveByCode(code, 'the host (cld-gui-login)')) {
        auth.limiter.fail(keys);
        return reply.code(400).send({ ok: false });
      }
      auth.audit.write({ kind: 'approvalAnswered', detail: 'approved', by: 'host', ...contextOf(request) });
      return { ok: true };
    },
  );

  // ADR-0009: leave no upgrade or fallback route that could create a PTY.
  app.all('/terminal/*', async (_request, reply) => reply.code(404).send());

  /** The login page, with the buttons this request may use. */
  function page(request: FastifyRequest, reply: FastifyReply, status: number, error?: string) {
    const rp = relyingParty(request, rpHosts());
    const direct = isDirectRequest(request.socket);
    const options: LoginPageOptions = {
      label: requestLabel(request),
      error,
      passkey: !direct && !!passkeys && !!rp && passkeys.has(rp.rpID),
      approval: !direct && !!approvals,
      device: deviceLoginOn(),
      lang: pageLanguage(request.headers['accept-language']),
    };
    return sendLoginPage(reply, status, options);
  }

  /**
   * One device-key proof from this request (POST {deviceId, nonce,
   * signature}). The nonce is used up either way; a request from another
   * origin can't match it. The device, or null.
   */
  function proveDevice(request: FastifyRequest, proof: unknown) {
    const origin = requestOrigin(request);
    const { deviceId, nonce, signature } = (proof ?? {}) as DeviceProof;
    const from = request.headers.origin === origin ? origin : '';
    return devices?.verify(deviceId, nonce, signature, from) ?? null;
  }

  /**
   * One code attempt, from a link or the form. Per client and per code; short
   * codes also under the global lock. Every failure gets the same 401; a
   * block answers 429 without looking at (or using up) the code.
   */
  function attemptCode(request: FastifyRequest, reply: FastifyReply, raw: unknown) {
    if (raw === undefined || raw === '') return page(request, reply, 401);
    const code = typeof raw === 'string' ? raw : '';
    const short = isShortCode(code);
    // S-18: a page on another site must not spend this client's guesses (or the global short-code
    // lock). It may only hand over a link in a tab (a move, a pasted invite): a 24-byte code, which
    // can't be guessed, so its failure isn't counted -- else one click opens a window it re-aims at will.
    const h = request.headers;
    const crossSite = h['sec-fetch-site'] === 'cross-site';
    if (
      crossSite &&
      (short || !(h['sec-fetch-mode'] === 'navigate' && h['sec-fetch-dest'] === 'document'))
    )
      return page(request, reply, 401, LOGIN_ERRORS.badCode);
    const direct = isDirectRequest(request.socket);
    const keys = [ipKey(requestClient(request))];
    if (code) keys.push(codeKey(code));
    if (
      auth.limiter.blocked(keys) ||
      (short && auth.shortCodeLock.blocked(SHORT_LOCK_KEY)) ||
      (direct && auth.directCodeLock.blocked(DIRECT_LOCK_KEY))
    )
      return page(request, reply, 429, LOGIN_ERRORS.tooMany);
    const session = code
      ? auth.login(
          code,
          requestLabel(request),
          sessionLifetime(request),
          deviceKind(request.headers['user-agent']),
          contextOf(request),
        )
      : null;
    if (!session) {
      if (crossSite) return page(request, reply, 401, LOGIN_ERRORS.badCode);
      auth.limiter.fail(keys);
      if (direct && auth.directCodeLock.fail(DIRECT_LOCK_KEY)) {
        auth.audit.write({ kind: 'lockout', detail: 'direct', ...contextOf(request) });
        console.warn(
          '[cld auth] code login on the direct listener locked for an hour: 10 failed attempts in an hour',
        );
      }
      if (short && auth.shortCodeLock.fail(SHORT_LOCK_KEY)) {
        auth.audit.write({ kind: 'lockout', detail: 'short', ...contextOf(request) });
        console.warn(
          '[cld auth] short-code login locked for 10 minutes: 20 failed attempts in 10 minutes',
        );
      }
      return page(request, reply, 401, LOGIN_ERRORS.badCode);
    }
    setSessionCookie(request, reply, session.id, session);
    // A move began on another origin: one hop from this one takes the cookie along.
    if (session.method === 'move') return sendEnterPage(reply);
    return reply.code(303).header('Location', '/').send();
  }
}

/** Session cookie or (not over Funnel) the host's Bearer token. */
export function standaloneRequestAuthorized(
  request: FastifyRequest,
  token: string,
  auth: StandaloneAuth,
): boolean {
  return (
    hostBearerValid(request, token) ||
    auth.validSession(sessionIdFromCookie(request.headers.cookie))
  );
}

/** The host's Bearer token, never accepted from a public request (Funnel, direct, the LAN). */
export function hostBearerValid(request: FastifyRequest, token: string): boolean {
  return (
    !isPublicRequest(request.headers, request.socket) &&
    bearerTokenValid(request.headers.authorization, token)
  );
}

/**
 * The session behind a browser-only route, or a 401. A state-changing request
 * must also be same-origin: SameSite=Strict still sends the cookie from a
 * sibling `*.ts.net` page, so the Origin header is checked too.
 */
function sessionFor(
  request: FastifyRequest,
  reply: FastifyReply,
  auth: StandaloneAuth,
): Session | undefined {
  const session = auth.session(sessionIdFromCookie(request.headers.cookie));
  if (!session) {
    reply.code(401).send('unauthorized');
    return undefined;
  }
  if (request.method !== 'GET' && request.headers.origin !== requestOrigin(request)) {
    reply.code(403).send('forbidden origin');
    return undefined;
  }
  return session;
}

/**
 * The WebAuthn relying party for this request: its own host, when that is a
 * serve name or localhost (an IP address can't be an RP ID), over https --
 * or plain http on localhost, the one place browsers allow it.
 */
function relyingParty(request: FastifyRequest, rpHosts: ReadonlySet<string>): RelyingParty | null {
  const name = normalizeHostname(request.headers.host);
  if (!name || !rpHosts.has(name)) return null;
  const https = requestIsHttps(headerValue(request.headers['x-forwarded-proto']));
  if (!https && name !== 'localhost') return null;
  return { rpID: name, origin: requestOrigin(request) };
}

/** The coarse network a request came from, shown to the approver. */
function requestNetwork(request: FastifyRequest): ApprovalNetwork {
  if (isFunnelRequest(request.headers) || isDirectRequest(request.socket)) return 'funnel';
  // A public listener behind a portproxy sees 127.0.0.1: still not this PC (T-0074).
  if (isPublicListener(request.socket) || !isLoopbackPeer(request.socket.remoteAddress))
    return 'lan';
  return request.headers['x-forwarded-for'] && isTailscaleAddress(requestClient(request))
    ? 'tailnet'
    : 'local';
}

/**
 * What a client with no session may load: the health check, the login page
 * with its script, style, font and login calls, and what a browser fetches
 * without cookies to install the web app (manifest, icons, the push service
 * worker, T-0039: its update check may come without a session). Everything else --
 * the app, `/ws`, `/api/*`, `/cld/*` -- answers 401.
 */
function standaloneRouteIsPublic(pathname: string): boolean {
  return (
    [
      '/',
      '/login',
      '/login/login.js',
      '/login/login.css',
      '/login/passkey/options',
      '/login/passkey',
      '/login/device/challenge',
      '/login/device',
      '/login/approval',
      '/login/approval/poll',
      '/fonts/FSPixelSansUnicode-Regular.ttf',
      '/api/health',
      '/manifest.webmanifest',
      '/favicon.ico',
      '/sw.js',
    ].includes(pathname) ||
    /^\/apple-touch-icon(-precomposed)?\.png$/.test(pathname) ||
    /^\/icons\/[A-Za-z0-9_-]+\.png$/.test(pathname) ||
    /^\/fonts\/galmuri\/Galmuri[0-9]+(-Bold)?\.woff2$/.test(pathname)
  );
}

/** Set-Cookie for a session's cookie value (handed out at login, never stored). */
function setSessionCookie(request: FastifyRequest, reply: FastifyReply, value: string, session?: Session): void {
  reply.header(
    'Set-Cookie',
    sessionCookie(value, requestIsHttps(headerValue(request.headers['x-forwarded-proto'])), session?.lifetime),
  );
}

/** The LAN listener, not a supplied Host or Origin, chooses the short session lifetime. */
function sessionLifetime(request: FastifyRequest): Session['lifetime'] | undefined {
  return isLanRequest(request.socket) ? 'lan' : undefined;
}

function clearedCookie(request: FastifyRequest): string {
  return sessionCookie(
    '',
    requestIsHttps(headerValue(request.headers['x-forwarded-proto'])),
  ).replace(/Max-Age=\d+/, 'Max-Age=0');
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function requestLabel(request: FastifyRequest): string {
  return deviceName(request.headers['user-agent']);
}

/** O3: how the request came in, for the record: this PC, the LAN listener, or anything else. */
function contextOf(request: FastifyRequest): AuditContext {
  return {
    via: isLocalRequest(request) ? 'local' : isLanRequest(request.socket) ? 'lan' : 'remote',
    peer: requestClient(request),
  };
}

function requestClient(request: FastifyRequest): string {
  const forwarded = request.headers['x-forwarded-for'];
  return clientAddress(
    request.socket.remoteAddress,
    Array.isArray(forwarded) ? forwarded.join(',') : forwarded,
    isPublicListener(request.socket),
  );
}

/** A state-changing request from this site's own page (see sessionFor). */
export function sameOriginRequest(request: FastifyRequest): boolean {
  return request.headers.origin === requestOrigin(request);
}

/** The origin the browser sees: https behind tailscale serve, else http. */
function requestOrigin(request: FastifyRequest): string {
  const https = requestIsHttps(headerValue(request.headers['x-forwarded-proto']));
  return `${https ? 'https' : 'http'}://${request.headers.host ?? ''}`;
}

/**
 * Whether two addresses share an origin. The canonical address can carry a
 * path (T-0024's direct connector: https://<ip>/<secret>), so it is never
 * compared whole; links keep the whole address.
 */
function sameOrigin(a: string, b: string): boolean {
  const origin = (url: string) => {
    try {
      return new URL(url).origin;
    } catch {
      return url;
    }
  };
  return origin(a) === origin(b);
}

/** A move carries a secret, so its target must be verified or host-approved. */
export function moveTarget(
  verifiedOutsideUrl: string | undefined,
  canonicalUrl: string | undefined,
  allowedHosts: readonly string[],
): string | null {
  const valid = (value: string | undefined) => {
    if (!value) return null;
    try {
      const url = new URL(value);
      return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin !== 'null'
        ? value.replace(/\/+$/, '')
        : null;
    } catch {
      return null;
    }
  };
  const verified = valid(verifiedOutsideUrl);
  if (verified) return verified;
  const canonical = valid(canonicalUrl);
  const allowedName = (name: string) => {
    try {
      return normalizeHostname(new URL(`https://${name}`).hostname);
    } catch {
      return null;
    }
  };
  if (canonical) {
    const host = normalizeHostname(new URL(canonical).hostname);
    return host && allowedHosts.some((name) => allowedName(name) === host) ? canonical : null;
  }
  // No canonical address yet: an explicitly allowed reverse-proxy name is the
  // only safe fallback. This preserves its optional direct secret path.
  return valid(allowedHosts[0] ? `https://${allowedHosts[0]}` : undefined);
}

/**
 * Where a new device opens an invitation, with no trailing slash: the
 * canonical address (cld remote, T-0024: the direct URL with its secret path,
 * the Tailscale name or the LAN URL); without one, the serve name, else this
 * request's origin. NB: with the direct connector it is more than an origin.
 */
function publicOrigin(request: FastifyRequest, allowedHosts: readonly string[]): string {
  const canonical = cldHooks.canonicalUrl?.();
  if (canonical) return canonical.replace(/\/+$/, '');
  const host = normalizeHostname(request.headers.host);
  if (host && allowedHosts.some((name) => normalizeHostname(name) === host))
    return requestOrigin(request);
  return allowedHosts.length > 0 ? `https://${allowedHosts[0]}` : requestOrigin(request);
}

function tooManyAttempts(reply: FastifyReply) {
  return reply
    .code(429)
    .header('Retry-After', '300')
    .type('text/plain; charset=utf-8')
    .send(textIn(pageLanguage(reply.request.headers['accept-language']), LOGIN_ERRORS.tooMany));
}
