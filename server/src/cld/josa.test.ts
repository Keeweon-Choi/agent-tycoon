import { describe, expect, it } from 'vitest';

import { fixJosa, josa, withJosa } from '../../../core/src/cld/josa.js';
import { plainText } from '../../../core/src/cld/plainText.js';

describe('josa', () => {
  it('Hangul: by the final consonant', () => {
    expect(withJosa('우치하 사스케줄', '이/가')).toBe('우치하 사스케줄이'); // ㄹ is a final consonant
    expect(withJosa('롤로노아 제로데이', '이/가')).toBe('롤로노아 제로데이가');
    expect(withJosa('책', '을/를')).toBe('책을');
    expect(withJosa('나무', '을/를')).toBe('나무를');
    expect(withJosa('밥', '은/는')).toBe('밥은');
    expect(withJosa('나무', '은/는')).toBe('나무는');
    expect(withJosa('밥', '와/과')).toBe('밥과');
    expect(withJosa('나무', '와/과')).toBe('나무와');
  });

  it('(으)로: ㄹ and no final consonant take 로, other finals 으로', () => {
    expect(josa('서울', '(으)로')).toBe('로');
    expect(josa('나무', '(으)로')).toBe('로');
    expect(josa('집', '(으)로')).toBe('으로');
  });

  it('digits are read in Korean', () => {
    expect(josa('Task 3', '이/가')).toBe('이'); // 삼
    expect(josa('Task 2', '이/가')).toBe('가'); // 이
    expect(josa('Task 9', '을/를')).toBe('를'); // 구
    expect(josa('Task 1', '(으)로')).toBe('로'); // 일: ㄹ
    expect(josa('Task 6', '(으)로')).toBe('으로'); // 육
  });

  it('Latin words go by how they end in Korean (l, m, n, -ng closed)', () => {
    expect(josa('alpha', '이/가')).toBe('가'); // 에이
    expect(josa('bot', '이/가')).toBe('가'); // 티
    expect(josa('beta-m', '이/가')).toBe('이'); // 엠
    expect(josa('pencil', '을/를')).toBe('을'); // 엘
    expect(josa('pencil', '(으)로')).toBe('로');
    expect(josa('cld-gui', '이/가')).toBe('가'); // 아이
    expect(josa('SELF', '을/를')).toBe('를'); // 셀프
    expect(josa('wayfinder', '을/를')).toBe('를'); // 파인더
    expect(josa('server', '이/가')).toBe('가'); // 서버
    expect(josa('string', '이/가')).toBe('이'); // 스트링
  });

  it('skips closing quotes, marks and a trailing note', () => {
    expect(josa("'책'", '이/가')).toBe('이');
    expect(josa('배포(주)', '이/가')).toBe('가');
    expect(josa('...', '이/가')).toBe('가');
  });

  it('fixJosa settles the written marks by the word before them', () => {
    expect(fixJosa('우치하 사스케줄이(가) 허락을 기다려요')).toBe('우치하 사스케줄이 허락을 기다려요');
    expect(fixJosa('롤로노아 제로데이이(가) 묻고 있어요')).toBe('롤로노아 제로데이가 묻고 있어요');
    expect(fixJosa("'alpha' 을(를) 켰어요")).toBe("'alpha' 를 켰어요");
    expect(fixJosa('“제목”을(를) 맡겨요')).toBe('“제목”을 맡겨요');
    expect(fixJosa('docs/a.md은(는) v1 입니다')).toBe('docs/a.md는 v1 입니다');
    expect(fixJosa('서울(으)로 가요')).toBe('서울로 가요');
  });

  it('fixJosa leaves a marker with no word before it, and text without markers', () => {
    expect(fixJosa('이(가) 맡겨요')).toBe('이(가) 맡겨요');
    expect(fixJosa('함수(인자)를 불러요')).toBe('함수(인자)를 불러요');
  });
});

describe('plainText', () => {
  it('drops inline marks and keeps their words', () => {
    expect(plainText('**굵게** 와 `코드` 와 *기울임* 와 ~~취소~~')).toBe('굵게 와 코드 와 기울임 와 취소');
    expect(plainText('[링크 글자](https://example.com/a) 를 보세요')).toBe('링크 글자 를 보세요');
    expect(plainText('![그림](a.png) 끝')).toBe('그림 끝');
    expect(plainText('snake_case_name 은 그대로')).toBe('snake_case_name 은 그대로');
  });

  it('headings, quotes, rules and fences go; list items become "· "', () => {
    expect(plainText('## 제목\n본문')).toBe('제목 본문');
    expect(plainText('> 인용\n\n---\n끝')).toBe('인용 끝');
    expect(plainText('- 하나\n- 둘\n1. 셋\n2) 넷')).toBe('· 하나 · 둘 · 셋 · 넷');
    expect(plainText('```ts\nconst a = 1;\n```')).toBe('const a = 1;');
  });

  it('collapses whitespace', () => {
    expect(plainText('  a \n\n\t b  ')).toBe('a b');
    expect(plainText('')).toBe('');
  });
});
