/** BRN K3: the agent query tools' spec reads (engine/agentQueries.ts SpecReads) on the SpecService,
 *  bound by project name. Here, not in engine/ or spec/: neither imports the other (K0). */
import type { SpecReads } from './engine/agentQueries.js';
import type { SpecProject, SpecService } from './spec/service.js';

export function specReads(spec: SpecService): SpecReads {
  const bound = <T>(name: string, read: (p: SpecProject) => Promise<T>): Promise<T | null> => {
    const p = spec.project(name);
    return p ? read(p) : Promise.resolve(null);
  };
  return {
    head: (n) => bound(n, (p) => spec.agentHead(p)),
    sensitive: (n) => {
      const p = spec.project(n);
      return p ? spec.sensitive(p) : { paths: new Set(), uids: new Set() };
    },
    summary: (n) => bound(n, (p) => spec.summary(p)),
    items: (n, q) => bound(n, (p) => spec.items(p, q)),
    item: (n, uid) => bound(n, (p) => spec.item(p, uid)),
    graph: (n, q) => bound(n, (p) => spec.graph(p, q)),
    task: (n, id) => bound(n, (p) => spec.task(p, id)),
    taskCode: (n, id) => bound(n, (p) => spec.taskCode(p, id, spec.sensitive(p).paths)),
    recent: (n) => bound(n, (p) => spec.recent(p)),
    map: (n) => bound(n, (p) => spec.map(p, {}, spec.sensitive(p).paths)),
  };
}
