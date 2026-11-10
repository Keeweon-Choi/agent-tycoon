// SPT C1 (§8.1-8.3, TC-233): the structure rules, fixed on this repository at 662d3ef9 (R4's
// numbers), on the Spec Kit example's files, and on small cases; the scan's import reading too.
// The fixture __fixtures__/r4-662d3ef9.json.gz is scanCode's answer for a clone at 662d3ef9
// (files, edges, unresolved, workspaces) plus that commit's SRS items as extract() reads them
// ([display ID, section, line]): made once by hand, `git clone --shared` + `git checkout 662d3ef9`.
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import * as zlib from 'zlib';

import { SPEC_MAP_ARROW_MIN } from '../../constants.js';
import { codeKey, type CodeScan, isCodeFile, isGenerated, relativeImports, resolveImport, scanCode, workspaceDirs } from './mapWorker.js';
import { type FeatureReq, featuresOf, layersOf, structureView } from './structure.js';

const fixture = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(__dirname, '__fixtures__/r4-662d3ef9.json.gz'))).toString('utf-8')) as Omit<CodeScan, 'at' | 'ms' | 'rssKb' | 'big'> & { srs: Array<[string, string, number]> };
const r4: CodeScan = { ...fixture, big: 0, at: '2026-11-04T00:00:00.000Z', ms: 0, rssKb: 0 };
const cells = (v: ReturnType<typeof structureView>) => v!.blocks.filter((b) => b.kind !== 'rail').map((b) => [b.rest ? `${b.name} 나머지` : b.name, b.files]);

describe('the structure on this repository (R4, 662d3ef9)', () => {
  it('nine cells as R4 drew them, rails 336 and 80, no layer violation, nine two-way pairs, bands in import order', () => {
    expect([r4.files.length, r4.edges.length / 2, r4.unresolved]).toEqual([1516, 6209, 347]);
    const v = structureView(r4)!;
    expect(cells(v).sort((a, b) => Number(b[1]) - Number(a[1]))).toEqual([
      ['webview-ui 나머지', 396],
      ['server 나머지', 335],
      ['engine', 117],
      ['messenger', 69],
      ['core', 46],
      ['office', 40],
      ['components', 35],
      ['auth', 31],
      ['devroom', 31],
    ]);
    expect(v.blocks.filter((b) => b.kind === 'rail').map((b) => [b.id, b.files])).toEqual([
      ['tests', 336],
      ['tools', 80],
    ]);
    expect(v.bands.map((b) => b.id)).toEqual(['webview-ui', 'server', 'core']); // the importer above
    expect(v.violations).toBe(0);
    expect(v.pairs.filter((p) => p.ab && p.ba)).toHaveLength(9);
    expect(v.pairs[0]).toEqual({ a: 'server', b: 'server/src/cld/engine', ab: 158, ba: 159 });
    expect(v.imports).toBe(6209);
    expect(v.blocks.find((b) => b.id === 'server')!.inside.slice(0, 2)).toEqual([
      { name: 'cld/*', n: 167 },
      { name: 'src/*', n: 41 },
    ]);
  });

  it('negative control: without the import rule for top folders (M1), the nine cells are not R4 any more', () => {
    expect(layersOf(r4.files, r4.edges, r4.workspaces)).toEqual(['server', 'webview-ui', 'core']);
    const strict = structureView(r4, [], new Map(), 9, Number.MAX_SAFE_INTEGER)!; // core never imported enough
    expect(strict.bands.map((b) => b.id)).toEqual(['webview-ui', 'server']);
    expect(cells(strict)).not.toEqual(cells(structureView(r4)));
    const loose = layersOf(r4.files, r4.edges, r4.workspaces, 1); // cld (2) and eslint-rules (1) become layers
    expect(loose).toEqual(['server', 'webview-ui', 'cld', 'core', 'eslint-rules']);
    expect(SPEC_MAP_ARROW_MIN).toBe(50);
  });

  it('[한 단계 들어가기]: a cell folded again as one layer, with its crumbs; a chain naming no cell is null; the owner names a folder', () => {
    const inside = structureView(r4, ['server'])!;
    expect(inside.crumbs).toEqual([{ id: 'server', name: 'server' }]);
    expect(inside.bands).toHaveLength(1);
    expect(inside.files).toBe(335);
    expect(inside.blocks.map((b) => b.id)).toContain('server/src/cld/spec');
    expect(inside.violations).toBe(0);
    const deeper = structureView(r4, ['server', 'server/src/cld/spec'])!;
    expect(deeper.crumbs.map((c) => c.id)).toEqual(['server', 'server/src/cld/spec']);
    expect(structureView(r4, ['nowhere'])).toBeNull();
    const named = structureView(r4, [], new Map([['webview-ui', '화면']]))!;
    expect(named.bands[0].name).toBe('화면');
    expect(named.blocks.find((b) => b.id === 'webview-ui')!.name).toBe('화면');
  });
});

describe('features (SPT §8.1)', () => {
  const srs = (fmId?: string): FeatureReq[] =>
    fixture.srs.map(([id, section, line], i) => ({ uid: `r${i}`, id, doc: 'd_srs', path: 'cld/docs/requirements/SRS.md', ...(fmId && { fmId }), section, line, changed: false, progress: false, blocked: false }));

  it('this SRS: 21 features by prefix (182 requirements) named by their sections, 90 common (NFR 55, IR 20, CON 15); its front-matter id is not used (34 prefixes)', () => {
    const { features, common } = featuresOf(srs('SRS'));
    expect(features).toHaveLength(21);
    expect(features.reduce((s, f) => s + f.reqs, 0)).toBe(182);
    expect(features.every((f) => f.rule === 'prefix')).toBe(true);
    expect(features.find((f) => f.key === 'FR-ENG')).toMatchObject({ short: 'ENG', name: '내장 엔진', reqs: 13, source: { path: 'cld/docs/requirements/SRS.md' } });
    expect(features.find((f) => f.key === 'FR-TRC')).toMatchObject({ name: '명세 추적', reqs: 16 });
    const by = (head: string) => common.filter((c) => c.key.split('-')[0] === head).reduce((s, c) => s + c.reqs, 0);
    expect([by('NFR'), by('IR'), by('CON')]).toEqual([55, 20, 15]);
  });

  it('a display ID repeated in another document (a traceability table) counts once; the defining section names it whichever comes first', () => {
    const table = fixture.srs.map(([id], i): FeatureReq => ({ uid: `t${i}`, id, doc: 'd_trc', path: 'cld/docs/requirements/traceability.md', section: '요구사항 추적표', line: i + 10, changed: false, progress: false, blocked: false }));
    const { features, common } = featuresOf([...table, ...srs('SRS')]);
    expect([features.length, features.reduce((s, f) => s + f.reqs, 0), common.reduce((s, c) => s + c.reqs, 0)]).toEqual([21, 182, 90]);
    expect(features.find((f) => f.key === 'FR-ENG')).toMatchObject({ name: '내장 엔진', reqs: 13, source: { path: 'cld/docs/requirements/SRS.md' } });
  });

  it('the other rules: a front-matter id with one prefix, a Spec Kit folder, a folder for ID-less items; 볼 것 먼저', () => {
    const r = (uid: string, id: string, p: string, more: Partial<FeatureReq> = {}): FeatureReq => ({ uid, id, doc: p, path: p, section: '', line: 1, changed: false, progress: false, blocked: false, ...more });
    const { features } = featuresOf([
      r('a', 'FR-PAY-001', 'docs/pay.md', { fmId: 'PAY' }),
      r('b', 'FR-PAY-002', 'docs/pay.md', { fmId: 'PAY', progress: true }),
      r('c', 'FR-001', 'specs/002-checkout/spec.md'),
      r('d', '', 'docs/old/notes.md', { changed: true }),
      r('e', 'FR-X-001', 'docs/x.md', { blocked: true }),
    ]);
    expect(features.map((f) => [f.key, f.rule, f.reqs])).toEqual([
      ['FR-X', 'prefix', 1], // blocked first
      ['dir:docs/old', 'folder', 1], // then changed
      ['fm:docs/pay.md', 'fm', 2], // then in progress
      ['sk:002-checkout', 'speckit', 1],
    ]);
    expect(features.find((f) => f.rule === 'fm')).toMatchObject({ short: 'PAY', progress: true });
  });
});

describe('the scan (the child process side)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  const noGit = async () => ({ code: 128, stdout: Buffer.alloc(0), stderr: '', capped: false, timedOut: false });

  it('reads the four import forms, resolves .js to .ts and folders to index, counts what it cannot resolve', () => {
    expect(relativeImports(`import a from './a.js';\nimport type { B } from "../b";\nexport * from './c';\nconst d = await import('./d.js');\nconst e = require('./e.cjs');\nimport x from 'react';\nimport './style.css';`)).toEqual([
      './a.js',
      '../b',
      './c',
      './d.js',
      './e.cjs',
      './style.css',
    ]);
    const has = (f: string) => ['src/a.ts', 'b.tsx', 'src/c/index.ts', 'src/e.cjs'].includes(f);
    expect(['./a.js', '../b', './c', './e.cjs', './style.css'].map((s) => resolveImport('src/x.ts', s, has))).toEqual(['src/a.ts', 'b.tsx', 'src/c/index.ts', 'src/e.cjs', null]);
    expect([isCodeFile('a/b.ts'), isCodeFile('a/b.d.ts'), isCodeFile('node_modules/x/y.js'), isCodeFile('webview-ui/public/x.js'), isCodeFile('x.mjs'), isCodeFile('a.py')]).toEqual([true, false, false, false, true, true]);
    expect(isGenerated('/**\n * AUTO-GENERATED FROM core/asyncapi.yaml. DO NOT EDIT MANUALLY.')).toBe(true);
    expect(workspaceDirs({ workspaces: ['server', './webview-ui/', 'packages/*'] }, ['packages/a/x.ts', 'packages/b/y.ts', 'packages/z.ts'])).toEqual(['packages/a', 'packages/b', 'server', 'webview-ui']);
    expect(workspaceDirs({ workspaces: { packages: ['apps/*'] } }, ['apps/web/i.ts'])).toEqual(['apps/web']);
  });

  it.skipIf(process.platform === 'win32')('never opens what is no regular file of the project: a link to /dev/zero, a link out of the folder, a linked folder, a FIFO; the key counts the same files', async () => {
    const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agty-structure-evil-')));
    dirs.push(base);
    const dir = path.join(base, 'repo');
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(base, 'outside'));
    fs.writeFileSync(path.join(base, 'outside/secret.ts'), "import { s } from './s.js';");
    fs.writeFileSync(path.join(base, 'outside/s.ts'), 'export const s = 1;');
    fs.writeFileSync(path.join(dir, 'src/ok.ts'), "import { a } from './a.js';");
    fs.writeFileSync(path.join(dir, 'src/a.ts'), 'export const a = 1;');
    fs.symlinkSync('/dev/zero', path.join(dir, 'src/zero.ts'));
    fs.symlinkSync('../../outside/secret.ts', path.join(dir, 'src/out.ts'));
    fs.symlinkSync('../outside', path.join(dir, 'linked'));
    fs.symlinkSync('/dev/zero', path.join(dir, 'package.json'));
    execFileSync('mkfifo', [path.join(dir, 'src/pipe.ts')]);
    // As a repository would list them (a linked folder's files named as if they were there).
    const listed = ['src/ok.ts', 'src/a.ts', 'src/zero.ts', 'src/out.ts', 'src/pipe.ts', 'linked/secret.ts', 'linked/s.ts'].sort();
    const git = async () => ({ code: 0, stdout: Buffer.from(listed.join('\0')), stderr: '', capped: false, timedOut: false });
    const scan = await scanCode(dir, git);
    expect(scan.files).toEqual(['src/a.ts', 'src/ok.ts']);
    expect(scan.edges.length / 2).toBe(1);
    expect(scan.workspaces).toEqual([]);
    expect((await codeKey(dir, git)).split('|')[0]).toBe('2');
  });

  it('the Spec Kit example (lendlib, a folder that is no repository): four layers under src/, the tests rail, no violation; a generated file is left out', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agty-structure-')));
    dirs.push(dir);
    const files: Record<string, string> = {
      'src/api/catalog/categories.ts': "import type { Book } from '../../shared/models/book.js';",
      'src/api/catalog/search.ts': "import { searchBooks } from '../../db/books.js';",
      'src/api/loans/checkout.ts': "import { loans } from '../../db/loans.js';\nimport type { Loan } from '../../shared/models/loan.js';",
      'src/api/loans/return.ts': "import { loans } from '../../db/loans.js';",
      'src/api/notify/schedule.ts': "import { loans } from '../../db/loans.js';",
      'src/db/books.ts': "import type { Book } from '../shared/models/book.js';\nimport { db } from './index.js';",
      'src/db/index.ts': 'export const db = 1;',
      'src/db/loans.ts': "import type { Loan } from '../shared/models/loan.js';\nimport { db } from './index.js';",
      'src/shared/models/book.ts': 'export type Book = 1;',
      'src/shared/models/loan.ts': 'export type Loan = 1;',
      'src/web/pages/book.ts': "import type { Loan } from '../../shared/models/loan.js';",
      'src/web/pages/catalog.ts': "import type { Book } from '../../shared/models/book.js';",
      'src/web/gen.ts': '// @generated by a tool\nimport x from "../db/index.js";',
      'tests/catalog.test.ts': "import { searchBooks } from '../src/db/books.js';",
      'tests/checkout.test.ts': "import { checkout } from '../src/api/loans/checkout.js';",
      'package.json': '{ "name": "lendlib", "private": true, "type": "module" }',
    };
    for (const [f, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), text);
    }
    const scan = await scanCode(dir, noGit);
    expect(scan.files).toHaveLength(14); // gen.ts out
    expect(scan.files).not.toContain('src/web/gen.ts');
    expect(scan.edges.length / 2).toBe(14);
    const v = structureView(scan)!;
    expect(v.bands.map((b) => b.id).sort()).toEqual(['src/api', 'src/db', 'src/shared', 'src/web']);
    expect(v.blocks.filter((b) => b.kind !== 'rail').map((b) => b.name).sort()).toEqual(['catalog', 'db', 'loans', 'notify', 'shared', 'web']); // src/api's rest is empty: dropped
    expect(v.blocks.filter((b) => b.kind === 'rail').map((b) => [b.id, b.files])).toEqual([['tests', 2]]);
    expect(v.violations).toBe(0);
    expect(v.bands.at(-1)!.id).toBe('src/shared'); // everyone imports it: the bottom
  });
});
