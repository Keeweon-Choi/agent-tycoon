/**
 * T-184: the 터미널 board's 1 · 2 · 2×2 asked from outside it (the branch view's tool row). The ask is
 * kept until a board with agents is on screen to take it (the branch view switches to its 터미널 tab
 * first), then forgotten.
 */
let asked: 1 | 2 | 4 | null = null;
const takers = new Set<() => void>();

export function askBoardLayout(n: 1 | 2 | 4): void {
  asked = n;
  takers.forEach((take) => take());
}

/** The board's side: `apply` runs with the asked layout, once, while `ready`. Returns the unsubscribe. */
export function takeBoardLayout(ready: boolean, apply: (n: 1 | 2 | 4) => void): () => void {
  const take = () => {
    if (asked === null || !ready) return;
    const n = asked;
    asked = null;
    apply(n);
  };
  take();
  takers.add(take);
  return () => void takers.delete(take);
}
