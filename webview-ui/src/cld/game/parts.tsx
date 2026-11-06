/**
 * GAME-UI-0: the game parts every game screen shares (specs/ui-mock-1103, cockpit D2, owner 11-03
 * "이거야!!!! 바로 진행"). Calm on purpose: one accent (purple), LED green and amber only where they
 * mean something, gold only for the project name, low-contrast borders, zero dimmed.
 *
 *   <PixelIcon name="bell" />                              8x8 art at 2x, crisp, currentColor
 *   <HudCounter icon label value onClick? active? />        icon + name + big number; 0 dimmed; a button with onClick
 *   <Led state="on|half|off" reason? />                      evidence light; reason in title and aria-label
 *   <LedLegend compact? />                                   what the three lights mean
 *   <SegBar value max segments? label? mark? />              a bar of segments (mark: one cell red)
 *   <Stamp tone?>수락</Stamp>                                 drops in 3 steps and thunks 2px, once
 *   <DataText text />                                        ASCII runs in the data face (IDs, numbers in Korean text)
 *
 * Motion is decided in gameMotion.ts only (game.css animates under :root[data-game-motion='on']).
 */
import './game.css';

import type { CSSProperties, ReactNode } from 'react';

import { GAME_ICON_PX, GAME_SEGBAR_SEGMENTS } from '../../constants.js';
import { t } from '../../i18n/index.js';
import { Icon, type LucideName } from '../icons/Icon.js';

// 8x8 pixel icons, '#' = lit (copied from the mock's common.mjs).
const ICONS = {
  bell: ['...##...', '..####..', '.######.', '.######.', '.######.', '########', '........', '...##...'],
  gear: ['...##...', '.##..##.', '.######.', '##.##.##', '##.##.##', '.######.', '.##..##.', '...##...'],
  lens: ['.####...', '#....#..', '#....#..', '#....#..', '#....#..', '.####...', '....###.', '.....###'],
  stop: ['..####..', '.#....#.', '#......#', '#.####.#', '#.####.#', '#......#', '.#....#.', '..####..'],
  board: ['..####..', '.##..##.', '.######.', '.#....#.', '.#.##.#.', '.#....#.', '.#.##.#.', '.######.'],
  scroll: ['.#####..', '.#...##.', '.#.#..#.', '.#....#.', '.#.##.#.', '.#....#.', '.#.##.#.', '.######.'],
  eye: ['........', '..####..', '.#....#.', '#..##..#', '#..##..#', '.#....#.', '..####..', '........'],
  flag: ['.#......', '.#####..', '.######.', '.#####..', '.#......', '.#......', '.#......', '###.....'],
  hammer: ['.####...', '######..', '.####...', '..##....', '...##...', '....##..', '.....##.', '......##'],
  star: ['...##...', '...##...', '########', '.######.', '..####..', '.##..##.', '.#....#.', '........'],
  coin: ['..####..', '.#....#.', '#..##..#', '#.#....#', '#.#....#', '#..##..#', '.#....#.', '..####..'],
  heart: ['........', '.##..##.', '########', '########', '.######.', '..####..', '...##...', '........'],
  clock: ['..####..', '.#....#.', '#...#..#', '#...#..#', '#...###.', '#......#', '.#....#.', '..####..'],
  play: ['..#.....', '..##....', '..###...', '..####..', '..###...', '..##....', '..#.....', '........'],
  min: ['........', '........', '........', '........', '........', '........', '.######.', '.######.'],
  max: ['########', '########', '#......#', '#......#', '#......#', '#......#', '#......#', '########'],
  check: ['........', '.......#', '......##', '#....##.', '##..##..', '.####...', '..##....', '........'],
  // GAME-UI-1 G2: the 신기록 box and a quest card's pin.
  trophy: ['########', '#.####.#', '#.####.#', '.######.', '..####..', '...##...', '..####..', '.######.'],
  pin: ['.######.', '..####..', '..####..', '.######.', '...##...', '...##...', '...##...', '...#....'],
  // GAME-UI-1 G3 (ideas/agents kit.mjs): party states, the HUD, the job run.
  zzz: ['........', '.####...', '...#....', '..#.....', '.####...', '.....###', '......#.', '.....###'],
  lock: ['..####..', '.#....#.', '.#....#.', '########', '###..###', '###..###', '########', '........'],
  ask: ['.######.', '#......#', '#..##..#', '#....#.#', '#...#..#', '.######.', '..#.....', '.#......'],
  bolt: ['....##..', '...##...', '..##....', '.######.', '....##..', '...##...', '..##....', '.##.....'],
  thermo: ['...##...', '..#..#..', '..#.##..', '..#..#..', '..#.##..', '.#.##.#.', '.#.##.#.', '..####..'],
  flame: ['...#....', '...##...', '..###.#.', '.######.', '.######.', '.##..##.', '.##..##.', '..####..'],
  moon: ['..###...', '.###..#.', '###.....', '###.....', '###.....', '####....', '.######.', '..####..'],
  sun: ['#..#..#.', '.#####..', '.#####..', '#######.', '.#####..', '.#####..', '#..#..#.', '........'],
  case: ['..####..', '..#..#..', '########', '#......#', '########', '#......#', '#......#', '########'],
  log: ['######..', '#....##.', '#.##..#.', '#......#', '#.####.#', '#......#', '#.###..#', '########'],
  // GAME-UI-1 G1 (ideas/messenger/src/chrome.mjs): ▼ next (and ▲), ▶▶ shown at once, the terminal
  next: ['#######.', '.#####..', '..###...', '...#....', '........', '........', '........', '........'],
  up: ['...#....', '..###...', '.#####..', '#######.', '........', '........', '........', '........'],
  skip: ['........', '#...#...', '##..##..', '###.###.', '##..##..', '#...#...', '........', '........'],
  term: ['########', '#......#', '#.#....#', '#..#...#', '#.#..###', '#......#', '########', '........'],
  // HUD-1B / 2B (specs/ui-mock-1104/hud2): the camera strip and the top bar's menu.
  person: ['...##...', '..####..', '..####..', '...##...', '.######.', '#.####.#', '..#..#..', '..#..#..'],
  home: ['...##...', '..####..', '.######.', '########', '.#....#.', '.#.##.#.', '.#.##.#.', '.######.'],
  menu: ['........', '########', '........', '########', '........', '########', '........', '........'],
  device: ['.####...', '.#..#...', '.#..#.#.', '.#..####', '.#..#.#.', '.#..#...', '.####...', '........'],
  shield: ['########', '#......#', '#..##..#', '#.####.#', '#..##..#', '.#....#.', '..#..#..', '...##...'],
  list: ['........', '#.######', '........', '#.######', '........', '#.######', '........', '........'],
  // FEAT-HUD-CONTROL-CENTER: the control center's open button and a part's ›.
  grid: ['###..###', '###..###', '###..###', '........', '........', '###..###', '###..###', '###..###'],
  right: ['..#.....', '...#....', '....#...', '.....#..', '....#...', '...#....', '..#.....', '........'],
} as const;
export type IconName = keyof typeof ICONS;

const paths = new Map<IconName, string>();
const pathOf = (name: IconName) => {
  let d = paths.get(name);
  if (d === undefined) {
    d = '';
    ICONS[name].forEach((row, y) => [...row].forEach((c, x) => c === '#' && (d += `M${x} ${y}h1v1h-1z`)));
    paths.set(name, d);
  }
  return d;
};

/** An 8x8 icon at 2x (or `size` px), crisp edges, drawn in the text colour; decorative (aria-hidden). */
/** FEAT-UI-MODERN-THEME: the outline each pixel icon becomes in 모던 (cld/icons/Icon.tsx). */
const OUTLINE: Record<IconName, LucideName> = {
  bell: 'bell',
  gear: 'settings',
  lens: 'search',
  stop: 'circle-stop',
  board: 'clipboard',
  scroll: 'scroll-text',
  eye: 'eye',
  flag: 'flag',
  hammer: 'hammer',
  star: 'star',
  coin: 'coins',
  heart: 'heart',
  clock: 'clock',
  play: 'play',
  min: 'minus',
  max: 'app-window',
  check: 'check',
  trophy: 'trophy',
  pin: 'pin',
  zzz: 'coffee',
  lock: 'lock',
  ask: 'message-circle-question',
  bolt: 'zap',
  thermo: 'thermometer',
  flame: 'flame',
  moon: 'moon',
  sun: 'sun',
  case: 'briefcase',
  log: 'file-text',
  next: 'chevron-down',
  up: 'chevron-up',
  skip: 'skip-forward',
  term: 'square-terminal',
  person: 'user',
  home: 'house',
  menu: 'menu',
  device: 'monitor-smartphone',
  shield: 'shield',
  list: 'list',
  grid: 'layout-grid',
  right: 'chevron-right',
};

export function PixelIcon({ name, size = GAME_ICON_PX, className = '' }: { name: IconName; size?: number; className?: string }) {
  return (
    <Icon
      name={OUTLINE[name]}
      size={size}
      className={`game-ico ${className}`}
      pixel={
        <svg className={`game-ico ${className}`} viewBox="0 0 8 8" width={size} height={size} shapeRendering="crispEdges" aria-hidden="true" data-icon={name}>
          <path d={pathOf(name)} fill="currentColor" />
        </svg>
      }
    />
  );
}

/**
 * A counter: icon, name and a big number. 0 (and undefined, drawn '—') is dimmed. With `onClick`
 * (and a number) it is a button named "<label> <value>"; `active` lights it (나를 기다림).
 */
export function HudCounter({
  icon,
  label,
  value,
  onClick,
  active,
  testId,
  className = '',
}: {
  icon?: IconName;
  label: string;
  value: number | undefined;
  onClick?: () => void;
  active?: boolean;
  testId?: string;
  className?: string;
}) {
  const body = (
    <>
      <span className="game-hud-k">
        {icon && <PixelIcon name={icon} />}
        {label}
      </span>
      <span className="game-hud-v" data-zero={!value || undefined}>
        {value ?? '—'}
      </span>
    </>
  );
  const common = { className: `game-hud ${className}`, 'data-testid': testId, 'data-count': value, 'data-active': active || undefined };
  return onClick && value !== undefined ? (
    <button type="button" {...common} onClick={onClick} aria-label={`${label} ${value}`}>
      {body}
    </button>
  ) : (
    <div {...common}>{body}</div>
  );
}

/** A text whose ASCII runs (IDs, numbers, `exit 0`, `main`) are in the data face, the rest in the pixel font. */
export function DataText({ text }: { text: string }) {
  return text.split(/([A-Za-z0-9][A-Za-z0-9:.,/+()-]*)/).map((part, i) =>
    i % 2 ? (
      <span key={i} className="game-data">
        {part}
      </span>
    ) : (
      part
    ),
  );
}

export type LedState = 'on' | 'half' | 'off';
const LED_WORD = { on: 'game.led.on', half: 'game.led.half', off: 'game.led.off' } as const;
const LEGEND = { on: 'game.legend.on', half: 'game.legend.half', off: 'game.legend.off' } as const;
const STATES = ['on', 'half', 'off'] as const;

/**
 * An evidence light, 8x8 art at 2x: on = filled green, half = amber frame with its left half
 * filled (two spans, never a gradient), off = empty. Its word and `reason` are its title and name.
 */
export function Led({ state, reason }: { state: LedState; reason?: string }) {
  const word = t(LED_WORD[state]);
  const text = reason ? `${word}: ${reason}` : word;
  return (
    <span className="game-led" data-led={state} role="img" aria-label={text} title={text}>
      {state !== 'off' && <span />}
    </span>
  );
}

/** What the lights mean: the mock's rows (light, word, what it means), or `compact` on one line. */
export function LedLegend({ compact }: { compact?: boolean }) {
  if (compact)
    return (
      <span className="game-legend-line" data-testid="game-legend">
        {STATES.map((s) => (
          <span key={s}>
            <Led state={s} />
            {s === 'half' ? t('game.legend.halfShort') : t(LED_WORD[s])}
          </span>
        ))}
      </span>
    );
  return (
    <ul className="game-legend" data-testid="game-legend">
      <li className="game-legend-title">{t('game.legend.title')}</li>
      {STATES.map((s) => (
        <li key={s}>
          <Led state={s} />
          <span>{t(LED_WORD[s])}</span>
          <span className="game-muted">
            <DataText text={t(LEGEND[s])} />
          </span>
        </li>
      ))}
    </ul>
  );
}

export type SegTone = 'ok' | 'warn' | 'bad';

/**
 * A bar of `segments` cells, ceil(value / max) of them lit; a meter for assistive tech. `tone` colours
 * the lit cells; `refill` (a number that changes) lights them again one by one, once (GAME-UI-1).
 */
export function SegBar({
  value,
  max,
  segments = GAME_SEGBAR_SEGMENTS,
  label,
  tone,
  refill,
  mark,
  className = '',
}: {
  value: number;
  max: number;
  segments?: number;
  label?: string;
  tone?: SegTone;
  refill?: number;
  /** One cell drawn red: where a failed job stopped. */
  mark?: number;
  className?: string;
}) {
  const lit = max > 0 ? Math.min(segments, Math.ceil((Math.max(0, value) / max) * segments)) : 0;
  return (
    <span
      key={refill}
      className={`game-segbar ${className}`}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      data-lit={lit}
      data-tone={tone}
      data-refill={refill ? '' : undefined}
    >
      {Array.from({ length: segments }, (_, i) => (
        <i key={i} data-on={i < lit || undefined} data-mark={i === mark || undefined} style={refill ? ({ '--i': i } as CSSProperties) : undefined} />
      ))}
    </span>
  );
}

/**
 * A pixel stamp: drops in three steps and lands with a 2px thunk, once, when it mounts (re-key it
 * to play again; `still`: already there, no drop). gold = 수락 (the one gold moment), accent = 완료, muted = 반려 (dashed).
 */
export function Stamp({ children, sub, tone = 'accent', still }: { children: ReactNode; sub?: ReactNode; tone?: 'gold' | 'accent' | 'muted'; still?: boolean }) {
  return (
    <span className="game-stamp" data-tone={tone} data-testid="game-stamp" data-still={still || undefined}>
      <b>{children}</b>
      {sub && <small>{sub}</small>}
    </span>
  );
}
