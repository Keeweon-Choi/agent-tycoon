/**
 * CHARS-1104: the built-in people. loadCharacterSprites returns null (no character draws at all)
 * when one of char_0..char_{CHAR_COUNT-1}.png is missing, so every one must be there and be a sheet.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';

import { checkSheetPng, SHEET_W } from '../../core/src/agent-tycoon/sheetCheck.js';
import {
  CHAR_COUNT,
  CHAR_FRAME_H,
  CHAR_FRAME_W,
  PNG_ALPHA_THRESHOLD,
} from '../../core/src/assets/constants.js';
import { CharacterPresets } from '../src/agent-tycoon/characterPresets.js';
import { builtInSheetDirs } from '../src/agent-tycoon/packs.js';
import { loadCharacterSprites } from '../src/assetLoader.js';

const PUBLIC = path.join(__dirname, '..', '..', 'webview-ui', 'public');
const sheet = (i: number) => path.join(PUBLIC, 'assets', 'characters', `char_${i}.png`);
/** The standing frames' feet (front and back rows), as the imported sheets and mascots stand. */
const STAND_FEET_ROW = 30;
const STAND_FRAME = 1;

describe('built-in character sheets', () => {
  it('loads all CHAR_COUNT of them', async () => {
    const loaded = await loadCharacterSprites(PUBLIC);
    expect(loaded?.characters).toHaveLength(CHAR_COUNT);
  });

  it.each([...Array(CHAR_COUNT).keys()])(
    'char_%i.png is a 112×96 sheet, every cell drawn, standing on row 30',
    async (i) => {
      const bytes = fs.readFileSync(sheet(i));
      const { problem, warning } = await checkSheetPng(
        bytes,
        (b) => PNG.sync.read(Buffer.from(b)).data,
      );
      expect(problem).toBeNull();
      expect(warning).toBeNull();
      const rgba = PNG.sync.read(bytes).data;
      for (const row of [0, 1]) {
        let lowest = -1;
        for (let y = 0; y < CHAR_FRAME_H; y++)
          for (let x = 0; x < CHAR_FRAME_W; x++)
            if (
              rgba[((row * CHAR_FRAME_H + y) * SHEET_W + STAND_FRAME * CHAR_FRAME_W + x) * 4 + 3] >=
              PNG_ALPHA_THRESHOLD
            )
              lowest = y;
        expect(lowest, `row ${row}`).toBe(STAND_FEET_ROW);
      }
    },
  );
});

describe('DIAG-1104: the built-in three-quarter walks (char_N_diag.png)', () => {
  it('every built-in person has one: 3 frames facing lower right and upper right, standing on row 30', async () => {
    const loaded = await loadCharacterSprites(PUBLIC);
    for (const [i, c] of (loaded?.characters ?? []).entries()) {
      expect([c.downRight?.length, c.upRight?.length], `char_${i}`).toEqual([3, 3]);
      for (const row of [c.downRight!, c.upRight!]) {
        const stand = row[STAND_FRAME];
        const feet = stand.length - 1 - [...stand].reverse().findIndex((r) => r.some(Boolean));
        expect(feet, `char_${i}`).toBe(STAND_FEET_ROW);
      }
    }
  });

  it('a missing or broken one leaves that person its four views, and every sheet still loads', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-'));
    const dir = path.join(root, 'assets', 'characters');
    fs.mkdirSync(dir, { recursive: true });
    for (let i = 0; i < CHAR_COUNT; i++) fs.copyFileSync(sheet(i), path.join(dir, `char_${i}.png`));
    fs.copyFileSync(sheet(0).replace('.png', '_diag.png'), path.join(dir, 'char_0_diag.png'));
    fs.copyFileSync(sheet(1), path.join(dir, 'char_1_diag.png')); // 112×96: not a diagonal walk
    fs.writeFileSync(path.join(dir, 'char_2_diag.png'), 'not a png');
    try {
      const loaded = await loadCharacterSprites(root);
      expect(loaded?.characters).toHaveLength(CHAR_COUNT);
      const has = loaded!.characters.slice(0, 4).map((c) => 'downRight' in c);
      expect(has).toEqual([true, false, false, false]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('BUNNY-SHEET: the built-in bunny (agent-tycoon/packs/hd-bunny/sheets/builtin-bunny.png)', () => {
  /** 9 columns × 5 rows of 288×528 cells; a standing frame's feet end on row 511. */
  const [CELL_W, CELL_H, COLS, ROWS, FEET] = [288, 528, 9, 5, 511];

  it('is a 9-column iso8 preset the daemon lists from the built-in packs', () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny-'));
    const published: { presets: { id: string; format?: string; columns?: string }[] }[] = [];
    const presets = new CharacterPresets({
      configDir,
      builtInDirs: builtInSheetDirs(),
      publish: (m) => published.push(m),
      knownKey: () => false,
    });
    try {
      presets.start();
      const bunny = published.at(-1)?.presets.find((p) => p.id === 'builtin-bunny');
      expect(bunny).toMatchObject({ format: 'iso8', columns: 'standFirst' });
    } finally {
      presets.dispose();
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });

  it('every standing cell and the three-quarter steps stand on row 511', () => {
    const dir = builtInSheetDirs().find((d) => fs.existsSync(path.join(d, 'builtin-bunny.png')));
    const img = PNG.sync.read(fs.readFileSync(path.join(dir!, 'builtin-bunny.png')));
    expect([img.width, img.height]).toEqual([CELL_W * COLS, CELL_H * ROWS]);
    const feet = (row: number, col: number) => {
      for (let y = CELL_H - 1; y >= 0; y--)
        for (let x = 0; x < CELL_W; x++)
          if (img.data[((row * CELL_H + y) * img.width + col * CELL_W + x) * 4 + 3]) return y;
      return -1;
    };
    for (let r = 0; r < ROWS; r++) expect(feet(r, 0), `row ${r + 1}`).toBe(FEET);
    for (const r of [0, 1])
      for (const c of [1, 2]) expect(feet(r, c), `row ${r + 1} column ${c + 1}`).toBe(FEET);
  });
});
