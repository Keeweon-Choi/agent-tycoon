import { type RefObject, useEffect, useRef } from 'react';

/** While `open`: Esc or a press outside `ref` calls `close` (its latest; listeners only while open). */
export function useDismiss(open: boolean, ref: RefObject<HTMLElement | null>, close: () => void): void {
  const latest = useRef(close);
  useEffect(() => {
    latest.current = close;
  });
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) latest.current();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') latest.current();
    };
    document.addEventListener('pointerdown', down, true);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('pointerdown', down, true);
      document.removeEventListener('keydown', key);
    };
  }, [open, ref]);
}
