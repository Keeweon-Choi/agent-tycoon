import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';

import { isIgnoredPath } from './filesStore.js';
import { Preview } from './Preview.js';

it('renders Markdown as escaped React text, without raw HTML', () => {
  const html = renderToStaticMarkup(
    createElement(Preview, {
      file: {
        path: 'report.md',
        kind: 'markdown',
        size: 30,
        truncated: false,
        text: '# Report\n<script>alert(1)</script>',
      },
      url: null,
    }),
  );
  expect(html).toContain('Report');
  expect(html).toContain('&lt;script&gt;');
  expect(html).not.toContain('<script>');
});

it('dims ignored directories and their children without confusing name prefixes', () => {
  expect(isIgnoredPath('outputs/chart.png', ['outputs/'])).toBe(true);
  expect(isIgnoredPath('outputs', ['outputs/'])).toBe(true);
  expect(isIgnoredPath('outputs-other/chart.png', ['outputs/'])).toBe(false);
});

it('renders SVG only through an image element and CSV as a table', () => {
  const image = renderToStaticMarkup(
    createElement(Preview, {
      file: { path: 'chart.svg', kind: 'image', size: 10, truncated: false },
      url: '/api/cld/files/content/ticket',
    }),
  );
  expect(image).toContain('<img');
  expect(image).not.toContain('<svg');
  const csv = renderToStaticMarkup(
    createElement(Preview, {
      file: { path: 'data.csv', kind: 'csv', size: 14, truncated: false, text: 'a,b\n"one,two",3' },
      url: null,
    }),
  );
  expect(csv).toContain('<table');
  expect(csv).toContain('one,two');
});

it('shows an HTML report only in an iframe with an empty sandbox', () => {
  const html = renderToStaticMarkup(
    createElement(Preview, {
      file: { path: 'report.html', kind: 'html', size: 10, truncated: false },
      url: '/api/cld/files/content/ticket',
    }),
  );
  expect(html).toContain('<iframe');
  expect(html).toContain('sandbox=""');
  expect(html).not.toContain('allow-scripts');
});
