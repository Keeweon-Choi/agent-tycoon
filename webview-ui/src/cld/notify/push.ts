/**
 * T-0039 Web Push, the browser side: can this browser get pushes, and the
 * subscribe / unsubscribe a tap on 알림 받기 starts (Notification permission
 * needs that user gesture). The daemon keeps one subscription per device and
 * pushes only while no page of this device is showing.
 */
import {
  type NoticeKind,
  type NoticeTarget,
  OPEN_TARGET_KEY,
  parseNoticeUrl,
} from '../../../../core/src/cld/notices.js';
import type { ClientMessage, PushState } from '../../../../core/src/messages.js';
import { getLanguage, t, type TranslationKey } from '../../i18n/index.js';
import type { NoticeSettings } from './notices.js';

export type PushSupport = 'ok' | 'insecure' | 'ios-browser' | 'none';

const isIos = () =>
  /iPhone|iPad|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isHomeScreenApp = () =>
  (navigator as Navigator & { standalone?: boolean }).standalone === true ||
  window.matchMedia?.('(display-mode: standalone)').matches === true;

export function pushSupport(): PushSupport {
  if (!window.isSecureContext) return 'insecure';
  // iOS 16.4+: only the Home-Screen app has PushManager.
  if (isIos() && !isHomeScreenApp()) return 'ios-browser';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window))
    return 'none';
  return 'ok';
}

export const PUSH_HINT: Record<Exclude<PushSupport, 'ok'>, TranslationKey> = {
  insecure: 'notice.pushInsecure',
  'ios-browser': 'notice.pushIos',
  none: 'notice.pushUnsupported',
};

type Send = (msg: ClientMessage) => void;

// ── The "notifications are off here" banner ────────────────────
const DISMISSED_KEY = 'cld.push-banner-dismissed';
const OPTED_OUT_KEY = 'cld.push-off';
/** A dismissed banner stays away this long; a device that stays silent is worth asking again. */
export const PUSH_BANNER_DISMISS_MS = 7 * 24 * 3600_000;
/** The banner floats over the page like a toast, so it leaves on its own (back next page load). */
export const PUSH_BANNER_SHOW_MS = 12_000;

export type PushBannerKind = 'none' | 'resubscribe' | 'ask' | 'ios-install';

/**
 * What to do about a logged-in device the daemon has no subscription for
 * (a new address is a new origin: the old subscription cannot follow).
 * 'resubscribe': permission is already granted here, do it silently;
 * 'ask': a banner whose button is the user gesture; 'ios-install': the
 * banner says why a plain iOS browser tab cannot. Nothing when the user
 * turned push off on purpose, dismissed the banner lately, or nothing could
 * help (blocked, insecure, unsupported: the settings row says why).
 */
export function pushBannerKind(i: {
  push: PushState | null;
  support: PushSupport;
  permission: NotificationPermission | 'unsupported';
  dismissedAt: number | null;
  optedOut: boolean;
  now: number;
}): PushBannerKind {
  if (!i.push?.available || i.push.subscribed || i.optedOut) return 'none';
  if (i.dismissedAt !== null && i.now - i.dismissedAt < PUSH_BANNER_DISMISS_MS) return 'none';
  if (i.support === 'ios-browser') return 'ios-install';
  if (i.support !== 'ok' || i.permission === 'denied' || i.permission === 'unsupported')
    return 'none';
  return i.permission === 'granted' ? 'resubscribe' : 'ask';
}

const stamp = (key: string): number | null => {
  try {
    const n = Number(localStorage.getItem(key));
    return n > 0 ? n : null;
  } catch {
    return null;
  }
};
const setStamp = (key: string, on: boolean) => {
  try {
    if (on) localStorage.setItem(key, String(Date.now()));
    else localStorage.removeItem(key);
  } catch {
    // No storage: the banner just returns next visit.
  }
};
export const pushBannerDismissedAt = () => stamp(DISMISSED_KEY);
export const dismissPushBanner = () => setStamp(DISMISSED_KEY, true);
export const pushOptedOut = () => stamp(OPTED_OUT_KEY) !== null;
export const currentPermission = (): NotificationPermission | 'unsupported' =>
  'Notification' in window ? Notification.permission : 'unsupported';

/**
 * The kinds this device wants and (U-49) the ones it turned off. The daemon tells a row saved by an
 * older page (no `kindsOff`: messages are on until switched off) from an explicit off by this list.
 */
const kindsOf = (s: NoticeSettings) => {
  const all = Object.keys(s.kinds) as NoticeKind[];
  return { kinds: all.filter((k) => s.kinds[k]), kindsOff: all.filter((k) => !s.kinds[k]) };
};

export function subscribeMessage(sub: PushSubscription, settings: NoticeSettings): ClientMessage {
  const { endpoint, keys } = sub.toJSON();
  return {
    type: 'pushSubscribe',
    endpoint: endpoint ?? '',
    p256dh: keys?.p256dh ?? '',
    auth: keys?.auth ?? '',
    ...kindsOf(settings),
    subagents: settings.subagents,
    remoteTurnEnds: settings.remoteTurnEnds,
    lang: getLanguage(),
  };
}

const keyBytes = (b64url: string) =>
  Uint8Array.from(atob(b64url.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

/** 알림 받기: permission, the service worker, the subscription, then the daemon. */
export async function subscribePush(
  publicKey: string,
  settings: NoticeSettings,
  send: Send,
): Promise<void> {
  if ((await Notification.requestPermission()) !== 'granted')
    throw new Error(t('notice.pushDenied'));
  setStamp(OPTED_OUT_KEY, false);
  const reg = await navigator.serviceWorker.register(new URL('sw.js', document.baseURI));
  await navigator.serviceWorker.ready;
  const options = { userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) };
  let sub: PushSubscription;
  try {
    sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe(options));
  } catch {
    // A subscription made with another key (a new push.json): start over.
    await (await reg.pushManager.getSubscription())?.unsubscribe();
    sub = await reg.pushManager.subscribe(options);
  }
  send(subscribeMessage(sub, settings));
}

/** The kinds changed: the daemon gets them with the same subscription. */
export async function resendPush(settings: NoticeSettings, send: Send): Promise<void> {
  const reg = await navigator.serviceWorker?.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) send(subscribeMessage(sub, settings));
}

export async function unsubscribePush(send: Send): Promise<void> {
  setStamp(OPTED_OUT_KEY, true); // on purpose: no banner asks again
  send({ type: 'pushUnsubscribe' });
  const reg = await navigator.serviceWorker?.getRegistration();
  await (await reg?.pushManager.getSubscription())?.unsubscribe();
}

/**
 * Where a push's click lands (T-0043): its url's target (`?open=chat&lead=`,
 * `?open=job&id=`, `?open=codex&id=`, or `?agent=<id>`), from the address a
 * new window opened with or the service worker's message to an open one.
 * `open` returns false while what it names is not there yet (the office still
 * loading): it is asked again for up to 20 s.
 */
export function listenForPushClicks(open: (target: NoticeTarget) => boolean): () => void {
  const timers: number[] = [];
  const openWhenThere = (t: NoticeTarget, tries = 40) => {
    if (!open(t) && tries > 0)
      timers.push(window.setTimeout(() => openWhenThere(t, tries - 1), 500));
  };
  // Through the login (login.ts kept it): the page that showed the login had it.
  let carried: string | null = null;
  try {
    carried = sessionStorage.getItem(OPEN_TARGET_KEY);
    sessionStorage.removeItem(OPEN_TARGET_KEY);
  } catch {
    // No storage.
  }
  const fromUrl = parseNoticeUrl(window.location.search) ?? parseNoticeUrl(carried ?? '');
  if (fromUrl) {
    const params = new URLSearchParams(window.location.search);
    for (const k of ['open', 'lead', 'room', 'id', 'terminal', 'agent', 'at']) params.delete(k);
    const rest = params.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${rest ? `?${rest}` : ''}`);
    openWhenThere(fromUrl);
  }
  const onMessage = (e: MessageEvent) => {
    const d = e.data as { type?: unknown; agentId?: unknown; url?: unknown } | null;
    const t =
      d?.type === 'cld-open' && typeof d.url === 'string'
        ? parseNoticeUrl(new URL(d.url, window.location.origin).search)
        : d?.type === 'cld-go' && typeof d.agentId === 'number'
          ? ({ open: 'agent', agentId: d.agentId } as const)
          : null;
    if (t) openWhenThere(t);
  };
  navigator.serviceWorker?.addEventListener('message', onMessage);
  return () => {
    timers.forEach((t) => window.clearTimeout(t));
    navigator.serviceWorker?.removeEventListener('message', onMessage);
  };
}
