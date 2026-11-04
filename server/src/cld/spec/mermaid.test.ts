// SPT-P4A: the strict Mermaid subset. The R3 spike's cases, grammar examples written from Mermaid's
// documented flowchart syntax, the real-document quirks the research found, strict refusal with the
// first blocked line, the sequence reader, other diagram types, and every Mermaid block in this
// repository's cld/docs read through the real documents (with the parse time of all of them).
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import { readArch } from './arch.js';
import { type MBlock, type MFlow, type MSeq, parseMermaid } from './mermaid.js';

const flow = (src: string): MFlow => {
  const r = parseMermaid(src);
  if (!('flow' in r)) throw new Error(`not read: ${JSON.stringify(r)}`);
  return r.flow;
};
const seq = (src: string): MSeq => {
  const r = parseMermaid(src);
  if (!('seq' in r)) throw new Error(`not read: ${JSON.stringify(r)}`);
  return r.seq;
};
const blocked = (src: string) => (parseMermaid(src) as Extract<MBlock, { unsupported: unknown }>).unsupported;
const edges = (src: string) => flow(src).edges.map((e) => `${e.from}>${e.to}|${e.label}|${e.kind}${e.arrow ? '>' : ''}${e.bidir ? '<' : ''}`);
const nodes = (src: string) => [...flow(src).nodes.values()].map((n) => `${n.id}:${n.shape}:${n.label}`);
const F = (body: string) => `flowchart LR\n${body}`;

describe('the spike cases', () => {
  it('reads direction and node shapes', () => {
    const f = flow('flowchart LR\n A[Hard] --> B(Round) --> C{Pick}\n D[(Db)] --> E((Circle))');
    expect(f.dir).toBe('LR');
    expect([...f.nodes.values()].map((n) => `${n.id}:${n.shape}:${n.label}`)).toEqual(['A:rect:Hard', 'B:round:Round', 'C:rhombus:Pick', 'D:cylinder:Db', 'E:circle:Circle']);
  });
  it('reads the edge families and their labels', () => {
    expect(edges('graph TD\n A-->|yes|B\n A-- no -->C\n A-.->D\n A-. maybe .->E\n A==>F\n A== big ==>G\n A---H\n I-.attr.->J')).toEqual([
      'A>B|yes|solid>',
      'A>C|no|solid>',
      'A>D||dotted>',
      'A>E|maybe|dotted>',
      'A>F||thick>',
      'A>G|big|thick>',
      'A>H||solid',
      'I>J|attr|dotted>',
    ]);
  });
  it('expands chains and & groups', () => {
    expect(edges('flowchart TB\n A & B --> C & D')).toHaveLength(4);
    expect(edges('flowchart TB\n A --> B --> C')).toEqual(['A>B||solid>', 'B>C||solid>']);
  });
  it('keeps subgraph membership, nests, and skips class/style lines', () => {
    const f = flow('flowchart TB\n subgraph one [One]\n a1-->a2\n subgraph inner\n b1\n end\n end\n classDef x fill:orange\n class a1 x\n style a2 fill:white\n a2:::x --> z');
    expect(f.subgraphs.map((s) => `${s.id}<${s.parent}:${s.nodes.join(',')}`)).toEqual(['one<null:a1,a2', 'inner<one:b1']);
    expect(f.nodes.has('x')).toBe(false);
    expect(f.edges.map((e) => e.to)).toContain('z');
  });
  it('quoted labels may hold closers, semicolons and double dashes', () => {
    const f = flow('flowchart LR\n a["x (y) [z]; w"] -- "cmd --json" --> b');
    expect(f.nodes.get('a')!.label).toBe('x (y) [z]; w');
    expect(f.edges[0].label).toBe('cmd --json');
  });
  it('other diagram types are refused, named', () => {
    expect(parseMermaid('sequenceDiagram\n A->>B: hi')).toMatchObject({ type: 'sequenceDiagram' }); // read by the sequence reader now
    expect(parseMermaid('%%{init: {}}%%\nerDiagram\n A ||--o{ B : has')).toEqual({ type: 'erDiagram', unsupported: { line: 2, text: 'erDiagram' } });
  });
  it('accepts the init directive and front matter before the header', () => {
    expect(flow('%%{init: {"theme":"dark"}}%%\nflowchart TD\n A-->B').edges).toHaveLength(1);
    expect(flow('---\ntitle: t\n---\ngraph LR\n A-->B').dir).toBe('LR');
  });
});

// Written from Mermaid's flowchart syntax page (shapes, links, labels, chaining, subgraphs, comments, styling).
const GRAMMAR: Array<[string, string, { nodes?: string[]; edges?: string[]; subs?: string[] }]> = [
  ['a lone node', F('A'), { nodes: ['A:rect:A'] }],
  ['rect', F('A[Text]'), { nodes: ['A:rect:Text'] }],
  ['round', F('A(Text)'), { nodes: ['A:round:Text'] }],
  ['stadium', F('A([Text])'), { nodes: ['A:stadium:Text'] }],
  ['subroutine', F('A[[Text]]'), { nodes: ['A:subroutine:Text'] }],
  ['cylinder', F('A[(Database)]'), { nodes: ['A:cylinder:Database'] }],
  ['circle', F('A((Text))'), { nodes: ['A:circle:Text'] }],
  ['asymmetric', F('A>Text]'), { nodes: ['A:asymmetric:Text'] }],
  ['rhombus', F('A{Text}'), { nodes: ['A:rhombus:Text'] }],
  ['hexagon', F('A{{Text}}'), { nodes: ['A:hexagon:Text'] }],
  ['parallelogram', F('A[/Text/]'), { nodes: ['A:trapezoid:Text'] }],
  ['parallelogram alt', F('A[\\Text\\]'), { nodes: ['A:trapezoid:Text'] }],
  ['trapezoid', F('A[/Text\\]'), { nodes: ['A:trapezoid:Text'] }],
  ['trapezoid alt', F('A[\\Text/]'), { nodes: ['A:trapezoid:Text'] }],
  ['double circle', F('A(((Text)))'), { nodes: ['A:doublecircle:Text'] }],
  ['a quoted label with brackets', F('A["Text (one) [two]"]'), { nodes: ['A:rect:Text (one) [two]'] }],
  ['arrow', F('A --> B'), { edges: ['A>B||solid>'] }],
  ['open link', F('A --- B'), { edges: ['A>B||solid'] }],
  ['dotted arrow', F('A -.-> B'), { edges: ['A>B||dotted>'] }],
  ['dotted link', F('A -.- B'), { edges: ['A>B||dotted'] }],
  ['thick arrow', F('A ==> B'), { edges: ['A>B||thick>'] }],
  ['thick link', F('A === B'), { edges: ['A>B||thick'] }],
  ['circle edge', F('A --o B'), { edges: ['A>B||solid>'] }],
  ['cross edge', F('A --x B'), { edges: ['A>B||solid>'] }],
  ['both ways', F('A <--> B'), { edges: ['A>B||solid><'] }],
  ['both circles', F('A o--o B'), { edges: ['A>B||solid><'] }],
  ['both crosses', F('A x--x B'), { edges: ['A>B||solid><'] }],
  ['invisible', F('A ~~~ B'), { edges: ['A>B||invisible'] }],
  ['a longer arrow', F('A ----> B'), { edges: ['A>B||solid>'] }],
  ['a longer dotted arrow', F('A -...-> B'), { edges: ['A>B||dotted>'] }],
  ['a longer thick arrow', F('A ====> B'), { edges: ['A>B||thick>'] }],
  ['a pipe label', F('A -->|text| B'), { edges: ['A>B|text|solid>'] }],
  ['a quoted pipe label', F('A -->|"a text"| B'), { edges: ['A>B|a text|solid>'] }],
  ['a text label', F('A -- text --> B'), { edges: ['A>B|text|solid>'] }],
  ['a dotted text label', F('A -. text .-> B'), { edges: ['A>B|text|dotted>'] }],
  ['a thick text label', F('A == text ==> B'), { edges: ['A>B|text|thick>'] }],
  ['a text label on an open link', F('A -- text --- B'), { edges: ['A>B|text|solid'] }],
  ['a chain', F('A --> B --> C'), { edges: ['A>B||solid>', 'B>C||solid>'] }],
  ['a chain through &', F('A --> B & C --> D'), { edges: ['A>B||solid>', 'A>C||solid>', 'B>D||solid>', 'C>D||solid>'] }],
  ['& on the left', F('A & B --> C'), { edges: ['A>C||solid>', 'B>C||solid>'] }],
  ['a subgraph', F('subgraph one\n a1 --> a2\nend'), { subs: ['one:one<null:a1,a2'] }],
  ['a subgraph with an id and a title', F('subgraph id1 [Title one]\n x\nend'), { subs: ['id1:Title one<null:x'] }],
  ['a quoted subgraph title', F('subgraph "Quoted title"\n x\nend'), { subs: ['Quoted title:Quoted title<null:x'] }],
  ['nested subgraphs', F('subgraph a\n subgraph b\n  subgraph c\n   n\n  end\n end\nend'), { subs: ['a:a<null:', 'b:b<a:', 'c:c<b:n'] }],
  ['an edge to a subgraph', F('subgraph s1\n a\nend\nb --> s1'), { edges: ['b>s1||solid>'], subs: ['s1:s1<null:a'] }],
  ['a comment line', F('%% a comment\nA --> B'), { edges: ['A>B||solid>'] }],
  ['semicolons', F('A --> B; B --> C;'), { edges: ['A>B||solid>', 'B>C||solid>'] }],
  ['a header with a semicolon', 'graph TD;\n A-->B;', { edges: ['A>B||solid>'] }],
  ['classes', F('classDef green fill:green,stroke:black\nclass A,B green\nA:::green --> B'), { nodes: ['A:rect:A', 'B:rect:B'], edges: ['A>B||solid>'] }],
  ['styles', F('style A fill:pink\nlinkStyle 0 stroke:yellow\nA --> B'), { edges: ['A>B||solid>'] }],
  ['click', F('click A callback "Tooltip"\nA --> B'), { edges: ['A>B||solid>'] }],
  ['direction in a subgraph', F('subgraph s\n direction TB\n a\nend'), { subs: ['s:s<null:a'] }],
  ['no spaces', F('A-->B'), { edges: ['A>B||solid>'] }],
  ['no spaces around a text label', F('A-- text -->B'), { edges: ['A>B|text|solid>'] }],
  ['a dotted label without spaces', F('A-.text.->B'), { edges: ['A>B|text|dotted>'] }],
  ['ids with dashes and dots', F('my-node.x --> b'), { edges: ['my-node.x>b||solid>'] }],
  ['unicode ids', F('사용자 --> 서버'), { edges: ['사용자>서버||solid>'] }],
  ['a label first, then the bare id', F('A[Server] --> B\nB --> A'), { nodes: ['A:rect:Server', 'B:rect:B'] }],
  ['the label given later', F('A --> B\nB[(Store)]'), { nodes: ['A:rect:A', 'B:cylinder:Store'] }],
];

describe('flowchart grammar', () => {
  it.each(GRAMMAR)('%s', (_name, src, want) => {
    const f = flow(src);
    if (want.nodes) expect(nodes(src)).toEqual(want.nodes);
    if (want.edges) expect(edges(src)).toEqual(want.edges);
    if (want.subs) expect(f.subgraphs.map((s) => `${s.id}:${s.title}<${s.parent}:${s.nodes.join(',')}`)).toEqual(want.subs);
  });
  it('holds at least 40 examples', () => expect(GRAMMAR.length).toBeGreaterThanOrEqual(40));
  it('reads every header form', () => {
    expect(flow('graph\n A').dir).toBe('TD');
    expect(flow('flowchart TB\n A').dir).toBe('TD');
    expect(flow('flowchart BT\n A').dir).toBe('BT');
    expect(flow('flowchart RL\n A').dir).toBe('RL');
    expect(flow('flowchart-elk LR\n A').dir).toBe('LR');
  });
  it('the init directive over several lines, and front matter', () => {
    expect(edges('%%{\n  init: { "flowchart": { "curve": "basis" } }\n}%%\nflowchart LR\n A --> B')).toEqual(['A>B||solid>']);
    expect(edges('---\ntitle: Example\nconfig:\n  theme: forest\n---\nflowchart LR\n A --> B')).toEqual(['A>B||solid>']);
  });
});

describe('the real-document quirks (research §3)', () => {
  it('<br> in a label is a line break', () => {
    expect(flow(F('A["Line one<br/>Line two"] -- "a<br>b" --> B')).nodes.get('A')!.label).toBe('Line one\nLine two');
    expect(edges(F('A["x"] -- "a<br>b" --> B'))).toEqual(['A>B|a\nb|solid>']);
  });
  it('an unquoted (GraphRAG) in a square label is read (mermaid refuses it; the structure is clear)', () => {
    expect(nodes(F('S[Search (GraphRAG)] --> I'))[0]).toBe('S:rect:Search (GraphRAG)');
  });
  it('a line-end %% comment is dropped (mermaid refuses it)', () => {
    expect(edges(F('A --> B %% why'))).toEqual(['A>B||solid>']);
  });
});

describe('strict blocks: one unsupported line and the block is refused with it', () => {
  const cases: Array<[string, string, number]> = [
    ['A@{ shape }', F('A --> B\nA@{ shape: rect }\nB --> C'), 3],
    ['a markdown label', F('A["`**bold**`"] --> B'), 2],
    ['an edge id', F('A e1@--> B'), 2],
    ['an edge with no end', F('A -->'), 2],
    ['end without a subgraph', F('A\nend'), 3],
    ['title', F('title Something\nA'), 2],
    ['text after a node', F('A B'), 2],
    ['an unclosed shape', F('A[open --> B'), 2],
    ['accTitle', F('accTitle: x\nA'), 2],
    ['subgraph without a name', F('subgraph\nA\nend'), 2],
    ['a bad header', 'flowchart XY\n A', 1],
  ];
  it.each(cases)('%s', (_n, src, line) => {
    const b = blocked(src);
    expect(b.line).toBe(line);
    expect(b.text).toBe(src.split('\n')[line - 1].trim());
    expect(parseMermaid(src)).not.toHaveProperty('flow'); // never a partial graph
  });
  it('an open subgraph is refused at its line', () => expect(blocked(F('A\nsubgraph s\n b'))).toEqual({ line: 3, text: 'subgraph s' }));
  it('line numbers count front matter, directives and blank lines', () => {
    expect(blocked('---\ntitle: t\n---\n\n%%{init: {}}%%\nflowchart LR\n A --> B\n\n C@{ shape: odd }')).toMatchObject({ line: 9, text: 'C@{ shape: odd }' });
  });
  it('a line over the length cap refuses its block', () => expect(blocked(F(`A["${'x'.repeat(5000)}"]`)).line).toBe(2));
});

describe('sequence diagrams', () => {
  const SEQ = [
    'sequenceDiagram',
    '  autonumber',
    '  participant W as Web app',
    '  actor U as Owner',
    '  participant D',
    '  U->>W: open',
    '  activate W',
    '  W->>+D: GET /api',
    '  D-->>-W: 200',
    '  Note right of D: cached',
    '  loop every minute',
    '    W-)D: ping',
    '  end',
    '  alt ok',
    '    D--)W: pong',
    '  else fails',
    '    D-xW: error',
    '    D--xW: closed',
    '  end',
    '  W->D: plain',
    '  W-->D: dotted',
    '  deactivate W',
    '  D->>Cache: write',
  ].join('\n');
  it('reads participants (with as), the eight arrows and their text, and the messages inside blocks', () => {
    const s = seq(SEQ);
    expect([...s.participants.values()].map((p) => `${p.id}=${p.label}@${p.line}`)).toEqual(['W=Web app@3', 'U=Owner@4', 'D=D@5', 'Cache=Cache@23']);
    expect(s.messages.map((m) => `${m.from}${m.arrow}${m.to}:${m.text}`)).toEqual([
      'U->>W:open',
      'W->>D:GET /api',
      'D-->>W:200',
      'W-)D:ping',
      'D--)W:pong',
      'D-xW:error',
      'D--xW:closed',
      'W->D:plain',
      'W-->D:dotted',
      'D->>Cache:write',
    ]);
  });
  it('refuses what it does not read', () => {
    expect(blocked('sequenceDiagram\n A->>B: x\n box Aqua Group\n end')).toMatchObject({ line: 3, text: 'box Aqua Group' });
    expect(blocked('sequenceDiagram\n participant A@{ "type": "database" }')).toMatchObject({ line: 2 });
    expect(blocked('sequenceDiagram\n A->>B: x\n end')).toMatchObject({ line: 3 });
    expect(blocked('sequenceDiagram\n title Hello')).toMatchObject({ line: 2 });
    expect(blocked('sequenceDiagram\n A<<->>B: both')).toMatchObject({ line: 2 });
    expect(blocked('sequenceDiagram\n else')).toMatchObject({ line: 2 });
  });
});

describe('other diagram types', () => {
  it.each(['erDiagram', 'stateDiagram-v2', 'stateDiagram', 'classDiagram', 'gantt', 'pie', 'journey', 'gitGraph', 'architecture-beta'])('%s is named', (type) => {
    expect(parseMermaid(`${type}\n  x`)).toEqual({ type, unsupported: { line: 1, text: type } });
  });
  it('an empty block', () => expect(parseMermaid('\n \n')).toMatchObject({ type: 'unknown' }));
});

describe("this repository's cld/docs", () => {
  const root = path.resolve(__dirname, '../../../../cld/docs');
  const md = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? md(path.join(dir, e.name)) : e.name.endsWith('.md') ? [path.join(dir, e.name)] : []));
  it('every Mermaid block is read, none refused, every edge between read nodes; the parse time of all documents', () => {
    const files = md(root);
    const texts = files.map((f) => fs.readFileSync(f, 'utf-8'));
    const t0 = performance.now();
    const archs = texts.map((t) => readArch(t));
    const ms = performance.now() - t0;
    const fences = texts.reduce((n, t) => n + (t.match(/^\s*```mermaid/gm)?.length ?? 0), 0);
    expect(fences).toBeGreaterThanOrEqual(3);
    let blocks = 0;
    archs.forEach((a, i) => {
      expect(a.unsupported, files[i]).toEqual([]);
      for (const l of a.links) for (const e of [l.from, l.to]) expect(typeof e === 'number' ? a.comps[e] : a.groups.find((g) => g.key === e), `${files[i]}:${l.line}`).toBeTruthy();
      blocks += new Set(a.comps.map((c) => c.block)).size;
    });
    expect(blocks).toBeGreaterThanOrEqual(fences);
    const arch = archs[files.findIndex((f) => f.endsWith('design/architecture.md'))];
    expect(arch.groups.length).toBeGreaterThanOrEqual(1);
    console.log(`[measure] readArch over ${files.length} cld/docs files (${(texts.join('').length / 1024).toFixed(0)} KB, ${fences} Mermaid blocks): ${ms.toFixed(1)} ms`);
  });
});
