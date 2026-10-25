/**
 * Markdown to React elements (T-0054 follow-up; replaces T-0044's line toy in
 * the file preview and renders the leads' replies in the messenger).
 *
 * Safe by construction: the output is React elements built from strings, so
 * raw HTML in the source (`<img onerror>`, `<script>`, `<iframe>`) is only ever
 * text; nothing here calls innerHTML or sets a style string, so the app CSP
 * has nothing to object to. Links must be http(s) (checked through URL); any
 * other scheme shows the source text unlinked.
 *
 * GFM subset: headings, paragraphs (a single newline is a line break, as the
 * leads write them), bold, italic, strikethrough, inline code, fenced code,
 * bullet and numbered lists (nested by indent), blockquotes, tables, rules and
 * links. No dependency: a renderer this size is cheaper than a library and its
 * output stays escaped React.
 */
import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';

import { t } from '../i18n/index.js';
import { writeClipboardText } from '../terminal/clipboard.js';
import { findFilePaths, resolvePath } from './messenger/fileLinks.js';
import { matchRanges } from './messenger/searchMatch.js';

// ── inline ──

/** The pixel faces have no bold and a synthesized one smears them, so strong
 *  text is brighter and one font pixel wider (a 1px text-shadow, crisp at any
 *  DPR). Italic still needs the browser's synthesized slant (index.css turns
 *  synthesis off). Headings and table headers carry a rule instead. */
const STRONG = 'text-white [text-shadow:1px_0_0_currentColor]';
const EM = 'italic [font-synthesis-style:auto]';
const LINK = 'text-accent-text underline break-all';
// Code stays in the pixel stack (no mono font), one step below the bubble text.
// `font-pixel` is explicit: Tailwind's base rule gives code and pre a mono family.
const CODE = 'font-pixel text-xs bg-bg-dark border border-border px-4';

type FileLinkOptions = {
  projectRoot?: string;
  fileLink?: (path: string) => boolean;
  onOpenFile?: (path: string, line?: number) => void;
};

/** A safe external link target, or null. */
function safeHref(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

// One alternative per construct, tried left to right at each position:
// 1 escape, 2-3 code span, 4-6 link, 7 bold, 8 bold, 9 italic, 10 italic,
// 11 strike, 12 bare URL.
const INLINE =
  /\\([\\`*_[\]()#+.!|~>-])|(`+)([\s\S]*?[^`])\2(?!`)|\[([^\]\n]+)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)|\*\*(?=\S)([\s\S]*?\S)\*\*|(?<![A-Za-z0-9_])__(?=\S)([\s\S]*?\S)__(?![A-Za-z0-9_])|\*(?=[^\s*])([^*\n]*?[^\s*])\*(?!\*)|(?<![A-Za-z0-9_])_(?=[^\s_])([^_\n]*?[^\s_])_(?![A-Za-z0-9_])|~~(?=\S)([\s\S]*?\S)~~|(https?:\/\/[^\s<>"']+)/g;

/** Nesting (quote in quote, bold in bold) stops here: deeper source is shown as
 *  plain text, so hostile input cannot exhaust the stack. */
const MAX_DEPTH = 6;

export function HighlightedText({
  text,
  query,
  current = false,
}: {
  text: string;
  query?: string;
  current?: boolean;
}) {
  const ranges = query ? matchRanges(text, query) : [];
  if (!ranges.length) return text;
  const nodes: ReactNode[] = [];
  let at = 0;
  for (const range of ranges) {
    if (range.start > at) nodes.push(text.slice(at, range.start));
    nodes.push(
      <mark
        key={range.start}
        className={`text-search-match-text px-px ${current ? 'bg-search-current' : 'bg-search-match'}`}
      >
        {text.slice(range.start, range.end)}
      </mark>,
    );
    at = range.end;
  }
  if (at < text.length) nodes.push(text.slice(at));
  return <>{nodes}</>;
}

function FileLinkText({
  text,
  query,
  current,
  fileLinks,
}: {
  text: string;
  query?: string;
  current: boolean;
  fileLinks?: FileLinkOptions;
}) {
  if (!fileLinks?.fileLink || !fileLinks.onOpenFile)
    return <HighlightedText text={text} query={query} current={current} />;
  const nodes: ReactNode[] = [];
  let at = 0;
  for (const match of findFilePaths(text)) {
    const absolute = resolvePath(match.path, fileLinks.projectRoot);
    if (!absolute || !fileLinks.fileLink(absolute)) continue;
    if (match.start > at)
      nodes.push(
        <HighlightedText
          key={`${match.start}t`}
          text={text.slice(at, match.start)}
          query={query}
          current={current}
        />,
      );
    nodes.push(
      <button
        key={`${match.start}f`}
        type="button"
        className={`${LINK} cursor-pointer text-left`}
        title={absolute}
        onClick={() => fileLinks.onOpenFile?.(absolute, match.line)}
      >
        <HighlightedText text={match.path} query={query} current={current} />
      </button>,
    );
    at = match.end;
  }
  if (at < text.length)
    nodes.push(
      <HighlightedText key={`${at}t`} text={text.slice(at)} query={query} current={current} />,
    );
  return <>{nodes}</>;
}

function inline(
  text: string,
  keyBase: string,
  depth = 0,
  query?: string,
  current = false,
  fileLinks?: FileLinkOptions,
): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  const push = (node: ReactNode) => out.push(node);
  const plain = (s: string) => {
    s.split('\n').forEach((part, i) => {
      if (i) push(<br key={`${keyBase}b${n++}`} />);
      if (part)
        push(
          <FileLinkText
            key={`${keyBase}t${n++}`}
            text={part}
            query={query}
            current={current}
            fileLinks={fileLinks}
          />,
        );
    });
  };
  for (const m of depth >= MAX_DEPTH ? [] : text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at < last) continue;
    plain(text.slice(last, at));
    last = at + m[0].length;
    const key = `${keyBase}.${n++}`;
    if (m[1] !== undefined) push(m[1]);
    else if (m[3] !== undefined)
      push(
        <code key={key} className={CODE}>
          <FileLinkText
            text={m[3].replace(/^ (.*) $/s, '$1')}
            query={query}
            current={current}
            fileLinks={fileLinks}
          />
        </code>,
      );
    else if (m[4] !== undefined) {
      const href = safeHref(m[5]);
      const target = findFilePaths(m[5]).find((match) => match.end === m[5].length);
      const absolute = target && resolvePath(target.path, fileLinks?.projectRoot);
      if (absolute) {
        if (fileLinks?.fileLink?.(absolute) && fileLinks.onOpenFile)
          push(
            <button
              key={key}
              type="button"
              className={`${LINK} cursor-pointer text-left`}
              title={absolute}
              onClick={() => fileLinks.onOpenFile?.(absolute, target.line)}
            >
              {inline(m[4], key, depth + 1, query, current)}
            </button>,
          );
        else plain(m[4]);
      } else if (href)
        push(
          <a key={key} href={href} target="_blank" rel="noopener noreferrer" className={LINK}>
            {inline(m[4], key, depth + 1, query, current)}
          </a>,
        );
      else if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(m[5])) plain(m[0]);
      else plain(m[4]);
    } else if (m[6] !== undefined || m[7] !== undefined)
      push(
        <strong key={key} className={STRONG}>
          {inline((m[6] ?? m[7]) as string, key, depth + 1, query, current, fileLinks)}
        </strong>,
      );
    else if (m[8] !== undefined || m[9] !== undefined)
      push(
        <em key={key} className={EM}>
          {inline((m[8] ?? m[9]) as string, key, depth + 1, query, current, fileLinks)}
        </em>,
      );
    else if (m[10] !== undefined)
      push(
        <del key={key} className="line-through">
          {inline(m[10], key, depth + 1, query, current, fileLinks)}
        </del>,
      );
    else {
      // A bare URL: trailing sentence punctuation is not part of it.
      const url = m[11].replace(/[.,;:!?)\]]+$/, '');
      const href = safeHref(url);
      if (href)
        push(
          <a key={key} href={href} target="_blank" rel="noopener noreferrer" className={LINK}>
            {url}
          </a>,
        );
      else push(url);
      plain(m[11].slice(url.length));
    }
  }
  plain(text.slice(last));
  return out;
}

// ── blocks ──

/** How long a copy button says 복사됨 before it is 복사 again. */
const COPIED_MS = 1500;
const COPY_LABEL = {
  idle: 'markdown.copy',
  done: 'markdown.copied',
  failed: 'markdown.copyFailed',
} as const;

/** A fenced code block with a copy button at its top right. The button copies
 *  `text` itself (the source between the fences), never the rendered text. */
function CodeBlock({ text, query, current }: { text: string; query?: string; current?: boolean }) {
  const [state, setState] = useState<keyof typeof COPY_LABEL>('idle');
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = () => {
    // Called straight from the click: the plain-http fallback needs the gesture.
    void writeClipboardText(text).then((ok) => {
      setState(ok ? 'done' : 'failed');
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setState('idle'), COPIED_MS);
    });
  };
  return (
    <div className="relative">
      <pre className="font-pixel text-xs whitespace-pre overflow-x-auto max-w-full bg-bg-dark border border-border pl-8 pr-48 py-4 pointer-coarse:min-h-48">
        <code className="font-pixel">
          <HighlightedText text={text} query={query} current={current} />
        </code>
      </pre>
      <button
        type="button"
        className="absolute top-2 right-2 select-none text-2xs border border-border bg-bg text-text px-4 pointer-coarse:min-h-44"
        aria-label={t('markdown.copyCode')}
        data-testid="code-copy"
        data-state={state}
        onClick={copy}
      >
        {t(COPY_LABEL[state])}
      </button>
    </div>
  );
}

type Align = 'left' | 'center' | 'right' | undefined;
type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'para'; text: string }
  | { type: 'code'; text: string }
  | { type: 'rule' }
  | { type: 'quote'; blocks: Block[] }
  | { type: 'list'; ordered: boolean; start: number; items: Block[][] }
  | { type: 'table'; head: string[]; align: Align[]; rows: string[][] };

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

/** Cells of one table row; `\|` is a literal pipe. */
function cells(line: string): string[] {
  const body = line
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '');
  return body.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
}

function parse(text: string, depth = 0): Block[] {
  if (depth >= MAX_DEPTH) return [{ type: 'para', text }];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  const startsBlock = (l: string, next?: string) =>
    FENCE.test(l) ||
    HEADING.test(l) ||
    RULE.test(l) ||
    /^ {0,3}>/.test(l) ||
    ITEM.test(l) ||
    (l.includes('|') && next !== undefined && TABLE_SEP.test(next) && next.includes('-'));
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const mark = fence[1];
      const body: string[] = [];
      i++;
      // An unclosed fence runs to the end: a reply may still be arriving.
      while (i < lines.length && !lines[i].trim().startsWith(mark)) body.push(lines[i++]);
      i++;
      blocks.push({ type: 'code', text: body.join('\n') });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] });
      i++;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ type: 'rule' });
      i++;
      continue;
    }
    if (/^ {0,3}>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^ {0,3}>/.test(lines[i]))
        body.push(lines[i++].replace(/^ {0,3}> ?/, ''));
      blocks.push({ type: 'quote', blocks: parse(body.join('\n'), depth + 1) });
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const head = cells(line);
      const sep = cells(lines[i + 1]);
      if (sep.length === head.length && lines[i + 1].includes('-')) {
        const align = sep.map((c): Align =>
          c.startsWith(':') && c.endsWith(':')
            ? 'center'
            : c.endsWith(':')
              ? 'right'
              : c.startsWith(':')
                ? 'left'
                : undefined,
        );
        const rows: string[][] = [];
        i += 2;
        while (i < lines.length && lines[i].trim() && lines[i].includes('|'))
          rows.push(cells(lines[i++]));
        blocks.push({ type: 'table', head, align, rows });
        continue;
      }
    }
    const item = ITEM.exec(line);
    if (item) {
      const base = item[1].length;
      const ordered = /\d/.test(item[2]);
      const items: Block[][] = [];
      let start = ordered ? parseInt(item[2], 10) : 1;
      while (i < lines.length) {
        const m = ITEM.exec(lines[i]);
        if (!m || m[1].length !== base || /\d/.test(m[2]) !== ordered) break;
        if (items.length === 0 && ordered) start = parseInt(m[2], 10);
        const body = [m[3]];
        i++;
        // Deeper-indented lines (and one blank between them) belong to this item.
        while (i < lines.length) {
          const l = lines[i];
          if (!l.trim()) {
            const next = lines[i + 1];
            if (next !== undefined && next.trim() && /^\s*/.exec(next)![0].length > base) {
              body.push('');
              i++;
              continue;
            }
            break;
          }
          if (/^\s*/.exec(l)![0].length <= base) break;
          body.push(l.slice(Math.min(/^\s*/.exec(l)![0].length, base + 2)));
          i++;
        }
        items.push(parse(body.join('\n'), depth + 1));
      }
      blocks.push({ type: 'list', ordered, start, items });
      continue;
    }
    const para: string[] = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i], lines[i + 1]))
      para.push(lines[i++]);
    blocks.push({ type: 'para', text: para.join('\n') });
  }
  return blocks;
}

const ALIGN = { left: 'text-left', center: 'text-center', right: 'text-right' } as const;

const HEADING_CLASS: Record<number, string> = {
  1: 'text-base',
  2: 'text-sm',
  3: 'text-sm',
  4: 'text-xs',
  5: 'text-xs',
  6: 'text-xs',
};

function render(
  blocks: Block[],
  keyBase: string,
  query?: string,
  current = false,
  fileLinks?: FileLinkOptions,
): ReactNode[] {
  return blocks.map((b, idx) => {
    const key = `${keyBase}${idx}`;
    switch (b.type) {
      case 'heading':
        return (
          <p
            key={key}
            role="heading"
            aria-level={b.level}
            className={`${HEADING_CLASS[b.level]} text-white border-b border-border pb-2 mt-8 first:mt-0`}
          >
            {inline(b.text, key, 0, query, current, fileLinks)}
          </p>
        );
      case 'para':
        return (
          <p key={key} className="break-words">
            {inline(b.text, key, 0, query, current, fileLinks)}
          </p>
        );
      case 'code':
        return <CodeBlock key={key} text={b.text} query={query} current={current} />;
      case 'rule':
        return <hr key={key} className="border-border" />;
      case 'quote':
        return (
          <blockquote key={key} className="border-l-2 border-border pl-8 text-text-muted space-y-4">
            {render(b.blocks, key, query, current, fileLinks)}
          </blockquote>
        );
      case 'list': {
        const Tag = b.ordered ? 'ol' : 'ul';
        return (
          <Tag
            key={key}
            start={b.ordered ? b.start : undefined}
            className={`${b.ordered ? 'list-decimal' : 'list-disc'} pl-20 space-y-2`}
          >
            {b.items.map((item, j) => (
              <li key={`${key}.${j}`} className="space-y-2">
                {render(item, `${key}.${j}.`, query, current, fileLinks)}
              </li>
            ))}
          </Tag>
        );
      }
      case 'table':
        return (
          // Its own scroller: a wide table never widens the bubble or the page.
          <div key={key} className="overflow-x-auto max-w-full" data-testid="md-table">
            <table className="text-xs border-collapse">
              <thead>
                <tr>
                  {b.head.map((c, j) => (
                    <th
                      key={j}
                      className={`border border-border border-b-2 border-b-accent bg-bg-dark px-8 py-4 whitespace-nowrap text-white ${ALIGN[b.align[j] ?? 'left']}`}
                    >
                      {inline(c, `${key}h${j}`, 0, query, current, fileLinks)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((row, r) => (
                  <tr key={r}>
                    {b.head.map((_, j) => (
                      <td
                        key={j}
                        className={`border border-border px-8 py-4 align-top min-w-96 break-keep ${ALIGN[b.align[j] ?? 'left']}`}
                      >
                        {inline(row[j] ?? '', `${key}r${r}c${j}`, 0, query, current, fileLinks)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
    }
  });
}

/** Render Markdown source as a block of safe React elements. */
export function Markdown({
  text,
  className = '',
  highlightQuery,
  currentMatch = false,
  projectRoot,
  fileLink,
  onOpenFile,
}: {
  text: string;
  className?: string;
  highlightQuery?: string;
  currentMatch?: boolean;
  projectRoot?: string;
  fileLink?: (path: string) => boolean;
  onOpenFile?: (path: string) => void;
}) {
  return (
    <div className={`space-y-4 min-w-0 ${className}`}>
      {render(parse(text), 'm', highlightQuery, currentMatch, {
        projectRoot,
        fileLink,
        onOpenFile,
      })}
    </div>
  );
}
