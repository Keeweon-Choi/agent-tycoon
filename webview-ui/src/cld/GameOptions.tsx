import { type ReactNode, useEffect, useState } from 'react';

import { Button } from '../components/ui/Button.js';
import { Modal } from '../components/ui/Modal.js';
import { useIsMobile } from '../hooks/useIsMobile.js';
import { setLanguage, t, useLanguage } from '../i18n/index.js';
import { IME_GUARD_OFF_KEY } from '../terminal/imeGuard.js';
import { AgentRulesOption } from './AgentRulesOption.js';
import { AccessButton } from './auth/Access.js';
import { SecurityButton } from './auth/SecurityPanel.js';
import { bypassReadOnly, chooseBypass, useBypass } from './bypass.js';
import { PixelSprite } from './ez/PixelSprite.js';
import { rankSprite } from './ez/rankSprites.js';
import { nameplatesOn, setNameplates } from './ez/useNameplates.js';
import { setStackedView, useFloors } from './floors.js';
import { setBackdrop, useBackdrop } from './gfx/backdrop.js';
import { setTitleAtStart, useTitleScene } from './gfx/titleSceneState.js';
import { applyLayoutPreset, resetLayout } from './hud/hudStore.js';
import { type Preset, PRESETS } from './hud/layout.js';
import { fromClock, setOfficeHours, toClock, useOfficeHours } from './officeHours.js';
import { panelAvailable, useCldStore } from './officeStore.js';
import { OwnerPictureOption } from './OwnerPictureOption.js';
import { getRankStyle, RANK_STYLES, setRankStyle } from './rank.js';
import { SettingRow } from './SettingRow.js';
import { setSettingsOpener, type SettingsTab } from './settingsOpen.js';
import { StartPolicyOption } from './StartPolicyOption.js';
import { AttachCapOption } from './terminal/AttachCapOption.js';
import { setUiScale, UI_SCALES, useUiScale } from './uiScale.js';
import { isEdgeScrollOn, setEdgeScroll } from './useGameControls.js';

/** O4: the permission mode NEW agents start with; existing agents keep theirs (each agent's own settings change it). */
function BypassOption() {
  const { mode, error } = useBypass();
  const cld = useCldStore();
  if (bypassReadOnly(cld)) return null;
  const on = mode === 'bypass';
  return (
    <SettingRow
      testId="bypass-option"
      title={t('settings.bypass.title')}
      help={t('settings.bypass.help')}
      note={
        error && (
          <p className="text-sm text-red-400" role="alert">
            {['read_only', 'stepup', 'write_failed'].includes(error) ? t('onboarding.bypass.refused') : error}
          </p>
        )
      }
    >
      <Button
        size="sm"
        variant={on ? 'active' : 'default'}
        aria-pressed={on}
        onClick={() => chooseBypass(on ? 'ask' : 'bypass')}
      >
        {t(on ? 'settings.bypass.on' : 'settings.bypass.off')}
      </Button>
    </SettingRow>
  );
}

/** U-33: the terminal's Korean (IME) layer. Off = xterm's own path: the way back when a phone keyboard disagrees. */
function ImeGuardOption() {
  const [on, setOn] = useState(() => {
    try {
      return localStorage.getItem(IME_GUARD_OFF_KEY) !== 'off';
    } catch {
      return true;
    }
  });
  return (
    <SettingRow testId="ime-guard-option" title={t('settings.imeGuard.title')} help={t('settings.imeGuard.help')}>
      <Button
        size="sm"
        variant={on ? 'active' : 'default'}
        aria-pressed={on}
        onClick={() => {
          try {
            if (on) localStorage.setItem(IME_GUARD_OFF_KEY, 'off');
            else localStorage.removeItem(IME_GUARD_OFF_KEY);
            setOn(!on);
          } catch {
            // No storage (private mode): the layer stays on.
          }
        }}
      >
        {t(on ? 'settings.imeGuard.on' : 'settings.imeGuard.off')}
      </Button>
    </SettingRow>
  );
}

/** The settings' sections, in order; the last one picked is remembered per browser. */
const SETTINGS_TABS = ['general', 'display', 'access', 'security', 'advanced'] as const satisfies readonly SettingsTab[];
const SETTINGS_TAB_KEY = 'cld.settings-tab';

function readTab(): SettingsTab {
  try {
    const saved = localStorage.getItem(SETTINGS_TAB_KEY);
    return SETTINGS_TABS.find((id) => id === saved) ?? 'general';
  } catch {
    return 'general';
  }
}

/** Over the office's overlays and panels, like the other cld dialogs. */
const OPTIONS_Z_INDEX = 60;

/** A fixed width, so switching tabs does not resize the window. */
const OPTIONS_WIDTH = 'w-[min(480px,100%)]';

/** Rows outside a tab (the install hint, the phone's quick row): the tab panel's own side padding. */
const bar = 'flex items-center gap-8 px-10 pb-8';
/** A tab's content: one padding for the whole window width, one gap between rows and sections. */
const panelClass = 'flex flex-col gap-12 px-10 pb-10 pt-6';
/** A time or number field: the height of a small button. */
const field = 'h-28 bg-bg border-2 border-border px-4 text-sm pointer-coarse:min-h-44';
const INSTALL_HINT_KEY = 'cld.install-hint-dismissed';

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

let pendingInstallPrompt: InstallPromptEvent | null = null;
let appWasInstalled = false;
const installStateListeners = new Set<() => void>();
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    pendingInstallPrompt = event as InstallPromptEvent;
    installStateListeners.forEach((listener) => listener());
  });
  window.addEventListener('appinstalled', () => {
    appWasInstalled = true;
    pendingInstallPrompt = null;
    installStateListeners.forEach((listener) => listener());
  });
}

function isIosSafari(): boolean {
  const ua = navigator.userAgent;
  const ios =
    /iPhone|iPad|iPod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return ios && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
}

function useInstallApp() {
  const [promptEvent, setPromptEvent] = useState<InstallPromptEvent | null>(pendingInstallPrompt);
  const [installed, setInstalled] = useState(appWasInstalled);
  const [hintDismissed, setHintDismissed] = useState(() => {
    try {
      return localStorage.getItem(INSTALL_HINT_KEY) === '1';
    } catch {
      return true;
    }
  });
  const iosSafari = isIosSafari();

  useEffect(() => {
    const media = window.matchMedia('(display-mode: standalone)');
    const syncInstalled = () =>
      setInstalled(
        appWasInstalled ||
          media.matches ||
          (navigator as Navigator & { standalone?: boolean }).standalone === true,
      );
    const syncPrompt = () => {
      setPromptEvent(pendingInstallPrompt);
      syncInstalled();
    };
    installStateListeners.add(syncPrompt);
    syncPrompt();
    media.addEventListener('change', syncInstalled);
    if (window.isSecureContext && 'serviceWorker' in navigator) {
      void navigator.serviceWorker
        .register(new URL('sw.js', document.baseURI))
        .catch((error: unknown) =>
          console.warn('[cld install] service worker registration failed', error),
        );
    }
    return () => {
      installStateListeners.delete(syncPrompt);
      media.removeEventListener('change', syncInstalled);
    };
  }, []);

  const dismissHint = () => {
    setHintDismissed(true);
    try {
      localStorage.setItem(INSTALL_HINT_KEY, '1');
    } catch {
      // The install button remains available if storage is blocked.
    }
  };
  const install = async () => {
    if (!promptEvent) return;
    await promptEvent.prompt();
    await promptEvent.userChoice;
    pendingInstallPrompt = null;
    setPromptEvent(null);
    dismissHint();
  };

  return { promptEvent, installed, hintDismissed, iosSafari, dismissHint, install };
}

type InstallAppState = ReturnType<typeof useInstallApp>;

function InstallAppOptions({ promptEvent, installed, iosSafari, install }: InstallAppState) {
  const instructions = installed
    ? t('settings.install.running')
    : iosSafari
      ? t('settings.install.ios')
      : promptEvent
        ? t('settings.install.available')
        : t('settings.install.manual');

  return (
    <SettingRow
      testId="install-app-option"
      title={t('settings.install.title')}
      help={instructions}
      note={
        iosSafari &&
        !installed && (
            <svg
              aria-label={t('settings.install.share')}
              role="img"
              viewBox="0 0 180 44"
              className="mt-6 h-40 w-180 text-text-muted"
            >
              <rect x="1" y="1" width="178" height="42" rx="5" fill="none" stroke="currentColor" />
              <path
                d="M28 28V16m-5 5 5-5 5 5m-10 5h10"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              />
              <text x="46" y="27" fill="currentColor" fontSize="11">
                {t('settings.install.shareShort')}
              </text>
              <path d="M78 22h18m-9-9v18" stroke="currentColor" strokeWidth="2" />
              <text x="104" y="27" fill="currentColor" fontSize="11">
                {t('settings.install.homeScreen')}
              </text>
            </svg>
        )
      }
    >
      <Button
        size="sm"
        onClick={install}
        disabled={installed || (!!promptEvent === false && !iosSafari)}
      >
        {t('settings.install.title')}
      </Button>
    </SettingRow>
  );
}

/** T-0041: office hours (cosmetic: when the staff go home) and how long temps linger. */
function OfficeHoursOptions() {
  const h = useOfficeHours();
  return (
    <div className="flex flex-col gap-8" data-testid="office-hours-options">
      <SettingRow title={t('settings.hours.title')} help={t('settings.hours.help')}>
        <Button
          size="sm"
          variant={h.on ? 'active' : 'default'}
          aria-pressed={h.on}
          aria-label={t('settings.hours.title')}
          onClick={() => setOfficeHours({ on: !h.on })}
        >
          {h.on ? t('settings.on') : t('settings.off')}
        </Button>
      </SettingRow>
      {h.on && (
        <>
          <div className="flex items-center gap-8 text-sm">
            <input
              type="time"
              className={field}
              aria-label={t('settings.hours.start')}
              value={toClock(h.start)}
              onChange={(e) => {
                const v = fromClock(e.target.value);
                if (v !== null && v !== h.end) setOfficeHours({ start: v });
              }}
            />
            <span>~</span>
            <input
              type="time"
              className={field}
              aria-label={t('settings.hours.end')}
              value={toClock(h.end)}
              onChange={(e) => {
                const v = fromClock(e.target.value);
                if (v !== null && v !== h.start) setOfficeHours({ end: v });
              }}
            />
          </div>
          <div className="flex flex-wrap gap-4" role="group" aria-label={t('settings.hours.days')}>
            {(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const).map((name, day) => {
              const on = h.days.includes(day);
              return (
                <Button
                  key={name}
                  size="sm"
                  variant={on ? 'active' : 'default'}
                  aria-pressed={on}
                  onClick={() =>
                    setOfficeHours({
                      days: on ? h.days.filter((d) => d !== day) : [...h.days, day],
                    })
                  }
                >
                  {t(`settings.weekday.${name}`)}
                </Button>
              );
            })}
          </div>
        </>
      )}
      <SettingRow title={t('settings.hours.linger')} help={t('settings.hours.lingerHelp')}>
        <input
          type="number"
          min={0}
          max={240}
          className={`${field} w-64`}
          aria-label={t('settings.hours.minutesLabel')}
          value={h.lingerMin}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (Number.isFinite(v) && v >= 0) setOfficeHours({ lingerMin: v });
          }}
        />
        <span className="self-center text-sm">{t('settings.hours.minutes')}</span>
      </SettingRow>
    </div>
  );
}

/** T-0111: three ready-made arrangements of the icons and windows (desktop; a phone has pages). */
function LayoutPresets() {
  const store = useCldStore();
  const [picked, setPicked] = useState<Preset | null>(null);
  const icons = [
    'office',
    'workbench',
    ...(store.officeSnapshot?.chat ? ['messenger'] : []),
    'notices',
    ...(panelAvailable('terminal', store) ? ['terminal'] : []),
    'files',
  ];
  const pick = (preset: Preset) => {
    applyLayoutPreset(preset, icons);
    setPicked(preset);
  };
  return (
    <SettingRow
      testId="hud-preset-option"
      title={t('settings.layoutPresets.title')}
      help={t('settings.layoutPresets.help')}
      stacked
    >
      <div className="flex flex-wrap gap-4" role="group" aria-label={t('settings.layoutPresets.title')}>
        {PRESETS.map((p) => (
          <Button
            key={p.id}
            size="sm"
            variant={picked === p.id ? 'active' : 'default'}
            aria-pressed={picked === p.id}
            title={t(`settings.layoutPresets.${p.id}Hint`)}
            onClick={() => pick(p.id)}
          >
            {t(`settings.layoutPresets.${p.id}`)}
          </Button>
        ))}
      </div>
    </SettingRow>
  );
}

/** GFX: the night skyline behind the office, and its gentle parallax (off unless asked). */
function BackdropOptions() {
  const { on, parallax } = useBackdrop();
  const { atStart } = useTitleScene();
  return (
    <>
      <SettingRow testId="title-scene-option" title={t('gfx.titleOption.title')} help={t('gfx.titleOption.help')}>
        <Button size="sm" variant={atStart ? 'active' : 'default'} aria-pressed={atStart} onClick={() => setTitleAtStart(!atStart)}>
          {atStart ? t('settings.on') : t('settings.off')}
        </Button>
      </SettingRow>
      <SettingRow testId="backdrop-option" title={t('gfx.backdrop.title')} help={t('gfx.backdrop.help')}>
        <Button size="sm" variant={on ? 'active' : 'default'} aria-pressed={on} onClick={() => setBackdrop({ on: !on })}>
          {on ? t('settings.on') : t('settings.off')}
        </Button>
      </SettingRow>
      <SettingRow testId="backdrop-parallax-option" title={t('gfx.parallax.title')} help={t('gfx.parallax.help')}>
        <Button
          size="sm"
          variant={parallax ? 'active' : 'default'}
          aria-pressed={parallax}
          disabled={!on}
          onClick={() => setBackdrop({ parallax: !parallax })}
        >
          {parallax ? t('settings.on') : t('settings.off')}
        </Button>
      </SettingRow>
    </>
  );
}

/** The top bar settings: office hours, floor view, and mouse edge scrolling. */
export function GameOptions({ quick }: { quick?: ReactNode } = {}) {
  const language = useLanguage();
  const uiScale = useUiScale();
  const [open, setOpen] = useState(false);
  const [edge, setEdge] = useState(isEdgeScrollOn);
  const [plates, setPlates] = useState(nameplatesOn);
  const [rankStyle, setRankStyleState] = useState(getRankStyle);
  const installApp = useInstallApp();
  const { stacked } = useFloors();
  const mobile = useIsMobile();
  const [tab, setTab] = useState(readTab);
  const chooseTab = (id: SettingsTab) => {
    setTab(id);
    try {
      localStorage.setItem(SETTINGS_TAB_KEY, id);
    } catch {
      // No storage: the tab is only not remembered.
    }
  };
  // GFX: the title scene's menu opens this, on a tab.
  useEffect(
    () =>
      setSettingsOpener((id) => {
        if (id) setTab(id);
        setOpen(true);
      }),
    [],
  );
  const showHint =
    !installApp.hintDismissed &&
    !!(installApp.promptEvent || installApp.iosSafari) &&
    !installApp.installed;
  const hintBody = (
    <>
      <span className="flex-1">
        {installApp.iosSafari
          ? t('settings.install.hintIos')
          : t('settings.install.hint')}
      </span>
      {installApp.promptEvent && (
        <Button size="sm" onClick={installApp.install}>
          {t('settings.install.button')}
        </Button>
      )}
      <button type="button" aria-label={t('settings.install.dismiss')} onClick={installApp.dismissHint}>
        ×
      </button>
    </>
  );
  return (
    <>
      {/* Desktop: a floating note under the top bar. A phone's top bar grows by the
          safe-area inset, so a floating note covered 설정 there (T-0097): on a phone the
          same note is the first row of the 설정 menu, and a dot on 설정 points to it. */}
      {showHint && !mobile && (
        <div
          className="fixed right-12 top-52 z-[70] flex max-w-[300px] items-center gap-8 border border-border bg-bg p-8 text-sm shadow-lg"
          role="status"
        >
          {hintBody}
        </div>
      )}
      <Button
        size="icon_md"
        className="relative"
        aria-label={t('settings.title')}
        title={t('settings.title')}
        onClick={() => setOpen(true)}
      >
        <span className="material-symbols-sharp" aria-hidden="true">
          settings
        </span>
        {showHint && mobile && (
          <span
            data-testid="install-hint-dot"
            className="pointer-events-none absolute right-2 top-2 size-8 bg-accent-bright"
          />
        )}
      </Button>
      <Modal
        isOpen={open}
        onClose={() => setOpen(false)}
        title={t('settings.title')}
        zIndex={OPTIONS_Z_INDEX}
        className={OPTIONS_WIDTH}
      >
        {showHint && mobile && (
          <div className={bar} role="status" data-testid="install-hint">
            {hintBody}
          </div>
        )}
        {/* The phone's top bar keeps only the floor and 설정: what left it is here (owner 10-24). */}
        {quick && (
          <div
            className={`${bar} flex-wrap *:min-h-44`}
            role="group"
            aria-label={t('settings.quick')}
            data-testid="settings-quick"
          >
            {quick}
          </div>
        )}
        <div
          className="flex gap-4 overflow-x-auto px-10 pb-8"
          role="tablist"
          aria-label={t('settabs.label')}
          data-testid="settings-tabs"
        >
          {SETTINGS_TABS.map((id) => (
            <Button
              key={id}
              size="sm"
              role="tab"
              id={`settings-tab-${id}`}
              aria-selected={tab === id}
              aria-controls={`settings-panel-${id}`}
              variant={tab === id ? 'active' : 'default'}
              className="shrink-0"
              onClick={() => chooseTab(id)}
            >
              {t(`settabs.${id}`)}
            </Button>
          ))}
        </div>
        <div
          role="tabpanel"
          id="settings-panel-general"
          aria-labelledby="settings-tab-general"
          hidden={tab !== 'general'}
          className={panelClass}
          data-testid="settings-panel-general"
        >
          <InstallAppOptions {...installApp} />
          <SettingRow
            testId="language-option"
            title={t('settings.language')}
            help={t('settings.language.help')}
          >
            <div className="flex gap-4" role="group" aria-label={t('settings.language')}>
              {(['en', 'ko'] as const).map((choice) => (
                <Button
                  key={choice}
                  size="sm"
                  variant={language === choice ? 'active' : 'default'}
                  aria-pressed={language === choice}
                  onClick={() => setLanguage(choice)}
                >
                  {t(`settings.language.${choice === 'en' ? 'english' : 'korean'}`)}
                </Button>
              ))}
            </div>
          </SettingRow>
          <OwnerPictureOption />
          <OfficeHoursOptions />
        </div>
        <div
          role="tabpanel"
          id="settings-panel-display"
          aria-labelledby="settings-tab-display"
          hidden={tab !== 'display'}
          className={panelClass}
          data-testid="settings-panel-display"
        >
          {/* UI-SCALE: the whole UI's size, per browser (owner 10-24: the setting decides, not the screen). */}
          <SettingRow testId="ui-scale-option" title={t('settings.uiScale')} help={t('settings.uiScale.help')} stacked>
            <div className="flex flex-wrap gap-4" role="group" aria-label={t('settings.uiScale')}>
              {UI_SCALES.map((step) => (
                <Button
                  key={step}
                  size="sm"
                  variant={uiScale === step ? 'active' : 'default'}
                  aria-pressed={uiScale === step}
                  data-ui-scale={step}
                  onClick={() => setUiScale(step)}
                >
                  {t(`hud.${step}`)}
                </Button>
              ))}
            </div>
          </SettingRow>
          <SettingRow testId="floor-view-option" title={t('settings.floors.title')} help={t('settings.floors.help')} stacked>
            <div className="flex flex-wrap gap-4" role="group" aria-label={t('settings.floors.title')}>
              <Button
                size="sm"
                variant={stacked ? 'active' : 'default'}
                aria-pressed={stacked}
                onClick={() => setStackedView(true)}
              >
                {t('settings.floors.all')}
              </Button>
              <Button
                size="sm"
                variant={!stacked ? 'active' : 'default'}
                aria-pressed={!stacked}
                onClick={() => setStackedView(false)}
              >
                {t('settings.floors.one')}
              </Button>
            </div>
          </SettingRow>
          <BackdropOptions />
          <SettingRow testId="nameplates-option" title={t('settings.nameplates.title')} help={t('settings.nameplates.help')}>
            <Button
              size="sm"
              variant={plates ? 'active' : 'default'}
              aria-pressed={plates}
              aria-label={t('settings.nameplates.title')}
              onClick={() => {
                setNameplates(!plates);
                setPlates(!plates);
              }}
            >
              {plates ? t('settings.on') : t('settings.off')}
            </Button>
          </SettingRow>
          {/* RANK-LEVELS: how the rank icon beside a name is drawn, per browser. */}
          <SettingRow testId="rank-icon-option" title={t('settings.rankIcon')} help={t('settings.rankIcon.help')} stacked>
            <div className="flex flex-wrap gap-4" role="group" aria-label={t('settings.rankIcon')}>
              {RANK_STYLES.map((style) => (
                <Button
                  key={style}
                  size="sm"
                  variant={rankStyle === style ? 'active' : 'default'}
                  aria-pressed={rankStyle === style}
                  data-rank-style={style}
                  onClick={() => {
                    setRankStyle(style);
                    setRankStyleState(style);
                  }}
                >
                  <PixelSprite sprite={rankSprite(style, 'manager')} scale={2} />
                  {t(`settings.rankIcon.${style}`)}
                </Button>
              ))}
            </div>
          </SettingRow>
          <SettingRow className="pointer-coarse:hidden" title={t('settings.edge.title')} help={t('settings.edge.help')}>
            <Button
              size="sm"
              variant={edge ? 'active' : 'default'}
              aria-pressed={edge}
              aria-label={t('settings.edge.title')}
              onClick={() => {
                setEdgeScroll(!edge);
                setEdge(!edge);
              }}
            >
              {edge ? t('settings.on') : t('settings.off')}
            </Button>
          </SettingRow>
          {!mobile && <LayoutPresets />}
          <SettingRow testId="hud-reset-option" title={t('settings.layoutReset.title')} help={t('settings.layoutReset.help')}>
            <Button size="sm" onClick={resetLayout}>
              {t('settings.layoutReset.button')}
            </Button>
          </SettingRow>
        </div>
        <div
          role="tabpanel"
          id="settings-panel-access"
          aria-labelledby="settings-tab-access"
          hidden={tab !== 'access'}
          className={panelClass}
          data-testid="settings-panel-access"
        >
          <SettingRow testId="access-option" title={t('settings.access.title')} help={t('settings.access.help')}>
            <AccessButton />
          </SettingRow>
          <StartPolicyOption />
        </div>
        <div
          role="tabpanel"
          id="settings-panel-security"
          aria-labelledby="settings-tab-security"
          hidden={tab !== 'security'}
          className={panelClass}
          data-testid="settings-panel-security"
        >
          <BypassOption />
          <SettingRow
            testId="security-open-option"
            title={t('settabs.securityOpen.title')}
            help={t('settabs.securityOpen.help')}
          >
            <SecurityButton />
          </SettingRow>
        </div>
        <div
          role="tabpanel"
          id="settings-panel-advanced"
          aria-labelledby="settings-tab-advanced"
          hidden={tab !== 'advanced'}
          className={panelClass}
          data-testid="settings-panel-advanced"
        >
          <AttachCapOption />
          <ImeGuardOption />
          <AgentRulesOption />
        </div>
      </Modal>
    </>
  );
}
