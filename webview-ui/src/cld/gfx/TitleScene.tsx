/**
 * GFX title scene (owner 10-25): the owner's lobby art with the menu as real buttons over it.
 *
 * Shows on the first open of a browser session (unless turned off in 설정 > 화면) and from the
 * 로비 button in the office's corner. Never in the way: 사무실 입장 has the focus, so Enter or
 * Esc or one click or tap is the office. The office keeps running underneath (the daemon and
 * the agents carry on; the canvas draws nothing while covered: the loop is paced to idle).
 *
 * The status line is honest and free: the socket's own state and the connector the remote
 * banner already reads (GET /api/cld/connector, a local call). No usage, no hardware numbers,
 * no model call.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import type { TransportState } from '../../../../core/src/transport.js';
import { Button } from '../../components/ui/Button.js';
import { Modal } from '../../components/ui/Modal.js';
import { LAYOUT_UNITS_PER_PX, TITLE_LOGO, TITLE_SCENE_Z } from '../../constants.js';
import { t } from '../../i18n/index.js';
import { transport } from '../../transport/index.js';
import { authFetch } from '../auth/authApi.js';
import type { ConnectorStatus } from '../auth/Remote.js';
import { openSettings } from '../settingsOpen.js';
import logo from './art/logo-sign.png';
import tall from './art/title-tall.webp';
import wide from './art/title-wide.webp';
import { closeTitleScene, useTitleScene } from './titleScene.js';

function useTransportState(): TransportState {
  const [s, setS] = useState<TransportState>(transport.state);
  useEffect(() => {
    setS(transport.state);
    return transport.onStateChange(setS);
  }, []);
  return s;
}

/** The connector, once per opening; null while unknown (a viewer without access gets none). */
function useConnector(): ConnectorStatus['connector'] | null {
  const [c, setC] = useState<ConnectorStatus['connector'] | null>(null);
  useEffect(() => {
    let live = true;
    authFetch<ConnectorStatus>('/api/cld/connector').then(
      (s) => live && setC(s.connector),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);
  return c;
}

const MENU = ['remote', 'settings', 'help'] as const;

/** The owner's logo sign at the largest whole number of device px per art px that fits the
 *  title box's width (and a share of the window's height), never smoothed. */
function Logo() {
  const ref = useRef<HTMLHeadingElement>(null);
  const [css, setCss] = useState<number | null>(null); // CSS px per art px
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      const dpr = window.devicePixelRatio || 1;
      const most = Math.max(
        1,
        Math.floor(
          Math.min(
            (el.clientWidth * dpr) / TITLE_LOGO.w,
            (window.innerHeight * TITLE_LOGO.maxHeightShare * dpr) / TITLE_LOGO.h,
          ),
        ),
      );
      // The CSS size must be exact in the layout's 1/64 px units, or the browser resamples the
      // picture by a hair and smears one row of every block (dpr 3: 62 x 7/3 px is not exact).
      const exact = (k: number) =>
        [TITLE_LOGO.w, TITLE_LOGO.h].every((n) => {
          const v = ((n * k) / dpr) * LAYOUT_UNITS_PER_PX;
          return Math.abs(v - Math.round(v)) < 1e-6;
        });
      let k = most;
      while (k > 1 && !exact(k)) k--;
      setCss((exact(k) ? k : most) / dpr);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(el);
    window.addEventListener('resize', fit);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', fit);
    };
  }, []);
  return (
    <h1 ref={ref} className="m-0 leading-none">
      <img
        src={logo}
        alt={t('gfx.title.name')}
        draggable={false}
        data-testid="title-logo"
        className="block"
        style={{
          imageRendering: 'pixelated',
          width: css === null ? undefined : TITLE_LOGO.w * css,
          height: css === null ? undefined : TITLE_LOGO.h * css,
          visibility: css === null ? 'hidden' : undefined,
        }}
      />
    </h1>
  );
}

export function TitleScene({ phone }: { phone: boolean }) {
  const { open } = useTitleScene();
  return open ? createPortal(<Title phone={phone} />, document.body) : null;
}

function Title({ phone }: { phone: boolean }) {
  const [help, setHelp] = useState(false);
  const socket = useTransportState();
  const connector = useConnector();
  useEffect(() => {
    // Enter or Esc with nothing focused (a click on the picture) is the office too; a dialog
    // the menu opened keeps its own keys.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' && e.key !== 'Enter') return;
      if (document.querySelector('[role="dialog"]')) return;
      if (e.key === 'Enter' && document.activeElement && document.activeElement !== document.body)
        return; // a focused button does its own
      e.preventDefault();
      closeTitleScene();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const pick = (id: (typeof MENU)[number]) => {
    if (id === 'help') setHelp(true);
    else openSettings(id === 'remote' ? 'access' : undefined);
  };
  const daemon =
    socket === 'connected'
      ? 'connected'
      : socket === 'connecting' || socket === 'reconnecting'
        ? 'connecting'
        : 'down';
  const remote =
    connector === null ? null : connector === 'local' ? 'off' : connector === 'lan' ? 'lan' : 'on';
  return (
    <div
      className="fixed inset-0 overflow-hidden bg-bg select-none"
      style={{ zIndex: TITLE_SCENE_Z }}
      role="region"
      aria-label={t('gfx.title.region')}
      data-testid="title-scene"
    >
      <picture>
        <source media="(orientation: portrait)" srcSet={tall} />
        <img
          src={wide}
          alt=""
          draggable={false}
          className="absolute inset-0 w-full h-full object-cover"
          style={{ imageRendering: 'pixelated' }}
        />
      </picture>
      <div
        className={`absolute flex flex-col gap-8 ${
          phone
            ? 'left-0 right-0 bottom-0 items-stretch px-[calc(var(--cld-safe-left)+16px)] pb-[calc(var(--cld-safe-bottom)+16px)] pr-[calc(var(--cld-safe-right)+16px)]'
            : 'top-1/2 -translate-y-1/2 left-[calc(var(--cld-safe-left)+6%)] w-[min(24rem,40vw)]'
        }`}
      >
        <div className="pixel-panel px-12 py-8">
          <Logo />
          <p className="m-0 mt-4 text-sm text-text-muted">{t('gfx.title.tagline')}</p>
        </div>
        <nav className="flex flex-col gap-4" aria-label={t('gfx.title.menu')}>
          <Button
            autoFocus
            size="md"
            variant="accent"
            className="justify-start! text-lg shadow-pixel"
            data-testid="title-enter"
            onClick={closeTitleScene}
          >
            {`▶ ${t('gfx.title.enter')}`}
          </Button>
          {MENU.map((id) => (
            <Button
              key={id}
              size="md"
              className="justify-start! shadow-pixel border-border!"
              data-testid={`title-${id}`}
              onClick={() => pick(id)}
            >
              {t(`gfx.title.${id}`)}
            </Button>
          ))}
        </nav>
        <p
          className="pixel-panel m-0 px-10 py-4 text-sm flex flex-wrap gap-x-12 gap-y-2"
          data-testid="title-status"
          aria-live="polite"
        >
          <span data-daemon={daemon}>{t(`gfx.title.daemon.${daemon}`)}</span>
          {remote && <span data-remote={remote}>{t(`gfx.title.remote.${remote}`)}</span>}
        </p>
      </div>
      {help && (
        <Modal isOpen onClose={() => setHelp(false)} title={t('gfx.title.help')}>
          <ul className="m-0 px-24 pb-10 text-sm flex flex-col gap-4" data-testid="title-help-text">
            {(['camera', 'floors', 'select', 'modes', 'legend'] as const).map((k) => (
              <li key={k}>{t(`gfx.help.${k}`)}</li>
            ))}
          </ul>
        </Modal>
      )}
    </div>
  );
}
