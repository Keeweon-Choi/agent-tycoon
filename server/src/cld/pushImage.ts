/**
 * The picture in a Web Push notification (Android Chrome's `image` option). The browser fetches
 * that URL itself, with no page and no session, so this is the ONE unauthenticated file read:
 *
 *   GET /api/cld/push-image/<id>.<expiry>.<signature>
 *
 * - It serves only a file the daemon named when it sent a push (`mint`): an image copy in a
 *   project's `.cld-outbox/` (the folder sendOutbox fills after its own source checks), png, jpeg,
 *   gif or webp, at most PUSH_IMAGE_MAX_BYTES. No other file, no listing, no path in the URL: the
 *   id is a hash and the path comes from this table, never from the request.
 * - The signature is HMAC-SHA256 over `<id>.<expiry>` with a secret made at daemon start, compared
 *   in constant time; the link dies PUSH_IMAGE_TTL_MS after the push (and with a daemon restart).
 * - Every refusal (bad shape, wrong signature, expired, unknown id, file gone or changed) is the
 *   same empty 404.
 * ponytail: the original is served when it is small enough, never scaled (no image library here);
 * a larger picture simply gets no preview, only the "[사진]" text.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { FastifyInstance } from 'fastify';

import { IMAGE_TYPES } from './files/attachments.js';
import { OUTBOX } from './files/outbox.js';

export const PUSH_IMAGE_ROUTE = '/api/cld/push-image/';
/** How long a push's picture link works. */
export const PUSH_IMAGE_TTL_MS = 10 * 60_000;
/** Bigger pictures are not offered to the notification (it would be downloaded on mobile data). */
export const PUSH_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
const ID_BYTES = 16;
/** The id table is dropped when it grows past this (the oldest links die early; nothing else breaks). */
const KNOWN_MAX = 500;
/** The shape of a token, and of the public path the login gate lets through without a session. */
export const PUSH_IMAGE_PATH = /^\/api\/cld\/push-image\/[A-Za-z0-9_-]{22}\.\d{10,16}\.[A-Za-z0-9_-]{43}$/;
const TOKEN = /^([A-Za-z0-9_-]{22})\.(\d{10,16})\.([A-Za-z0-9_-]{43})$/;

export interface PushImageFile {
  fd: number;
  size: number;
  type: string;
}

export class PushImages {
  private readonly known = new Map<string, string>();

  constructor(
    private readonly secret: Buffer = crypto.randomBytes(32),
    private readonly now: () => number = Date.now,
  ) {}

  private sign(id: string, expiry: number): string {
    return crypto.createHmac('sha256', this.secret).update(`${id}.${expiry}`).digest('base64url');
  }

  /** The file opened if it is still a small image copy in an outbox folder, else null. */
  private openImage(file: string): PushImageFile | null {
    const type = IMAGE_TYPES[path.extname(file).toLowerCase()];
    if (!type || !path.isAbsolute(file) || path.basename(path.dirname(file)) !== OUTBOX) return null;
    let fd: number | null = null;
    try {
      const folder = fs.lstatSync(path.dirname(file));
      if (!folder.isDirectory() || folder.isSymbolicLink()) return null;
      // O_NOFOLLOW: a symlink in place of the copy is refused; O_NONBLOCK: a FIFO cannot hang us.
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > PUSH_IMAGE_MAX_BYTES) throw new Error('not offered');
      return { fd, size: stat.size, type };
    } catch {
      if (fd !== null) fs.closeSync(fd);
      return null;
    }
  }

  /** The URL path for one outbox image copy, or null when it may not be offered. */
  mint(file: string): string | null {
    const checked = this.openImage(file);
    if (!checked) return null;
    fs.closeSync(checked.fd);
    const id = crypto.createHash('sha256').update(file).digest().subarray(0, ID_BYTES).toString('base64url');
    if (this.known.size >= KNOWN_MAX) this.known.clear();
    this.known.set(id, file);
    const expiry = this.now() + PUSH_IMAGE_TTL_MS;
    return `${PUSH_IMAGE_ROUTE}${id}.${expiry}.${this.sign(id, expiry)}`;
  }

  /** The opened file a token names (the caller closes `fd`), or null for anything else. */
  open(token: string): PushImageFile | null {
    const m = TOKEN.exec(token);
    if (!m) return null;
    const [, id, expiry, signature] = m;
    const want = Buffer.from(this.sign(id, Number(expiry)));
    const got = Buffer.from(signature);
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
    if (Number(expiry) <= this.now()) return null;
    const file = this.known.get(id);
    return file ? this.openImage(file) : null;
  }
}

export function registerPushImageRoute(app: FastifyInstance, images: PushImages): void {
  app.get<{ Params: { token: string } }>(`${PUSH_IMAGE_ROUTE}:token`, async (request, reply) => {
    const file = images.open(request.params.token);
    if (!file) return reply.code(404).send();
    return reply
      .header('Content-Type', file.type)
      .header('Content-Length', file.size)
      .header('Cache-Control', 'private, no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .send(fs.createReadStream('', { fd: file.fd, autoClose: true }));
  });
}
