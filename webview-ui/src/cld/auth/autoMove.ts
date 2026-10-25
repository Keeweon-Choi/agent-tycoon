/**
 * O5 (F-5): a registered page follows the host to its verified outside
 * address with no hands. The server says where (`autoMoveTo`: only an address
 * the host's outside check passed); this browser's device key proves a
 * step-up by itself; a 60-second move code takes it there, where the move
 * registers a key under the same device. Nothing secret crosses origins but
 * that single-use code. Never: a Home-Screen app (bound to the address it was
 * installed from: leaving it would strand the app), a plain-http page or the
 * host's own loopback page, a page whose key is not here, or the same address twice from one
 * origin (an outside address this network cannot reach must not bounce the
 * page to an error on every open).
 */
import { deviceStepUp } from '../shell/shellApi.js';
import { authFetch, isHomeScreenApp, type Me } from './authApi.js';

const TRIED = 'cld.auto-move-tried';
export const LOOPBACK = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/;

/** Where this page moves itself, or null. */
export function autoMoveTarget(
  me: Pick<Me, 'autoMoveTo' | 'deviceId'>,
  here: { hostname: string; origin: string; protocol: string },
  homeScreenApp: boolean,
  tried: string | null,
): string | null {
  const to = me.autoMoveTo;
  if (!to || !me.deviceId || homeScreenApp || tried === to) return null;
  // Only an https page that is not this PC: never by the side effect of plain http lacking WebCrypto.
  if (here.protocol !== 'https:' || LOOPBACK.test(here.hostname)) return null;
  try {
    return new URL(to).origin === here.origin ? null : to;
  } catch {
    return null;
  }
}

/** Move now if this page should; `moving` hears the address just before the page leaves. */
export async function moveByItself(me: Me, moving: (to: string) => void): Promise<void> {
  try {
    const to = autoMoveTarget(me, window.location, isHomeScreenApp(), localStorage.getItem(TRIED));
    // No passkey prompt and no tap: only the device key may prove it, else the banner's manual move.
    if (!to || (await deviceStepUp(me)) !== 'ok') return;
    const { url } = await authFetch<{ url: string }>('/api/auth/move-code', {
      method: 'POST',
      body: { auto: to },
      noStepUp: true,
    });
    // ponytail: one try per address per origin, no reachability probe (CSP keeps fetch same-origin);
    // a failed hop leaves the manual move in the banner.
    localStorage.setItem(TRIED, to);
    moving(to);
    window.location.assign(url);
  } catch {
    // No storage, no key, refused (address changed, not verified): stay here.
  }
}
