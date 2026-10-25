import type { ProjectFilePreview } from '../../../../core/src/cld/projectFiles.js';
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

export function Preview({ file, url }: { file: ProjectFilePreview; url: string | null }) {
  if (file.kind === 'image')
    return url ? (
      <img src={url} alt={file.path} className="max-w-full max-h-[70vh] object-contain" />
    ) : (
      <p>{t('files.loadingImage')}</p>
    );
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
