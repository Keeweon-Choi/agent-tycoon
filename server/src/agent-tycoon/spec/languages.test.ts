// Project Brain K7a: every language's files become cells of the 지도 (the extension table is Linguist's and
// tokei's data, the test-file and test-name rules are ours). A small Python-led fake repository with a few
// other languages: its files are counted, its tests go to the tests rail, its numbers are read from the
// language's own comments and test names; only TS and JS have their imports read. Negative control: take
// Python out of the table (languages.ts RULES and the generated row) and the Python parts fail.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { isTestFile, isTestFileOutsideJs, languageOf, otherKind } from './languages.js';
import { CODE_LANGUAGES } from './languageTable.generated.js';
import { headTags, isCodeFile, scanCode, testNameIds } from './mapWorker.js';
import { structureView } from './structure.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const REPO: Record<string, string> = {
  'app/__init__.py': '',
  'app/models.py': '# SPT-P3: the models\n# FR-DEMO-001 stores a book\nclass Book: pass\n',
  'app/views.py': 'from .models import Book\n',
  'app/test_views.py': 'import pytest\n@pytest.mark.req("FR-DEMO-003")\ndef test_views(): pass\n',
  'tests/test_models.py': 'def test_book(): pass\n',
  'cmd/main.go': '// MAP-A\npackage main\n',
  'cmd/main_test.go': 't.Run("FR-DEMO-004 serves", nil)\nfunc TestMain(t *testing.T) {}\n',
  'src/lib.rs': 'pub fn f() {}\n',
  'server/Foo.java': 'class Foo {}\n',
  'server/FooTest.java': 'class FooTest {}\n',
  'scripts/run.sh': '#!/bin/sh\n# OPS-RUN\necho hi\n',
  'scripts/run.bats': '@test "FR-DEMO-005 runs" {\n}\n',
  'db/schema.sql': '-- DB-TAG\ncreate table t (id int);\n',
  'web/app.ts': "import { x } from './x.js';\n",
  'web/x.ts': 'export const x = 1;\n',
  'docs/README.md': '# readme\n',
  'etc/settings.toml': 'a = 1\n',
  '.venv/lib/dep.py': 'x = 1\n',
  'build/gen.py': 'x = 1\n',
  'setup.py': 'from setuptools import setup\n',
};
const makeRepo = (): string => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agty-languages-')));
  dirs.push(dir);
  for (const [f, text] of Object.entries(REPO)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), text);
  }
  return dir;
};

describe('the language table', () => {
  it('every language of the table is code; settings, documents and dependency folders are not; every hand rule has a table row', () => {
    expect(['a/b.py', 'x.go', 'x.rs', 'X.java', 'x.kt', 'x.c', 'x.cc', 'x.cs', 'x.rb', 'x.php', 'x.swift', 'x.sh', 'x.sql', 'x.lua', 'x.ts'].map(isCodeFile)).toEqual(Array(15).fill(true));
    expect(['README.md', 'a.json', 'a.toml', '.venv/lib/a.py', 'build/a.py', 'target/debug/a.rs', 'vendor/a.go', 'a.d.ts', 'Makefile'].map(isCodeFile)).toEqual(Array(9).fill(false));
    expect([otherKind('a.json'), otherKind('b.yml'), otherKind('c.md'), otherKind('d.rst'), otherKind('e.py'), otherKind('f.png')]).toEqual(['config', 'config', 'docs', 'docs', null, null]);
    expect(CODE_LANGUAGES.length).toBeGreaterThan(200);
    for (const e of 'ts tsx mts cts js jsx mjs cjs py pyi pyw go rs java kt kts c h cc cpp cxx hpp hh hxx cs rb rake php swift sh bash zsh sql scala sc dart lua pl pm ex exs'.split(' ')) expect(languageOf(`x.${e}`), e).toBeDefined();
    expect(languageOf('a.h')!.name).toBe('C');
    expect(languageOf('a.tsx')!.name).toBe('TypeScript');
  });
  it('a test file by its name, per language; TS and JS test files stay beside the code, the others go to the rail', () => {
    const t = ['pkg/test_a.py', 'pkg/a_test.py', 'x/a_test.go', 'src/foo/tests/it.rs', 'S/FooTest.java', 'k/FooTests.kt', 'a/b_spec.rb', 'a/CalcTest.cs', 'a/FooTest.php', 'a/FooTests.swift', 'a/x_test.cc', 'a/run.bats', 'a/a_test.exs'];
    expect(t.map(isTestFile)).toEqual(Array(t.length).fill(true));
    expect(['pkg/a.py', 'x/a.go', 'S/Foo.java', 'a/b.rb', 'a/run.sh'].map(isTestFile)).toEqual(Array(5).fill(false));
    expect(isTestFile('a/b.test.ts')).toBe(true);
    expect(isTestFileOutsideJs('a/b.test.ts')).toBe(false);
    expect(isTestFileOutsideJs('a/b_test.go')).toBe(true);
  });
  it("test names and head-comment tags in the language's own syntax", () => {
    const py = languageOf('a.py')!;
    expect(testNameIds('@pytest.mark.req("FR-DEMO-003")\ndef test_x(): pass\nx = "FR-DEMO-002"', py)).toEqual(['FR-DEMO-003']);
    expect(testNameIds('func TestA(t *testing.T) {\n t.Run("FR-DEMO-004 a", f)\n}\nvar s = "FR-DEMO-002"', languageOf('a.go')!)).toEqual(['FR-DEMO-004']);
    expect(testNameIds('describe "FR-DEMO-006 a" do\n  it "FR-DEMO-007 b" do\n', languageOf('a.rb')!)).toEqual(['FR-DEMO-006', 'FR-DEMO-007']);
    expect(testNameIds('@test "FR-DEMO-005 runs" {\n}', languageOf('a.bats')!)).toEqual(['FR-DEMO-005']);
    expect(headTags('# SPT-P3: x\n# FR-DEMO-001 is a number\nx = 1', py)).toEqual(['SPT-P3']);
    expect(headTags('"""SPT-P4 module"""', py)).toEqual(['SPT-P4']);
    expect(headTags('-- DB-TAG\n', languageOf('a.sql')!)).toEqual(['DB-TAG']);
    // a language with no test-name rule (SQL, C) or an unknown one reads none, and does not throw
    expect(testNameIds("it('FR-DEMO-001')", languageOf('a.sql')!)).toEqual([]);
    expect(testNameIds('TEST(FR-DEMO-001)', languageOf('a.hs')!)).toEqual([]);
    expect(headTags('-- DB-TAG', languageOf('a.c')!)).toEqual([]);
    expect(headTags('/** SPT-P3\n * MAP-A\n */', languageOf('a.ts')!)).toEqual(['SPT-P3', 'MAP-A']);
  });
});

describe('a Python-led fake repository', () => {
  it('every language is in the cells; tests go to the tests rail; imports are read for TS only; settings and documents are counted apart', async () => {
    const listed = Object.keys(REPO); // as a repository would list them (the folder walk leaves root files out)
    const git = async () => ({ code: 0, stdout: Buffer.from(listed.join('\0')), stderr: '', capped: false, timedOut: false });
    const scan = await scanCode(makeRepo(), git);
    expect(scan.files).toEqual(
      ['app/__init__.py', 'app/models.py', 'app/test_views.py', 'app/views.py', 'cmd/main.go', 'cmd/main_test.go', 'db/schema.sql', 'scripts/run.bats', 'scripts/run.sh', 'server/Foo.java', 'server/FooTest.java', 'setup.py', 'src/lib.rs', 'tests/test_models.py', 'web/app.ts', 'web/x.ts'].sort(),
    );
    expect(scan.other).toEqual({ config: 1, docs: 1 });
    expect(scan.edges.length / 2).toBe(1); // web/app.ts → web/x.ts; `from .models import Book` is not read
    const v = structureView(scan)!;
    expect(v.files).toBe(16);
    const rail = v.blocks.find((b) => b.id === 'tests')!;
    expect(rail.files).toBe(5); // tests/test_models.py, app/test_views.py, cmd/main_test.go, server/FooTest.java, scripts/run.bats
    expect(v.blocks.find((b) => b.id === 'tools')!.files).toBe(1); // setup.py
    expect(v.langs!.map((l) => [l.name, l.files])).toEqual([['Python', 6], ['TypeScript', 2], ['Go', 2], ['Java', 2], ['Shell', 2], ['Rust', 1], ['SQL', 1]].sort((a, b) => (b[1] as number) - (a[1] as number) || (a[0] < b[0] ? -1 : 1)));
    expect(v.noImports).toBe(14);
    // numbers: a comment's, a test name's and a head tag, in each language's own syntax
    const at = (f: string) => scan.files.indexOf(f);
    expect(scan.links!.body['FR-DEMO-001']).toEqual([at('app/models.py')]);
    expect(scan.links!.names['FR-DEMO-003']).toEqual([at('app/test_views.py')]);
    expect(scan.links!.names['FR-DEMO-004']).toEqual([at('cmd/main_test.go')]);
    expect(scan.links!.names['FR-DEMO-005']).toEqual([at('scripts/run.bats')]);
    expect(Object.keys(scan.links!.tags).sort()).toEqual(['DB-TAG', 'MAP-A', 'OPS-RUN', 'SPT-P3']);
  });
});
