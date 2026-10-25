/**
 * MSG-UI3: the owner's profile picture, `<config>/profile/owner.png`: one 128x128 8-bit PNG the
 * browser cropped and shrank. Same gates as the character photo save: a logged-in session, the same
 * origin, the header checked before pngjs inflates anything, a server-chosen path, an atomic 0600
 * write. Served to logged-in clients only; no file means 404 and the UI draws its default.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as fs from 'fs';
import * as path from 'path';

import { refused } from '../../../core/src/cld/serverText.js';
import { MAX_SHEET_BYTES } from '../../../core/src/cld/sheetCheck.js';
import { sameOriginRequest } from './authRoutes.js';
import { pngProblem } from './characterPresets.js';

export const OWNER_PICTURE_SIDE = 128;
const FILE = 'owner.png';
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const UPLOAD_BODY_LIMIT = Math.ceil(MAX_SHEET_BYTES / 3) * 4 + 1024;

/** The stored picture's bytes, or null when there is none (or it is not a plain, valid file). */
function readPicture(file: string): { png: Buffer; mtimeMs: number } | null {
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > MAX_SHEET_BYTES) return null;
    const png = fs.readFileSync(file);
    return pngProblem(png, OWNER_PICTURE_SIDE, OWNER_PICTURE_SIDE, true)
      ? null
      : { png, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

function writeAtomic(dir: string, png: Buffer): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.${FILE}.tmp`);
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(tmp, png, { mode: 0o600, flag: 'wx' });
  fs.renameSync(tmp, path.join(dir, FILE));
}

type RouteAuth = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** GET/POST/DELETE /cld/profile/owner(.png), all behind `auth`; `dir` is `<config>/profile`. */
export function registerOwnerProfileRoutes(
  app: FastifyInstance,
  auth: RouteAuth,
  dir: string,
): void {
  const file = path.join(dir, FILE);
  app.get('/cld/profile/owner.png', { preHandler: auth }, async (request, reply) => {
    const picture = readPicture(file);
    if (!picture) return reply.code(404).send();
    const etag = `"${Math.floor(picture.mtimeMs)}-${picture.png.length}"`;
    reply.header('etag', etag).header('cache-control', 'private, no-cache');
    if (request.headers['if-none-match'] === etag) return reply.code(304).send();
    return reply.type('image/png').header('x-content-type-options', 'nosniff').send(picture.png);
  });
  // Like a character's look, the owner's picture only changes how the office looks: a logged-in
  // page may change it even when the daemon runs without --allow-actions (read-only).
  const gate = (request: FastifyRequest, reply: FastifyReply): boolean => {
    if (!sameOriginRequest(request)) {
      reply.code(403).send({ ...refused('origin_mismatch') });
      return false;
    }
    return true;
  };
  app.post<{ Body: { png?: unknown } | undefined }>(
    '/cld/profile/owner',
    { preHandler: auth, bodyLimit: UPLOAD_BODY_LIMIT },
    async (request, reply) => {
      if (!gate(request, reply)) return;
      const text = request.body?.png;
      if (typeof text !== 'string' || !BASE64.test(text))
        return reply.code(400).send({ error: 'not base64' });
      const png = Buffer.from(text, 'base64');
      // The header first (size, format, interlace), then a full decode.
      const problem = pngProblem(png, OWNER_PICTURE_SIDE, OWNER_PICTURE_SIDE, true);
      if (problem) {
        console.warn(`[cld] profile: upload refused: ${problem}`);
        return reply.code(400).send({ error: problem });
      }
      try {
        writeAtomic(dir, png);
      } catch (err) {
        return reply
          .code(500)
          .send({ error: `not saved (${err instanceof Error ? err.message : String(err)})` });
      }
      return { ok: true };
    },
  );
  app.delete('/cld/profile/owner', { preHandler: auth }, async (request, reply) => {
    if (!gate(request, reply)) return;
    fs.rmSync(file, { force: true });
    return { ok: true };
  });
}
