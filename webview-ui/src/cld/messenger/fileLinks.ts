export interface FilePathMatch {
  start: number;
  end: number;
  path: string;
  line?: number;
}

const TRAILING_PUNCTUATION = /[.,;:)\]]+$/;
const TRAILING_HANGUL = /[\uac00-\ud7a3]+$/;
const LEADING_DELIMITER = /^[`([{'"]+/;
const TRAILING_DELIMITER = /[`'"]+$/;
const LOCATION = /:(\d+)(?::\d+)?$/;
const SEGMENT = /^[\p{L}\p{N}_.-]+$/u;
const EXTENSION = /\.([A-Za-z][A-Za-z0-9]{0,7})$/;
const ABBREVIATION = /^[a-z]\.[a-z]\.?$/;
const HOST_TLDS = new Set([
  'ai',
  'app',
  'biz',
  'co',
  'com',
  'dev',
  'edu',
  'gov',
  'info',
  'io',
  'kr',
  'me',
  'net',
  'org',
  'tech',
  'uk',
  'us',
]);

function trimPathToken(token: string) {
  let path = token;
  while (true) {
    const before = path;
    path = path.replace(TRAILING_DELIMITER, '').replace(TRAILING_PUNCTUATION, '');
    path = path.replace(TRAILING_HANGUL, '');
    if (path === before) return path;
  }
}

function looksLikeHost(segment: string) {
  const lower = segment.toLowerCase();
  if (lower === 'localhost' || /^localhost:\d+$/.test(lower)) return true;
  if (lower.startsWith('www.')) return true;
  const tld = lower.split('.').at(-1);
  return !!tld && lower.includes('.') && HOST_TLDS.has(tld);
}

function looksLikePathSegment(segment: string, index: number) {
  return SEGMENT.test(segment) || (index === 0 && /^localhost:\d+$/.test(segment));
}

/** A path accepted for message links, after punctuation and an optional line are removed. */
function pathMatch(raw: string, start: number): FilePathMatch | null {
  const leading = raw.match(LEADING_DELIMITER)?.[0] ?? '';
  const token = raw.slice(leading.length);
  if (!token || token.startsWith('~/') || /^(?:https?|file):\/\//i.test(token)) return null;

  const trimmed = trimPathToken(token);
  const location = LOCATION.exec(trimmed);
  let path = location ? trimmed.slice(0, location.index) : trimmed;
  let offset = start + leading.length;
  if (path.startsWith('./')) {
    path = path.slice(2);
    offset += 2;
  }
  if (!path || /[\s*?[{@]/.test(path)) return null;

  const absolute = path.startsWith('/');
  const segments = path.split('/');
  const named = absolute ? segments.slice(1) : segments;
  if (
    named.length < 2 ||
    named.some(
      (part, index) => !part || part === '.' || part === '..' || !looksLikePathSegment(part, index),
    ) ||
    looksLikeHost(named[0]) ||
    named.some((part) => ABBREVIATION.test(part)) ||
    !EXTENSION.test(named.at(-1)!) ||
    !named.slice(0, -1).some((part) => /^[\p{L}._]/u.test(part))
  )
    return null;

  return {
    start: offset,
    end: offset + path.length,
    path,
    ...(location && { line: Number(location[1]) }),
  };
}

/** Find file-looking absolute and project-relative paths in ordinary message text. */
export function findFilePaths(text: string): FilePathMatch[] {
  const matches: FilePathMatch[] = [];
  for (const tokenMatch of text.matchAll(/\S+/g)) {
    const token = tokenMatch[0];
    const tokenStart = tokenMatch.index ?? 0;
    let offset = 0;
    for (const part of token.split(',')) {
      const match = pathMatch(part, tokenStart + offset);
      if (match) matches.push(match);
      offset += part.length + 1;
    }
  }
  return matches;
}

/** Turn a safe relative path into an absolute path below the current project. */
export function resolvePath(path: string, projectRoot?: string): string | null {
  if (!path || /\s/.test(path) || path.startsWith('~/')) return null;
  const relative = path.startsWith('./') ? path.slice(2) : path;
  if (!relative || relative.split('/').some((part) => part === '.' || part === '..')) return null;
  if (relative.startsWith('/')) return relative;
  if (!projectRoot || projectRoot.split('/').some((part) => part === '.' || part === '..'))
    return null;
  return `${projectRoot.replace(/\/+$/, '')}/${relative}`;
}
