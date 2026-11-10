/**
 * The GPU reservation board (T-0046), folded from the engine's events.jsonl
 * alone: gpu_queue joins the line, gpu_move reorders it, gpu_lease moves the
 * front to the holders, gpu_release and gpu_cancel end a ticket.
 *
 * ponytail: a ticket whose events fell outside the primed tail (512 KB) or
 * that ended without an event is missed or stays; the sweep of dead tickets
 * writes their end events.
 */
import type { GpuBoard, GpuEnd, GpuTicket } from '../../../../core/src/messages.js';

type Obj = Record<string, unknown>;
const str = (x: unknown): string | null => (typeof x === 'string' && x ? x : null);
const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/** Endings kept for the board to fade out. */
export const RECENT_MAX = 6;

export class GpuBoardFold {
  private holders: GpuTicket[] = [];
  private queue: GpuTicket[] = [];
  private recent: GpuEnd[] = [];
  private seq = 0;

  /** One events.jsonl record; true when the board changed. */
  apply(e: Obj): boolean {
    const kind = str(e.type);
    const id = str(e.id);
    const ts = str(e.ts);
    if (!kind?.startsWith('gpu_') || !id || !ts) return false;
    const project = str(e.project) ?? '?';
    const take = (list: GpuTicket[]) => {
      const k = list.findIndex((t) => t.id === id);
      return k < 0 ? null : list.splice(k, 1)[0];
    };
    switch (kind) {
      case 'gpu_queue':
        take(this.queue);
        this.queue.push({ ...ticketOf(e, id, project, ts), ticket: ++this.seq });
        return true;
      case 'gpu_move': {
        const t = take(this.queue);
        if (!t) return false;
        // `position` is the 1-based place after the move.
        const pos = num(e.position) ?? this.queue.length + 1;
        this.queue.splice(Math.max(0, Math.min(this.queue.length, pos - 1)), 0, t);
        return true;
      }
      case 'gpu_lease': {
        const was = take(this.queue);
        take(this.holders);
        const t = ticketOf(e, id, project, ts);
        this.holders.push({
          ...t,
          label: t.label ?? was?.label ?? null,
          ticket: was?.ticket ?? ++this.seq,
        });
        return true;
      }
      case 'gpu_release':
      case 'gpu_cancel': {
        const was = take(this.holders) ?? take(this.queue);
        this.recent.push({
          id,
          project,
          label: was?.label ?? null,
          kind: kind === 'gpu_release' ? 'release' : 'cancel',
          reason: str(e.reason),
          exit: num(e.exit),
          ts,
        });
        if (this.recent.length > RECENT_MAX) this.recent.shift();
        return true;
      }
      default:
        return false;
    }
  }

  board(): GpuBoard {
    return {
      type: 'gpuBoard',
      holders: [...this.holders],
      queue: [...this.queue],
      recent: [...this.recent],
    };
  }
}

function ticketOf(e: Obj, id: string, project: string, ts: string): Omit<GpuTicket, 'ticket'> {
  const vramGib = num(e.vram_gib);
  // HIF §9: no --vram means it runs alone.
  return {
    id,
    project,
    label: str(e.label),
    vramGib,
    exclusive: e.exclusive === true || vramGib === null,
    ts,
  };
}
