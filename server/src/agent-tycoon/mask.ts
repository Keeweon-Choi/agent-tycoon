/**
 * The secret masker (T-0056): everything the read-only work view shows (a
 * temp's transcript, its commands, a worker's log) goes through maskText().
 * The first five rules cover tokens, keys, `password=`, Authorization
 * headers, URLs with credentials and known key shapes; values go, names
 * stay. The rest: names with a secret word
 * in them (`AWS_SECRET_ACCESS_KEY=...`), PEM key blocks, and a block of plain
 * `NAME=value` lines, which is an environment dump and is never shown.
 *
 * Per line, like sed: no value runs on into the next line.
 */

const BASE_RULES: Array<[RegExp, string]> = [
  [/((proxy-)?authorization["']?[: =]+["']?((bearer|basic|token) +)?)[^ '"]+/gi, '$1***'],
  [
    /((x-)?(api[-_]?key|access[-_]?token|auth[-_]?token|refresh[-_]?token|client[-_]?secret|secret|token|password|passwd)["']?[:=] *["']?)[^ '"&]+/gi,
    '$1***',
  ],
  [/(--(api[-_]?key|access[-_]?token|token|secret|password|passwd)[ =]+)[^ ]+/gi, '$1***'],
  [/(:\/\/[^/:@ ]+:)[^@/ ]+@/g, '$1***@'],
  [
    /\b(sk-ant-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|hf_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})\b/g,
    '***',
  ],
];

const OUR_RULES: Array<[RegExp, string]> = [
  // AWS_SECRET_ACCESS_KEY=..., DB_PASSWORD: ..., GITHUB_TOKEN=...
  [
    /(\b[A-Za-z0-9_]*(secret|token|password|passwd|api_?key|access_?key|private_?key|credential)[A-Za-z0-9_]*["']?[:=] *["']?)[^ '"&]+/gi,
    '$1***',
  ],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----.*/g, '-----BEGIN PRIVATE KEY----- ***'],
];

/** Longer lines are cut first: a line is for reading, and the cut bounds the regex work. */
const LINE_MAX = 2000;
/** A line longer than this is cut (with '…') before it is masked. */
export const MASK_LINE_MAX = LINE_MAX;
const ENV_LINE = /^\s*(export\s+)?[A-Z][A-Z0-9_]{2,}=\S*/;
/** This many `NAME=value` lines in a row is an environment dump. */
const ENV_RUN = 4;
const PEM_BEGIN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const PEM_END = /-----END [A-Z ]*PRIVATE KEY-----/;
export const ENV_DUMP_NOTE = '(환경 변수 출력은 보여 주지 않아요)';

const maskLine = (line: string): string => {
  // Past the cap the cut falls at the last whitespace at or before it, else (compact JSON, a long
  // path) at the last character no token has (outside [A-Za-z0-9_-] and base64's or a JWT's . + / =),
  // so a token straddling the cap is dropped whole rather than leaving its first characters unmatched
  // by the patterns. A line with neither is dropped.
  let out = line;
  if (line.length > LINE_MAX) {
    const head = line.slice(0, LINE_MAX + 1);
    let cut = head.search(/\s\S*$/);
    if (cut <= 0) cut = head.search(/[^\w\-.+/=][\w\-.+/=]*$/);
    out = `${line.slice(0, Math.max(cut, 0))}…`;
  }
  for (const [re, to] of BASE_RULES) out = out.replace(re, to);
  for (const [re, to] of OUR_RULES) out = out.replace(re, to);
  return out;
};

/** `text` with its secrets replaced by `***`, and environment dumps by a note. */
export function maskText(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    let j = i;
    while (j < lines.length && ENV_LINE.test(lines[j])) j++;
    if (j - i >= ENV_RUN) {
      out.push(ENV_DUMP_NOTE);
      i = j;
      continue;
    }
    out.push(maskLine(lines[i]));
    // A PEM private key's body lines carry the key: everything through its END line goes (to the
    // text's end when there is none); maskLine already turned the BEGIN line into the note.
    if (PEM_BEGIN.test(lines[i]) && !PEM_END.test(lines[i])) {
      do i++;
      while (i < lines.length && !PEM_END.test(lines[i]));
    }
    i++;
  }
  return out.join('\n');
}
