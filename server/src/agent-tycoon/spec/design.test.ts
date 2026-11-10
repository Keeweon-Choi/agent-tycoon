/** BRN K8: the design read from folder trees, tables and Mermaid, and the four drifts against the code. */
import { describe, expect, it } from 'vitest';

import { archGraph, readArch, treeEntries } from './arch.js';
import { type DesignEdgeIn, designMap, type DesignModuleIn } from './design.js';
import type { CodeScan } from './mapWorker.js';
import { emptyRegistry } from './store.js';
import { structureOwned } from './structure.js';

const CLAUDE_TREE = [
  'core/                 Protocol + interfaces',
  '  asyncapi.yaml       the contract',
  '  src/messages.ts     AUTO-GENERATED',
  '  src/*.ts            provider.ts, transport.ts',
  '  src/agent-tycoon/   shared agty helpers',
  'server/src/           Lifecycle runtime',
  '  providers/hook/     claude/ = the only place',
  '  agentRuntime.ts     Lifecycle core',
  '    consentGate.ts Provider-agnostic consent POLICY',
  '  src/hooks/ components/ mobile/   React side',
  '  cli.ts, server.ts, layout.json',
];
const SPEC_KIT_TREE = ['src/', '├── models/', '│   └── loan.py', '├── services/', '└── lib/', '', 'tests/', '└── unit/'];

describe('folder trees', () => {
  it('an indented tree: each line under the folder above it, descriptions and non-code files out, a line of paths read whole', () => {
    expect(treeEntries(CLAUDE_TREE).map((e) => e.path)).toEqual([
      'core/',
      'core/src/messages.ts',
      'core/src/agent-tycoon/',
      'server/src/',
      'server/src/providers/hook/',
      'server/src/agentRuntime.ts',
      // a file is never a parent: the deeper line sits under the folder above it
      'server/src/consentGate.ts',
      'server/src/src/hooks/',
      'server/src/src/components/',
      'server/src/src/mobile/',
      'server/src/cli.ts',
      'server/src/server.ts',
    ]);
  });
  it("a tree drawn with lines (Spec Kit's plan.md); `..` and absolute paths are no entries", () => {
    expect(treeEntries(SPEC_KIT_TREE).map((e) => e.path)).toEqual(['src/', 'src/models/', 'src/models/loan.py', 'src/services/', 'src/lib/', 'tests/', 'tests/unit/']);
    expect(treeEntries(['../secret/', '/etc/', 'a/../b/'])).toEqual([]);
  });

  const DOC = [
    '# Design',
    '',
    '```mermaid',
    'flowchart LR',
    '  api["server/src/api"] --> db[(Main DB)]',
    '```',
    '',
    '## Directory map',
    '',
    '```',
    'server/',
    '  src/api/',
    '```',
    '',
    '```bash',
    'server/ not a tree: a shell block',
    '```',
    '',
    '## Communication flow',
    '',
    '```',
    'web/ ─→ server/',
    '```',
    '',
    '| 구성 요소 | 하는 일 | 자리(제안) |',
    '|---|---|---|',
    '| Spec Sources | reads | `server/src/agent-tycoon/tracking/docTracker.ts` 확장 |',
    '| 검사기 | checks | 새 코드 |',
    '',
  ].join('\n');

  it('readArch: a tree under a structure heading is one block after every other; a path column and a path label give a path; trees are never drawn', () => {
    const a = readArch(DOC);
    expect(a.comps.map((c) => [c.block, c.label, c.path ?? null, !!c.tree])).toEqual([
      [0, 'server/src/api', 'server/src/api', false],
      [0, 'Main DB', null, false],
      [1, 'Spec Sources', 'server/src/agent-tycoon/tracking/docTracker.ts', false],
      [1, '검사기', null, false],
      [2, 'server/', 'server/', true],
      [2, 'server/src/api/', 'server/src/api/', true],
    ]);
    // The diagrams keep the numbers they had before trees were read; a tree is no diagram.
    expect(a.blocks!.map((b) => [b.block, b.type])).toEqual([
      [0, 'flowchart'],
      [1, 'table'],
    ]);
    const reg = emptyRegistry('p_abcdefghij', '/x', new Date(0));
    reg.docs.d_aaaaaaaaaa = { path: 'docs/design.md', tracked: true, state: 'active' } as never;
    const uids = a.comps.map((_, i) => `c_aaaaaaaa${String.fromCharCode(97 + i)}${String.fromCharCode(97 + i)}`);
    for (const u of uids) reg.components[u] = { doc: 'd_aaaaaaaaaa', block: 0, node: '', fp: '', state: 'active', firstRev: '' };
    expect(archGraph(reg, new Map([['d_aaaaaaaaaa', { arch: a, uids }]]), 'composition').nodes.map((n) => n.label)).toEqual(['server/src/api', 'Main DB', 'Spec Sources', '검사기']);
  });
});

// The code: four top folders. core imports server (the design says server → core), cli imports core
// (the design has no arrow between them), webview-ui imports core (webview-ui is in no counted pair).
const FILES = ['cli/main.ts', 'core/x.ts', 'server/src/a.ts', 'server/src/b.ts', 'webview-ui/src/App.tsx'];
const at = (f: string) => FILES.indexOf(f);
const EDGES = [
  ['server/src/a.ts', 'core/x.ts'],
  ['core/x.ts', 'server/src/a.ts'],
  ['cli/main.ts', 'core/x.ts'],
  ['cli/main.ts', 'server/src/b.ts'],
  ['webview-ui/src/App.tsx', 'core/x.ts'],
].flatMap(([a, b]) => [at(a), at(b)]);
const SCAN: CodeScan = { files: FILES, edges: EDGES, unresolved: 0, workspaces: [], big: 0, at: '', ms: 0, rssKb: 0 };
const CODE = structureOwned(SCAN)!.s;
const MODS: DesignModuleIn[] = [
  { id: 'c_server', label: 'server/', paths: ['server/'], by: 'written' },
  { id: 'c_core', label: 'core/', paths: ['core/'], by: 'written' },
  { id: 'c_cli', label: 'cli/', paths: ['cli/'], by: 'written' },
  { id: 'c_docs', label: 'docs/', paths: ['docs/'], by: 'written' },
  { id: 'c_api', label: 'API', paths: ['server/src/a.ts'], by: 'written' },
  { id: 'c_web', label: 'webview-ui', paths: [], by: null },
];
const ARROWS: DesignEdgeIn[] = [
  { from: 'c_api', to: 'c_core' },
  { from: 'c_cli', to: 'c_server' },
  { from: 'c_web', to: 'c_core' },
];

describe('the four drifts', () => {
  it('설계에만 · 설계에 없음 · 설계에 없는 의존 · 반대 방향, from the pairs a path makes; a name alone is shown, never counted', () => {
    expect(CODE.blocks.map((b) => b.id).sort()).toEqual(['cli', 'core', 'server', 'webview-ui']);
    const { design, drift } = designMap(MODS, ARROWS, SCAN, CODE, () => false);
    expect(drift.counts).toEqual({ reversed: 1, undesigned: 1, designOnly: 1, codeOnly: 1 });
    expect(drift.items).toEqual([
      { kind: 'reversed', from: 'core', to: 'server', imports: 1 },
      { kind: 'undesigned', from: 'cli', to: 'core', imports: 1 },
      { kind: 'designOnly', module: 'c_docs', path: 'docs' },
      { kind: 'codeOnly', cell: 'webview-ui' },
    ]);
    expect(design.modules.find((m) => m.id === 'c_web')).toMatchObject({ cells: ['webview-ui'], by: 'guess' });
    expect(design.modules.find((m) => m.id === 'c_api')).toMatchObject({ cells: ['server'], by: 'written' });
    // The design's own fold: the code's layers, a planned folder one file in it, its arrows.
    expect(design.structure!.bands.map((b) => b.id).sort()).toEqual(['cli', 'core', 'server']);
    expect(design.structure!.blocks.find((b) => b.id === 'tools')?.inside).toEqual([{ name: 'docs/·', n: 1 }]);
    expect(design.structure!.pairs.map((p) => [p.a, p.b, p.ab + p.ba]).length).toBeGreaterThan(0);
  });

  it('a planned path that is there but holds no code is no drift; no counted module: no 설계에 없음 either', () => {
    expect(designMap(MODS, ARROWS, SCAN, CODE, (p) => p === 'docs').drift.counts.designOnly).toBe(0);
    const names = MODS.map((m) => ({ ...m, paths: [], by: null }));
    expect(designMap(names, ARROWS, SCAN, CODE, () => false).drift).toEqual({ counts: { reversed: 0, undesigned: 0, designOnly: 0, codeOnly: 0 }, items: [], more: 0 });
  });

  it('the owner\'s pair (confirmed) counts like a written one; a plain line (---) has no direction', () => {
    const mods: DesignModuleIn[] = [
      { id: 'c_a', label: 'Core', paths: ['core/'], by: 'confirmed' },
      { id: 'c_b', label: 'Server', paths: ['server/'], by: 'confirmed' },
    ];
    expect(designMap(mods, [{ from: 'c_b', to: 'c_a' }], SCAN, CODE, () => false).drift.counts).toMatchObject({ reversed: 1, undesigned: 0 });
    expect(designMap(mods, [{ from: 'c_b', to: 'c_a', ends: 'none' }], SCAN, CODE, () => false).drift.counts).toMatchObject({ reversed: 0, undesigned: 0 });
  });

  it('no code yet: the design alone is the map, every planned path 설계에만', () => {
    const { design, drift } = designMap(MODS, ARROWS, null, null, () => false);
    expect(design.structure!.bands.map((b) => b.id).sort()).toEqual(['cli', 'core', 'docs', 'server']);
    expect(drift.counts).toEqual({ reversed: 0, undesigned: 0, designOnly: 5, codeOnly: 0 });
  });
});
