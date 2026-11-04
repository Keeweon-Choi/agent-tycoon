/**
 * C1: the director turns office events (a 휴식 count that went up, a level or a 환생 count that
 * went up, the dev trigger) into short character moments: a coffee break, a level-up burst, a rebirth. One moment plays at
 * a time per character, the rest wait in a short queue. A moment is a small swappable object
 * (actions.ts); it only draws and walks, it never holds up the agent's real work, a tap on the
 * character skips it, and with prefers-reduced-motion the factory hands a still badge instead.
 *
 * Idle cost: `step` returns at once while nothing is queued, `drawables` is one Map lookup per
 * character, and `busy` (the game loop's full-rate vote) is false unless a moving moment plays.
 *
 * DOM-free and OfficeState-free on purpose (the Node test runner loads it).
 */
import type { TempEmployee } from '../../../../core/src/messages.js';
import { COMPACT_COFFEE_DEDUPE_MS, FX_QUEUE_MAX, OWNER_CHARACTER_ID } from '../../constants.js';
import type { Character } from '../../office/types.js';

export type LevelUpKind = 'levelUpA' | 'levelUpB' | 'levelUpC';
/** C1-FX2: the grand rebirths; a live 환생 picks one at random (owner 11-01 11:31). */
export type RebirthKind = 'rebirthR1' | 'rebirthR2' | 'rebirthR3';
/** INHERIT: a new agent took a removed one's records over (계승). */
export type InheritKind = 'inherit';
export type FxKind = 'coffee' | LevelUpKind | RebirthKind | InheritKind;
export const FX_KINDS: readonly FxKind[] = [
  'coffee',
  'levelUpA',
  'levelUpB',
  'levelUpC',
  'rebirthR1',
  'rebirthR2',
  'rebirthR3',
  'inherit',
];

/** A character's feet on screen this frame (device px) and the scale, for drawing a moment. */
export interface FxSpot {
  x: number;
  y: number;
  zoom: number;
  /** The figure's height in world px (feet to the top of its head). */
  h: number;
  /** The character's own frame drawn again, shifted (dx, dy) device px (the 계승's ghost). */
  figure?: (ctx: CanvasRenderingContext2D, dx: number, dy: number) => void;
}

/** The office as a moment sees it (OfficeState in the app, a fake in tests). */
export interface FxWorld {
  characters: Map<number, Character>;
}

export interface FxAction {
  /** Moves on screen: the office draws at the full rate while it plays (false for a still badge). */
  readonly moving: boolean;
  /** One frame; false when the moment is over (it is dropped and never stepped again). */
  step(dt: number, world: FxWorld, ch: Character): boolean;
  /** End it now: whatever it changed on the character is put back. */
  skip(world: FxWorld, ch: Character): void;
  /** Its pictures: `back` is drawn just behind the character, `front` over the whole office. */
  draw(layer: 'back' | 'front', ctx: CanvasRenderingContext2D, at: FxSpot): void;
}

export interface FxRequest {
  kind: FxKind;
  /** The count shown with it (the Lv N, the 환생 N회), when there is one. */
  count?: number;
  /** A coffee break's drink (the dev trigger: an energy drink from the vending machine); absent:
   *  the theme's. */
  drink?: 'coffee' | 'energy';
  /** FX-ALL: a coffee break at this machine (furniture uid: the owner's tap on it); absent: the
   *  nearest one of the drink's kind. */
  machine?: string;
}

/** FX-ALL: the owner's own character never does 환생 or 계승 (owner 11-01 13:23). */
export const ownerMay = (id: number, kind: FxKind): boolean =>
  id !== OWNER_CHARACTER_ID || !(kind.startsWith('rebirth') || kind === 'inherit');

export type FxFactory = (req: FxRequest, reduced: boolean) => FxAction;

interface Drawable {
  zY: number;
  draw: (ctx: CanvasRenderingContext2D) => void;
}

/** Just behind the character it belongs to (the 2D z-sort; the isometric pass draws zY < 0 behind). */
const BACK_Z = -0.004;

export class Director {
  private readonly queues = new Map<number, Array<FxRequest | FxAction>>();
  private readonly spots = new Map<number, FxSpot>();
  private make: FxFactory | null;
  private readonly reduced: () => boolean;

  constructor(reduced: () => boolean = () => false, factory?: FxFactory) {
    this.reduced = reduced;
    this.make = factory ?? null;
  }

  /** The moments the app knows (actions.ts registers them). */
  use(factory: FxFactory): void {
    this.make = factory;
  }

  /** Queue a moment for character `id`; past FX_QUEUE_MAX waiting ones the new one is dropped,
   *  and so is one the owner's character may not play (ownerMay). False: not queued. */
  play(id: number, req: FxRequest): boolean {
    const q = this.queues.get(id) ?? [];
    if (q.length > FX_QUEUE_MAX || !ownerMay(id, req.kind)) return false;
    q.push(req);
    this.queues.set(id, q);
    return true;
  }

  /** Whether character `id` has a moment playing or waiting. */
  playing(id: number): boolean {
    return this.queues.has(id);
  }

  /** The game loop, every frame. Nothing queued: nothing done. */
  step(world: FxWorld, dt: number): void {
    if (!this.queues.size || !this.make) return;
    for (const [id, q] of this.queues) {
      const ch = world.characters.get(id);
      if (!ch) {
        this.queues.delete(id);
        continue;
      }
      const head = this.current(id, q);
      if (head && !head.step(dt, world, ch)) this.next(id, q);
    }
  }

  /** A tap on the character: its playing moment ends now (the next one waits for the next frame). */
  skip(world: FxWorld, id: number): boolean {
    const q = this.queues.get(id);
    const ch = world.characters.get(id);
    if (!q) return false;
    const head = q[0];
    if (ch && head && 'step' in head) head.skip(world, ch);
    this.next(id, q);
    return true;
  }

  /** The game loop's vote for the full frame rate. */
  busy(): boolean {
    for (const q of this.queues.values()) {
      const head = q[0];
      if (head && 'step' in head && head.moving) return true;
    }
    return false;
  }

  /** The character's back-layer pictures for the renderer's z-sorted pass; remembers its feet for
   *  the front pass. One Map lookup for a character with nothing playing. */
  drawables(ch: Character, at: FxSpot, zY: number): Drawable[] {
    const head = this.queues.get(ch.id)?.[0];
    if (!head || !('step' in head)) return [];
    this.spots.set(ch.id, at);
    return [{ zY: zY + BACK_Z, draw: (ctx) => head.draw('back', ctx, at) }];
  }

  /** After the whole office is drawn: the front layer of every moment drawn this frame. */
  drawFront(ctx: CanvasRenderingContext2D): void {
    if (!this.spots.size) return;
    for (const [id, at] of this.spots) {
      const head = this.queues.get(id)?.[0];
      if (head && 'step' in head) head.draw('front', ctx, at);
    }
    this.spots.clear();
  }

  /** The head of the queue as an action (a request is made into one when its turn comes). */
  private current(id: number, q: Array<FxRequest | FxAction>): FxAction | null {
    const head = q[0];
    if (!head) {
      this.queues.delete(id);
      return null;
    }
    if ('step' in head) return head;
    const action = this.make!(head, this.reduced());
    q[0] = action;
    return action;
  }

  private next(id: number, q: Array<FxRequest | FxAction>): void {
    q.shift();
    this.spots.delete(id);
    if (!q.length) this.queues.delete(id);
  }
}

/**
 * INHERIT: each row's 계승 count, by agent name. A count that goes up live (a new agent that
 * shows up after the handshake's replay with one, or a higher one) is due once; it plays when
 * the row has a character of its own (`live`: its session's agent id), so the moment is not
 * dropped with the stand-in character a starting agent has before its session is seen.
 */
export class InheritWatch {
  private readonly seen = new Map<string, number>();
  private readonly due = new Set<string>();
  private quietUntil = -Infinity;

  /** A (re)connect handshake: what comes next is the daemon's replay, not news. */
  connected(nowMs: number, settleMs: number): void {
    this.seen.clear();
    this.due.clear();
    this.quietUntil = nowMs + settleMs;
  }

  /** True once: the 계승 of `name` plays now. */
  observe(name: string, count: number, live: boolean, nowMs: number): boolean {
    const before = this.seen.get(name);
    this.seen.set(name, count);
    if (count > (before ?? 0) && nowMs >= this.quietUntil) this.due.add(name);
    if (!live || !this.due.has(name)) return false;
    this.due.delete(name);
    return true;
  }
}

/** FX-ALL: a temp employee's moment due now, on the character of `execution`. */
export interface TempMoment {
  execution: string;
  kind: 'levelUp' | 'coffee';
  /** The new Lv, or the execution's compactions so far. */
  count: number;
}

/**
 * FX-ALL: the temp staff's moments (the tempStaff roster). The Lv is the employee's, carried
 * from one execution to the next: one that went up live is a level-up. The context is the
 * execution's own (each is a fresh session): a compaction the daemon counted in its transcript
 * is a coffee break. What a page load or a reconnect brings is a baseline.
 * ponytail: one small count per execution this page saw, cleared on a reconnect.
 */
export class TempStaffWatch {
  private readonly levels = new Map<string, number>();
  private readonly compactions = new Map<string, number>();
  private quietUntil = -Infinity;

  /** A (re)connect handshake: what comes next is the daemon's replay, not news. */
  connected(nowMs: number, settleMs: number): void {
    this.levels.clear();
    this.compactions.clear();
    this.quietUntil = nowMs + settleMs;
  }

  observe(staff: readonly TempEmployee[], nowMs: number): TempMoment[] {
    const live = nowMs >= this.quietUntil;
    const out: TempMoment[] = [];
    for (const e of staff) {
      const lv = e.level?.level;
      if (lv !== undefined) {
        const before = this.levels.get(e.employeeId);
        this.levels.set(e.employeeId, lv);
        if (live && before !== undefined && lv > before)
          out.push({ execution: e.execution, kind: 'levelUp', count: lv });
      }
      if (e.contextTokens === undefined || !e.maxContextTokens) continue;
      const prev = this.compactions.get(e.execution);
      const count = e.compactions ?? 0;
      this.compactions.set(e.execution, count);
      if (live && prev !== undefined && count > prev)
        out.push({ execution: e.execution, kind: 'coffee', count });
    }
    return out;
  }
}

/**
 * COMPACT-COFFEE: a row's `compacting` (Claude Code's Compacting spinner, read off its screen by
 * the daemon) and its 휴식 count. `start`: compacting began, the break starts now and is held while
 * it lasts; `rest`: the count went up for a compaction no break was played for (one seen only by
 * its compact_boundary: today's after-the-fact break). The rise of a compaction whose break
 * started at the spinner is swallowed while it compacts and COMPACT_COFFEE_DEDUPE_MS after.
 */
export class CompactBreakWatch {
  private readonly on = new Set<number>();
  /** A break played at the spinner, its count rise not seen yet: until when it may come (ms). */
  private readonly owed = new Map<number, number>();

  /** `rose`: the 휴식 count went up live (RestWatch.observe). */
  observe(id: number, compacting: boolean, rose: boolean, nowMs: number): 'start' | 'rest' | null {
    const was = this.on.has(id);
    let out: 'start' | 'rest' | null = null;
    if (rose) {
      if (nowMs < (this.owed.get(id) ?? -Infinity)) this.owed.delete(id);
      else out = 'rest';
    }
    if (compacting) this.on.add(id);
    else this.on.delete(id);
    if (compacting && !was) {
      this.owed.set(id, Infinity);
      out = 'start';
    } else if (!compacting && was && this.owed.get(id) === Infinity)
      this.owed.set(id, nowMs + COMPACT_COFFEE_DEDUPE_MS);
    return out;
  }
}

const prefersReduced = (): boolean =>
  typeof window !== 'undefined' &&
  !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** The office's director (actions.ts gives it the moments). */
export const director = new Director(prefersReduced);
