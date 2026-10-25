import { browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { useEffect, useRef, useState } from 'react';

import { Button } from '../../components/ui/Button.js';
import { Modal } from '../../components/ui/Modal.js';
import { getLanguage, t } from '../../i18n/index.js';
import { transport } from '../../transport/index.js';
import { FloatingToast } from '../FloatingToast.js';
import { AccessStart } from './Access.js';
import { ApprovalDialog } from './ApprovalDialog.js';
import { authFetch, isPhoneSafariTab, type Me, passkeyError, registerPasskey } from './authApi.js';
import { moveByItself } from './autoMove.js';
import { ensureDeviceKey } from './deviceKey.js';
import { HandoffPrompt } from './HandoffPrompt.js';
import { RemoteBanner } from './Remote.js';
import { setSecurityOpener } from './securityOpen.js';
import { SecurityModal } from './SecurityPanel.js';
import { StepUpPrompt } from './StepUpPrompt.js';
import { UpdateNotice } from './UpdateNotice.js';

/** Logins that came from another device's help; passkeys make the next one a tap. */
const PROMPT_AFTER = ['qr', 'short', 'approval', 'handoff'];
const DISMISSED_KEY = 'cld.passkey-prompt-dismissed';
/** While the socket is down: how often to ask whether this session still exists. */
const SESSION_CHECK_MS = 5000;

/** `list`: a device notice, with "기기 목록"; it stays until it is closed. */
interface Toast {
  text: string;
  list?: boolean;
}

/**
 * The login layer of the app (T-0022), mounted once at the top level: the
 * approval dialog (when the daemon allows requests) and, after a code, QR or
 * approval login, "Face ID로 다음부터 바로 들어오기". T-0034: after any login
 * this browser's device key is registered (or proved); other devices'
 * first logins show "새 기기 로그인"; and a page whose session is gone
 * (signed out from another device) goes back to the login page.
 */
export function AuthLayer() {
  const [me, setMe] = useState<Me | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [devices, setDevices] = useState(false);
  /** S3: closed by the person, or never shown (not a QR login in Safari). */
  const [handoffClosed, setHandoffClosed] = useState(false);
  /** This device's rows in the device list: its notices are not news. */
  const own = useRef(new Set<string>());

  useEffect(() => {
    authFetch<Me>('/api/auth/me').then(
      (loaded) => {
        own.current.add(loaded.id);
        setMe(loaded);
        void ensureDeviceKey(loaded, (id) => own.current.add(id)).then((text) => {
          if (text) setToast({ text, list: true });
          // O5: then follow the host to its verified outside address, if it has one.
          else void moveByItself(loaded, (to) => setToast({ text: t('autoMove.moving', { host: new URL(to).host }) }));
        });
      },
      () => undefined,
    );
    const offMessage = transport.onMessage((msg) => {
      const time = (ms: number) =>
        new Date(ms).toLocaleTimeString(getLanguage() === 'ko' ? 'ko-KR' : 'en-US', { hour: '2-digit', minute: '2-digit' });
      // T-0052: another device opened or closed a shell on this PC.
      if (msg.type === 'shellNotice' && !own.current.has(msg.deviceId)) {
        setToast({ text: t(msg.action === 'open' ? 'auth.shellOpened' : 'auth.shellClosed', { name: msg.label, time: time(msg.at) }), list: true });
        return;
      }
      if (msg.type !== 'newDeviceLogin' || own.current.has(msg.id)) return;
      const at = time(msg.at);
      setToast({
        text: `${/^(\uae30\uae30 \uc5f4\uc1e0\uac00 \ubc14\ub00c\uc5c8\uc5b4\uc694|\ud328\uc2a4\ud0a4\uac00 \ucd94\uac00\ub410\uc5b4\uc694):/.test(msg.label) ? msg.label : t('auth.newLogin', { name: msg.label })} · ${at}`,
        list: true,
      });
    });
    // Signed out elsewhere: the socket closes and can't come back. Once the
    // server says this session is gone, the reload is the login page.
    let timer: number | undefined;
    const check = () =>
      // Not while hidden: showing the page again reconnects and checks.
      !document.hidden &&
      fetch('/api/auth/me', { credentials: 'same-origin' }).then(
        (res) => res.status === 401 && window.location.reload(),
        () => undefined, // the daemon is down: keep waiting
      );
    const offState = transport.onStateChange((state) => {
      window.clearInterval(timer);
      if (state !== 'reconnecting') return;
      void check();
      timer = window.setInterval(check, SESSION_CHECK_MS);
    });
    return () => {
      offMessage();
      offState();
      window.clearInterval(timer);
    };
  }, []);
  // O3: the new-device push opens the panel.
  useEffect(() => setSecurityOpener(() => setDevices(true)), []);
  useEffect(() => {
    if (!toast || toast.list) return;
    const timer = window.setTimeout(() => setToast(null), 5000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const say = (text: string) => setToast({ text });
  const handoffOpen = !!me?.handoff && !handoffClosed && isPhoneSafariTab();
  return (
    <>
      <StepUpPrompt />
      {me?.approvals && <ApprovalDialog onDone={say} />}
      {me && <RemoteBanner me={me} />}
      {me && <AccessStart />}
      {me && <UpdateNotice />}
      {handoffOpen && <HandoffPrompt onClose={() => setHandoffClosed(true)} />}
      {me && !handoffOpen && shouldPrompt(me) && <PasskeyPrompt onDone={say} />}
      {toast && (
        <FloatingToast
          key={toast.text}
          testId="auth-toast"
          className="fixed left-1/2 -translate-x-1/2 bottom-[calc(var(--cld-toast-bottom)+8px)] z-[75] w-max max-w-[min(420px,calc(100vw-32px))] cursor-pointer"
          frameClassName="px-12 py-8 text-sm"
          onDismiss={() => setToast(null)}
          onTap={() => setToast(null)}
        >
          <div className="flex items-center gap-8">
            <span className="min-w-0">{toast.text}</span>
            {toast.list && (
              <Button
                size="sm"
                variant="accent"
                className="shrink-0 whitespace-nowrap"
                onClick={() => setDevices(true)}
              >
                {t('auth.deviceList')}
              </Button>
            )}
          </div>
        </FloatingToast>
      )}
      {devices && <SecurityModal onClose={() => setDevices(false)} />}
    </>
  );
}

/** After a helped login, on a device that has not said 나중에. Whether THIS device
 *  holds a passkey can't be asked without a ceremony, so another device's
 *  passkey for the same address does not silence it. */
function shouldPrompt(me: Me): boolean {
  if (!me.passkeys || !PROMPT_AFTER.includes(me.method)) return false;
  if (!browserSupportsWebAuthn()) return false;
  try {
    return localStorage.getItem(DISMISSED_KEY) !== '1';
  } catch {
    return true;
  }
}

function PasskeyPrompt({ onDone }: { onDone: (text: string) => void }) {
  const [open, setOpen] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // 나중에, a registration, or "this device already has one": stop asking on this device.
  const stopAsking = () => {
    try {
      localStorage.setItem(DISMISSED_KEY, '1');
    } catch {
      /* private mode: ask again next time */
    }
    setOpen(false);
  };
  if (!open) return null;
  return (
    <Modal isOpen onClose={stopAsking} title={t('auth.quickLogin')} zIndex={65}>
      <div className="px-10 pb-10 flex flex-col gap-10 max-w-[400px]" data-testid="passkey-prompt">
        <p className="text-base m-0">{t('auth.quickLoginCall')}</p>
        <p className="text-sm text-text-muted m-0">
          {t('auth.quickLoginInfo')}
        </p>
        {error && <p className="text-sm text-red-400 m-0">{error}</p>}
        <div className="flex justify-end gap-8">
          <Button
            size="sm"
            variant="accent"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                await registerPasskey();
                stopAsking();
                onDone(t('auth.passkeyRegisteredNext'));
              } catch (err) {
                // excludeCredentials matched: the authenticator already holds one for this address.
                if (err instanceof Error && err.name === 'InvalidStateError') {
                  stopAsking();
                  onDone(
                    t('auth.passkeyAlreadyHere'),
                  );
                } else setError(passkeyError(err));
              } finally {
                setBusy(false);
              }
            }}
          >
            {t('auth.registerPasskey')}
          </Button>
          <Button size="sm" onClick={stopAsking}>
            {t('auth.later')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
