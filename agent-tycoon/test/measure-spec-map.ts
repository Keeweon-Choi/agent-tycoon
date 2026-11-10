/**
 * SPT C1-C2 (§8.7, TC-234): the 지도's links on THIS repository, read only. Runs the child process's
 * scan in this process (real git, real files), the SRS's requirements as extract() reads them, and
 * prints per path (확정·직접·커밋·작업) how many feature requirements reach a file, with the test-data
 * rule on and off (R4 had no rule), the cells 'ENG' reaches, the scan's time and peak RSS, and the
 * commits linked by a head-comment tag only. `--sample <file>` also writes the accuracy sample: 30
 * feature requirements (picked by a hash of their ID, filling each path in turn) and, per path that
 * links one, one of its files, for a hand check (agent-tycoon/docs/research/spec-map-links-2026-11-04.md).
 *
 *   npx tsx agent-tycoon/test/measure-spec-map.ts [--sample out.json]
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import type { MapLinkPath } from '../../core/src/agent-tycoon/spec/trace.js';
import {
  type ChainReq,
  filesOn,
  lightCells,
  LINK_PATHS,
  type Links,
  reqLinks,
  tagOnly,
} from '../../server/src/agent-tycoon/spec/chain.js';
import { extract } from '../../server/src/agent-tycoon/spec/extract.js';
import { scanCode } from '../../server/src/agent-tycoon/spec/mapWorker.js';
import {
  type FeatureReq,
  featuresOf,
  structureOwned,
} from '../../server/src/agent-tycoon/spec/structure.js';
import { REPO_ROOT } from '../../server/src/agent-tycoon/testHome.js';
import { SPEC_MAP_PATHS_ON, SPEC_MAP_RECENT_MS } from '../../server/src/constants.js';

const SRS = 'agent-tycoon/docs/requirements/SRS.md';
const SAMPLE = 30;
const PER_PATH = 10;
const out =
  process.argv.indexOf('--sample') > 0 ? process.argv[process.argv.indexOf('--sample') + 1] : null;
const hash = (s: string) => crypto.createHash('sha1').update(s).digest().readUInt32BE(0);

async function main() {
  const t0 = Date.now();
  const scan = await scanCode(REPO_ROOT);
  console.log(
    `scan: ${scan.files.length} files, ${scan.edges.length / 2} imports, ${scan.links!.commits.length} commits${scan.links!.capped ? ' (capped)' : ''}, ${Object.keys(scan.links!.tags).length} tags, ${Object.keys(scan.links!.tasks).length} task specs, ${scan.ms} ms, peak RSS ${Math.round(scan.rssKb / 1024)} MB, JSON ${Math.round(JSON.stringify(scan).length / 1024)} kB`,
  );

  const items = extract(fs.readFileSync(path.join(REPO_ROOT, SRS), 'utf-8'), 'SRS.md', {
    kind: 'requirements',
    mode: 'auto',
    depth: 2,
    shortIds: false,
    idPatterns: [],
  }).filter((x) => x.displayId);
  const reqs: FeatureReq[] = items.map((x, i) => ({
    uid: `r${i}`,
    id: x.displayId!,
    doc: 'srs',
    path: SRS,
    section: x.section,
    line: x.line,
    changed: false,
    progress: false,
    blocked: false,
  }));
  const chainReqs: ChainReq[] = items.map((x, i) => ({
    uid: `r${i}`,
    id: x.displayId!,
    tasks: x.refs.filter((r) => /^T-\d{1,5}$/.test(r)),
    folders: [],
  }));
  const { features } = featuresOf(reqs);
  const featureUids = new Set(features.flatMap((f) => f.uids));
  const since = Date.now() - SPEC_MAP_RECENT_MS;

  const count = (links: Links) => {
    const by: Record<string, number> = {};
    for (const p of LINK_PATHS)
      by[p] = [...featureUids].filter((u) => links.reqs.get(u)!.paths[p].size > 0).length;
    by.any = [...featureUids].filter(
      (u) => filesOn(links.reqs.get(u), new Set(LINK_PATHS)).size > 0,
    ).length;
    return by;
  };
  const links = reqLinks(scan, chainReqs, since)!;
  const loose = reqLinks(scan, chainReqs, since, new Map(), false)!;
  console.log(`feature requirements: ${featureUids.size} of ${reqs.length}`);
  console.log('linked feature requirements by path (rule on):', count(links));
  console.log('linked feature requirements by path (test-data rule off):', count(loose));
  console.log(
    'R4 (main 662d3ef9, no rule, all 272): direct 35, commit 19, task 93, any 114; feature 83 / 182',
  );
  const medianFiles = (() => {
    const xs = [...featureUids]
      .map((u) => filesOn(links.reqs.get(u), new Set(LINK_PATHS)).size)
      .filter(Boolean)
      .sort((a, b) => a - b);
    return xs[xs.length >> 1];
  })();
  console.log(`files per linked feature requirement, median: ${medianFiles}`);
  console.log(
    `commits linked by a head-comment tag only: ${links.commits.filter((c) => tagOnly(c, links.known)).length} of ${links.commits.length}`,
  );

  const owned = structureOwned(scan)!;
  const keyOf = new Map(features.flatMap((f) => f.uids.map((u) => [u, f.key] as const)));
  for (const [name, on] of [
    ['every path', new Set(LINK_PATHS)],
    ['the paths on by default', new Set(SPEC_MAP_PATHS_ON as MapLinkPath[])],
  ] as const) {
    lightCells(links, owned.s, owned.owner, keyOf, on, since);
    const eng = owned.s.blocks.filter((b) => b.features.some((f) => f.key === 'FR-ENG'));
    console.log(
      `ENG reaches (${name}): ${eng.filter((b) => b.kind !== 'rail').length} cells + ${eng.filter((b) => b.kind === 'rail').length} rails: ${eng.map((b) => `${b.id} ${b.features.find((f) => f.key === 'FR-ENG')!.reqs}`).join(', ')}`,
    );
  }
  console.log(`total ${Date.now() - t0} ms`);

  if (out) {
    // Pick by a hash of the ID; fill direct, commit, task in turn (확정 needs the owner: none here).
    const linkedUids = [...featureUids]
      .filter((u) => filesOn(links.reqs.get(u), new Set(LINK_PATHS)).size > 0)
      .sort((a, b) => hash(reqs[+a.slice(1)].id) - hash(reqs[+b.slice(1)].id));
    const picked: string[] = [];
    const has: Record<string, number> = { direct: 0, commit: 0, task: 0 };
    for (const p of ['direct', 'commit', 'task'] as const)
      for (const u of linkedUids) {
        if (has[p] >= PER_PATH || picked.length >= SAMPLE) break;
        if (picked.includes(u) || !links.reqs.get(u)!.paths[p].size) continue;
        picked.push(u);
        for (const q of ['direct', 'commit', 'task'] as const)
          if (links.reqs.get(u)!.paths[q].size) has[q]++;
      }
    for (const u of linkedUids) if (picked.length < SAMPLE && !picked.includes(u)) picked.push(u);
    const rows = picked.flatMap((u) => {
      const r = items[+u.slice(1)];
      const l = links.reqs.get(u)!;
      return (['direct', 'commit', 'task'] as const).flatMap((p) => {
        const fs_ = [...l.paths[p]].map((i) => scan.files[i]).sort();
        if (!fs_.length) return [];
        const file = fs_[hash(`${r.displayId}|${p}`) % fs_.length];
        return [
          {
            id: r.displayId,
            text: r.title.slice(0, 400),
            path: p,
            file,
            of: fs_.length,
            ...(p === 'task' && { tasks: l.tasks }),
          },
        ];
      });
    });
    fs.writeFileSync(out, JSON.stringify({ head: scan.at, rows }, null, 1));
    console.log(
      `sample: ${picked.length} requirements, ${rows.length} rows (${['direct', 'commit', 'task'].map((p) => `${p} ${rows.filter((r) => r.path === p).length}`).join(', ')}) → ${out}`,
    );
  }
}
void main();
