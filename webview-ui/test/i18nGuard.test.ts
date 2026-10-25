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
