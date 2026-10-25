import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stylesheets = ['src/index.css', 'src/cld/login/login.css'] as const;
const white: Rgb = [255, 255, 255];

type Rgb = [number, number, number];

function read(rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

function token(css: string, name: string): Rgb {
  const value = new RegExp(`${name}:\\s*([^;]+);`).exec(css)?.[1].trim();
  expect(value, `missing ${name}`).toBeTruthy();

  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value!);
  if (hex) {
    const digits = hex[1].length === 3 ? hex[1].split('').map((part) => part + part).join('') : hex[1];
    return [0, 2, 4].map((start) => Number.parseInt(digits.slice(start, start + 2), 16)) as Rgb;
  }

  const rgb = /^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i.exec(value!);
  expect(rgb, `${name} must be a hexadecimal or RGB functional colour`).toBeTruthy();
  return rgb!.slice(1).map(Number) as Rgb;
}

function luminance([red, green, blue]: Rgb): number {
  const linear = [red, green, blue].map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(first: Rgb, second: Rgb): number {
  const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(rel);
    return /\.(?:css|ts|tsx)$/.test(entry.name) ? [rel] : [];
  });
}

describe('accent contrast (U-41)', () => {
  it('keeps accent text readable and accent fills usable in both palettes', () => {
    for (const stylesheet of stylesheets) {
      const css = read(stylesheet);
      const accent = token(css, '--color-accent');
      const accentText = token(css, '--color-accent-text');
      const bright = token(css, '--color-accent-bright');
      const backgrounds = [token(css, '--color-bg'), token(css, '--color-bg-dark'), token(css, '--color-btn-bg')];

      for (const background of backgrounds) {
        expect(contrast(accentText, background), `${stylesheet} accent text`).toBeGreaterThanOrEqual(4.5);
      }
      for (const background of backgrounds.slice(0, 2)) {
        expect(contrast(accent, background), `${stylesheet} accent fill`).toBeGreaterThanOrEqual(3);
      }
      expect(contrast(white, accent), `${stylesheet} white on accent`).toBeGreaterThanOrEqual(4.5);
      // The hover/active fill carries the same white label.
      expect(contrast(white, bright), `${stylesheet} white on accent-bright`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(bright, backgrounds[0]), `${stylesheet} accent-bright fill`).toBeGreaterThanOrEqual(3);
    }
  });

  it('does not leave the low-contrast text utilities or CSS colours behind', () => {
    const staleTextUtility = /\btext-accent(?:-bright)?\b(?!-)/;
    const staleCssColour = /(?<![-\w])color\s*:\s*var\(--color-accent(?:-bright)?\)/;

    for (const file of sourceFiles('src')) {
      const source = read(file);
      expect(source, `${file} has a stale accent text utility`).not.toMatch(staleTextUtility);
      expect(source, `${file} has a stale accent CSS text colour`).not.toMatch(staleCssColour);
    }
  });

  it('exposes the accent text token to Tailwind', () => {
    expect(read('src/index.css')).toContain('--color-accent-text: var(--color-accent-text)');
  });
});
