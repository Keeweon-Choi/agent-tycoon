import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { expect, it } from 'vitest';

const hangul = /[가-힣]/;
const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    // i18n/ is where the words live; every other source file takes its words from there.
    if (entry.isDirectory()) return file === path.join(srcDir, 'i18n') ? [] : sourceFiles(file);
    return /\.tsx?$/.test(entry.name) ? [file] : [];
  });
}

function literalLines(file: string, source: string): number[] {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const lines: number[] = [];
  function visit(node: ts.Node): void {
    if (
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node) ||
        ts.isRegularExpressionLiteral(node) ||
        ts.isJsxText(node)) &&
      hangul.test(node.getText(tree))
    ) {
      lines.push(tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1);
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return lines;
}

it('keeps Hangul literals out of every webview source file outside i18n', () => {
  const violations = sourceFiles(srcDir).flatMap((file) =>
    literalLines(file, readFileSync(file, 'utf8')).map(
      (line) => `${path.relative(srcDir, file)}:${line}`,
    ),
  );
  expect(violations).toEqual([]);
});

it('catches a planted Hangul literal while allowing a comment', () => {
  expect(literalLines('negative.ts', "const label = '안녕'; // 한국어")).toEqual([1]);
  expect(literalLines('comment.ts', '// 한국어\nconst label = "English";')).toEqual([]);
});

// Owner 11-06: say what developers say, not an awkward translation. A git worktree is a
// 워크트리 (not 작업 공간) and a version is a 버전 (not 새 판 / 옛 판). Escapes keep Hangul out of this file.
const banned = [
  { word: '작업 ?공간', use: 'worktree' },
  { word: '(새|옛) 판(?![단정])', use: 'version' },
  // 11-06 (second round): merge, clone, worker, and 작업 폴더 for a worktree.
  { word: '병합|합쳐', use: '머지 (a git merge)' },
  { word: '복제', use: '클론 (a git clone)' },
  { word: '일꾼', use: '워커' },
  { word: '작업 ?폴더', use: '워크트리 (a worktree folder)' },
];

// Lines that keep an old word because it is not about git: the working folder of a plain git
// error and Claude's /add-dir. (ponytail: matched by their text; a new exception is one more entry.)
const allowed = ['git 작업 폴더가 아니에요', "ko: '작업 폴더를 더 추가해요'"];

it.each(['i18n/ko.ts', 'i18n/spec.ko.ts', '../../core/src/cld/serverText.ts'])(
  'keeps the owner-banned words out of %s',
  (file) => {
    const lines = readFileSync(path.join(srcDir, file), 'utf8').split('\n');
    const hits = banned.flatMap(({ word, use }) =>
      lines.flatMap((text, i) => (new RegExp(word).test(text) && !allowed.some((ok) => text.includes(ok)) ? [`${file}:${i + 1} (use ${use})`] : [])),
    );
    expect(hits).toEqual([]);
  },
);
