import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  isLanRequest,
  LAN_SESSION_TTL_MS,
  publicSockets,
  requestIsHttps,
  SESSION_TTL_MS,
  sessionCookie,
  StandaloneAuth,
} from './auth.js';

describe('StandaloneAuth', () => {
  afterEach(() => vi.useRealTimers());

  it('accepts a login code once only', () => {
    const auth = new StandaloneAuth();
    const { code, expiresIn } = auth.createLoginCode();

    const session = auth.login(code);
    expect(expiresIn).toBe(60);
    expect(session).not.toBeNull();
    expect(auth.validSession(session?.id)).toBe(true);
    expect(auth.login(code)).toBeNull();
  });

  it('rejects an expired or incorrect code', () => {
    vi.useFakeTimers();
    const auth = new StandaloneAuth();
    const { code } = auth.createLoginCode();
    vi.advanceTimersByTime(60_001);

    expect(auth.login(code)).toBeNull();
    expect(auth.login('wrong-code')).toBeNull();
  });

  it('sets strict HttpOnly cookie flags and adds Secure for HTTPS', () => {
    expect(sessionCookie('session id', false)).toBe(
      'cld_session=session%20id; HttpOnly; SameSite=Strict; Path=/; Max-Age=7776000',
    );
    expect(sessionCookie('id', true)).toContain('; Secure');
    expect(requestIsHttps('https')).toBe(true);
    expect(requestIsHttps('http')).toBe(false);
  });

  it('marks a plain LAN listener session as an absolute 12-hour session', () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const lanSocket = {};
    publicSockets.add(lanSocket);
    // The listener marker is the only input here: Host and Origin cannot change it.
    expect(isLanRequest(lanSocket)).toBe(true);
    const auth = new StandaloneAuth();
    const session = auth.createSession('link', 'phone', undefined, isLanRequest(lanSocket) ? 'lan' : undefined);
    const expiresAt = session.expiresAt;
    expect(expiresAt).toBe(1_000_000 + LAN_SESSION_TTL_MS);
    expect(sessionCookie(session.id, false, session.lifetime)).toContain('Max-Age=43200');

    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(auth.validSession(session.id)).toBe(true);
    expect(auth.session(session.id)?.expiresAt).toBe(expiresAt);
    vi.advanceTimersByTime(LAN_SESSION_TTL_MS - 60 * 60 * 1000);
    expect(auth.validSession(session.id)).toBe(false);
    expect(SESSION_TTL_MS).toBeGreaterThan(LAN_SESSION_TTL_MS);
  });

  it('S-11: an open socket of a LAN session closes when the 12 hours are up, with no request to notice', () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const auth = new StandaloneAuth();
    const lan = auth.createSession('link', 'phone', undefined, 'lan');
    const normal = auth.createSession('link', 'laptop');
    const closed: string[] = [];
    auth.bindSocket(lan.id, () => closed.push('lan'));
    auth.bindSocket(normal.id, () => closed.push('normal'));
    vi.advanceTimersByTime(LAN_SESSION_TTL_MS - 1);
    expect(closed).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(closed).toEqual(['lan']);
  });

  it('S-11: a timer that fires before Date.now() reaches the expiry (clock set back) waits again', () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const auth = new StandaloneAuth();
    const lan = auth.createSession('link', 'phone', undefined, 'lan');
    const closed: string[] = [];
    auth.bindSocket(lan.id, () => closed.push('lan'));
    vi.setSystemTime(Date.now() - 5);
    vi.advanceTimersByTime(LAN_SESSION_TTL_MS);
    expect(closed).toEqual([]);
    vi.advanceTimersByTime(5);
    expect(closed).toEqual(['lan']);
  });
});
