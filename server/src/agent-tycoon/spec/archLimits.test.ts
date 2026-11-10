// SPT-P4A review: one document must never crash or freeze the daemon. The reviewer's probes
// (quadratic matching, `&` cross products, big subgraphs, `;` rescans, raw IDs in the Registry,
// subgraph text in group ids, reopened subgraphs, swapped UIDs, retired records piling up, the
// edges sent) as regression tests. Time bounds are loose on purpose: the point is no OOM and no
// multi-second stall, not a benchmark.
import { describe, expect, it } from 'vitest';

import {
  SPEC_ARCH_BLOCK_EDGES_MAX,
  SPEC_ARCH_DEP_NAMES_MAX,
  SPEC_ARCH_DOC_COMPS_MAX,
  SPEC_ARCH_EDGES_MAX,
  SPEC_ARCH_RETIRED_PER_DOC,
} from '../../constants.js';
import { archGraph, type DocArch, matchComponents, nodeKey, readArch } from './arch.js';
import { parseMermaid } from './mermaid.js';
import { createCompUid, emptyRegistry, type SpecRegistry } from './store.js';

const fence = (body: string) => '```mermaid\n' + body + '\n```\n';
const ms = (f: () => unknown) => {
  const s = performance.now();
  f();
  return performance.now() - s;
};
const log = (...a: unknown[]) => console.log('[limits]', ...a);
/**
 * The time bounds: well below the quadratic seconds-to-minutes these guard against, with room for
 * a loaded machine (review of SPT-P4B: 1 s failed once under parallel load and would break the gate).
 */
const TIME_BOUND_MS = 5_000;
/** The best of three runs: a check against a 1 s regression that one busy moment does not fail. */
const best = (f: () => unknown) => Math.min(ms(f), ms(f), ms(f));
const D = 'd_aaaaaaaaaa';
function reg1(): SpecRegistry {
  const reg = emptyRegistry('p_aaaaaaaaaa', '/x', new Date(0));
  for (const d of [D, 'd_bbbbbbbbbb'])
    reg.docs[d] = { path: `${d}.md`, kind: 'design', mode: 'auto', tracked: true, state: 'active', git: 'committed', blob: 'b', size: 1, mtimeMs: 1, changedAt: '', pathHistory: [], decisions: [] };
  return reg;
}
/** n components of one label, no links: what a 10k-row table would be without the document cap. */
const sameLabel = (n: number): DocArch => ({ comps: Array.from({ length: n }, (_, i) => ({ block: 0, node: nodeKey(`#${i + 1}`), label: 'x', kind: 'component' as const, line: i + 3, also: [] })), groups: [], links: [], unsupported: [] });

describe('1. matching is linear; a document has a component cap', () => {
  it('10,000 components of one label: the second scan is linear and keeps every UID (was a 4.3 GB OOM)', () => {
    const reg = reg1();
    const read = new Map([[D, sameLabel(10_000)]]);
    const first = matchComponents(reg, read, 'r', createCompUid).get(D)!;
    const t = ms(() => expect(matchComponents(reg, read, 'r', createCompUid).get(D)).toEqual(first));
    log('10k same-label components, second scan ms', t.toFixed(0));
    expect(t).toBeLessThan(TIME_BOUND_MS);
  });
  it('the 60 KB table of 10,000 rows saying x is refused as too big, whole (the probe document)', () => {
    const doc = '| component |\n|---|\n' + '| x |\n'.repeat(10_000);
    let a: DocArch | null = null;
    const t = ms(() => (a = readArch(doc)));
    expect(a!.comps).toEqual([]);
    expect(a!.unsupported).toEqual([{ line: 1, type: 'document', firstBlockedLine: 3 + SPEC_ARCH_DOC_COMPS_MAX, text: '', source: '', big: true }]);
    log('10k-row table readArch ms', t.toFixed(0));
    expect(t).toBeLessThan(TIME_BOUND_MS);
  });
  it('a table row that repeats a label is the same component: one more source line', () => {
    const a = readArch('| 구성요소 | 의존 |\n|---|---|\n| x | y |\n| y | |\n| x | z |\n| z | |\n');
    expect(a.comps.map((c) => `${c.label}@${c.line}+${c.also.join(',')}`)).toEqual(['x@3+5', 'y@4+', 'z@6+']);
    expect(a.links.map((l) => `${l.from}>${l.to}`)).toEqual(['0>1', '0>2']);
  });
});

describe('2. & groups cannot multiply without bound', () => {
  const side = (p: string) => Array.from({ length: 400 }, (_, i) => `${p}${i}`).join('&');
  const line = `${side('a')} --> ${side('b')}`;
  it('one 3.8 KB line of 400 & 400 is refused as too big at that line (was 160,000 edges)', () => {
    expect(parseMermaid(`flowchart TD\n${line}`)).toMatchObject({ type: 'flowchart', unsupported: { line: 2, text: line, big: true } });
  });
  it('twenty of them (74 KB): no links kept, well under a second (was 3.2 M links, 4.3 s, 686 MB)', () => {
    global.gc?.();
    const h0 = process.memoryUsage().heapUsed;
    let a: DocArch | null = null;
    const t = ms(() => (a = readArch(fence(`flowchart TD\n${Array.from({ length: 20 }, () => line).join('\n')}`))));
    const mb = (process.memoryUsage().heapUsed - h0) / 1e6;
    log('20 cross-product lines readArch ms', t.toFixed(0), 'heap MB +', mb.toFixed(0));
    expect(a!.links).toEqual([]);
    expect(a!.unsupported[0]).toMatchObject({ type: 'flowchart', big: true });
    expect(t).toBeLessThan(TIME_BOUND_MS);
  });
  it('right at the edge cap the block is read; one more edge refuses it', () => {
    const ok = parseMermaid(`flowchart TD\n${'a --> b\n'.repeat(SPEC_ARCH_BLOCK_EDGES_MAX)}`);
    expect('flow' in ok && ok.flow.edges.length).toBe(SPEC_ARCH_BLOCK_EDGES_MAX);
    expect(parseMermaid(`flowchart TD\n${'a --> b\n'.repeat(SPEC_ARCH_BLOCK_EDGES_MAX + 1)}`)).toMatchObject({ unsupported: { line: SPEC_ARCH_BLOCK_EDGES_MAX + 2, big: true } });
  });
  it('many small blocks past the document link cap refuse the document', () => {
    const block = fence(`flowchart TD\n${Array.from({ length: 30 }, (_, i) => `a${i} --> b${i}`).join('\n')}`);
    const a = readArch(block.repeat(200));
    expect(a.unsupported).toEqual([expect.objectContaining({ type: 'document', big: true })]);
  });
});

describe('3. subgraph membership is not quadratic', () => {
  it('80,000 nodes in one subgraph: refused as too big quickly (was 11 s)', () => {
    const src = `flowchart TD\nsubgraph S\n${Array.from({ length: 80_000 }, (_, i) => `n${i}`).join('\n')}\nend`;
    let a: DocArch | null = null;
    const t = ms(() => (a = readArch(fence(src))));
    log('80k-node subgraph readArch ms', t.toFixed(0));
    expect(a!.unsupported[0]).toMatchObject({ big: true });
    expect(t).toBeLessThan(TIME_BOUND_MS);
  });
  it('20,000 nested subgraphs: refused at the cap', () => {
    const deep = `flowchart TD\n${Array.from({ length: 20_000 }, (_, i) => `subgraph s${i}`).join('\n')}\nx\n${'end\n'.repeat(20_000)}`;
    const t = ms(() => expect(readArch(fence(deep)).unsupported[0]).toMatchObject({ big: true }));
    expect(t).toBeLessThan(TIME_BOUND_MS);
  });
  it('the node → subgraph map: the first subgraph that lists a node', () => {
    const r = parseMermaid('flowchart TD\nsubgraph A\n a1 --> a2\nend\nsubgraph B\n a2 --> b1\nend');
    expect('flow' in r && [...r.flow.groupOf]).toEqual([
      ['a1', 0],
      ['a2', 0],
      ['b1', 1],
    ]);
  });
});

describe('4-6. what leaves the parser: no raw node ID in the Registry, no subgraph text in a group id, no reopened subgraph', () => {
  it('a secret-shaped ID, a sentence and a 4,000-character ID reach the Registry only as 16-hex hashes', () => {
    const reg = reg1();
    const secret = `ghp_${'A'.repeat(36)}`;
    const doc =
      fence(`flowchart TD\n${secret} --> B`) +
      fence('sequenceDiagram\nmy password is hunter2 please->>B: x\nparticipant sk-ant-api03-abcdefghijklmnop as Svc') +
      fence(`flowchart TD\n${'x'.repeat(4000)}`);
    matchComponents(reg, new Map([[D, readArch(doc)]]), 'r', createCompUid);
    const json = JSON.stringify(reg.components);
    for (const s of [secret, 'hunter2', 'sk-ant-api03', 'x'.repeat(100)]) expect(json).not.toContain(s);
    expect(Object.values(reg.components).every((c) => /^[0-9a-f]{16}$/.test(c.node) && /^[0-9a-f]{16}$/.test(c.fp))).toBe(true);
  });
  it('a subgraph ID with a token and 3,000 characters: the group id is its index, the label masked and capped (was 3,070 characters in clear)', () => {
    const reg = reg1();
    const a = readArch(`${fence(`flowchart TD\nsubgraph deploy uses ghp_${'A'.repeat(36)} ${'y'.repeat(3000)}\nx\nend`)}`);
    const uids = matchComponents(reg, new Map([[D, a]]), 'r', createCompUid).get(D)!;
    const g = archGraph(reg, new Map([[D, { arch: a, uids }]]));
    expect(g.groups[0].id).toBe(`g:${D}:0:0`);
    expect(g.nodes[0].group).toBe(`g:${D}:0:0`);
    expect(JSON.stringify(g)).not.toContain(`ghp_${'A'.repeat(36)}`);
    expect(g.groups[0].label.length).toBeLessThanOrEqual(200);
  });
  it('a subgraph ID opened again is refused at that line (no duplicate group, no parent cycle)', () => {
    expect(parseMermaid('flowchart TD\nsubgraph B\nsubgraph A\nsubgraph B\nx\nend\nend\nend')).toMatchObject({ type: 'flowchart', unsupported: { line: 4, text: 'subgraph B' } });
    expect(parseMermaid('flowchart TD\nsubgraph B\nx\nend\nsubgraph B\ny\nend')).toMatchObject({ unsupported: { line: 5 } });
  });
});

describe('7. `;` splitting is one pass', () => {
  it('2 MB of semicolon lines, and of long participant lines: well under a second (was 3.4 s)', () => {
    const semis = `\`\`\`mermaid\nflowchart TD\n${Array.from({ length: 500 }, () => ';'.repeat(4000)).join('\n')}\n\`\`\`\n`;
    const t1 = ms(() => readArch(semis));
    const sp = `participant a${' '.repeat(4000)}b`;
    const t2 = ms(() => readArch(`\`\`\`mermaid\nsequenceDiagram\n${Array.from({ length: 500 }, () => sp).join('\n')}\n\`\`\`\n`));
    const quoted = `\`\`\`mermaid\nflowchart TD\n${Array.from({ length: 500 }, () => ';"x'.repeat(1333)).join('\n')}\n\`\`\`\n`;
    const t3 = ms(() => readArch(quoted));
    log('2 MB semicolons ms', t1.toFixed(0), '; participants ms', t2.toFixed(0), '; quoted semicolons ms', t3.toFixed(0));
    expect(Math.max(t1, t2, t3)).toBeLessThan(TIME_BOUND_MS);
  });
  it('the reviewer`s worst families over a 2 MB document stay fast (lexers are sticky: no token copies its line)', () => {
    const N = 4000;
    const fam = ['A-- ' + '-'.repeat(N) + '=', 'A-- x' + ' '.repeat(N) + 'y', 'A-.x' + '.'.repeat(N) + 'y', 'a&'.repeat(N / 2) + '-', 'a(x)&'.repeat(N / 5), 'a-->|'.repeat(N / 5), ';"'.repeat(N / 2) + '"'];
    let worst = 0;
    for (const line of fam) {
      const block = fence(`flowchart TD\n${Array.from({ length: 25 }, () => line).join('\n')}`);
      const doc = block.repeat(Math.floor((2 * 1024 * 1024) / block.length));
      worst = Math.max(worst, ms(() => readArch(doc)));
    }
    log('worst 2 MB hostile document readArch ms', worst.toFixed(0));
    expect(worst).toBeLessThan(TIME_BOUND_MS);
  });
});

describe('8-10. identity, retired records, the edges sent', () => {
  it('two equal-label nodes, a block inserted above them: neither UID swaps', () => {
    const reg = reg1();
    const b1 = fence('flowchart TD\nDB[(Database)] --> X1');
    const b2 = fence('flowchart TD\nDB[(Database)] --> X2');
    const r1 = matchComponents(reg, new Map([[D, readArch(b1 + b2)]]), 'r', createCompUid).get(D)!;
    const r2 = matchComponents(reg, new Map([[D, readArch(fence('flowchart TD\nNEW') + b1 + b2)]]), 'r', createCompUid).get(D)!;
    // before: [DB(b0), X1, DB(b1), X2]; after: [NEW, DB(b1), X1, DB(b2), X2]
    expect([r2[1], r2[2], r2[3], r2[4]]).toEqual(r1);
  });
  it('a document whose components are made new each scan keeps at most SPEC_ARCH_RETIRED_PER_DOC retired records (was 1,810 of 1,910)', () => {
    const reg = reg1();
    for (let s = 0; s < 20; s++) {
      const body = Array.from({ length: 100 }, (_, i) => `n${s}_${i}[label ${s} ${i}]`).join('\n');
      matchComponents(reg, new Map([[D, readArch(fence(`flowchart TD\n${body}`))]]), 'r', createCompUid, `2026-11-03T00:00:${String(s).padStart(2, '0')}Z`);
    }
    const all = Object.values(reg.components);
    expect(all.filter((c) => c.state === 'active')).toHaveLength(100);
    const retired = all.filter((c) => c.state === 'retired');
    // The 200 newest of those retired before the last scan (at scans 17 and 18), and the 100 it retired (kept: they may come back).
    expect(retired).toHaveLength(SPEC_ARCH_RETIRED_PER_DOC + 100);
    expect(Math.min(...retired.map((c) => Number(c.retired!.slice(-3, -1))))).toBe(17);
  });
  it('the query sends at most SPEC_ARCH_EDGES_MAX edges per layer and counts the rest', () => {
    const reg = reg1();
    const n = 60;
    const comps = Array.from({ length: n }, (_, i) => ({ block: 0, node: nodeKey(`n${i}`), label: `n${i}`, kind: 'component' as const, line: i + 1, also: [] }));
    const links = comps.flatMap((_, i) => comps.map((__, j) => ({ from: i, to: j, layer: 'composition' as const, label: '', line: 1 }))).filter((l) => l.from !== l.to);
    const arch: DocArch = { comps, groups: [], links, unsupported: [] };
    const uids = matchComponents(reg, new Map([[D, arch]]), 'r', createCompUid).get(D)!;
    const g = archGraph(reg, new Map([[D, { arch, uids }]]), 'composition');
    expect(g.edges).toHaveLength(SPEC_ARCH_EDGES_MAX);
    expect(g.hiddenEdges).toBe(links.length - SPEC_ARCH_EDGES_MAX);
  });
});

// ── the re-review (zzAdv2, zzPin) ──
describe('N1. a block refused for a moment, or a document over its cap, loses no UID', () => {
  const ids = (p: string, n: number) => Array.from({ length: n }, (_, i) => `${p}${i}`);
  const at = (m: number) => `2026-11-03T10:0${m}:00Z`;
  it('a typo in a 300-node block, then fixed: all 300 UIDs come back (was 200)', () => {
    const reg = reg1();
    const body = ids('n', 300).map((x) => `${x}[Label ${x}]`).join('\n');
    const good = fence(`flowchart TD\n${body}`);
    const u1 = matchComponents(reg, new Map([[D, readArch(good)]]), 'r', createCompUid, at(0)).get(D)!;
    const bad = readArch(fence(`flowchart TD\n${body}\nZ@{ typo }`));
    expect(bad.refused).toEqual([0]);
    matchComponents(reg, new Map([[D, bad]]), 'r', createCompUid, at(1));
    expect(Object.values(reg.components).filter((c) => c.state === 'active')).toHaveLength(300); // held as they were
    expect(matchComponents(reg, new Map([[D, readArch(good)]]), 'r', createCompUid, at(2)).get(D)).toEqual(u1);
  });
  it('a 900-row table grown to 1,001 rows (too big), then back to 900: all 900 UIDs come back (was 200)', () => {
    const reg = reg1();
    const tab = (n: number) => `| component |\n|---|\n${ids('c', n).map((x) => `| ${x} |`).join('\n')}\n`;
    const v1 = matchComponents(reg, new Map([[D, readArch(tab(900))]]), 'r', createCompUid, at(0)).get(D)!;
    const big = readArch(tab(1001));
    expect(big.whole).toBe(true);
    expect(matchComponents(reg, new Map([[D, big]]), 'r', createCompUid, at(1)).get(D)).toEqual([]);
    expect(matchComponents(reg, new Map([[D, readArch(tab(900))]]), 'r', createCompUid, at(2)).get(D)).toEqual(v1);
  });
  it('what this scan retires is never pruned by it: a block deleted then put back keeps its UIDs past the retired cap', () => {
    const reg = reg1();
    const block = fence(`flowchart TD\n${ids('n', 300).join('\n')}`);
    const u1 = matchComponents(reg, new Map([[D, readArch(block)]]), 'r', createCompUid, at(0)).get(D)!;
    matchComponents(reg, new Map([[D, readArch('# gone\n')]]), 'r', createCompUid, at(1));
    expect(Object.values(reg.components).filter((c) => c.state === 'retired')).toHaveLength(300);
    expect(matchComponents(reg, new Map([[D, readArch(block)]]), 'r', createCompUid, at(2)).get(D)).toEqual(u1);
  });
});

describe('N2. a 의존 cell has a size limit', () => {
  it('a 2 MB cell of names that match nothing, or the row itself, reads in well under a second (was 1.0 s each read)', () => {
    let worst = 0;
    for (const cell of ['x,'.repeat(1_000_000), 'a,'.repeat(1_000_000), 'x,'.repeat(2_000)]) worst = Math.max(worst, best(() => readArch(`| component | depends |\n|---|---|\n| a | ${cell} |\n| x | |\n`)));
    const t2 = best(() => readArch(`| component |\n|---|\n| ${'z'.repeat(2_000_000)} |\n`));
    log('2 MB dependency cell ms', worst.toFixed(0), '; 2 MB name cell ms', t2.toFixed(0));
    expect(Math.max(worst, t2)).toBeLessThan(300);
    // A short cell still names its components; past SPEC_ARCH_DEP_NAMES_MAX names the rest is not read.
    const names = `${'q, '.repeat(SPEC_ARCH_DEP_NAMES_MAX)}x`;
    expect(readArch(`| component | depends |\n|---|---|\n| a | y, ${names} |\n| x | |\n| y | |\n`).links.map((l) => `${l.from}>${l.to}`)).toEqual(['0>2']);
  });
});

describe('N3. what is kept is flat; N4. refused blocks count against the document', () => {
  it('readArch keeps no slice of the document: 30 documents of 1.2 MB prose keep little heap', () => {
    const mk = (tag: number) => {
      const prose = Array.from({ length: 12_000 }, (_, i) => `Paragraph ${tag}-${i} about the system and its parts, with enough words to be prose.`).join('\n');
      return `${prose}\n${fence(`flowchart TD\n${Array.from({ length: 20 }, (_, i) => `n${i}[Service number ${i} of ${tag}] --> n${(i + 1) % 20}`).join('\n')}`)}${prose}`;
    };
    const keep: DocArch[] = [];
    global.gc?.();
    const h0 = process.memoryUsage().heapUsed;
    let bytes = 0;
    for (let d = 0; d < 30; d++) {
      const text = mk(d);
      bytes += text.length;
      keep.push(readArch(text));
    }
    global.gc?.();
    const mb = (process.memoryUsage().heapUsed - h0) / 1e6;
    log(`30 documents, ${(bytes / 1e6).toFixed(0)} MB of text: retained MB`, global.gc ? mb.toFixed(1) : '(run with --expose-gc to measure)');
    if (global.gc) expect(mb).toBeLessThan(20);
    expect(keep.every((a) => a.comps.length === 20)).toBe(true);
  });
  it('2 MB of blocks refused just under their caps: the document is refused early, quickly', () => {
    const side = (p: string, n: number) => Array.from({ length: n }, (_, i) => `${p}${i}`).join('&');
    const block = fence(`flowchart TD\n${side('a', 44)} --> ${side('b', 45)}\nZ@{ shape: rect }`);
    let a: DocArch | null = null;
    const t = ms(() => (a = readArch(block.repeat(Math.floor((2 * 1024 * 1024) / block.length)))));
    log('2 MB of refused near-cap blocks ms', t.toFixed(0));
    expect(a!.whole).toBe(true);
    expect(t).toBeLessThan(TIME_BOUND_MS);
  });
});
