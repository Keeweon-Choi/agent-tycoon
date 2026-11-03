import { useEffect, useState } from 'react';

import { transport } from '../../transport/index.js';
import { reviewOpen } from './reviewStore.js';

/** Counts the times the socket (re)connected: the server forgets who looks when it drops. */
function useReconnects(): number {
  const [count, setCount] = useState(0);
  useEffect(
    () =>
      transport.onStateChange((state) => {
        if (state === 'connected') setCount((n) => n + 1);
      }),
    [],
  );
  return count;
}

/** Look at project `project`'s repository while mounted (again after each reconnect); null: none. */
export function useRepoView(project: string | null): void {
  const reconnects = useReconnects();
  useEffect(() => {
    if (!project) return;
    transport.send({ type: 'repoView', project, on: true });
    return () => transport.send({ type: 'repoView', project, on: false });
  }, [project, reconnects]);
}

/** Follow one worktree's review notes while its review is open (again after a dropped socket). */
/** A new `stamp` (the worktree changed) asks again: the daemon answers `fixed` when asked, it does not push a worktree's edits. */
export function useReviewNotes(project: string, task: string, canWrite: boolean, stamp?: string): void {
  useEffect(() => {
    if (!canWrite) return;
    const ask = () => reviewOpen(project, task, (msg) => transport.send(msg));
    ask();
    return transport.onStateChange((state) => {
      if (state === 'connected') ask();
    });
  }, [project, task, canWrite, stamp]);
}
