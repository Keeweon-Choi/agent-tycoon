import { useEffect, useState } from 'react';

import { transport } from '../../transport/index.js';

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
