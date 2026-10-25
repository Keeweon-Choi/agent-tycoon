import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';

import { TextFile } from './AttachmentViewer.js';

it('renders text preview markup as literal text', () => {
  const markup = renderToStaticMarkup(
    createElement(TextFile, { content: '<img src=x onerror=alert(1)>' }),
  );
  expect(markup).toContain('&lt;img src=x onerror=alert(1)&gt;');
  expect(markup).not.toContain('<img');
});
