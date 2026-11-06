/**
 * BRN K8 on this repository: the design map through the real SpecService and the real child process
 * (dist/cld-worker.js spec-map, built in this folder), in a temp HOME (the sidecar lives there; the
 * repository is only read). Tracked: CLAUDE.md, docs/reference/architecture.md and cld/docs/design/*.md.
 * Writes cld/artifacts/feat-brain-design-map/drift-cld-gui.json: the design modules, the four drifts
 * (counts and five examples each), the child's time and peak RSS, the design read's time.
 *
 *   nice -n 10 taskset -c 18-19 npx tsx cld/test/run-brain-design-map.ts
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { MapDriftKind, TraceMap } from '../../core/src/cld/spec/trace.js';
import { createGitRunner } from '../../server/src/cld/engine/git/gitRun.js';
import { spawnSpecMap } from '../../server/src/cld/spec/mapWorker.js';
import { type SpecProject, SpecService } from '../../server/src/cld/spec/service.js';

const ROOT = path.resolve(__dirname, '../..');
const OUT = path.join(ROOT, 'cld/artifacts/feat-brain-design-map/drift-cld-gui.json');
const WORKER = path.join(ROOT, 'dist/cld-worker.js');
const EXAMPLES = 5;

async function main() {
  if (!fs.existsSync(WORKER)) throw new Error('build first: node esbuild.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'brn-k8-'));
  try {
    const project: SpecProject = { name: 'cld-gui', folder: ROOT, projectId: 'p_brnkeighta' };
    const spawn = spawnSpecMap(WORKER);
    let childMs = 0;
    const s = new SpecService({
      home,
      projects: () => [project],
      broadcast: () => undefined,
      run: createGitRunner(),
      later: () => undefined,
      idle: () => undefined,
      specMap: async (folder) => {
        const t0 = Date.now();
        const r = await spawn(folder);
        childMs = Date.now() - t0;
        return r;
      },
    });
    const docs = ['CLAUDE.md', 'docs/reference/architecture.md', ...fs.readdirSync(path.join(ROOT, 'cld/docs/design')).filter((f) => f.endsWith('.md')).map((f) => `cld/docs/design/${f}`)];
    const on = await s.enable(project, docs);
    if (!on.ok) throw new Error(`enable: ${on.error}`);
    const read = async (q: { design?: string }): Promise<TraceMap> => {
      const r = await s.map(project, q);
      if (!r.ok) throw new Error(`map: ${r.error}`);
      return r.value;
    };
    const plain = await read({});
    const t0 = performance.now();
    const v = await read({ design: '1' });
    const designMs = performance.now() - t0;
    const { design, drift } = v;
    if (!design || !drift) throw new Error('no design in the answer');
    const label = new Map(design.modules.map((m) => [m.id, m.label]));
    const kinds: MapDriftKind[] = ['designOnly', 'codeOnly', 'undesigned', 'reversed'];
    const by = (b?: string) => design.modules.filter((m) => m.by === b).length;
    const out = {
      at: new Date().toISOString(),
      docs: docs.length,
      modules: design.modules.length + design.more,
      withPath: design.modules.filter((m) => m.paths.length).length,
      pairs: { written: by('written'), confirmed: by('confirmed'), guess: by('guess'), none: design.modules.filter((m) => !m.by).length },
      edges: design.edges.length,
      codeCells: plain.structure?.blocks.filter((b) => b.kind !== 'rail').map((b) => b.id),
      designCells: design.structure?.blocks.map((b) => `${b.id} (${b.files})`),
      counts: drift.counts,
      examples: Object.fromEntries(
        kinds.map((k) => [k, drift.items.filter((x) => x.kind === k).slice(0, EXAMPLES).map((x) => ({ ...x, ...(x.module && { label: label.get(x.module) }) }))]),
      ),
      child: { wallMs: childMs, scanMs: plain.structure?.ms, peakRssKb: plain.structure?.rssKb, files: plain.structure?.files, imports: plain.structure?.imports },
      designReadMs: Math.round(designMs * 10) / 10,
      answerBytes: { plain: JSON.stringify(plain).length, withDesign: JSON.stringify(v).length },
    };
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
    console.log(JSON.stringify({ modules: out.modules, pairs: out.pairs, counts: out.counts, child: out.child, designReadMs: out.designReadMs, answerBytes: out.answerBytes }, null, 2));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
