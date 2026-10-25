/**
 * The terminal workspace (T-0078): every terminal of this device as a tab, in
 * up to 2x2 panes on a desktop and one pane at a time on a phone -- trusted-
 * device shells (T-0052) and a background session's `claude attach`
 * (터미널로 보기, T-0014). It is the content of the 터미널 panel.
 *
 * x on a tab only detaches: the shell keeps running in its tmux session
 * (listed under 닫은 터미널 to reopen), the agent's session keeps running and
 * its `claude attach` ends with its last viewer. All terminals are mounted
 * once, in a flat list placed by the pane grid, so a split or a move never
 * remounts an xterm (it would lose its scrollback and reconnect).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { CHAT_WS_PREFIX } from '../../../../core/src/constants.js';
import { MobileKeyBar } from '../../components/MobileKeyBar.js';
import { submitTerminalLine } from '../../components/mobileSend.js';
import type { TerminalInputHandle } from '../../components/TerminalPane.js';
import { TerminalPane } from '../../components/TerminalPane.js';
import { Button } from '../../components/ui/Button.js';
import { MOBILE_TERMINAL_FONT_SIZE_PX } from '../../constants.js';
import { t } from '../../i18n/index.js';
import type { TerminalConnectionStatus } from '../../terminal/terminalClient.js';
import { transport } from '../../transport/index.js';
import { authFetch, type Me, passkeyError, stepUpText } from '../auth/authApi.js';
import { Relogin } from '../auth/Relogin.js';
import { FolderPicker } from '../FolderPicker.js';
import { useCldStore } from '../officeStore.js';
import {
  closeShell,
  deviceStepUp,
  ensureShellProof,
  listShells,
  openShell,
  passkeyStepUp,
  type ShellList,
  shellSocketPath,
} from '../shell/shellApi.js';
import {
  agentTab,
  canSplitDown,
  canSplitRight,
  leastRecentAttached,
  paneCount,
  paneRects,
  phoneKey,
  shellTab,
  type Tab,
  tabLabels,
  terminalMessages,
} from './workspace.js';
import {
  getWorkspace,
  OPEN_TERMINAL_EVENT,
  reportVisibleTabs,
  useWorkspace,
  workspaceActions,
} from './workspaceStore.js';

/** The pane's own bar on a desktop (select, close). */
const PANE_HEADER_PX = 26;
/** An agent's attach takes this long to leave the daemon after its socket closed. */
const RELEASE_SETTLE_MS = 150;
const SHELLS_PER_DEVICE = 3;

/** TerminalPane keys its callbacks by a number: one per tab, never an agent's. */
const paneNumbers = new Map<string, number>();
const keysByNumber = new Map<number, string>();
const paneNumber = (key: string) => {
  let n = paneNumbers.get(key);
  if (n === undefined) {
    n = -1_000_000 - paneNumbers.size;
    paneNumbers.set(key, n);
    keysByNumber.set(n, key);
  }
  return n;
};

const folderName = (cwd: string) => cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;

const dot: Record<TerminalConnectionStatus, string> = {
  connecting: 'text-yellow-300',
  reconnecting: 'text-yellow-300',
  connected: 'text-green-400',
  closed: 'text-text-muted',
};

export function TerminalWorkspace({
  mobile = false,
  keyboardOpen = false,
  onScreen = true,
}: {
  mobile?: boolean;
  keyboardOpen?: boolean;
  /** False while its window is closed but kept mounted (T-0077): nothing of it is on screen. */
  onScreen?: boolean;
}) {
  const ws = useWorkspace();
  const { hostInfo, officeSnapshot } = useCldStore();
  const [list, setList] = useState<ShellList | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [status, setStatus] = useState<Record<string, TerminalConnectionStatus>>({});
  /** Why a socket closed for good (the server's reason), per tab. */
  const [refusal, setRefusal] = useState<Record<string, string>>({});
  /** Bumped to mount a tab's terminal afresh (a new attach). */
  const [gens, setGens] = useState<Record<string, number>>({});
  /** Agent tabs the user swapped out ("이 터미널로 바꾸기"): not attached. */
  const [released, setReleased] = useState<ReadonlySet<string>>(new Set());
  const [menu, setMenu] = useState(false);
  const [picking, setPicking] = useState(false);
  /** Waiting for a Face ID tap before `then` runs. */
  const [pending, setPending] = useState<{ then: () => Promise<void> } | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const inputs = useRef(new Map<string, TerminalInputHandle>());
  const menuRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(() => {
    listShells().then(setList, () =>
      // No shells here (--allow-terminal is off): agents' terminals still work.
      setList({ shells: [], canOpen: false, device: '' }),
    );
  }, []);
  useEffect(() => {
    refresh();
    authFetch<Me>('/api/auth/me').then(setMe, () => undefined);
    return transport.onMessage((msg) => {
      if (msg.type === 'shellNotice') refresh();
    });
  }, [refresh]);

  useEffect(() => {
    if (!menu) return;
    const away = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener('pointerdown', away);
    return () => document.removeEventListener('pointerdown', away);
  }, [menu]);

  const panes = mobile
    ? [
        {
          row: ws.focus.row,
          col: ws.focus.col,
          key: phoneKey(ws),
          left: 0,
          top: 0,
          width: 100,
          height: 100,
        },
      ]
    : paneRects(ws);
  const placed = new Map(panes.filter((p) => p.key !== null).map((p) => [p.key as string, p]));
  const shownList = [...placed.keys()];
  const shownSig = onScreen ? shownList.join('|') : '';
  useEffect(() => {
    reportVisibleTabs(onScreen ? shownList : []);
    return () => reportVisibleTabs([]);
    // shownSig stands for shownList and onScreen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownSig]);

  // 터미널로 보기 with the workspace already open: the terminal takes the keyboard (not on a phone,
  // where it would raise the software keyboard). A beat later, so a click that closes the messenger
  // in the same gesture does not take the focus back.
  useEffect(() => {
    if (mobile) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onOpen = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const key = phoneKey(getWorkspace());
        if (key) inputs.current.get(key)?.focus();
      }, 250);
    };
    window.addEventListener(OPEN_TERMINAL_EVENT, onOpen);
    return () => {
      clearTimeout(timer);
      window.removeEventListener(OPEN_TERMINAL_EVENT, onOpen);
    };
  }, [mobile]);

  const run = async (what: () => Promise<void>) => {
    setBusy(true);
    setNote('');
    try {
      await what();
    } catch (err) {
      setNote(passkeyError(err));
    } finally {
      setBusy(false);
    }
  };

  /** The step-up, then `then`: the device key by itself, else a Face ID tap. */
  const withProof = (then: () => Promise<void>) =>
    run(async () => {
      if (!me) throw new Error(t('terminal.loadingLogin'));
      const why = await deviceStepUp(me);
      if (why === 'ok') return then();
      // A lost key or a busy limit says so; anything else, that nothing here can prove it.
      if (!me.passkeyHere)
        throw new Error(
          why === 'lostKey' || why === 'rate' ? stepUpText(why) : t('terminal.noProof'),
        );
      setPending({ then });
    });

  const own = list?.shells.filter((s) => s.deviceId === list.device) ?? [];
  const shellTabs = ws.tabs.filter((t) => t.kind === 'shell');
  const closedShells = own.filter((s) => !shellTabs.some((t) => t.ref === s.id));
  const agents = (officeSnapshot?.chat ? officeSnapshot.orchestrators : []).filter((o) => o.bg?.id);

  const remount = (key: string) => {
    setRefusal((r) => omit(r, key));
    setStatus((s) => omit(s, key));
    setGens((g) => ({ ...g, [key]: (g[key] ?? 0) + 1 }));
  };

  /**
   * "이 터미널로 바꾸기": attach this agent tab. When the daemon's cap (설정) has no room left,
   * the least recently focused attached agent tab lets go first.
   */
  const swapIn = async (key: string) => {
    let cap: number | null = null;
    try {
      cap = (await authFetch<{ attaches: number }>('/api/chat-attaches')).attaches;
    } catch {
      /* unknown: make room */
    }
    const attached = ws.tabs
      .filter(
        (t) =>
          t.kind === 'agent' &&
          t.key !== key &&
          !released.has(t.key) &&
          status[t.key] !== undefined &&
          status[t.key] !== 'closed',
      )
      .map((t) => t.key);
    const victim =
      cap !== null && attached.length < cap ? null : leastRecentAttached(ws, attached, key);
    if (victim) {
      setReleased((r) => new Set(r).add(victim));
      setStatus((s) => omit(s, victim));
    }
    // The old attach needs a moment to leave before the cap lets this one in.
    window.setTimeout(
      () => {
        setReleased((r) => {
          const next = new Set(r);
          next.delete(key);
          return next;
        });
        remount(key);
      },
      victim ? RELEASE_SETTLE_MS : 0,
    );
  };

  const openShellFolder = (cwd: string) =>
    withProof(async () => {
      const row = await openShell(cwd);
      workspaceActions.open(shellTab(row.id, folderName(row.cwd)));
      refresh();
    });

  const reopenShell = (id: string, cwd: string) => {
    setMenu(false);
    workspaceActions.open(shellTab(id, folderName(cwd)));
  };

  const endShell = (id: string) =>
    run(async () => {
      await closeShell(id);
      workspaceActions.close(`shell:${id}`);
      refresh();
    });

  const focusedKeyNow = phoneKey(ws);
  const names = tabLabels(ws);

  if (list && !list.canOpen && own.length === 0 && ws.tabs.length === 0 && agents.length === 0)
    return (
      <div className="flex flex-col gap-8 text-sm" data-testid="shell-panel">
        <p className="m-0">{t('terminal.cannotOpen')}</p>
        <p className="m-0 text-xs text-text-muted">{t('terminal.trustedOnly')}</p>
      </div>
    );

  const tabButton = (tab: Tab) => {
    const shown = placed.has(tab.key);
    const state = status[tab.key];
    return (
      <span
        key={tab.key}
        className={`shrink-0 flex items-center border ${shown ? 'border-accent' : 'border-border'}`}
        data-testid={tab.kind === 'shell' ? 'shell-tab' : 'agent-tab'}
      >
        <button
          type="button"
          role="tab"
          aria-selected={shown}
          className={`self-stretch px-8 text-xs flex items-center gap-4 ${compact ? '' : 'pointer-coarse:min-h-44'} ${shown ? 'text-accent-text' : 'text-text-muted'}`}
          title={
            tab.kind === 'agent'
              ? t('terminal.agentTitle', { name: names[tab.key] })
              : names[tab.key]
          }
          onClick={() => workspaceActions.show(tab.key)}
        >
          <span aria-hidden className={state ? dot[state] : 'text-text-muted'}>
            ●
          </span>
          {tab.kind === 'agent' && <span aria-hidden>▸</span>}
          {names[tab.key]}
        </button>
        <Button
          size="icon_md"
          variant="ghost"
          aria-label={t('terminal.closeTab', { name: names[tab.key] })}
          title={t('terminal.closeTabHint')}
          onClick={() => workspaceActions.close(tab.key)}
        >
          ×
        </Button>
      </span>
    );
  };

  // The software keyboard leaves few rows: no finger-sized strip then.
  const compact = mobile && keyboardOpen;
  const menuItem =
    'block w-full text-left px-8 py-4 text-xs hover:bg-btn-hover pointer-coarse:min-h-44 disabled:opacity-50';

  return (
    <div className="h-full min-h-0 flex flex-col gap-6" data-testid="shell-panel">
      <div
        className="shrink-0 relative flex items-center gap-4"
        ref={menuRef}
        data-touch-compact={compact ? '' : undefined}
      >
        <div
          className="flex-1 min-w-0 flex items-center gap-4 overflow-x-auto"
          role="tablist"
          aria-label={t('terminal.tabs')}
        >
          {ws.tabs.map(tabButton)}
        </div>
        <Button
          size="icon_md"
          variant="accent"
          aria-label={t('terminal.add')}
          aria-expanded={menu}
          disabled={busy}
          onClick={() => setMenu((open) => !open)}
        >
          +
        </Button>
        {!mobile && (
          <>
            <Button
              size="icon_md"
              aria-label={t('terminal.splitRight')}
              title={t('terminal.splitRight')}
              disabled={!canSplitRight(ws)}
              onClick={workspaceActions.splitRight}
            >
              ▥
            </Button>
            <Button
              size="icon_md"
              aria-label={t('terminal.splitDown')}
              title={t('terminal.splitDown')}
              disabled={!canSplitDown(ws)}
              onClick={workspaceActions.splitDown}
            >
              ▤
            </Button>
          </>
        )}
        {menu && (
          <div
            role="menu"
            aria-label={t('terminal.add')}
            className="pixel-panel absolute right-0 top-full mt-4 z-50 min-w-[220px] max-h-[60vh] overflow-y-auto py-4"
          >
            {list?.canOpen && (
              <button
                type="button"
                role="menuitem"
                className={menuItem}
                disabled={busy || own.length >= SHELLS_PER_DEVICE}
                title={
                  own.length >= SHELLS_PER_DEVICE
                    ? t('terminal.shellLimit', { count: SHELLS_PER_DEVICE })
                    : undefined
                }
                onClick={() => {
                  setMenu(false);
                  setPicking(true);
                }}
              >
                {t('terminal.new')}
              </button>
            )}
            {agents.length > 0 && (
              <>
                <p className="m-0 px-8 pt-6 text-xs text-text-muted">
                  {t('terminal.agentTerminals')}
                </p>
                {agents.map((o) => (
                  <button
                    key={o.bg!.id}
                    type="button"
                    role="menuitem"
                    className={menuItem}
                    onClick={() => {
                      setMenu(false);
                      workspaceActions.open(agentTab(o.bg!.id, o.name, o.agentId ?? undefined));
                    }}
                  >
                    {o.name}
                    {ws.tabs.some((tab) => tab.key === `agent:${o.bg!.id}`)
                      ? t('terminal.openSuffix')
                      : ''}
                  </button>
                ))}
              </>
            )}
            {closedShells.length > 0 && (
              <>
                <p className="m-0 px-8 pt-6 text-xs text-text-muted">
                  {t('terminal.closedTerminals')}
                </p>
                {closedShells.map((s) => (
                  <div key={s.id} className="flex items-center" data-testid="closed-shell">
                    <button
                      type="button"
                      role="menuitem"
                      className={`${menuItem} flex-1`}
                      title={s.cwd}
                      onClick={() => reopenShell(s.id, s.cwd)}
                    >
                      {t('terminal.reopen', { name: folderName(s.cwd) })}
                    </button>
                    <button
                      type="button"
                      className="px-8 py-4 text-xs text-text-muted border-l border-border pointer-coarse:min-h-44"
                      aria-label={t('terminal.endLabel', { name: folderName(s.cwd) })}
                      title={t('terminal.endHint')}
                      disabled={busy}
                      onClick={() => void endShell(s.id)}
                    >
                      {t('terminal.end')}
                    </button>
                  </div>
                ))}
              </>
            )}
            {!list?.canOpen && !agents.length && (
              <p className="m-0 px-8 py-4 text-xs text-text-muted">{t('terminal.noneAvailable')}</p>
            )}
          </div>
        )}
      </div>
      {pending && (
        <div className="shrink-0 flex items-center gap-8 text-xs">
          <span>{t('terminal.verifyBeforeOpen')}</span>
          <Button
            size="sm"
            variant="accent"
            disabled={busy}
            onClick={() => {
              const { then } = pending;
              setPending(null);
              void run(async () => {
                await passkeyStepUp();
                await then();
              });
            }}
          >
            {t('terminal.verifyFace')}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setPending(null)}>
            {t('common.cancel')}
          </Button>
        </div>
      )}
      {note && (
        <p className="shrink-0 m-0 text-xs text-yellow-300" role="status">
          {note}
        </p>
      )}
      <Relogin note={note} />
      <div className="relative flex-1 min-h-0 border border-border" data-testid="terminal-area">
        {ws.tabs.map((tab) => {
          const at = placed.get(tab.key);
          const header = mobile ? 0 : PANE_HEADER_PX;
          const mounted = !(tab.kind === 'agent' && released.has(tab.key));
          const focused = !!at && at.row === ws.focus.row && at.col === ws.focus.col;
          const why = refusal[tab.key];
          const closed = status[tab.key] === 'closed';
          return (
            <div
              key={tab.key}
              className={`absolute ${at ? '' : 'hidden'}`}
              data-testid="terminal-pane"
              data-tab={tab.key}
              style={
                at
                  ? {
                      left: `${at.left}%`,
                      top: `calc(${at.top}% + ${header}px)`,
                      width: `${at.width}%`,
                      height: `calc(${at.height}% - ${header}px)`,
                    }
                  : undefined
              }
              onMouseDownCapture={() => at && workspaceActions.focus(at.row, at.col)}
            >
              {mounted && (
                <TerminalPane
                  key={gens[tab.key] ?? 0}
                  agentId={paneNumber(tab.key)}
                  socketPath={
                    tab.kind === 'shell' ? shellSocketPath(tab.ref) : `${CHAT_WS_PREFIX}/${tab.ref}`
                  }
                  isActive={!!at}
                  mobileKeyBar={mobile}
                  autoFocus={!mobile && focused}
                  messages={terminalMessages()}
                  prepare={tab.kind === 'shell' ? ensureShellProof : undefined}
                  onStatusChange={(n, s) => {
                    const k = keysByNumber.get(n);
                    if (k) setStatus((prev) => ({ ...prev, [k]: s }));
                  }}
                  onRefused={(n, reason) => {
                    const k = keysByNumber.get(n);
                    if (k) setRefusal((prev) => ({ ...prev, [k]: reason }));
                  }}
                  onRegisterInput={(n, handle) => {
                    const k = keysByNumber.get(n);
                    if (!k) return;
                    if (handle) inputs.current.set(k, handle);
                    else inputs.current.delete(k);
                  }}
                  {...(mobile && { fontSizePx: MOBILE_TERMINAL_FONT_SIZE_PX, autoFocus: false })}
                />
              )}
              {at && (!mounted || (closed && why)) && (
                <div
                  className="absolute inset-0 flex flex-col items-center justify-center gap-8 p-12 text-center text-xs bg-bg/90"
                  data-testid="terminal-overlay"
                >
                  {!mounted || why === 'cap' ? (
                    <>
                      <strong className="text-sm">{names[tab.key]}</strong>
                      <span className="text-text-muted">
                        {mounted ? t('terminal.capReached') : t('terminal.detached')}
                      </span>
                      <Button size="sm" variant="accent" onClick={() => void swapIn(tab.key)}>
                        {t('terminal.switchHere')}
                      </Button>
                    </>
                  ) : why === 'proof' ? (
                    <>
                      <span>{t('terminal.verifyReconnect')}</span>
                      <Button
                        size="sm"
                        variant="accent"
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            await passkeyStepUp();
                            remount(tab.key);
                          })
                        }
                      >
                        {t('terminal.verifyFace')}
                      </Button>
                    </>
                  ) : tab.kind === 'agent' && why === 'refused' ? (
                    <Button size="sm" onClick={() => remount(tab.key)}>
                      {t('terminal.reconnect')}
                    </Button>
                  ) : null}
                </div>
              )}
            </div>
          );
        })}
        {!mobile &&
          panes.map((p) => {
            const here = p.key ? ws.tabs.find((t) => t.key === p.key) : undefined;
            const focused = p.row === ws.focus.row && p.col === ws.focus.col;
            return (
              <div
                key={`${String(p.row)}:${String(p.col)}`}
                className={`absolute pointer-events-none border ${focused && paneCount(ws) > 1 ? 'border-accent' : 'border-border'}`}
                style={{
                  left: `${p.left}%`,
                  top: `${p.top}%`,
                  width: `${p.width}%`,
                  height: `${p.height}%`,
                }}
                data-testid="pane-frame"
              >
                <div
                  className="pointer-events-auto flex items-center gap-4 px-4 bg-bg-dark border-b border-border"
                  style={{ height: PANE_HEADER_PX }}
                  onMouseDown={() => workspaceActions.focus(p.row, p.col)}
                >
                  <select
                    className="flex-1 min-w-0 bg-bg border border-border text-xs"
                    aria-label={t('terminal.showInPane')}
                    value={p.key ?? ''}
                    onChange={(e) =>
                      workspaceActions.showInPane(p.row, p.col, e.target.value || null)
                    }
                  >
                    <option value="">
                      {here ? t('terminal.emptyPane') : t('terminal.choosePane')}
                    </option>
                    {ws.tabs.map((t) => (
                      <option key={t.key} value={t.key}>
                        {names[t.key]}
                      </option>
                    ))}
                  </select>
                  {paneCount(ws) > 1 && (
                    <button
                      type="button"
                      className="px-4 text-xs text-text-muted"
                      aria-label={t('terminal.closePane')}
                      title={t('terminal.closePaneHint')}
                      onClick={() => workspaceActions.closePane(p.row, p.col)}
                    >
                      ×
                    </button>
                  )}
                </div>
                {!here && (
                  <div className="absolute inset-x-0 top-[26px] bottom-0 flex items-center justify-center p-12 text-center text-xs text-text-muted">
                    {ws.tabs.length ? t('terminal.chooseTerminal') : t('terminal.openWithPlus')}
                  </div>
                )}
              </div>
            );
          })}
        {mobile && !focusedKeyNow && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-8 p-12 text-center text-xs text-text-muted">
            <span>{t('terminal.openLocalOrAgent')}</span>
          </div>
        )}
      </div>
      {mobile && keyboardOpen && focusedKeyNow && (
        <MobileKeyBar
          onKey={(seq) => inputs.current.get(focusedKeyNow)?.send(seq)}
          onSend={() => {
            const input = inputs.current.get(focusedKeyNow);
            if (input) submitTerminalLine(input);
          }}
        />
      )}
      {picking &&
        createPortal(
          <FolderPicker
            start={hostInfo?.home ?? ''}
            onPick={(cwd) => {
              setPicking(false);
              void openShellFolder(cwd);
            }}
            onClose={() => setPicking(false)}
          />,
          document.body,
        )}
    </div>
  );
}

function omit<T>(record: Record<string, T>, key: string): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}
