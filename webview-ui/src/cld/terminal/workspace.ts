/**
 * The terminal workspace (T-0078): which terminals are open as tabs, and
 * which panes show which tab. Pure: the component and the store call these
 * and keep the result; nothing here touches a socket or the DOM.
 *
 * A pane grid like VS Code's split editor, held to 2x2: up to two rows of up
 * to two panes. A tab shows in at most one pane (two xterms on one socket
 * would only fight over its size); the tabs no pane shows stay attached, so
 * their scrollback and their agent's attach stay too. Closing a tab here is
 * detaching: the model has no idea what runs behind it.
 */
import { t } from '../../i18n/index.js';

export type TabKind = 'shell' | 'agent';

export interface Tab {
  /** `shell:<id>` or `agent:<background id>`: unique, and what panes name. */
  key: string;
  kind: TabKind;
  /** The shell id, or the agent's background session id. */
  ref: string;
  title: string;
  /** An agent's character id (its card, its status); absent for a shell and after a reload without the office. */
  agentId?: number;
}

export interface Workspace {
  tabs: Tab[];
  /** The pane grid: `rows[r][c]` is the key of the tab shown there, or null. */
  rows: Array<Array<string | null>>;
  focus: { row: number; col: number };
  /** Tab keys by when they were last shown or focused, newest last. */
  recent: string[];
}

export const MAX_ROWS = 2;
export const MAX_COLS = 2;
/** Tabs one device may keep open: three shells (the daemon's cap) and the agents it can attach. */
export const MAX_TABS = 16;
/** Said by every pane (TerminalPane `messages`): a deploy is a pause, not an exit code. */
export const terminalMessages = () => ({
  reconnecting: t('terminal.reconnecting'),
  gone: t('terminal.gone'),
  ended: t('terminal.ended'),
});
export const WORKSPACE_STORAGE_KEY = 'cld.terminal-workspace.v1';

export const shellTab = (id: string, title: string): Tab => ({
  key: `shell:${id}`,
  kind: 'shell',
  ref: id,
  title,
});
export const agentTab = (bgId: string, title: string, agentId?: number): Tab => ({
  key: `agent:${bgId}`,
  kind: 'agent',
  ref: bgId,
  title,
  ...(agentId !== undefined && { agentId }),
});

export const emptyWorkspace = (): Workspace => ({
  tabs: [],
  rows: [[null]],
  focus: { row: 0, col: 0 },
  recent: [],
});

export const paneCount = (ws: Workspace): number => ws.rows.reduce((n, row) => n + row.length, 0);
export const shownKeys = (ws: Workspace): string[] =>
  ws.rows.flat().filter((k): k is string => k !== null);
export const hasTab = (ws: Workspace, key: string): boolean => ws.tabs.some((t) => t.key === key);
export const focusedKey = (ws: Workspace): string | null =>
  ws.rows[ws.focus.row]?.[ws.focus.col] ?? null;
export const canSplitRight = (ws: Workspace): boolean =>
  (ws.rows[ws.focus.row]?.length ?? MAX_COLS) < MAX_COLS;
export const canSplitDown = (ws: Workspace): boolean => ws.rows.length < MAX_ROWS;

/** Where `key` shows, or null when no pane shows it. */
export function paneOf(ws: Workspace, key: string): { row: number; col: number } | null {
  for (const [row, cols] of ws.rows.entries()) {
    const col = cols.indexOf(key);
    if (col >= 0) return { row, col };
  }
  return null;
}

/** What each tab is called: its title, and "<title> 2", "<title> 3"... when several share one. */
export function tabLabels(ws: Workspace): Record<string, string> {
  const labels: Record<string, string> = {};
  const seen = new Map<string, number>();
  for (const tab of ws.tabs) {
    const same = ws.tabs.filter((t) => t.title === tab.title).length;
    const n = (seen.get(tab.title) ?? 0) + 1;
    seen.set(tab.title, n);
    labels[tab.key] = same > 1 && n > 1 ? `${tab.title} ${String(n)}` : tab.title;
  }
  return labels;
}

/** A pane's place in the workspace area, in percent of it. */
export interface PaneRect {
  row: number;
  col: number;
  key: string | null;
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Every pane with its rectangle: rows share the height, the panes of a row share the width. */
export function paneRects(ws: Workspace): PaneRect[] {
  return ws.rows.flatMap((cols, row) =>
    cols.map((key, col) => ({
      row,
      col,
      key,
      left: (col * 100) / cols.length,
      top: (row * 100) / ws.rows.length,
      width: 100 / cols.length,
      height: 100 / ws.rows.length,
    })),
  );
}

/** The tab a phone shows: the focused pane's, else the most recent, else the first. */
export function phoneKey(ws: Workspace): string | null {
  return focusedKey(ws) ?? ws.recent.at(-1) ?? ws.tabs[0]?.key ?? null;
}

/** The newest tab no pane shows. */
function hiddenTab(ws: Workspace): string | null {
  const shown = new Set(shownKeys(ws));
  for (const key of [...ws.recent].reverse()) if (!shown.has(key) && hasTab(ws, key)) return key;
  return ws.tabs.find((t) => !shown.has(t.key))?.key ?? null;
}

const bump = (recent: string[], key: string | null): string[] =>
  key === null ? recent : [...recent.filter((k) => k !== key), key];

const withRows = (ws: Workspace, rows: Workspace['rows'], focus = ws.focus): Workspace => {
  const key = rows[focus.row]?.[focus.col] ?? null;
  return { ...ws, rows, focus, recent: bump(ws.recent, key) };
};

/** Put `key` in pane (row, col); where another pane showed it, that pane gets what this one showed. */
export function showInPane(ws: Workspace, row: number, col: number, key: string | null): Workspace {
  if (!ws.rows[row] || ws.rows[row][col] === undefined) return ws;
  if (key !== null && !hasTab(ws, key)) return ws;
  const rows = ws.rows.map((r) => [...r]);
  const old = rows[row][col];
  const at = key === null ? null : paneOf(ws, key);
  if (at) rows[at.row][at.col] = old;
  rows[row][col] = key;
  return withRows(ws, rows, { row, col });
}

/** Show a tab: where it already shows, focus that pane; else it takes the focused pane. */
export function showTab(ws: Workspace, key: string): Workspace {
  if (!hasTab(ws, key)) return ws;
  const at = paneOf(ws, key);
  return at ? focusPane(ws, at.row, at.col) : showInPane(ws, ws.focus.row, ws.focus.col, key);
}

/** Add a tab (or find it) and show it. A full workspace refuses (the same ws back). */
export function openTab(ws: Workspace, tab: Tab): Workspace {
  if (hasTab(ws, tab.key)) {
    // Same terminal, maybe a new look: keep the newer title and character.
    const tabs = ws.tabs.map((t) => (t.key === tab.key ? { ...t, ...tab } : t));
    return showTab({ ...ws, tabs }, tab.key);
  }
  if (ws.tabs.length >= MAX_TABS) return ws;
  return showTab({ ...ws, tabs: [...ws.tabs, tab] }, tab.key);
}

export function focusPane(ws: Workspace, row: number, col: number): Workspace {
  if (!ws.rows[row] || ws.rows[row][col] === undefined) return ws;
  return withRows(ws, ws.rows, { row, col });
}

/** A new pane to the right of the focused one; it shows a tab that nothing shows, if there is one. */
export function splitRight(ws: Workspace): Workspace {
  if (!canSplitRight(ws)) return ws;
  const { row, col } = ws.focus;
  const rows = ws.rows.map((r) => [...r]);
  rows[row].splice(col + 1, 0, hiddenTab(ws));
  return withRows(ws, rows, { row, col: col + 1 });
}

/** A new row under the focused pane's row, with one pane. */
export function splitDown(ws: Workspace): Workspace {
  if (!canSplitDown(ws)) return ws;
  const rows = ws.rows.map((r) => [...r]);
  rows.splice(ws.focus.row + 1, 0, [hiddenTab(ws)]);
  return withRows(ws, rows, { row: ws.focus.row + 1, col: 0 });
}

/** Remove a pane (never the last): its tab stays open, hidden. */
export function closePane(ws: Workspace, row: number, col: number): Workspace {
  if (!ws.rows[row] || ws.rows[row][col] === undefined || paneCount(ws) <= 1) return ws;
  const rows = ws.rows.map((r) => [...r]);
  rows[row].splice(col, 1);
  const kept = rows.filter((r) => r.length > 0);
  // Focus the pane that took its place: same spot, else the one before it.
  const r = Math.min(row, kept.length - 1);
  const c = Math.min(col, kept[r].length - 1);
  return withRows(ws, kept, { row: r, col: c });
}

/**
 * Close a tab: it leaves the workspace, and only that. Its pane shows the
 * newest hidden tab, or goes away when other panes remain.
 */
export function closeTab(ws: Workspace, key: string): Workspace {
  if (!hasTab(ws, key)) return ws;
  const at = paneOf(ws, key);
  const rest: Workspace = {
    ...ws,
    tabs: ws.tabs.filter((t) => t.key !== key),
    recent: ws.recent.filter((k) => k !== key),
    rows: ws.rows.map((r) => r.map((k) => (k === key ? null : k))),
  };
  if (!at) return rest;
  const next = hiddenTab(rest);
  if (next !== null) return showInPane(rest, at.row, at.col, next);
  return paneCount(rest) > 1 ? closePane(rest, at.row, at.col) : rest;
}

/**
 * The agent tab to let go of when `key` needs an attach and the cap is
 * reached: the least recently focused of `attached` (agent tab keys holding
 * an attach), `key` itself excepted. Null when there is none.
 */
export function leastRecentAttached(ws: Workspace, attached: string[], key: string): string | null {
  const live = attached.filter((k) => k !== key && hasTab(ws, k));
  const order = new Map(ws.recent.map((k, i) => [k, i]));
  live.sort((a, b) => (order.get(a) ?? -1) - (order.get(b) ?? -1));
  return live[0] ?? null;
}

/**
 * A cap refusal that came back after this window already let go of its own attach (a swap at
 * `swappedAt`, within `windowMs`) is a slot held by another browser or device: only they can free it.
 */
export function heldElsewhere(
  swappedAt: number | undefined,
  now: number,
  windowMs: number,
): boolean {
  return swappedAt !== undefined && now - swappedAt <= windowMs;
}

/** The next bounded retry after a swapped-out attach is still counted by the daemon, or null when done. */
export function swapCapRetryDelay(retry: number, delays: readonly number[]): number | null {
  return delays[retry] ?? null;
}

// ── What is kept per device ─────────────────────────────────────────────────

export function serialize(ws: Workspace): string {
  return JSON.stringify({ v: 1, ...ws });
}

const isText = (v: unknown, max = 200): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max;

function parseTab(v: unknown): Tab | null {
  if (!v || typeof v !== 'object') return null;
  const t = v as Record<string, unknown>;
  if (
    (t.kind !== 'shell' && t.kind !== 'agent') ||
    !isText(t.ref, 128) ||
    typeof t.title !== 'string'
  )
    return null;
  const base =
    t.kind === 'shell'
      ? shellTab(t.ref, t.title.slice(0, 120))
      : agentTab(t.ref, t.title.slice(0, 120));
  if (t.key !== base.key) return null;
  return t.kind === 'agent' && typeof t.agentId === 'number' && Number.isInteger(t.agentId)
    ? { ...base, agentId: t.agentId }
    : base;
}

/**
 * A stored workspace. Anything that is not exactly one of ours (not JSON, a
 * newer version, a pane naming a tab that is not there, a grid over 2x2) is
 * not trusted: the pieces that are sound are kept, and a value that is not an
 * object at all gives the empty workspace.
 */
export function restore(raw: unknown): Workspace {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return emptyWorkspace();
    }
  }
  if (!value || typeof value !== 'object' || (value as { v?: unknown }).v !== 1)
    return emptyWorkspace();
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.tabs) || !Array.isArray(v.rows)) return emptyWorkspace();

  const tabs: Tab[] = [];
  for (const item of v.tabs.slice(0, MAX_TABS)) {
    const tab = parseTab(item);
    if (tab && !tabs.some((t) => t.key === tab.key)) tabs.push(tab);
  }
  const seen = new Set<string>();
  const rows: Workspace['rows'] = [];
  for (const row of v.rows.slice(0, MAX_ROWS)) {
    if (!Array.isArray(row) || row.length === 0) continue;
    rows.push(
      row.slice(0, MAX_COLS).map((k: unknown) => {
        if (typeof k !== 'string' || seen.has(k) || !tabs.some((t) => t.key === k)) return null;
        seen.add(k);
        return k;
      }),
    );
  }
  if (!rows.length) rows.push([null]);
  const f = (v.focus ?? {}) as { row?: unknown; col?: unknown };
  const row =
    Number.isInteger(f.row) && (f.row as number) >= 0 && (f.row as number) < rows.length
      ? (f.row as number)
      : 0;
  const col =
    Number.isInteger(f.col) && (f.col as number) >= 0 && (f.col as number) < rows[row].length
      ? (f.col as number)
      : 0;
  const recent = (Array.isArray(v.recent) ? v.recent : []).filter(
    (k, i, all): k is string =>
      typeof k === 'string' && tabs.some((t) => t.key === k) && all.indexOf(k) === i,
  );
  return { tabs, rows, focus: { row, col }, recent };
}
