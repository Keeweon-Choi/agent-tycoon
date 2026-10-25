import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { PIXEL_FONT_FAMILY } from '../src/constants.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf-8');

/** Every source file that can name a font stack. */
function sources(dir: string): string[] {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) return e.name === 'fonts' ? [] : sources(rel);
    return /\.(css|tsx?)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [rel] : [];
  });
}

describe('pixel font stacks (T-0054)', () => {
  it('lists Galmuri right after FS Pixel Sans wherever a stack names it', () => {
    const stacks: string[] = [];
    for (const file of sources('src')) {
      for (const m of read(file).matchAll(/'FS Pixel Sans'(?!;)[^;\n`]*/g)) {
        stacks.push(m[0]);
        expect(m[0], `${file}: ${m[0]}`).toMatch(/^'FS Pixel Sans',\s*'Galmuri11'/);
      }
    }
    // the --font-pixel token, the login page and the two canvas call sites
    expect(stacks.length).toBeGreaterThanOrEqual(2);
    expect(PIXEL_FONT_FAMILY).toMatch(/^'FS Pixel Sans', 'Galmuri11'$/);
    expect(read('src/index.css')).toContain("--font-pixel: 'FS Pixel Sans', 'Galmuri11'");
    expect(read('src/cld/login/login.css')).toContain("'FS Pixel Sans', 'Galmuri11'");
  });

  it('serves every Galmuri face from public/fonts/galmuri, Hangul only', () => {
    const faces = [...read('src/fonts.css').matchAll(/@font-face\s*\{[^}]*\}/g)].map((m) => m[0]);
    expect(faces.length).toBeGreaterThan(0);
    for (const face of faces) {
      const url = /url\('\/fonts\/galmuri\/([^']+)'\)/.exec(face)?.[1];
      expect(url, face).toBeTruthy();
      expect(fs.existsSync(path.join(root, 'public/fonts/galmuri', url!))).toBe(true);
      expect(face).toContain('U+ac00-d7a3');
      expect(face).toContain('unicode-range');
      expect(face).toContain('size-adjust: 66.667%');
    }
    expect(fs.existsSync(path.join(root, 'public/fonts/galmuri/OFL.txt'))).toBe(true);
  });

  it('the login page carries the same @font-face rules (it cannot @import)', () => {
    const faces = (css: string) =>
      [...css.matchAll(/@font-face\s*\{[^}]*Galmuri[^}]*\}/g)].map((m) => m[0]);
    expect(faces(read('src/cld/login/login.css'))).toEqual(faces(read('src/fonts.css')));
  });
});
