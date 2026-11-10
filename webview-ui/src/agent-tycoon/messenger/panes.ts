/**
 * MSG-SPLIT: on a wide messenger, 1, 2 or 4 conversations side by side. Each pane holds a
 * conversation key (a lead's name, `room:<id>` for a room: the keys `read` and `pinned` use),
 * one pane has the focus and mirrors the store's active conversation. Kept per viewer in
 * localStorage. Pure rules here; the store applies them.
 */

export const PANE_LAYOUTS = [1, 2, 4] as const;
export type PaneLayout = (typeof PANE_LAYOUTS)[number];
const PANE_MAX = 4;
const PANES_KEY = 'agty.messenger.panes';

export interface PaneState {
  layout: PaneLayout;
  /** Always PANE_MAX entries; null = an empty pane. */
  panes: (string | null)[];
  focus: number;
}

export const emptyPanes = (): PaneState => ({
  layout: 1,
  panes: Array.from({ length: PANE_MAX }, () => null),
  focus: 0,
});

/** How many panes are on screen: a narrow messenger (and the phone) shows one. */
export const panesShown = (s: PaneState, wide: boolean): number => (wide ? s.layout : 1);

/** Show `key` in the focused pane. One already in another pane on screen takes the focus instead
 *  (never twice); a copy in a pane not on screen is cleared. Unchanged: the same object. */
export function placeInPane(s: PaneState, key: string | null, shown: number): PaneState {
  if (key !== null) {
    const at = s.panes.indexOf(key);
    if (at >= 0 && at < shown && at !== s.focus) return { ...s, focus: at };
  }
  if (s.panes[s.focus] === key) return s;
  return { ...s, panes: s.panes.map((k, i) => (i === s.focus ? key : k === key ? null : k)) };
}

export function closePane(s: PaneState, index: number): PaneState {
  return { ...s, panes: s.panes.map((k, i) => (i === index ? null : k)) };
}

/** Switch layout. A focused pane that would be off screen trades places with the last one shown,
 *  so the conversation in front stays in front (1 shows the focused pane's conversation). */
export function setPaneLayout(s: PaneState, layout: PaneLayout): PaneState {
  if (layout === 1 || s.focus < layout) return { ...s, layout };
  const to = layout - 1;
  const panes = [...s.panes];
  [panes[to], panes[s.focus]] = [panes[s.focus], panes[to]];
  return { layout, panes, focus: to };
}

/** What a pane key stands for now: a lead (by name) or a room; null when neither is listed. */
export function paneTarget(
  key: string | null,
  contacts: readonly { name: string; agentId: number }[],
  rooms: readonly { id: string }[],
): { agentId: number } | { room: string } | null {
  if (key === null) return null;
  if (key.startsWith('room:')) {
    const id = key.slice('room:'.length);
    return rooms.some((r) => r.id === id) ? { room: id } : null;
  }
  const c = contacts.find((x) => x.name === key);
  return c ? { agentId: c.agentId } : null;
}

/** The open conversations (each one chatView) with every lead in `keep` among them; when that
 *  makes too many, the oldest not kept give way. Unchanged: the same array. */
export function keepOpen(open: number[], keep: number[], max: number): number[] {
  const next = [...open, ...new Set(keep.filter((id) => !open.includes(id)))];
  while (next.length > max) {
    const i = next.findIndex((id) => !keep.includes(id));
    if (i < 0) break;
    next.splice(i, 1);
  }
  return next.length === open.length && next.every((id, i) => id === open[i]) ? open : next;
}

/** A stored layout, each part checked on its own (anything odd falls back to the default). */
export function parsePanes(raw: string | null): PaneState {
  const out = emptyPanes();
  let v: unknown;
  try {
    v = JSON.parse(raw ?? 'null');
  } catch {
    return out;
  }
  if (!v || typeof v !== 'object') return out;
  const o = v as Record<string, unknown>;
  if ((PANE_LAYOUTS as readonly unknown[]).includes(o.layout)) out.layout = o.layout as PaneLayout;
  if (Array.isArray(o.panes))
    out.panes = out.panes.map((_, i) => {
      const k: unknown = (o.panes as unknown[])[i];
      return typeof k === 'string' && k && !(o.panes as unknown[]).slice(0, i).includes(k)
        ? k
        : null;
    });
  if (Number.isInteger(o.focus) && (o.focus as number) >= 0 && (o.focus as number) < PANE_MAX)
    out.focus = o.focus as number;
  return out;
}

export function loadPanes(): PaneState {
  try {
    return parsePanes(localStorage.getItem(PANES_KEY));
  } catch {
    return emptyPanes(); // no storage (private mode, tests): this visit only
  }
}

export function savePanes(s: PaneState): void {
  try {
    localStorage.setItem(PANES_KEY, JSON.stringify(s));
  } catch {
    // Private mode: this visit still remembers it.
  }
}
