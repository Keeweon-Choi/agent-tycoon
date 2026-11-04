import { useEffect, useRef, useState } from 'react';

import type { ProjectFilePreview } from '../../../../core/src/cld/projectFiles.js';
import { IMAGE_FIT_MAX_VH } from '../../constants.js';
import { t } from '../../i18n/index.js';
import { Markdown } from '../markdown.js';

/** Enough CSV quoting for report tables; large previews remain bounded server-side. */
function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length && rows.length < 101; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      row.push(cell);
      cell = '';
    } else if ((ch === '\n' || ch === '\r') && !quoted) {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (row.length || cell) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/** `zoom` scales the whole preview (text, tables) with CSS zoom; 1 leaves it untouched. An image
 *  grows from its fitted size instead: under CSS zoom its fit-to-the-pane limits grow with it, so
 *  it never got past the pane's width (owner 11-03 13:04). */
export function Preview({
  file,
  url,
  zoom = 1,
  line,
}: {
  file: ProjectFilePreview;
  url: string | null;
  zoom?: number;
  /** A text file's source with this line marked and scrolled to (the 요구사항 detail's [원본 열기]). */
  line?: number;
}) {
  if (file.kind === 'image') return <ZoomedImage key={url ?? ''} url={url} alt={file.path} zoom={zoom} />;
  const lines = line && file.text !== undefined && ['markdown', 'text', 'json', 'csv'].includes(file.kind);
  return (
    <div style={zoom === 1 ? undefined : { zoom }}>
      {lines ? <SourceLines text={file.text ?? ''} line={line} /> : <PreviewBody file={file} url={url} />}
    </div>
  );
}

/** The text line by line with its numbers; `line` marked and scrolled into the middle. */
function SourceLines({ text, line }: { text: string; line: number }) {
  const mark = useRef<HTMLDivElement>(null);
  useEffect(() => mark.current?.scrollIntoView({ block: 'center' }), [text, line]);
  return (
    <pre data-selectable="always" className="font-mono text-xs whitespace-pre-wrap break-all" data-testid="file-lines">
      {text.split('\n').map((l, i) => (
        <div
          key={i}
          ref={i + 1 === line ? mark : undefined}
          data-line={i + 1}
          aria-current={i + 1 === line ? 'true' : undefined}
          className={i + 1 === line ? 'bg-active-bg outline outline-2 outline-accent' : undefined}
        >
          <span className="text-text-muted select-none">{`${i + 1}`.padStart(4)} </span>
          {l}
        </div>
      ))}
    </pre>
  );
}

/** The image at `zoom` times its fitted size: the pane's width or IMAGE_FIT_MAX_VH of the screen's
 *  height, never above its own size (what the old fit classes did). Past the pane, the pane scrolls. */
function ZoomedImage({ url, alt, zoom }: { url: string | null; alt: string; zoom: number }) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  if (!url) return <p>{t('files.loadingImage')}</p>;
  const fit = size && `min(100%, ${size.w}px, ${IMAGE_FIT_MAX_VH * (size.w / size.h)}vh)`;
  return (
    <img
      src={url}
      alt={alt}
      onLoad={(e) => {
        const { naturalWidth: w, naturalHeight: h } = e.currentTarget;
        if (w > 0 && h > 0) setSize({ w, h });
      }}
      className={fit ? 'max-w-none' : 'max-w-full max-h-[70vh] object-contain'}
      style={fit ? { width: `calc(${fit} * ${zoom})` } : undefined}
    />
  );
}

function PreviewBody({ file, url }: { file: ProjectFilePreview; url: string | null }) {
  if (file.kind === 'pdf')
    return url ? (
      <iframe src={url} title={file.path} className="w-full h-[70vh] border border-border" />
    ) : (
      <p>{t('files.loadingPdf')}</p>
    );
  if (file.kind === 'html')
    return url ? (
      // No allow-scripts, no allow-same-origin; the server adds a CSP sandbox too.
      <iframe
        src={url}
        sandbox=""
        title={file.path}
        className="w-full h-[70vh] border border-border bg-white"
      />
    ) : (
      <p>{t('files.loadingReport')}</p>
    );
  if (file.kind === 'markdown')
    return <Markdown text={file.text ?? ''} className="break-words leading-relaxed" />;
  if (file.kind === 'csv') {
    const rows = csvRows(file.text ?? '');
    return (
      <div className="overflow-auto max-h-[70vh]">
        <table className="text-xs border-collapse">
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                {row.slice(0, 30).map((cell, j) => (
                  <td
                    key={j}
                    className="border border-border px-8 py-4 whitespace-pre-wrap align-top"
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  let text = file.text ?? '';
  if (file.kind === 'json') {
    try {
      text = JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      /* partial JSON stays readable */
    }
  }
  return (
    <pre data-selectable="always" className="font-mono text-xs whitespace-pre-wrap break-all">
      {text}
    </pre>
  );
}
