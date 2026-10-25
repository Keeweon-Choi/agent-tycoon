/**
 * CH-6b: furniture the user redrew in the pixel editor. A save is always a NEW item: the daemon
 * picks the id (`custom-<base>-<time>`), checks the PNG against the original's sprite size before
 * decoding it, and writes `<id>.png` plus a manifest it builds itself from the original's catalog
 * fields into ~/.config/cld-gui/furniture/<id>/ (0700 folder, 0600 files, write-then-rename). The
 * browser never sends a manifest. One orientation and one state: a redrawn item does not rotate
 * or switch on/off. Only these custom items can be removed; bundled ones live elsewhere.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PNG } from 'pngjs';

import type { FurnitureAsset } from '../../../core/src/assets/manifestUtils.js';
import { koText, refused } from '../../../core/src/cld/serverText.js';
import { artIssue, MAX_SHEET_BYTES, pngHeaderIssue } from '../../../core/src/cld/sheetCheck.js';
import { sameOriginRequest } from './authRoutes.js';
import { decode } from './characterPresets.js';
import { writeJsonAtomic } from './jsonFile.js';

export const CUSTOM_FURNITURE_ID = /^custom-[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** One base64 PNG at the cap plus the JSON around it. */
const BODY_LIMIT = Math.ceil(MAX_SHEET_BYTES / 3) * 4 + 1024;
const MAX_BASE_LENGTH = 40;

export const customFurnitureDir = (home = os.homedir()) =>
  path.join(home, '.config', 'cld-gui', 'furniture');

/** `custom-<base>-<time>`: the original's id, lower case, without an earlier custom's stamp. */
function idStem(base: string, now: number): string {
  const slug =
    base
      .replace(/^custom-/, '')
      .replace(/-\d{13}(?:-\d+)?$/, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, MAX_BASE_LENGTH)
      .replace(/-+$/, '') || 'item';
  return `custom-${slug}-${now}`;
}

/** POST /cld/furniture {base, png}: the original's catalog id and the redrawn sprite (base64). */
export function saveCustomFurniture(
  dir: string,
  catalog: readonly FurnitureAsset[],
  body: unknown,
  now = Date.now(),
): { id: string } | { error: string } {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const base = typeof b.base === 'string' ? b.base.replace(/:left$/, '') : '';
  const original = catalog.find((a) => a.id === base);
  if (!original) return { error: 'unknown furniture' };
  const png = decode(b.png);
  if (!png) return { error: 'not base64' };
  // Header first (size, 8-bit RGBA, not interlaced, 64 KB): pngjs inflates nothing unchecked.
  const header = pngHeaderIssue(png, original.width, original.height);
  if (header) return { error: header.text };
  let rgba: Buffer;
  try {
    rgba = PNG.sync.read(png).data;
  } catch (err) {
    return { error: `broken PNG (${err instanceof Error ? err.message : String(err)})` };
  }
  const blank = artIssue(rgba);
  if (blank) return { error: blank.text };

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stem = idStem(base, now);
  let id = stem;
  // mkdir is the claim: a second save in the same millisecond takes the next number.
  for (let n = 1; ; n++) {
    try {
      fs.mkdirSync(path.join(dir, id), { mode: 0o700 });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || n > 99)
        return { error: `not saved (${err instanceof Error ? err.message : String(err)})` };
      id = `${stem}-${n}`;
    }
  }
  const folder = path.join(dir, id);
  try {
    const file = path.join(folder, `${id}.png`);
    const tmp = path.join(folder, `.${id}.png.tmp`);
    fs.writeFileSync(tmp, png, { mode: 0o600 });
    fs.renameSync(tmp, file);
    // Last: the loader skips a folder without its manifest, so it never sees a half item.
    writeJsonAtomic(path.join(folder, 'manifest.json'), {
      id,
      // A redraw of a redraw keeps one suffix.
      name: CUSTOM_FURNITURE_ID.test(original.id)
        ? original.label
        : koText('custom_label', { name: original.label }),
      category: original.category, // isDesk follows it (category 'desks')
      type: 'asset',
      file: `${id}.png`,
      width: original.width,
      height: original.height,
      footprintW: original.footprintW,
      footprintH: original.footprintH,
      canPlaceOnWalls: !!original.canPlaceOnWalls,
      canPlaceOnSurfaces: !!original.canPlaceOnSurfaces,
      backgroundTiles: original.backgroundTiles ?? 0,
    });
  } catch (err) {
    fs.rmSync(folder, { recursive: true, force: true });
    return { error: `not saved (${err instanceof Error ? err.message : String(err)})` };
  }
  return { id };
}

/** DELETE /cld/furniture/<id>: only a custom item's own folder (never a link, never bundled art). */
export function removeCustomFurniture(dir: string, id: unknown): { ok: true } | { error: string } {
  if (typeof id !== 'string' || !CUSTOM_FURNITURE_ID.test(id))
    return { error: 'not a custom item' };
  const folder = path.join(dir, id);
  let st: fs.Stats;
  try {
    st = fs.lstatSync(folder);
  } catch {
    return { error: 'not found' };
  }
  if (!st.isDirectory()) return { error: 'not found' };
  fs.rmSync(folder, { recursive: true });
  return { ok: true };
}

type RouteAuth = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** Both behind `auth` (login session or Bearer) and from the office's own page. Cosmetic, like
 *  decor, floors and character sheets: allowed on a `--read-only` daemon too (that flag gates the
 *  engine's actions). `reload` re-reads the catalog and sends it to every client. */
export function registerFurnitureRoutes(
  app: FastifyInstance,
  auth: RouteAuth,
  opts: {
    dir: string;
    catalog: () => readonly FurnitureAsset[];
    reload: () => Promise<void>;
  },
): void {
  const refuse = (request: FastifyRequest, reply: FastifyReply) =>
    sameOriginRequest(request) ? null : reply.code(403).send(refused('origin_mismatch'));
  app.post(
    '/cld/furniture',
    { preHandler: auth, bodyLimit: BODY_LIMIT },
    async (request, reply) => {
      const no = refuse(request, reply);
      if (no) return no;
      const result = saveCustomFurniture(opts.dir, opts.catalog(), request.body);
      if ('error' in result) {
        console.warn(`[cld] furniture: save refused: ${result.error}`);
        return reply.code(400).send(result);
      }
      console.log(`[cld] furniture: saved ${result.id}`);
      await opts.reload();
      return result;
    },
  );
  app.delete<{ Params: { id: string } }>(
    '/cld/furniture/:id',
    { preHandler: auth },
    async (request, reply) => {
      const no = refuse(request, reply);
      if (no) return no;
      const result = removeCustomFurniture(opts.dir, request.params.id);
      if ('error' in result) return reply.code(400).send(result);
      console.log(`[cld] furniture: removed ${request.params.id}`);
      await opts.reload();
      return result;
    },
  );
}
