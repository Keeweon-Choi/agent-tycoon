/**
 * FEAT-HUD-CONTROL-CENTER (owner 11-06 17:12, 안 C, mockups specs/ui-mock-1106/bottom-left/C2-*): the PC office's
 * one bottom-left control center. Folded, a tile of separate targets: the notifications (unread count, the latest
 * line; opens the notification panel), the usage of the two agents closest to their limits (opens the usage part
 * alone), what runs now (opens the jobs list), the host clock, and ⊞ (opens everything). Open, one panel grows up
 * from the corner: the latest news, every agent's usage (the same row for each, controlCenter.usageView), 실행 중
 * and 시간, and the menu's tiles 기기 추가 · 보안 · 범례 · 설정 (their dialogs portal, so the tiles stay mounted).
 * It replaced the bottom-left notification bar, the bottom-right usage panel and the corner's ≡ menu. No timer or
 * poll of its own: the stores and HostClock.
 */
import './controlCenter.css';

import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { compareVersions } from '../../../../core/src/agent-tycoon/versionCompare.js';
import { CC_BAR_SEGMENTS, CC_FOLDED_AGENTS, CC_NEWS_ROWS, MEMBER_SHEET_Z } from '../../constants.js';
import { t } from '../../i18n/index.js';
import { writeClipboardText } from '../../terminal/clipboard.js';
import { AddDeviceButton } from '../auth/AddDevice.js';
import { ago } from '../auth/authApi.js';
import { SecurityButton } from '../auth/SecurityPanel.js';
import { capsOf, cliLatestOf, cliVersionOf, meteredTag, noLimitsText, staleSessions } from '../engine.js';
import { useEngineStore } from '../engineStore.js';
import { ActivityLegend } from '../ez/ActivityLegend.js';
import { resetClock } from '../format.js';
import { useGameLooks } from '../game/gameLooks.js';
import { gaugeTone, partyState } from '../game/gameState.js';
import { openJobs } from '../game/openJobs.js';
import { PixelIcon, SegBar } from '../game/parts.js';
import { HostClock } from '../HostClock.js';
import { AgentMark } from '../icons/AgentMark.js';
import { bodyOf, mergeNews, type NewsItem } from '../notify/newsList.js';
import type { OpenTarget } from '../notify/NoticeLayer.js';
import { markRead, unreadCount, useNotices } from '../notify/notices.js';
import { useAgtyStore } from '../officeStore.js';
import { workCounts } from '../panels/jobs.js';
import { openSettings } from '../settingsOpen.js';
import { useUiTheme } from '../uiTheme.js';
import { useWaitReasons } from '../waiting.js';
import { useNow } from '../workbench/workbenchStore.js';
import { type AgentUpdateView, updateAgentCli, useAgentUpdate, useUsagePanel } from './agentUpdate.js';
import { type AgentUsage, type CcLocal, type CcPart, ccPart, ccPress, closest, PHONE_FOLD_LEVELS, phoneFolded, usageAsOf, usageView,type UsageWindowView } from './controlCenterModel.js';
import { CloseGlyph } from './glyphs.js';
import { closeWindow, noticesExpanded, openWindow, useHud } from './hudStore.js';
import { useSummaryStyle } from './summaryStyle.js';
import { UsageRefresh } from './UsageRefresh.js';
import { layerZ } from './windowModel.js';

const pct = (left: number) => (
  <span className="cc-pct" data-tone={gaugeTone(left)}>
    {left}%
  </span>
);

/** A window's bar: what is LEFT. 모던 draws it smooth, 픽셀 감성 as HP cells (controlCenter.css). */
const Bar = ({ left, small = false }: { left: number; small?: boolean }) => (
  <SegBar
    value={left}
    max={100}
    segments={CC_BAR_SEGMENTS}
    tone={gaugeTone(left) === 'warn' ? 'warn' : gaugeTone(left) === 'zero' ? 'bad' : 'ok'}
    className={`cc-bar${small ? ' cc-bar-sm' : ''}`}
  />
);

/** An agent's own mark (its logo, else its initial on its own hue); a row with no agent id keeps the plain initial. */
const Mark = ({ name, id }: { name: string; id?: string }) =>
  id ? (
    <AgentMark id={id} name={name} className="cc-mark" />
  ) : (
    <span className="cc-mark" aria-hidden="true">
      {name.slice(0, 1).toUpperCase()}
    </span>
  );

function WindowRow({ w }: { w: UsageWindowView }) {
  const time = resetClock(w.resetAt);
  return (
    <div className="cc-win" title={w.title} data-testid="cc-window" data-left={w.leftPct ?? ''}>
      <span className="cc-win-label">{w.label}</span>
      {w.leftPct === null ? (
        <span className="cc-muted">{t('usage.unknownShort')}</span>
      ) : (
        <>
          <Bar left={w.leftPct} />
          <span className="cc-win-left">
            {pct(w.leftPct)} <span className="cc-muted">{t('controlCenter.left')}</span>
          </span>
        </>
      )}
      {time && <span className="cc-win-reset">{t('usage.resetAt', { time })}</span>}
    </div>
  );
}

/** One agent's folded row (owner 11-06 22:23): logo, name, then each window it shows (`5시간 ▬ N%` and `주간 ▬ N%` side
 *  by side for a 5-hour plan), every window with its own hover line. The phone has no bar and says 남음 instead;
 *  the status line (`compact`) keeps the logo only. */
type FoldEntry = { agent: AgentUsage; window?: UsageWindowView; windows: UsageWindowView[] };

function FoldRow({ entry: { agent, window, windows }, phone = false, compact = false, children }: { entry: FoldEntry; phone?: boolean; compact?: boolean; children?: ReactNode }) {
  return (
    <span className="cc-fold-row" data-agent={agent.id} data-left={window?.leftPct ?? ''} title={compact ? agent.agent : undefined}>
      <Mark name={agent.agent} id={agent.id} />
      {!compact && <strong className="cc-strong cc-fold-name">{agent.agent}</strong>}
      {!windows.length && <span className="cc-muted cc-fold-win">{t('controlCenter.noLimit')}</span>}
      <span className="cc-fold-wins" data-n={windows.length}>
        {windows.map((w) => (
          <span key={w.id} className="cc-fold-w" title={w.title} data-window={w.id} data-left={w.leftPct ?? ''}>
            <span className="cc-muted cc-fold-win">{w.label}</span>
            {phone ? <span className="cc-muted cc-fold-left">{t('controlCenter.left')}</span> : <Bar left={w.leftPct!} small />}
            {pct(w.leftPct!)}
          </span>
        ))}
      </span>
      {children}
    </span>
  );
}

const UPDATE_REFUSALS = {
  busy: 'agentUpdate.refused.busy',
  missing: 'agentUpdate.refused.missing',
  read_only: 'agentUpdate.refused.read_only',
  unsupported: 'agentUpdate.refused.unsupported',
  stepup: 'agentUpdate.refused.stepup',
} as const;

/** The package manager's command the CLI gave, picked out and copyable (run on the host). */
function ManualCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="cc-update-cmd-row">
      <code className="cc-update-cmd" data-testid="cc-update-cmd">
        {command}
      </code>
      <button
        type="button"
        className="cc-btn cc-btn-text"
        title={t('agentUpdate.copyTitle')}
        onClick={() => void writeClipboardText(command).then(setCopied)}
        data-testid="cc-update-copy"
      >
        {t(copied ? 'agentUpdate.copied' : 'agentUpdate.copy')}
      </button>
    </div>
  );
}

/** AGENT-UPDATE: how the last 업데이트 went: progress, the new version, or the CLI's own words. */
function UpdateResult({ view }: { view: AgentUpdateView }) {
  const changed = view.ok && !!view.before && !!view.after && view.before !== view.after;
  const refusal = view.error && view.error in UPDATE_REFUSALS ? UPDATE_REFUSALS[view.error as keyof typeof UPDATE_REFUSALS] : null;
  const head =
    view.phase === 'running'
      ? t('agentUpdate.running')
      : view.phase === 'refused'
        ? refusal
          ? t(refusal)
          : (view.error ?? '')
        : changed
          ? t('agentUpdate.changed', { before: view.before!, after: view.after! })
          : view.manual
            ? t('agentUpdate.manual')
            : view.ok
            ? t('agentUpdate.latest')
              : t(view.error === 'timeout' ? 'agentUpdate.timeout' : 'agentUpdate.failed');
  return (
    <div className="cc-update" data-testid="cc-update" data-phase={view.phase} data-ok={view.ok} role="status">
      <span className={view.phase === 'done' && (!view.ok || view.manual) ? 'cc-strong' : undefined}>{head}</span>
      {changed && <span className="cc-muted">{t('agentUpdate.restartNote')}</span>}
      {view.manual && view.command && <ManualCommand command={view.command} />}
      {view.phase === 'done' && !changed && view.lines.length > 0 && (
        <pre className="cc-update-lines" data-testid="cc-update-lines">
          {view.lines.join('\n')}
        </pre>
      )}
    </div>
  );
}

/** One agent: the same row shape for every agent the usage store knows. */
function AgentRows({ agent }: { agent: AgentUsage }) {
  const engine = useEngineStore().state;
  const caps = capsOf(engine, agent.id);
  const update = useAgentUpdate(agent.id);
  const { officeReadOnly } = useAgtyStore();
  const version = update?.after ?? cliVersionOf(engine, agent.id);
  // AGENT-LATEST: the newest published version, when the daemon knows it (display only; 업데이트 still runs the CLI's own updater).
  const latest = cliLatestOf(engine, agent.id);
  const newer = !!version && !!latest && compareVersions(latest, version) > 0;
  const newest = !!version && !!latest && !newer;
  // STALE-CLI: "newest" is about the installed CLI; sessions started before its update still run the old one.
  const stale = staleSessions(engine, agent.id);
  const metered = meteredTag(caps);
  const asOf = usageAsOf(agent.reportedAt, useNow());
  const running = update?.phase === 'running';
  return (
    <div className="cc-agent" data-testid="cc-agent" data-agent={agent.id}>
      <div className="cc-agent-head">
        <Mark name={agent.agent} id={agent.id} />
        <strong className="cc-strong">{agent.agent}</strong>
        {version && (
          <span className="cc-muted cc-nowrap" data-testid="cc-version">
            {version}
          </span>
        )}
        {newer && (
          <span className="cc-strong cc-nowrap" data-testid="cc-latest">
            {t('agentUpdate.latestArrow', { version: latest })}
          </span>
        )}
        {newest && (
          <span className="cc-muted cc-nowrap" data-testid="cc-newest">
            {t('agentUpdate.newest')}
          </span>
        )}
        {metered && (
          <span className="cc-muted" data-testid="cc-metered" title={t('agentCaps.meteredTitle')}>
            {metered}
          </span>
        )}
        {asOf && (
          <span className="cc-muted" data-testid="cc-as-of">
            {asOf}
          </span>
        )}
        {/* ponytail: with the engine off (--engine off) no engineState, so no caps, arrive and the button stays hidden;
            sending agentCaps outside engineState (its own message) is the upgrade path. */}
        {caps?.update && !officeReadOnly && !newest && (
          <button
            type="button"
            className="cc-btn cc-btn-text"
            title={t('agentUpdate.buttonTitle', { agent: agent.agent })}
            aria-busy={running}
            disabled={running}
            onClick={() => updateAgentCli(agent.id)}
            data-testid="cc-update-btn"
          >
            {t('agentUpdate.button')}
          </button>
        )}
      </div>
      {stale && (
        <div className="cc-win cc-strong" data-testid="cc-stale">
          {t('staleCli.usage', { count: stale.count, version: stale.version })}
        </div>
      )}
      {agent.windows.length ? (
        agent.windows.map((w) => <WindowRow key={w.id} w={w} />)
      ) : (
        <div className="cc-win cc-muted">{noLimitsText(caps)}</div>
      )}
      {update && <UpdateResult view={update} />}
    </div>
  );
}

function UsageList({ view }: { view: AgentUsage[] }) {
  return (
    <div className="cc-usage-list" data-testid="cc-usage">
      {view.length ? view.map((a) => <AgentRows key={a.id} agent={a} />) : <p className="cc-muted">{t('controlCenter.noUsage')}</p>}
    </div>
  );
}

const UsageHead = ({ count }: { count: number }) => (
  <div className="cc-head">
    <strong className="cc-strong">{t('controlCenter.usage')}</strong>
    <span className="cc-muted">{t('controlCenter.agents', { count })}</span>
    <span className="cc-grow" />
    <UsageRefresh />
  </div>
);

/** A box of the open panel (픽셀 감성: corner studs). */
const Box = ({ children, className = '', testId }: { children: ReactNode; className?: string; testId?: string }) => (
  <div className={`cc-box ${className}`} data-testid={testId}>
    {children}
  </div>
);

/** The latest news while the panel is open (its "3분 전" ticks as the notification panel's does). */
function NewsRows({ news, onPress }: { news: NewsItem[]; onPress: (item: NewsItem) => void }) {
  const now = useNow();
  if (!news.length) return <p className="cc-muted cc-news">{t('controlCenter.noNews')}</p>;
  return news.slice(0, CC_NEWS_ROWS).map((item) => <NewsRow key={item.id} item={item} now={now} onPress={onPress} />);
}

function NewsRow({ item, now, onPress }: { item: NewsItem; now: number; onPress: (item: NewsItem) => void }) {
  const unread = item.notice !== undefined && !item.notice.read;
  return (
    <button type="button" className="cc-news" onClick={() => onPress(item)} data-testid="cc-news">
      <Mark name={item.name} />
      <span className="cc-ell">
        <strong className="cc-strong">{item.name}</strong> {bodyOf(item)}
      </span>
      <span className="cc-muted cc-nowrap">{ago(item.at, now)}</span>
      {unread && <span className="cc-dot" aria-hidden="true" />}
    </button>
  );
}

/** 기기 추가 · 보안 · 범례 · 설정: the ≡ menu's four entries. A tile's own click opens its dialog (they portal, so keep this
 *  mounted); `onPick` folds the summary on the way (capture runs first). `list` is the popover's column. */
function MenuTiles({ onPick, list = false }: { onPick: () => void; list?: boolean }) {
  return (
    <div className={`cc-menu${list ? ' cc-menu-list' : ''}`} data-testid="hud-menu-list" role="group" aria-label={t('controlCenter.menu')} onClickCapture={onPick}>
      <AddDeviceButton
        label={
          <>
            <PixelIcon name="device" />
            {t('auth.addDevice')}
          </>
        }
      />
      <SecurityButton>
        <PixelIcon name="shield" />
        {t('auth.security')}
      </SecurityButton>
      <ActivityLegend>
        <PixelIcon name="list" />
        {t('activity.legend')}
      </ActivityLegend>
      <button type="button" onClick={() => openSettings()}>
        <PixelIcon name="gear" />
        {t('settings.title')}
      </button>
    </div>
  );
}

/** The bell with its unread count and the latest line: the notifications target of every summary style. */
function NoticeLine({ unread, latest }: { unread: number; latest: NewsItem | undefined }) {
  return (
    <>
      <span className="cc-accent">
        <PixelIcon name="bell" />
      </span>
      {unread > 0 && (
        <span className="cc-count" title={t('noticeB.unread', { count: unread })}>
          {unread}
        </span>
      )}
      <span className="cc-ell cc-muted">{latest ? `${latest.name} ${bodyOf(latest)}` : t('controlCenter.noNews')}</span>
    </>
  );
}

export function ControlCenter({
  ids,
  notices,
  onOpenNotice,
}: {
  /** The party's agents: 실행 중 counts the ones working. */
  ids: readonly number[];
  /** The notification panel (NoticePanel), opened from the notifications target. */
  notices: ReactNode;
  /** Where a news row goes (the app's notice opener). */
  onOpenNotice: OpenTarget;
}) {
  const { items, clearedAt } = useNotices();
  const { events, usageState, officeJobs, codexTasks } = useAgtyStore();
  const reasons = useWaitReasons();
  const looks = useGameLooks();
  const [local, setLocal] = useState<CcLocal>(null);
  const style = useSummaryStyle();
  // 카드 쌓기: the agents whose rows are open in place (each shows its windows, version and 업데이트).
  const [openAgents, setOpenAgents] = useState<readonly string[]>([]);
  const hud = useHud();
  const noticesOpen = noticesExpanded(hud);
  const part = ccPart(local, noticesOpen);
  useUsagePanel(part === 'usage' || part === 'all' || openAgents.length > 0);
  const root = useRef<HTMLElement>(null);
  const pixel = useUiTheme() === 'pixel';

  const news = useMemo(() => mergeNews(items, events, clearedAt), [items, events, clearedAt]);
  const unread = unreadCount(items);
  const view = useMemo(() => usageView(usageState?.providers ?? []), [usageState]);
  const folded = closest(view, CC_FOLDED_AGENTS);
  // 카드 쌓기 lists every agent, the closest to its limit first, the ones without a figure last.
  const cards: FoldEntry[] = useMemo(() => {
    const ranked = closest(view, view.length);
    return [...ranked, ...view.filter((a) => !ranked.some((r) => r.agent.id === a.id)).map((agent) => ({ agent, windows: [] }))];
  }, [view]);
  const toggleAgent = (id: string) => setOpenAgents((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const working = ids.filter((id) => partyState(reasons[id], looks?.statusFor(id) ?? null) === 'work').length;
  const jobs = workCounts(officeJobs?.jobs ?? [], codexTasks?.tasks ?? []).running;

  const show = (next: CcPart) => {
    if (next === 'notices') openWindow('notices');
    else if (noticesOpen) closeWindow('notices');
    setLocal(next === 'notices' ? null : next);
  };
  const press = (target: Exclude<CcPart, null>) => show(ccPress(part, target));

  // HUD-2B's menu manners, kept: Esc or a press outside folds the control center's own parts. The
  // notification list (a window in the store) folds on a press in a window: it draws over the windows.
  useEffect(() => {
    if (!local && !noticesOpen) return;
    const away = (e: PointerEvent) => {
      if (root.current?.contains(e.target as Node)) return;
      setLocal(null);
      if (noticesOpen && e.target instanceof Element && e.target.closest('[data-hud-window]')) closeWindow('notices');
    };
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setLocal(null);
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', key);
    };
  }, [local, noticesOpen]);

  const openNews = (item: NewsItem) => {
    if (item.notice) markRead(item.notice.id);
    if (item.target && item.target.open !== 'office') {
      show(null);
      onOpenNotice(item.target);
    } else show('notices');
  };
  const latest = news[0];
  const running = (
    <>
      <strong className="cc-num">{working}</strong>
      <span className="cc-muted">{t('controlCenter.agentsUnit')}</span>
      <strong className="cc-num">{jobs}</strong>
      <span className="cc-muted">{t('controlCenter.jobsUnit')}</span>
    </>
  );
  const runningTitle = t('controlCenter.runningTitle', { agents: working, jobs });
  // 픽셀 감성's LED scoreboards keep two digits.
  const led = (n: number) => (pixel ? String(n).padStart(2, '0') : String(n));

  return (
    <section
      ref={root}
      className="cc"
      // WINDOW-LAYERS: its turn in the stack (a press brings it up, HudLayer); the notification list, a window
      // in the store, opens in front with it.
      style={{ zIndex: Math.max(layerZ(hud, 'controlCenter'), noticesOpen ? layerZ(hud, 'notices') : 0) }}
      data-hud-panel="controlCenter"
      aria-label={t('controlCenter.title')}
      data-testid="control-center"
      data-part={part ?? undefined}
    >
      {part === 'notices' && (
        <div className="cc-panel pixel-panel ui-window cc-pop-notices" data-testid="cc-notice-pop">
          {notices}
        </div>
      )}
      {part === 'usage' && (
        <div className="cc-panel pixel-panel ui-window cc-pop-usage" data-testid="cc-usage-pop">
          <UsageHead count={view.length} />
          <UsageList view={view} />
        </div>
      )}

      {style === 'center' ? (
        <>
        {/* The whole control center: mounted while folded, so the menu tiles' dialogs outlive a press. */}
        <div className="cc-panel pixel-panel ui-window cc-center" hidden={part !== 'all'} data-testid="cc-center">
          <div className="cc-title ui-head">
            <span className="cc-coin" aria-hidden="true" />
            <strong className="cc-strong">{t('controlCenter.title')}</strong>
            <span className="cc-grow" />
            <span className="cc-muted cc-nowrap">
              <HostClock size="text-xs" />
            </span>
            <button
              type="button"
              className="cc-btn"
              data-on
              aria-expanded
              aria-label={t('controlCenter.close')}
              title={t('controlCenter.close')}
              data-testid="cc-close"
              onClick={() => show(null)}
            >
              <PixelIcon name="grid" />
            </button>
          </div>
          <div className="cc-marquee" aria-hidden="true" />
          <div className="cc-body">
            <Box testId="cc-notices">
              <button type="button" className="cc-head cc-head-btn" onClick={() => show('notices')} title={t('controlCenter.noticesOpen')}>
                <span className="cc-accent">
                  <PixelIcon name="bell" />
                </span>
                <strong className="cc-strong">{t('notice.title')}</strong>
                {unread > 0 && <span className="cc-count">{unread}</span>}
                <span className="cc-grow" />
                <span className="cc-muted">{t('controlCenter.seeAll')}</span>
                <PixelIcon name="right" />
              </button>
              {part === 'all' && <NewsRows news={news} onPress={openNews} />}
            </Box>
            <Box>
              <UsageHead count={view.length} />
              <UsageList view={view} />
            </Box>
            <div className="cc-pair">
              <button type="button" className="cc-box cc-tile" title={runningTitle} onClick={openJobs} data-testid="cc-running" data-agents={working} data-jobs={jobs}>
                <span className="cc-head">
                  <span className="cc-accent">
                    <PixelIcon name="case" />
                  </span>
                  <strong className="cc-strong">{t('controlCenter.running')}</strong>
                  <span className="cc-grow" />
                  <PixelIcon name="right" />
                </span>
                <span className="cc-led-row">
                  <span className="cc-led-cell">
                    <span className="cc-led">{led(working)}</span>
                    <span className="cc-muted">{t('controlCenter.agentsUnit')}</span>
                  </span>
                  <span className="cc-led-cell">
                    <span className="cc-led">{led(jobs)}</span>
                    <span className="cc-muted">{t('controlCenter.jobsUnit')}</span>
                  </span>
                </span>
                <span className="cc-muted cc-modern-only">{t('controlCenter.openJobs')}</span>
              </button>
              <div className="cc-box cc-tile" data-testid="cc-time">
                <span className="cc-head">
                  <span className="cc-accent">
                    <PixelIcon name="clock" />
                  </span>
                  <strong className="cc-strong">{t('controlCenter.time')}</strong>
                </span>
                <span className="cc-led cc-led-time">
                  <HostClock part="time" size="" />
                </span>
                <span className="cc-muted">
                  <HostClock part="date" size="" />
                </span>
              </div>
            </div>
            <MenuTiles onPick={() => setLocal(null)} />
          </div>
        </div>

        {/* Folded: separate targets. */}
        <div className="cc-panel pixel-panel ui-window cc-tile-folded" hidden={part === 'all'} data-testid="cc-tile">
          <div className="cc-line">
            <button
              type="button"
              className="cc-seg cc-grow"
              data-on={part === 'notices' || undefined}
              aria-expanded={part === 'notices'}
              title={t('controlCenter.noticesOpen')}
              data-testid="cc-seg-notices"
              onClick={() => press('notices')}
            >
              <NoticeLine unread={unread} latest={latest} />
            </button>
            <button
              type="button"
              className="cc-btn cc-btn-lg"
              aria-expanded={part === 'all'}
              aria-label={t('controlCenter.open')}
              title={t('controlCenter.open')}
              data-testid="hud-menu"
              onClick={() => press('all')}
            >
              <PixelIcon name="grid" />
            </button>
          </div>
          <button
            type="button"
            className="cc-seg cc-seg-usage"
            data-on={part === 'usage' || undefined}
            aria-expanded={part === 'usage'}
            title={t('controlCenter.usageOpen')}
            data-testid="cc-seg-usage"
            onClick={() => press('usage')}
          >
            {folded.length ? (
              folded.map((entry, i) => (
                <FoldRow key={entry.agent.id} entry={entry}>
                  <span className="cc-grow" />
                  {i === 0 && view.length > folded.length && (
                    <span className="cc-muted">{t('controlCenter.more', { count: view.length - folded.length })}</span>
                  )}
                  {i === folded.length - 1 && <PixelIcon name="up" />}
                </FoldRow>
              ))
            ) : (
              <span className="cc-fold-row cc-muted">{t('controlCenter.noUsage')}</span>
            )}
          </button>
          <div className="cc-line">
            <button type="button" className="cc-seg cc-grow" title={runningTitle} aria-label={runningTitle} data-testid="cc-seg-running" data-agents={working} data-jobs={jobs} onClick={openJobs}>
              <span className="cc-accent">
                <PixelIcon name="case" />
              </span>
              <span>{t('controlCenter.running')}</span>
              <span className="cc-grow" />
              {running}
            </button>
            <span className="cc-seg" data-testid="cc-clock">
              <span className="cc-muted">
                <PixelIcon name="clock" />
              </span>
              <HostClock part="short" size="" />
            </span>
          </div>
        </div>
        </>
      ) : (
        <>
          {/* The ≡ list of the card stack and the status line: mounted while folded, so the tiles' dialogs outlive a press. */}
          <div className="cc-panel pixel-panel ui-window cc-pop-menu" hidden={part !== 'menu'} data-testid="cc-menu-pop">
            <MenuTiles list onPick={() => setLocal(null)} />
          </div>
          {style === 'cards' ? (
            /* 카드 쌓기 (mockup A): one card per target, each agent's usage its own row that opens in place. */
            <div className="cc-panel pixel-panel ui-window cc-cards" data-testid="cc-cards">
              <button
                type="button"
                className="cc-card"
                data-on={part === 'notices' || undefined}
                aria-expanded={part === 'notices'}
                title={t('controlCenter.noticesOpen')}
                data-testid="cc-seg-notices"
                onClick={() => press('notices')}
              >
                <strong className="cc-strong cc-nowrap">{t('notice.title')}</strong>
                <NoticeLine unread={unread} latest={latest} />
                <PixelIcon name="up" />
              </button>
              <div className="cc-cards-usage" data-testid="cc-seg-usage">
                {cards.length ? (
                  cards.map((entry) => {
                    const open = openAgents.includes(entry.agent.id);
                    return (
                      <div key={entry.agent.id} className="cc-card-agent" data-open={open || undefined}>
                        <button type="button" className="cc-card" aria-expanded={open} title={t('controlCenter.usageOpen')} data-testid="cc-card-agent" onClick={() => toggleAgent(entry.agent.id)}>
                          <FoldRow entry={entry}>
                            <span className="cc-grow" />
                            <PixelIcon name={open ? 'up' : 'next'} />
                          </FoldRow>
                        </button>
                        {open && (
                          <div className="cc-card-body">
                            <AgentRows agent={entry.agent} />
                          </div>
                        )}
                      </div>
                    );
                  })
                ) : (
                  <span className="cc-card cc-muted">{t('controlCenter.noUsage')}</span>
                )}
              </div>
              <button type="button" className="cc-card" title={runningTitle} aria-label={runningTitle} data-testid="cc-seg-running" data-agents={working} data-jobs={jobs} onClick={openJobs}>
                <span className="cc-accent">
                  <PixelIcon name="case" />
                </span>
                <strong className="cc-strong cc-nowrap">{t('controlCenter.running')}</strong>
                <span className="cc-grow" />
                {running}
                <PixelIcon name="right" />
              </button>
              <div className="cc-card" data-testid="cc-clock">
                <span className="cc-muted">
                  <PixelIcon name="clock" />
                </span>
                <HostClock size="" />
                <span className="cc-grow" />
                <button
                  type="button"
                  className="cc-btn"
                  aria-expanded={part === 'menu'}
                  aria-label={t('controlCenter.menu')}
                  title={t('controlCenter.menu')}
                  data-testid="hud-menu"
                  onClick={() => press('menu')}
                >
                  <PixelIcon name="menu" />
                </button>
              </div>
            </div>
          ) : (
            /* 얇은 상태줄 (mockup B): one line, ≡ · notifications · usage · running · clock. */
            <div className="cc-panel pixel-panel ui-window cc-strip" data-testid="cc-strip">
              <button
                type="button"
                className="cc-btn"
                aria-expanded={part === 'menu'}
                aria-label={t('controlCenter.menu')}
                title={t('controlCenter.menu')}
                data-testid="hud-menu"
                onClick={() => press('menu')}
              >
                <PixelIcon name="menu" />
              </button>
              <button
                type="button"
                className="cc-seg cc-strip-notices"
                data-on={part === 'notices' || undefined}
                aria-expanded={part === 'notices'}
                title={t('controlCenter.noticesOpen')}
                data-testid="cc-seg-notices"
                onClick={() => press('notices')}
              >
                <NoticeLine unread={unread} latest={latest} />
              </button>
              <button
                type="button"
                className="cc-seg"
                data-on={part === 'usage' || undefined}
                aria-expanded={part === 'usage'}
                title={t('controlCenter.usageOpen')}
                data-testid="cc-seg-usage"
                onClick={() => press('usage')}
              >
                {folded.length ? (
                  <>
                    {/* One window each, the one `tightest` names (5 hours first unless another is nearly used up): one row at any width. */}
                    {folded.map((entry) => (
                      <FoldRow key={entry.agent.id} entry={{ ...entry, windows: [entry.window] }} compact />
                    ))}
                    {view.length > folded.length && <span className="cc-muted">{t('controlCenter.more', { count: view.length - folded.length })}</span>}
                  </>
                ) : (
                  <span className="cc-fold-row cc-muted">{t('controlCenter.noUsage')}</span>
                )}
              </button>
              <button type="button" className="cc-seg" title={runningTitle} aria-label={runningTitle} data-testid="cc-seg-running" data-agents={working} data-jobs={jobs} onClick={openJobs}>
                <span className="cc-accent">
                  <PixelIcon name="case" />
                </span>
                {/* mockup B: "4 실행 중" (the agents at work; the hover line has the jobs too) */}
                <strong className="cc-num">{working}</strong>
                <span className="cc-muted cc-running-word">{t('controlCenter.running')}</span>
              </button>
              <span className="cc-seg" data-testid="cc-clock">
                <HostClock part="short" size="" />
              </span>
            </div>
          )}
        </>
      )}
    </section>
  );
}

/**
 * FEAT-PHONE-CONTROL-CENTER (owner 11-06 19:24): the phone's usage, the folded usage row above the dock (each agent's
 * logo, name, tightest window and what is left). A press opens the same usage panel as a bottom sheet. The
 * notifications and the menu are the phone dock's own (no second bell).
 */
export function MobileUsage() {
  const { usageState } = useAgtyStore();
  const [open, setOpen] = useState(false);
  useUsagePanel(open);
  const view = useMemo(() => usageView(usageState?.providers ?? []), [usageState]);
  const folded = closest(view, CC_FOLDED_AGENTS);
  // One line at any width: step down PHONE_FOLD_LEVELS until nothing overflows (before the first paint), start again
  // when the figures or the width change.
  const [level, setLevel] = useState(0);
  const [resized, setResized] = useState(0);
  const rowRef = useRef<HTMLButtonElement>(null);
  const shape = view.map((a) => `${a.id}:${a.windows.map((w) => w.leftPct).join(',')}`).join(';');
  const shown = view.length > 0;
  useEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    let width = row.clientWidth;
    const ro = new ResizeObserver(() => {
      if (row.clientWidth === width) return;
      width = row.clientWidth;
      setLevel(0);
      setResized((n) => n + 1);
    });
    ro.observe(row);
    return () => ro.disconnect();
  }, [shown]);
  const [seen, setSeen] = useState(shape);
  if (seen !== shape) {
    setSeen(shape);
    setLevel(0);
  }
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (row && row.scrollWidth > row.clientWidth && level < PHONE_FOLD_LEVELS - 1) setLevel(level + 1);
  }, [level, resized, shape]);
  const { entries, names } = phoneFolded(folded, level);
  if (!view.length) return null;
  return (
    <div className="cc-phone">
      <button
        ref={rowRef}
        data-fold-level={level}
        type="button"
        className="cc-phone-row"
        aria-expanded={open}
        title={t('controlCenter.usageOpen')}
        data-testid="cc-seg-usage"
        onClick={() => setOpen(true)}
      >
        {folded.length ? (
          entries.map((entry) => <FoldRow key={entry.agent.id} entry={entry} phone compact={!names} />)
        ) : (
          <span className="cc-fold-row cc-muted">{t('controlCenter.noUsage')}</span>
        )}
        <span className="cc-grow" />
        {view.length > folded.length && <span className="cc-muted">{t('controlCenter.more', { count: view.length - folded.length })}</span>}
        <PixelIcon name="up" />
      </button>
      {open &&
        createPortal(
          <div className="cc-phone" style={{ zIndex: MEMBER_SHEET_Z }}>
            <button type="button" className="cc-sheet-back" aria-label={t('controlCenter.sheetClose')} onClick={() => setOpen(false)} />
            <aside className="cc-sheet pixel-panel ui-window" data-testid="cc-usage-sheet" aria-label={t('controlCenter.usage')}>
              <div className="cc-sheet-head">
                <div className="cc-grow">
                  <UsageHead count={view.length} />
                </div>
                <button type="button" className="cc-btn" aria-label={t('controlCenter.sheetClose')} data-testid="cc-usage-sheet-close" onClick={() => setOpen(false)}>
                  <CloseGlyph />
                </button>
              </div>
              <UsageList view={view} />
            </aside>
          </div>,
          document.body,
        )}
    </div>
  );
}
