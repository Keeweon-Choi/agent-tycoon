import { describe, expect, it } from 'vitest';

import { ENV_DUMP_NOTE, maskText } from './mask.js';

/** [what, line, the secret that must not survive]. */
const SHAPES: Array<[string, string, string]> = [
  ['curl apikey header', "curl -H 'apikey: Zq81hunter2Zq81' https://x.test", 'Zq81hunter2Zq81'],
  [
    'Authorization bearer',
    'curl -H "Authorization: Bearer abc.DEF-123_ghi" https://x.test',
    'abc.DEF-123_ghi',
  ],
  ['basic auth header', 'Authorization: Basic dXNlcjpwYXNzd29yZA==', 'dXNlcjpwYXNzd29yZA=='],
  ['proxy authorization', 'Proxy-Authorization: Bearer proxysecret99', 'proxysecret99'],
  ['password=', 'mysql --password=s3cr3tPass -u root', 's3cr3tPass'],
  ['--token flag', 'tool --token tok_live_12345 run', 'tok_live_12345'],
  ['json password', '{"password": "hunter2hunter2", "user": "a"}', 'hunter2hunter2'],
  ['url credentials', 'git clone https://bob:p4ssw0rdX@github.example/r.git', 'p4ssw0rdX'],
  ['anthropic key', 'key is sk-ant-api03-AbCdEf123456789', 'sk-ant-api03-AbCdEf123456789'],
  ['openai-style key', 'OPENAI sk-proj1234567890abcdefgh', 'sk-proj1234567890abcdefgh'],
  [
    'github token',
    'gh auth ghp_abcdefghijklmnopqrstuvwxyz0123',
    'ghp_abcdefghijklmnopqrstuvwxyz0123',
  ],
  ['aws access key id', 'id AKIAABCDEFGHIJKLMNOP here', 'AKIAABCDEFGHIJKLMNOP'],
  ['slack token', 'xoxb-1234567890-abcdefghij', 'xoxb-1234567890-abcdefghij'],
  ['env-style name', 'export AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENG', 'wJalrXUtnFEMIK7MDENG'],
  ['api_key query', 'GET /v1?api_key=QWERTY123456&x=1', 'QWERTY123456'],
  ['private key block', '-----BEGIN RSA PRIVATE KEY-----MIIEowIBAAKCAQEA', 'MIIEowIBAAKCAQEA'],
];

describe('maskText', () => {
  it.each(SHAPES)('hides a secret: %s', (_what, line, secret) => {
    const out = maskText(line);
    expect(out).not.toContain(secret);
    expect(out).toContain('***');
  });

  it('keeps names and the rest of the line', () => {
    expect(maskText('curl -H "Authorization: Bearer abc" https://x.test/a')).toBe(
      'curl -H "Authorization: Bearer ***" https://x.test/a',
    );
    expect(maskText('a password=xyz b')).toBe('a password=*** b');
  });

  it('leaves ordinary text alone', () => {
    const plain = 'npm run test -- --grep "login form" && git status';
    expect(maskText(plain)).toBe(plain);
    expect(maskText('한글 문장 token 이야기')).toBe('한글 문장 token 이야기');
  });

  it('masks per line: a value never runs into the next line', () => {
    expect(maskText('password=abc\nnext line stays')).toBe('password=***\nnext line stays');
  });

  it('never shows an environment dump', () => {
    const dump = [
      'HOME=/home/u',
      'PATH=/usr/bin',
      'LANG=C.UTF-8',
      'SHELL=/bin/bash',
      'TERM=xterm',
    ].join('\n');
    expect(maskText(`before\n${dump}\nafter`)).toBe(`before\n${ENV_DUMP_NOTE}\nafter`);
  });

  it('cuts a very long line', () => {
    expect(maskText('x'.repeat(5000)).length).toBeLessThan(2100);
  });

  it('a token straddling the long-line cap is dropped whole, never its first characters', () => {
    const tok = `ghp_${'Zq9'.repeat(12)}`;
    const out = maskText(`${'a'.repeat(1970)} ${tok} tail`);
    expect(out).not.toMatch(/ghp_/);
    expect(out).toBe(`${'a'.repeat(1970)}…`);
    // A token ending before the cap is still masked, not cut.
    expect(maskText(`${'a '.repeat(900)}${tok} ${'b'.repeat(400)}`)).toContain('***');
  });

  it('a long line without whitespace (compact JSON) keeps its head, cut at a non-token character; a straddling token still does not leak', () => {
    const json = JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ id: i, name: `item${i}` })));
    expect(json.length).toBeGreaterThan(2000);
    const out = maskText(json);
    expect(out.length).toBeGreaterThan(1950);
    expect(json.startsWith(out.slice(0, -1))).toBe(true);
    expect(out.endsWith('…')).toBe(true);
    const tok = `ghp_${'Zq9'.repeat(12)}`;
    const straddle = maskText(`{"k":"${'x'.repeat(1970)}","t":"${tok}","u":1}`);
    expect(straddle).not.toMatch(/ghp_|Zq9/);
    expect(straddle.startsWith('{"k":"xxx')).toBe(true);
    // A JWT or a base64 secret is cut neither at its dots nor at its + / =: dropped whole, not split.
    const jwt = `eyJ${'a'.repeat(30)}.eyJ${'b'.repeat(40)}.${'c/d+e='.repeat(8)}`;
    const cutJwt = maskText(`{"k":"${'x'.repeat(1960)}","jwt":"${jwt}","u":1}`);
    expect(cutJwt).not.toMatch(/eyJ|aaaa|c\/d/);
    expect(cutJwt.endsWith('"jwt":…')).toBe(true);
    // Nothing but token characters: nothing safe to keep.
    expect(maskText('x'.repeat(5000))).toBe('…');
  });
});
