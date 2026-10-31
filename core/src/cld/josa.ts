/**
 * Korean particles (josa) by the last sound of a word. Pure, shared by the daemon's texts and
 * the screen's. A Hangul word goes by its final consonant; a digit or Latin letter by how Korean
 * reads it ("3" 삼, "l" 엘, "k" 케이). Anything else (emoji, symbols) reads as no final consonant.
 */

export type JosaPair = '이/가' | '을/를' | '은/는' | '와/과' | '(으)로';

/** The pairs by role, for callers (the webview) that keep Hangul out of their sources. */
export const JOSA = {
  subject: '이/가',
  object: '을/를',
  topic: '은/는',
  and: '와/과',
  toward: '(으)로',
} as const satisfies Record<string, JosaPair>;

const HANGUL_FIRST = 0xac00;
const HANGUL_LAST = 0xd7a3;
const FINAL_COUNT = 28;
/** The final consonant index of ㄹ in a Hangul syllable block. */
const RIEUL = 8;
/** Digits read with a final consonant: 0 영, 1 일, 3 삼, 6 육, 7 칠, 8 팔. */
const DIGIT_FINAL = '013678';
/** Digits that end in ㄹ (일, 칠, 팔). */
const DIGIT_RIEUL = '178';
/**
 * Latin letters a word ends in with a final consonant when read in Korean: file 파일, name 네임,
 * main 메인 (l, m, n) and "-ng" 링. Other endings read open (server 서버, push 푸시, self 셀프).
 */
const LETTER_FINAL = 'lmn';
const LETTER_RIEUL = 'l';

/** What the sound at the end of `word` is: none, a final consonant, or ㄹ. */
function ending(word: string): 'open' | 'closed' | 'rieul' {
  // A trailing "(...)" note and closing quotes or marks are not part of the sound.
  const stem = word.trim().replace(/\([^()]*\)$/, '').replace(/[^A-Za-z0-9가-힣]+$/, '');
  const c = stem.slice(-1);
  const code = c.charCodeAt(0);
  if (code >= HANGUL_FIRST && code <= HANGUL_LAST) {
    const final = (code - HANGUL_FIRST) % FINAL_COUNT;
    return final === 0 ? 'open' : final === RIEUL ? 'rieul' : 'closed';
  }
  if (c >= '0' && c <= '9') {
    return DIGIT_RIEUL.includes(c) ? 'rieul' : DIGIT_FINAL.includes(c) ? 'closed' : 'open';
  }
  const lower = c.toLowerCase();
  if (lower && lower >= 'a' && lower <= 'z') {
    if (stem.toLowerCase().endsWith('ng')) return 'closed';
    // A lone letter is read by its own name: 에프 f, 에이치 h, 엘 l, 엠 m, 엔 n, 알 r.
    if (!/[A-Za-z]{2}$/.test(stem)) {
      return 'lr'.includes(lower) ? 'rieul' : 'fhmn'.includes(lower) ? 'closed' : 'open';
    }
    return LETTER_RIEUL.includes(lower) ? 'rieul' : LETTER_FINAL.includes(lower) ? 'closed' : 'open';
  }
  return 'open';
}

/** The particle alone: josa('사스케', '이/가') is '가'. */
export function josa(word: string, pair: JosaPair): string {
  const e = ending(word);
  switch (pair) {
    case '이/가':
      return e === 'open' ? '가' : '이';
    case '을/를':
      return e === 'open' ? '를' : '을';
    case '은/는':
      return e === 'open' ? '는' : '은';
    case '와/과':
      return e === 'open' ? '와' : '과';
    case '(으)로':
      return e === 'closed' ? '으로' : '로';
  }
}

/** The word with its particle: withJosa('제로데이', '이/가') is '제로데이가'. */
export const withJosa = (word: string, pair: JosaPair): string => `${word}${josa(word, pair)}`;

const MARKS: Record<string, JosaPair> = {
  '이(가)': '이/가',
  '을(를)': '을/를',
  '은(는)': '은/는',
  '와(과)': '와/과',
  '(으)로': '(으)로',
};
const MARK_RE = /(이\(가\)|을\(를\)|은\(는\)|와\(과\)|\(으\)로)/g;

/**
 * For a template that holds markers: `part` as regex source, each marker also matching either of
 * its settled forms (serverText's matchKorean reads texts that fixJosa already settled).
 */
export function markerPattern(part: string, escape: (s: string) => string): string {
  return part
    .split(MARK_RE)
    .map((piece, i) => {
      if (i % 2 === 0) return escape(piece);
      const [a, b] = MARKS[piece]!.split('/');
      return `(?:${escape(piece)}|${escape(a === '(으)로' ? '으로' : a!)}|${escape(b ?? '로')})`;
    })
    .join('');
}

/**
 * Settles the "이(가)" style markers in a finished text by the word before them (quotes and one
 * space in between are skipped). A marker with no word before it stays as written.
 */
export function fixJosa(text: string): string {
  if (!text.includes('(')) return text;
  return text.replace(MARK_RE, (mark: string, _g: string, offset: number) => {
    const before = text.slice(0, offset).replace(/[\s'"‘’“”]+$/, '');
    if (!before) return mark;
    return josa(before, MARKS[mark]!);
  });
}
