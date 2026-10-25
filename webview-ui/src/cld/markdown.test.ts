import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, expect, it } from 'vitest';

import { setLanguage } from '../i18n/index.js';
import { Markdown } from './markdown.js';

beforeEach(() => setLanguage('ko'));

const html = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));

const fileHtml = (text: string) =>
  renderToStaticMarkup(
    createElement(Markdown, {
      text,
      projectRoot: '/work/project',
      fileLink: (path) =>
        path === '/work/project/src/file.ts' || path === '/work/project/src/app.ts',
      onOpenFile: () => undefined,
    }),
  );

it('renders bold, italic, strikethrough and inline code', () => {
  const out = html('**\uad75\uac8c** and *\uae30\uc6b8\uc784* and ~~gone~~ and `x < y`');
  expect(out).toMatch(/<strong[^>]*>\uad75\uac8c<\/strong>/);
  expect(out).toMatch(/<em[^>]*>\uae30\uc6b8\uc784<\/em>/);
  expect(out).toContain('<del');
  expect(out).toMatch(/<code[^>]*>x &lt; y<\/code>/);
  expect(out).not.toContain('**');
});

it('does not turn snake_case or a lone asterisk into emphasis', () => {
  const out = html('use my_var_name and 2 * 3 * 4');
  expect(out).not.toContain('<em');
  expect(out).toContain('my_var_name');
});

it('keeps a single newline as a line break', () => {
  expect(html('one\ntwo')).toContain('one<br/>two');
});

it('renders headings sized down, as bold text with a level', () => {
  const out = html('# Big\n### Small');
  expect(out).toContain('role="heading"');
  expect(out).toContain('aria-level="1"');
  expect(out).toContain('aria-level="3"');
  expect(out).not.toContain('<h1');
});

it('renders fenced code verbatim and scrollable, without markup inside', () => {
  const out = html('```ts\nconst a = **1**;\n<b>x</b>\n```');
  expect(out).toContain('<pre');
  expect(out).toContain('overflow-x-auto');
  expect(out).toContain('const a = **1**;');
  expect(out).toContain('&lt;b&gt;x&lt;/b&gt;');
  expect(out).not.toContain('<strong');
});

it('an unclosed fence runs to the end (a reply may still be arriving)', () => {
  expect(html('```\nhalf')).toContain('half</code>');
});

it('renders bullet, numbered and nested lists', () => {
  const out = html('- a\n- b\n  - b1\n\n3. three\n4. four');
  expect(out).toMatch(/<ul[^>]*>.*<li[^>]*><p[^>]*>a<\/p><\/li>/);
  expect(out).toMatch(/<ul[^>]*>.*<ul/); // b1 nested
  expect(out).toContain('<ol');
  expect(out).toContain('start="3"');
});

it('renders blockquotes', () => {
  expect(html('> quoted **text**')).toMatch(/<blockquote[^>]*>.*<strong/);
});

it('renders a GFM table in its own horizontal scroller', () => {
  const out = html(
    '| \uc774\ub984 | \uc0c1\ud0dc |\n| :-- | --: |\n| alpha | **ok** |\n| beta | a\\|b |',
  );
  expect(out).toContain('data-testid="md-table"');
  expect(out).toContain('overflow-x-auto');
  expect(out).toMatch(/<th[^>]*>\uc774\ub984<\/th>/);
  expect(out).toContain('text-right');
  expect(out).toMatch(/<td[^>]*><strong[^>]*>ok<\/strong><\/td>/);
  expect(out).toContain('a|b');
});

it('a pipe line without a separator row is a paragraph, not a table', () => {
  expect(html('a | b\nc | d')).not.toContain('<table');
});

it('renders http(s) links that open safely, and bare URLs', () => {
  const out = html('[docs](https://example.com/a?b=1) and https://example.org/x.');
  expect(out).toContain('href="https://example.com/a?b=1"');
  expect(out).toContain('target="_blank"');
  expect(out).toContain('rel="noopener noreferrer"');
  expect(out).toContain('href="https://example.org/x"');
});

it('renders relative markdown file targets as one file link or plain link text', () => {
  const file = fileHtml('[spec](src/app.ts)');
  expect(file.match(/<button /g)).toHaveLength(1);
  expect(file).toContain('>spec</button>');
  expect(file).not.toContain('[spec]');
  expect(file).not.toContain('(src/app.ts)');

  const external = fileHtml('[spec](https://x.y/z)');
  expect(external).toContain('<a ');
  expect(external).toContain('href="https://x.y/z"');
  expect(external).toContain('>spec</a>');

  const missing = fileHtml('[spec](src/missing.ts)');
  expect(missing).not.toContain('<button ');
  expect(missing).not.toContain('[spec]');
  expect(missing).not.toContain('(src/missing.ts)');
  expect(missing).toContain('spec');
});

it('renders only openable file paths as keyboard-reachable links', () => {
  const out = fileHtml('src/file.ts and src/missing.ts and `src/file.ts`');
  expect(out.match(/<button /g)).toHaveLength(2);
  expect(out).toContain('title="/work/project/src/file.ts"');
  expect(out).toContain('src/missing.ts');
  expect(out).toContain('<code');
});

it('shows javascript:, data: and other schemes as text, never as a link', () => {
  for (const bad of [
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    ' javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:x',
    'file:///etc/passwd',
    '/relative',
    '//evil.example',
  ]) {
    const out = html(`[click](${bad.replace(/ /g, '')})`);
    expect(out, bad).not.toContain('<a ');
    expect(out, bad).not.toContain('href=');
  }
  expect(html('[click](javascript:alert(1))')).toContain('[click](javascript:alert(1))');
});

it('shows raw HTML as text: img onerror, script, iframe, style', () => {
  for (const attack of [
    '<img src=x onerror=alert(1)>',
    '<script>alert(1)</script>',
    '<iframe src="https://evil.example"></iframe>',
    '<svg onload=alert(1)>',
    '<a href="javascript:alert(1)">x</a>',
    '<div style="position:fixed">x</div>',
  ]) {
    const out = html(attack);
    expect(out, attack).not.toMatch(/<(img|script|iframe|svg|style)\b/);
    expect(out, attack).not.toContain('style="');
    expect(out, attack).toContain('&lt;');
  }
  // inside every container too: link text, table cells, quotes, list items, headings
  const nested = html(
    '# <img src=x onerror=alert(1)>\n- <script>x</script>\n> <iframe>\n\n| <img onerror=x> |\n|---|\n| <svg onload=x> |\n\n[<img onerror=x>](https://a.example)',
  );
  expect(nested).not.toMatch(/<(img|script|iframe|svg)\b/);
  expect(nested).not.toContain('onerror="');
});

it('never emits an inline style attribute (the app CSP)', () => {
  const out = html(
    '# h\n**b** *i* `c`\n```\ncode\n```\n- l\n> q\n| a | b |\n|---|:-:|\n| 1 | 2 |\n[l](https://a.example)',
  );
  expect(out).not.toContain('style=');
});

it('survives hostile and degenerate input without hanging', () => {
  const start = Date.now();
  for (const s of [
    '*'.repeat(5000),
    '`'.repeat(5000),
    '['.repeat(2000) + '](' + 'x'.repeat(2000),
    '|'.repeat(5000) + '\n' + '-'.repeat(5000),
    '- '.repeat(3000),
    '> '.repeat(2000),
    '_a'.repeat(3000),
  ])
    html(s);
  expect(Date.now() - start).toBeLessThan(5000);
});

it('a bullet list with a nested item, then a numbered list, then a quote', () => {
  const out = html(
    '- \uccab\uc9f8\n- \ub458\uc9f8\n  - \uc548\ucabd\n\n1. \ud558\ub098\n2. \ub458\n\n> \uc778\uc6a9 **\uad75\uac8c**',
  );
  expect((out.match(/<li/g) ?? []).length).toBe(5);
  expect((out.match(/<ul/g) ?? []).length).toBe(2);
  expect(out).toContain('<ol');
  expect(out).toContain('<blockquote');
});

it('a fenced block gets a \ubcf5\uc0ac button, inline code does not', () => {
  const fenced = html('```ts\nconst a = 1;\n```');
  expect(fenced.match(/data-testid="code-copy"/g)).toHaveLength(1);
  expect(fenced).toContain('>\ubcf5\uc0ac</button>');
  expect(html('use `npm test` here')).not.toContain('code-copy');
  expect(html('```\na\n```\n\n```\nb\n```').match(/code-copy/g)).toHaveLength(2);
});

/** The code of each fenced block, as the page holds it (what its button copies). */
const blocks = (text: string) =>
  [...html(text).matchAll(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/g)].map((m) =>
    m[1]
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, '&'),
  );

it('the copy button copies the code as written: indentation, tabs, markup and blank lines', () => {
  const src = 'if (x) {\n\treturn **a** < b;\n}\n\n  <b>x</b>   ';
  expect(blocks('intro\n\n```ts\n' + src + '\n```\n\nafter')).toEqual([src]);
  // Several, also inside a list and a quote; the fence mark rules the end.
  expect(
    blocks(
      '> ```\n> q\n> ```\n\n- item\n\n  ```sh\n  ls -la\n  ```\n\n````\n```\ninner\n```\n````',
    ),
  ).toEqual(['q', 'ls -la', '```\ninner\n```']);
  expect(blocks('no code, only `inline`')).toEqual([]);
});

it('search highlighting marks rendered text and never turns the query into markup', () => {
  const query = '<img src=x onerror=alert(1)>';
  const out = renderToStaticMarkup(
    createElement(Markdown, {
      text: `see ${query} and **${query}** and \`${query}\`\n\n\`\`\`\n${query}\n\`\`\``,
      highlightQuery: query,
      currentMatch: true,
    }),
  );
  expect(out).not.toMatch(/<img/i);
  expect(out).not.toMatch(/<[^>]*\sonerror/i);
  expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
  expect(out.match(/<mark /g)?.length).toBeGreaterThanOrEqual(3);
  // A plain word is marked in a bold run, a link label and a table cell too.
  const marked = renderToStaticMarkup(
    createElement(Markdown, {
      text: '**needle** [Needle](https://a.b)\n\n| h |\n|---|\n| NEEDLE |',
      highlightQuery: 'needle',
    }),
  );
  expect(marked.match(/<mark /g)?.length).toBe(3);
});
