/**
 * DV3 개발실 명령 팔레트 (mockup D3): Ctrl+K / ⌘K from anywhere, a terminal pane included (caught on
 * the window's capture phase, before xterm; every other key still reaches the PTY), the 개발실
 * title bar's `⌕ 찾기 · Ctrl+K` pill, or the phone head's search icon. A 640 px panel on a desktop,
 * the whole screen on a phone. Also the 개발실's keys: Alt+1..6 focuses pane 1..6, Alt+↓ the next
 * waiting agent. The lines (palette.ts) only go somewhere through the dev room's own functions;
 * no line and no key answers a permission. Mounted once at the app's top level.
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { DEVROOM_PALETTE_FOCUS_FRAMES, DEVROOM_PALETTE_Z } from '../../constants.js';
import { t } from '../../i18n/index.js';
import { transport } from '../../transport/index.js';
import { useEngineStore } from '../engineStore.js';
import { hudGetSnapshot, useHud } from '../hud/hudStore.js';
import { Icon } from '../icons/Icon.js';
import { useCldStore } from '../officeStore.js';
import { useWaitReasons, waitingSince } from '../waiting.js';
import { projectOfAgent } from '../workbench/workbenchState.js';
import { useCanAct } from '../workbench/workbenchStore.js';
import { BODY, SMALL, useDevroomGroups, whoName } from './devroomData.js';
import { openDevRoom, openDevroomPage, setDevroomTab, syncWorktree } from './devroomStore.js';
import {
  matchAt,
  nextWaiting,
  type PaletteAction,
  paletteChord,
  type PaletteInput,
  type PaletteItem,
  paletteItems,
  paletteKeyName,
  picksOnEnter,
} from './palette.js';
import { LEAVES_MAX } from './paneTree.js';
import { startRun, useRunStore } from './runStore.js';
import { NewTaskDialog, PaletteChip, RepoWatch } from './WorktreeRail.js';

// ── Open or shut (one palette per page) ──────────────────────

let shown = false;
/** Where focus was when it opened: Esc gives it back (the terminal pane it came from). */
let cameFrom: HTMLElement | null = null;
const listeners = new Set<() => void>();
const setShown = (v: boolean) => {
  shown = v;
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};
const usePaletteShown = () => useSyncExternalStore(subscribe, () => shown);

function openPalette(): void {
  if (shown) return;
  cameFrom = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  setShown(true);
}

function closePalette(giveBack: boolean): void {
  setShown(false);
  const back = cameFrom;
  cameFrom = null;
  if (giveBack && back?.isConnected) back.focus();
}

const PALETTE_KEY = paletteKeyName(typeof navigator === 'undefined' ? '' : navigator.platform);

/** The 개발실 title bar's `⌕ 찾기 · Ctrl+K` (D3, M1, M2). */
export function PalettePill() {
  return (
    <button
      type="button"
      className={`ui-raise hidden sm:flex items-center gap-6 h-28 w-200 px-10 mr-4 rounded-ui-card border-ui border-border bg-btn-bg text-text-muted ${SMALL}`}
      data-testid="devroom-palette-pill"
      onClick={openPalette}
    >
      <Icon name="search" size={14} pixel={<span aria-hidden="true">⌕</span>} />
      {t('devroom.palette.pill', { key: PALETTE_KEY })}
    </button>
  );
}

/** The phone 개발실 head's search icon. */
export function PaletteSearchButton({ className }: { className: string }) {
  return (
    <button
      type="button"
      className={className}
      aria-label={t('devroom.palette.title')}
      title={t('devroom.palette.title')}
      data-testid="devroom-palette-open"
      onClick={openPalette}
    >
      <Icon name="search" size={18} pixel={<span aria-hidden="true">⌕</span>} />
    </button>
  );
}

// ── Going there ───────────────────────────────────────────────

const PANES = '[data-devroom-root] [data-testid="devroom-pane"]';

/** Focus inside a pane: its terminal's (or chat's) text box, else the pane itself. */
function focusIn(pane: HTMLElement): void {
  (pane.querySelector<HTMLElement>('textarea, input[type="text"]') ?? pane).focus();
}

/** Once the 개발실 has drawn it, focus agent `name`'s pane (given up after a few frames). */
function focusAgentPane(name: string): void {
  let frames = DEVROOM_PALETTE_FOCUS_FRAMES;
  const tryNow = () => {
    const pane = [...document.querySelectorAll<HTMLElement>(PANES)].find((p) => p.dataset.agent === name);
    if (pane) focusIn(pane);
    else if (--frames > 0) requestAnimationFrame(tryNow);
  };
  requestAnimationFrame(tryNow);
}

/** The agent whose pane holds focus now, if any. */
const focusedAgent = (): string | null =>
  (document.activeElement?.closest<HTMLElement>(PANES)?.dataset.agent) ?? null;

/** The 개발실's own keys work while it is on screen and focus is in it (or nowhere). */
function devroomKeysHere(): boolean {
  const hud = hudGetSnapshot();
  if (!hud.open.devroom || hud.minimized.devroom) return false;
  const at = document.activeElement;
  return !at || at === document.body || !!at.closest('[data-devroom-root]');
}

function run(action: PaletteAction, phone: boolean, ask: () => void): void {
  switch (action.kind) {
    case 'pane':
      if (phone) {
        openDevRoom(action.project, action.task);
        openDevroomPage(action.project, action.task, 'terminal');
      } else {
        openDevRoom(action.project, action.task);
        focusAgentPane(action.agent);
      }
      return;
    case 'space':
      openDevRoom(action.project, action.task);
      return;
    case 'tab':
      openDevRoom(action.project, action.task);
      if (phone) openDevroomPage(action.project, action.task, action.tab);
      else setDevroomTab(action.tab);
      return;
    case 'sync':
      syncWorktree(action.project, action.task, (msg) => transport.send(msg), transport.state === 'connected');
      return;
    case 'cleanup':
      openDevRoom(action.project);
      if (phone) openDevroomPage(action.project, null, 'cleanup');
      else setDevroomTab('cleanup');
      return;
    case 'newIssue':
      ask();
      return;
    case 'run':
      openDevRoom(action.project, action.task || null);
      if (phone) openDevroomPage(action.project, action.task || null, 'runs');
      startRun(action.project, action.task, action.script, action.role === 'test' ? 'drawer' : 'side');
      return;
  }
}

// ── What it lists ─────────────────────────────────────────────

/** The palette's input from the stores the dev room already reads (nothing new is asked for). */
function usePaletteInput(): PaletteInput {
  const { projects, groups } = useDevroomGroups(true);
  const { officeSnapshot } = useCldStore();
  const engine = useEngineStore().state?.projects;
  const reasons = useWaitReasons();
  const canAct = useCanAct();
  const { scripts } = useRunStore();
  return useMemo(() => {
    const orchs = officeSnapshot?.orchestrators ?? [];
    const all = engine ?? [];
    const placeOf = (name: string) => {
      const project = projectOfAgent(name, all);
      const row = groups.find((g) => g.project === project)?.rows.find((r) => r.wt.assignee === name);
      return { project, row };
    };
    const trunks = Object.fromEntries(groups.map((g) => [g.project, g.repo?.ok ? (g.repo.branch ?? undefined) : undefined]));
    const waiting = Object.entries(reasons).flatMap(([id, reason]) => {
      const name = orchs.find((o) => o.agentId === Number(id))?.name;
      if (!name) return [];
      const { project, row } = placeOf(name);
      if (!projects.includes(project)) return [];
      return [{
        agent: name,
        reason,
        since: waitingSince(Number(id)) ?? 0,
        project,
        task: row?.wt.task ?? null,
        title: row?.title ?? trunks[project] ?? '',
      }];
    });
    const spaces = groups.flatMap((g) =>
      g.rows.map((r) => ({
        project: g.project,
        task: r.wt.task,
        title: r.title,
        chip: r.chip,
        conflicts: r.wt.conflicts?.length ?? 0,
        who: whoName(r.wt),
        branch: r.wt.branch,
        current: r.wt.behind === 0,
        resting: g.resting.includes(r),
      })),
    );
    const agents = all.flatMap((p) => {
      const { project, row } = placeOf(p.name);
      if (!projects.includes(project)) return [];
      return [{ name: p.name, project, task: row?.wt.task ?? null, lead: !p.role, branch: row?.wt.branch ?? trunks[project] }];
    });
    const runs = Object.entries(scripts).flatMap(([key, a]) => {
      const [project, task] = key.split('\0');
      if (a === 'loading' || !a.ok || !projects.includes(project)) return [];
      const title = task ? (spaces.find((s) => s.project === project && s.task === task)?.title ?? task) : (trunks[project] ?? project);
      return a.picks.filter((p) => !p.changed).map((p) => ({ project, task, title, script: p.script, role: p.role }));
    });
    return { projects, trunks, waiting, spaces, agents, canAct, runs };
  }, [projects, groups, officeSnapshot, engine, reasons, canAct, scripts]);
}

const STRONG = { fontWeight: 'var(--ui-weight-strong)' } as const;

/** A line's words, the typed part in bold (D3's 결제 highlight). */
function Label({ text, query }: { text: string; query: string }) {
  const at = matchAt(text, query);
  if (at < 0) return <>{text}</>;
  const end = at + query.trim().length;
  return (
    <>
      {text.slice(0, at)}
      <b className="text-accent-text" style={STRONG}>{text.slice(at, end)}</b>
      {text.slice(end)}
    </>
  );
}

// ── The palette ───────────────────────────────────────────────

/** The palette and the keys; `phone` draws it full screen. */
export function DevroomPalette({ phone }: { phone: boolean }) {
  const open = usePaletteShown();
  const devroomOpen = useHud().open.devroom === true;
  const [asking, setAsking] = useState(false);
  // Alt+↓ needs the waiting order while the palette is shut: the lines are kept in a ref.
  const waitOrder = useRef<{ order: string[]; go: (name: string) => void }>({ order: [], go: () => {} });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const chord = paletteChord(e, LEAVES_MAX);
      if (!chord) return;
      if (chord === 'palette') {
        // Caught before xterm (capture phase): the PTY never sees Ctrl+K, it sees every other key.
        e.preventDefault();
        e.stopPropagation();
        if (shown) closePalette(true);
        else openPalette();
        return;
      }
      if (shown || phone || !devroomKeysHere()) return;
      e.preventDefault();
      e.stopPropagation();
      if (chord === 'nextWaiting') {
        const next = nextWaiting(waitOrder.current.order, focusedAgent());
        if (next) waitOrder.current.go(next);
        return;
      }
      const pane = document.querySelectorAll<HTMLElement>(PANES)[chord.pane - 1];
      if (pane) focusIn(pane);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [phone]);
  return (
    <>
      {!phone && devroomOpen && <WaitWatch phone={phone} into={waitOrder} />}
      {open && <Panel phone={phone} onAsk={() => setAsking(true)} />}
      {asking && <AskDialog onClose={() => setAsking(false)} />}
    </>
  );
}

/** Keeps Alt+↓'s waiting order fresh (cheap: the stores it reads are already in memory). */
function WaitWatch({ phone, into }: { phone: boolean; into: React.RefObject<{ order: string[]; go: (name: string) => void }> }) {
  const input = usePaletteInput();
  const items = useMemo(() => paletteItems(input, ''), [input]);
  useEffect(() => {
    const waits = items.filter((i) => i.group === 'waiting');
    into.current = {
      order: waits.map((i) => (i.action.kind === 'pane' ? i.action.agent : '')),
      go: (name) => {
        const line = waits.find((i) => i.action.kind === 'pane' && i.action.agent === name);
        if (line) run(line.action, phone, () => {});
      },
    };
  }, [items, phone, into]);
  return null;
}

function AskDialog({ onClose }: { onClose: () => void }) {
  const { projects } = useDevroomGroups(true);
  return <NewTaskDialog projects={projects} onClose={onClose} />;
}

function Panel({ phone, onAsk }: { phone: boolean; onAsk: () => void }) {
  const input = usePaletteInput();
  const [query, setQuery] = useState('');
  const items = useMemo(() => paletteItems(input, query), [input, query]);
  // Typing chooses the first line that matches (a waiting line stays listed above it); empty, the first line.
  const first = query.trim() ? Math.max(0, items.findIndex((i) => matchAt([i.label, i.sub, i.keys].filter(Boolean).join(' · '), query) >= 0)) : 0;
  const [chosen, setChosen] = useState<string | null>(null);
  const at = Math.max(0, chosen === null ? first : items.findIndex((i) => i.id === chosen));
  const current = items[at];
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${at}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [at]);
  const pick = (item: PaletteItem | undefined) => {
    if (!item) return;
    // Focus goes where the line leads (a pane, a dialog), not back where the palette came from.
    closePalette(false);
    run(item.action, phone, onAsk);
  };
  const move = (step: number) => {
    if (!items.length) return;
    setChosen(items[(at + step + items.length) % items.length].id);
  };
  return (
    <>
      {/* The projects' repositories are read while the palette is open, as while the 개발실 is (no polling of its own). */}
      {input.projects.map((p) => (
        <RepoWatch key={p} project={p} />
      ))}
      {!phone && <div className="fixed inset-0 bg-black/50" style={{ zIndex: DEVROOM_PALETTE_Z }} aria-hidden="true" onClick={() => closePalette(true)} />}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('devroom.palette.title')}
        data-testid="devroom-palette"
        className={
          phone
            ? 'fixed inset-0 flex flex-col bg-bg pt-(--cld-safe-top) pb-(--cld-safe-bottom) pl-(--cld-safe-left) pr-(--cld-safe-right)'
            : 'pixel-panel ui-window fixed left-1/2 top-120 -translate-x-1/2 w-640 max-w-[calc(100%-32px)] flex flex-col overflow-hidden'
        }
        style={{ zIndex: DEVROOM_PALETTE_Z + 1 }}
      >
        <div className={`shrink-0 flex items-center gap-9 px-14 border-b-ui border-border ${phone ? 'min-h-52' : 'h-48'}`}>
          {phone ? (
            <button
              type="button"
              className={`shrink-0 px-9 py-5 border-ui border-border rounded-ui-card bg-btn-bg ${SMALL}`}
              data-testid="devroom-palette-close"
              onClick={() => closePalette(true)}
            >
              {t('devroom.palette.back')}
            </button>
          ) : (
            <Icon name="search" size={16} pixel={<span aria-hidden="true">⌕</span>} />
          )}
          <input
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls="devroom-palette-list"
            aria-activedescendant={current ? `devroom-palette-${at}` : undefined}
            aria-label={t('devroom.palette.title')}
            data-testid="devroom-palette-input"
            className={`flex-1 min-w-0 bg-transparent text-text outline-none ${BODY}`}
            placeholder={t('devroom.palette.placeholder')}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setChosen(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                closePalette(true);
              } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                move(e.key === 'ArrowDown' ? 1 : -1);
              } else if (picksOnEnter({ key: e.key, isComposing: e.nativeEvent.isComposing, keyCode: e.nativeEvent.keyCode })) {
                e.preventDefault();
                pick(current);
              }
            }}
          />
          {!phone && <span className={`shrink-0 text-text-muted ${SMALL}`}>{t('devroom.palette.esc')}</span>}
        </div>
        <div
          ref={list}
          id="devroom-palette-list"
          role="listbox"
          className={`overflow-y-auto overscroll-contain ${phone ? 'flex-1 min-h-0' : 'max-h-[60vh]'}`}
        >
          {items.length === 0 && <p className={`px-15 py-12 text-text-muted ${BODY}`}>{t('devroom.palette.none')}</p>}
          {items.map((item, i) => (
            <div key={item.id}>
              {item.group !== items[i - 1]?.group && (
                <p className={`px-15 pt-9 pb-4 text-text-muted ${SMALL}`} data-testid="devroom-palette-group" data-group={item.group}>
                  {t(`devroom.palette.group.${item.group}`)}
                </p>
              )}
              <div className="px-8">
                <button
                  type="button"
                  role="option"
                  tabIndex={-1}
                  id={`devroom-palette-${i}`}
                  aria-selected={i === at}
                  data-index={i}
                  data-testid="devroom-palette-item"
                  data-group={item.group}
                  data-kind={item.action.kind}
                  className={`w-full flex items-center gap-7 px-8 text-left rounded-ui-card ${phone ? 'min-h-44' : 'h-36'} ${i === at ? 'bg-active-bg' : ''} ${BODY}`}
                  onMouseMove={() => i !== at && setChosen(item.id)}
                  // Keep focus in the text box: a click picks, it does not take the caret away first.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(item)}
                >
                  <span className="min-w-0 truncate" style={item.group === 'spaces' ? STRONG : undefined}>
                    <Label text={item.label} query={query} />
                  </span>
                  {item.chip && <PaletteChip chip={item.chip.chip} count={item.chip.count} />}
                  {item.sub && <span className={`min-w-0 truncate text-text-muted ${SMALL}`}>{item.sub}</span>}
                  {item.note && !phone && <span className={`ml-auto shrink-0 text-text-muted ${SMALL}`}>{item.note}</span>}
                </button>
              </div>
            </div>
          ))}
          <div className="h-6" />
        </div>
        <p className={`shrink-0 flex items-center min-h-32 px-14 py-6 border-t-ui border-border text-text-muted ${SMALL}`} data-testid="devroom-palette-foot">
          {t(phone ? 'devroom.palette.footPhone' : 'devroom.palette.foot')}
        </p>
      </div>
    </>
  );
}
