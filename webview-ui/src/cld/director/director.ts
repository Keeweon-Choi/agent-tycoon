/**
 * C1: the director turns office events (a 휴식 count that went up, a 환생 count that went up, the
 * dev trigger) into short character moments: a coffee break, a rebirth burst. One moment plays at
 * a time per character, the rest wait in a short queue. A moment is a small swappable object
 * (actions.ts); it only draws and walks, it never holds up the agent's real work, a tap on the
 * character skips it, and with prefers-reduced-motion the factory hands a still badge instead.
 *
 * Idle cost: `step` returns at once while nothing is queued, `drawables` is one Map lookup per
 * character, and `busy` (the game loop's full-rate vote) is false unless a moving moment plays.
 *
 * DOM-free and OfficeState-free on purpose (the Node test runner loads it).
 */
import { FX_QUEUE_MAX } from '../../constants.js';
import type { Character } from '../../office/types.js';

export type FxKind = 'coffee' | 'rebirthA' | 'rebirthB' | 'rebirthC';
export const FX_KINDS: readonly FxKind[] = ['coffee', 'rebirthA', 'rebirthB', 'rebirthC'];

/** A character's feet on screen this frame (device px) and the scale, for drawing a moment. */
export interface FxSpot {
  x: number;
  y: number;
  zoom: number;
  /** The figure's height in world px (feet to the top of its head). */
  h: number;
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
  /** The count shown with it (the 환생 N회), when there is one. */
  count?: number;
}

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

  /** Queue a moment for character `id`; past FX_QUEUE_MAX waiting ones the new one is dropped. */
  play(id: number, req: FxRequest): void {
    const q = this.queues.get(id) ?? [];
    if (q.length > FX_QUEUE_MAX) return;
    q.push(req);
    this.queues.set(id, q);
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

const prefersReduced = (): boolean =>
  typeof window !== 'undefined' &&
  !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** The office's director (actions.ts gives it the moments). */
export const director = new Director(prefersReduced);
