/**
 * DV3 개발실 명령 팔레트 (Ctrl+K, mockup D3, plan §4 3위), its pure rules: which lines it lists in
 * which group (나를 기다림 / 워크트리 / 에이전트 / 할 수 있는 일), what typing keeps, and the keys
 * it answers. Every action only goes somewhere or opens something that already exists
 * (DevroomPalette.tsx runs them): a permission is never answered from here nor by any key
 * (owner 11-04, "허락엔 단축키 없음"), so there is no approve or deny kind.
 */
import type { RunRole } from '../../../../core/src/messages.js';
import { DEVROOM_PALETTE_GROUP_MAX } from '../../constants.js';
import { t } from '../../i18n/index.js';
import type { WaitReason } from '../waiting.js';
import type { Chip } from './devroomState.js';
import { roleLabel } from './runState.js';

export const PALETTE_GROUPS = ['waiting', 'spaces', 'agents', 'actions'] as const;
export type PaletteGroup = (typeof PALETTE_GROUPS)[number];

/** What picking a line does. `task` null = the project's trunk (its Lead). */
export type PaletteAction =
  | { kind: 'pane'; project: string; task: string | null; agent: string }
  | { kind: 'space'; project: string; task: string | null }
  | { kind: 'tab'; project: string; task: string; tab: 'changes' | 'merge' | 'preview' }
  | { kind: 'sync'; project: string; task: string }
  | { kind: 'cleanup'; project: string }
  | { kind: 'newIssue' }
  // DV2: a picked package.json script of a worktree (▶ 테스트 실행); the daemon decides what runs.
  | { kind: 'run'; project: string; task: string; script: string; role: RunRole };

export interface PaletteItem {
  id: string;
  group: PaletteGroup;
  label: string;
  /** The muted words after it (who · ⎇ branch). */
  sub?: string;
  /** A worktree's chip, as the rail draws it. */
  chip?: { chip: Chip; count: number };
  /** The right-hand hint (칸으로 가기). */
  note?: string;
  /** Also searched, not shown (an agent's name, a branch, the project). */
  keys?: string;
  action: PaletteAction;
}

export interface PaletteWaiting {
  agent: string;
  reason: WaitReason;
  /** When it started waiting (waiting.ts waitingSince). */
  since: number;
  project: string;
  task: string | null;
  /** Its worktree's title ('' on the trunk). */
  title: string;
}

export interface PaletteSpace {
  project: string;
  task: string;
  title: string;
  chip: Chip;
  conflicts: number;
  who?: string;
  branch: string;
  /** Not behind its base (nothing to catch up). */
  current: boolean;
  /** Folded on the rail (쉬는 작업): listed only when typed for. */
  resting: boolean;
}

export interface PaletteAgent {
  name: string;
  project: string;
  task: string | null;
  lead: boolean;
  branch?: string;
}

export interface PaletteInput {
  projects: readonly string[];
  /** Each project's base branch (main), when its repository is read. */
  trunks: Readonly<Record<string, string | undefined>>;
  waiting: readonly PaletteWaiting[];
  spaces: readonly PaletteSpace[];
  agents: readonly PaletteAgent[];
  /** This session may write (the rail's useCanAct): 따라잡기, the new issue and the runs. */
  canAct: boolean;
  /** DV2: the picked scripts of the worktrees whose 실행 row was read (runStore), with the space's title. */
  runs?: readonly { project: string; task: string; title: string; script: string; role: RunRole }[];
}

/** What typing is compared on: one case, one Unicode form (a Mac's file names come decomposed). */
export const fold = (s: string): string => s.normalize('NFC').toLowerCase();

/** Where `query` is in `label` (for the bold match), -1 when it is not or nothing is typed. */
export const matchAt = (label: string, query: string): number => {
  const q = fold(query.trim());
  return q ? fold(label).indexOf(q) : -1;
};

const dot = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(' · ');

/** Every line in group order, before typing narrows them; `always` = also listed while nothing is typed. */
function lines(input: PaletteInput): { item: PaletteItem; always: boolean }[] {
  const out: { item: PaletteItem; always: boolean }[] = [];
  const add = (item: PaletteItem, always: boolean) => out.push({ item, always });
  // 나를 기다림: the longest wait first, so an empty palette opens on it.
  for (const w of [...input.waiting].sort((a, b) => a.since - b.since)) {
    add(
      {
        id: `w:${w.agent}`,
        group: 'waiting',
        label: dot(w.agent, t(`devroom.palette.why.${w.reason}`), w.title),
        note: t('devroom.palette.goPane'),
        keys: w.project,
        action: { kind: 'pane', project: w.project, task: w.task, agent: w.agent },
      },
      true,
    );
  }
  for (const project of input.projects) {
    const trunk = input.trunks[project];
    add(
      {
        id: `s:${project}`,
        group: 'spaces',
        label: trunk ?? project,
        sub: dot(project, t('devroom.palette.trunk')),
        action: { kind: 'space', project, task: null },
      },
      true,
    );
  }
  for (const s of input.spaces) {
    add(
      {
        id: `s:${s.project}:${s.task}`,
        group: 'spaces',
        label: s.title,
        chip: { chip: s.chip, count: s.conflicts },
        sub: dot(s.who, s.branch),
        keys: dot(s.project, s.task),
        action: { kind: 'space', project: s.project, task: s.task },
      },
      !s.resting,
    );
  }
  for (const a of input.agents) {
    add(
      {
        id: `a:${a.name}`,
        group: 'agents',
        label: a.name,
        sub: dot(a.lead ? t('devroom.palette.lead') : a.project, a.branch),
        action: { kind: 'pane', project: a.project, task: a.task, agent: a.name },
      },
      true,
    );
  }
  // 할 수 있는 일: a worktree's own lines only come when typed for (there are many); the rest always.
  for (const s of input.spaces) {
    const keys = dot(s.project, s.task, s.branch, s.who);
    for (const tab of ['changes', 'merge', 'preview'] as const) {
      add(
        {
          id: `t:${s.project}:${s.task}:${tab}`,
          group: 'actions',
          label: t(`devroom.palette.do.${tab}`, { title: s.title }),
          keys,
          action: { kind: 'tab', project: s.project, task: s.task, tab },
        },
        false,
      );
    }
    if (input.canAct && !s.current && s.chip !== 'merged') {
      add(
        {
          id: `y:${s.project}:${s.task}`,
          group: 'actions',
          label: t('devroom.palette.do.sync', { title: s.title }),
          keys,
          action: { kind: 'sync', project: s.project, task: s.task },
        },
        false,
      );
    }
  }
  for (const r of input.canAct ? (input.runs ?? []) : []) {
    add(
      {
        id: `r:${r.project}:${r.task}:${r.script}`,
        group: 'actions',
        label: t('devroom.run.palette', { label: roleLabel(r.role, r.script), title: r.title }),
        keys: dot(r.project, r.task, r.script),
        action: { kind: 'run', project: r.project, task: r.task, script: r.script, role: r.role },
      },
      false,
    );
  }
  if (input.canAct && input.projects.length > 0) {
    add({ id: 'n', group: 'actions', label: t('devroom.palette.do.newIssue'), action: { kind: 'newIssue' } }, true);
  }
  for (const project of input.projects) {
    add(
      {
        id: `c:${project}`,
        group: 'actions',
        label: t('devroom.palette.do.cleanup', { project }),
        action: { kind: 'cleanup', project },
      },
      input.projects.length === 1,
    );
  }
  return out;
}

/** The palette's lines for `query`, in group order, each group at most DEVROOM_PALETTE_GROUP_MAX long. */
export function paletteItems(input: PaletteInput, query: string): PaletteItem[] {
  const q = fold(query.trim());
  const kept = lines(input).filter(({ item, always }) =>
    q ? fold(dot(item.label, item.sub, item.keys)).includes(q) : always,
  );
  return PALETTE_GROUPS.flatMap((g) =>
    kept
      .filter(({ item }) => item.group === g)
      .slice(0, DEVROOM_PALETTE_GROUP_MAX)
      .map(({ item }) => item),
  );
}

// ── Keys ──────────────────────────────────────────────────────

/** The parts of a key press the rules read. */
export interface PaletteKey {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/**
 * What a key press anywhere in the app means: Ctrl+K / ⌘K the palette (by its physical key too,
 * so a Korean keyboard layout's ㅏ still opens it), Alt+1..`panes` focuses that pane, Alt+↓ the
 * next waiting agent. Everything else (null) goes on to whoever has focus, the terminal included.
 */
export function paletteChord(e: PaletteKey, panes: number): 'palette' | 'nextWaiting' | { pane: number } | null {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && (e.code === 'KeyK' || e.key.toLowerCase() === 'k')) {
    return 'palette';
  }
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return null;
  if (e.key === 'ArrowDown') return 'nextWaiting';
  const n = /^Digit([1-9])$/.exec(e.code);
  return n && Number(n[1]) <= panes ? { pane: Number(n[1]) } : null;
}

/** Enter picks the chosen line, except while an IME (Hangul) is still composing the typed word. */
export const picksOnEnter = (e: { key: string; isComposing: boolean; keyCode: number }): boolean =>
  e.key === 'Enter' && !e.isComposing && e.keyCode !== 229;

/** Alt+↓: the waiting agent after `current` in `order` (around to the first), or the first. */
export function nextWaiting(order: readonly string[], current: string | null): string | null {
  if (!order.length) return null;
  const i = current === null ? -1 : order.indexOf(current);
  return order[(i + 1) % order.length];
}

/** The ⌘K a Mac shows, Ctrl+K elsewhere. */
export const paletteKeyName = (platform: string): string => (/Mac|iPhone|iPad|iPod/.test(platform) ? '⌘K' : 'Ctrl+K');
