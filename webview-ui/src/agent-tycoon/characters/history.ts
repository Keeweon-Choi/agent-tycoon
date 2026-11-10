/**
 * CH-6: undo/redo for the pixel editor, DOM-free. Adapted from upstream pixel-agents'
 * `webview-ui/src/characters/history.ts` (MIT): a press starts a step and every change until
 * its release joins it (one stroke = one step); a change outside a press is a step of its own.
 * Each entry remembers the frame it was made on, so undoing shows that frame.
 */

export interface HistoryEntry<T> {
  state: T;
  frame: number;
}

export class History<T> {
  private undoStack: HistoryEntry<T>[] = [];
  private redoStack: HistoryEntry<T>[] = [];
  /** A press is down: its changes are one step. */
  private held = false;
  /** The press has recorded its step already. */
  private recorded = false;

  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** A press began: its changes join one step until endStep. */
  beginStep(): void {
    this.held = true;
    this.recorded = false;
  }

  endStep(): void {
    this.held = false;
  }

  /** A change on `frame` is about to replace `before()` (only read when it starts a step). */
  record(before: () => T, frame: number): void {
    if (this.held && this.recorded) return;
    this.recorded = this.held;
    this.undoStack.push({ state: before(), frame });
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  }

  /** Step back from `current`: the entry to restore, or null. */
  undo(current: T): HistoryEntry<T> | null {
    return this.step(this.undoStack, this.redoStack, current);
  }

  redo(current: T): HistoryEntry<T> | null {
    return this.step(this.redoStack, this.undoStack, current);
  }

  private step(from: HistoryEntry<T>[], to: HistoryEntry<T>[], current: T) {
    const entry = from.pop();
    if (!entry) return null;
    to.push({ state: current, frame: entry.frame });
    this.recorded = false;
    return entry;
  }
}
