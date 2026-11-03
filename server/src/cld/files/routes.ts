import * as fs from 'node:fs';
import * as path from 'node:path';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { koText, refused } from '../../../../core/src/cld/serverText.js';
import type { HostInfo } from '../../../../core/src/messages.js';
import { type Session, sessionIdFromCookie, type StandaloneAuth } from '../auth.js';
import { sameOriginRequest } from '../authRoutes.js';
import type { ProjectFolder } from '../engine/git/repoRead.js';
import { detectHostInfo } from '../folders.js';
import { cleanOldAttachments, storeAttachment, VIDEO_ATTACH_MAX } from './attachments.js';
import { DownloadTickets } from './downloads.js';
import { gitIgnoredPaths } from './ignored.js';
import { listFiles } from './listing.js';
import { fileForContent, mimeType, openContent, previewFile } from './preview.js';
import { parseRange } from './range.js';
import { recentFiles } from './recent.js';
import { chosenRoot, FileAccessError, projectRoot, worktreeRoot } from './roots.js';
import { EDIT_MAX_BYTES, readForEdit, saveEdit } from './save.js';

export const FOLDER_PROJECT = '~folder';
type Query = { path?: string; root?: string; task?: string; hashOnly?: string; offset?: string; hidden?: string; limit?: string };
type ProjectParam = { project: string };
const NO_CACHE = 'private, no-store';
/** Kinds a preview ticket serves inline: <img>, the PDF viewer, a sandboxed iframe, <video>. */
const INLINE: readonly string[] = ['image', 'pdf', 'html', 'video'];

function responseError(reply: FastifyReply, error: unknown) {
  if (error instanceof FileAccessError)
    return reply.code(error.status).send({ error: error.message });
  return reply.code(500).send({ ...refused('file_unreadable') });
}

/** A small per-session window for listing, preview, tickets and file bytes. */
export class FileRateLimit {
  private readonly buckets = new Map<string, { since: number; count: number }>();
  constructor(
    private readonly now = Date.now,
    private readonly max = 120,
  ) {}
  allow(key: string): boolean {
    const previous = this.buckets.get(key);
    const bucket =
      !previous || this.now() - previous.since >= 60_000
        ? { since: this.now(), count: 0 }
        : previous;
    bucket.count++;
    this.buckets.set(key, bucket);
    return bucket.count <= this.max;
  }
}

function audit(
  action: 'preview' | 'download' | 'upload' | 'edit',
  session: Session,
  project: string,
  relative: string,
  size: number,
): void {
  console.log(
    `[cld files] ${action} device=${JSON.stringify(session.label)} project=${JSON.stringify(project)} path=${JSON.stringify(relative)} size=${size}`,
  );
}

export function registerProjectFileRoutes(
  app: FastifyInstance,
  auth: StandaloneAuth,
  projects: () => ProjectFolder[],
  host: HostInfo = detectHostInfo(),
): void {
  const tickets = new DownloadTickets();
  const limit = new FileRateLimit();
  const sensitive = new Set<string>();
  const batches = new Map<string, { count: number; at: number }>();
  for (const project of projects()) {
    try {
      cleanOldAttachments(projectRoot(projects(), project.name));
    } catch {
      /* A bad inbox must not prevent the daemon from starting. */
    }
  }
  const rootFor = (project: string, selected?: string, task?: string) =>
    project === FOLDER_PROJECT
      ? chosenRoot(selected ?? '', host)
      : task !== undefined
        ? worktreeRoot(projects(), project, task)
        : projectRoot(projects(), project);
  const session = (
    request: FastifyRequest,
    reply: FastifyReply,
    found = auth.session(sessionIdFromCookie(request.headers.cookie)),
  ): Session | undefined => {
    if (!found) {
      reply.code(401).send({ ...refused('login_needed') });
      return;
    }
    if (!limit.allow(found.hash)) {
      reply.code(429).send({ ...refused('try_again_soon') });
      return;
    }
    if (request.method !== 'GET' && !sameOriginRequest(request)) {
      reply.code(403).send({ ...refused('origin_mismatch') });
      return;
    }
    reply.header('Cache-Control', NO_CACHE).header('X-Content-Type-Options', 'nosniff');
    return found;
  };

  // The upload's own scope: the octet-stream parser reaches no other route, hands the handler the
  // request stream itself (never a whole-body Buffer; the handler enforces the limits as it writes),
  // and the session/Origin check runs in onRequest, before the body is read.
  const uploaders = new WeakMap<FastifyRequest, Session>();
  app.register(async (scope) => {
    scope.addContentTypeParser('application/octet-stream', (_request, payload, done) =>
      done(null, payload),
    );
    scope.post<{ Params: ProjectParam; Body: AsyncIterable<Uint8Array> }>(
      '/cld/attach/:project',
      {
        bodyLimit: VIDEO_ATTACH_MAX,
        onRequest: async (request, reply) => {
          const who = session(request, reply);
          if (!who) return reply;
          uploaders.set(request, who);
        },
      },
      async (request, reply) => {
        const who = uploaders.get(request);
        if (!who) return reply.code(401).send({ ...refused('login_needed') });
        try {
          const rawName = request.headers['x-file-name'];
          const rawType = request.headers['x-file-type'];
          if (
            typeof rawName !== 'string' ||
            typeof rawType !== 'string' ||
            typeof request.body?.[Symbol.asyncIterator] !== 'function'
          )
            throw new FileAccessError(koText('file_request_invalid'), 400);
          const batch = request.headers['x-attachment-batch'];
          if (
            batch !== undefined &&
            (typeof batch !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(batch))
          )
            throw new FileAccessError(koText('attach_request_invalid'), 400);
          const key = batch ? `${who.hash}:${batch}` : undefined;
          const held = key ? batches.get(key) : undefined;
          if (held && held.count >= 5)
            throw new FileAccessError(koText('attach_max_files'), 429);
          let name: string;
          try {
            name = decodeURIComponent(rawName);
          } catch {
            throw new FileAccessError(koText('file_name_invalid'), 400);
          }
          const root = projectRoot(projects(), request.params.project);
          const length = request.headers['content-length'];
          const result = await storeAttachment(
            root,
            name,
            rawType,
            request.body,
            length === undefined ? undefined : Number(length),
          );
          if (key) {
            batches.set(key, { count: (held?.count ?? 0) + 1, at: Date.now() });
            if (batches.size > 1000)
              for (const [entry, value] of batches)
                if (Date.now() - value.at > 60 * 60_000) batches.delete(entry);
          }
          audit(
            'upload',
            who,
            request.params.project,
            path.relative(root, result.path).split(path.sep).join('/'),
            result.size,
          );
          return result;
        } catch (error) {
          return responseError(reply, error);
        }
      },
    );
  });

  app.get<{ Params: ProjectParam; Querystring: Query }>(
    '/api/cld/files/:project/list',
    async (request, reply) => {
      if (!session(request, reply)) return reply;
      try {
        const root = rootFor(request.params.project, request.query.root, request.query.task);
        return listFiles(
          root,
          request.query.path ?? '',
          Number(request.query.offset ?? 0),
          request.query.hidden === '1',
          Number(request.query.limit ?? 200),
        );
      } catch (error) {
        return responseError(reply, error);
      }
    },
  );

  app.get<{ Params: ProjectParam; Querystring: Query }>(
    '/api/cld/files/:project/recent',
    async (request, reply) => {
      if (!session(request, reply)) return reply;
      try {
        const root = rootFor(request.params.project, request.query.root, request.query.task);
        const ignored = gitIgnoredPaths(root);
        const visibleIgnored =
          request.query.hidden === '1'
            ? ignored
            : ignored.filter((entry) => !entry.split('/').some((part) => part.startsWith('.')));
        return { ...recentFiles(root, Date.now(), ignored), ignored: visibleIgnored };
      } catch (error) {
        return responseError(reply, error);
      }
    },
  );

  app.get<{ Params: ProjectParam; Querystring: Query }>(
    '/api/cld/files/:project/ignored',
    async (request, reply) => {
      if (!session(request, reply)) return reply;
      try {
        return { ignored: gitIgnoredPaths(rootFor(request.params.project, request.query.root, request.query.task)) };
      } catch (error) {
        return responseError(reply, error);
      }
    },
  );

  app.get<{ Params: ProjectParam; Querystring: Query }>(
    '/api/cld/files/:project/preview',
    async (request, reply) => {
      const who = session(request, reply);
      if (!who) return reply;
      try {
        const root = rootFor(request.params.project, request.query.root, request.query.task);
        const result = previewFile(root, request.query.path ?? '', sensitive.has(who.hash));
        audit(
          'preview',
          who,
          request.params.project === FOLDER_PROJECT ? root : request.params.project,
          result.path,
          result.size,
        );
        return result;
      } catch (error) {
        return responseError(reply, error);
      }
    },
  );

  // The editor: the whole text with the hash a save must present (hashOnly: just the hash, for the 5 s poll).
  app.get<{ Params: ProjectParam; Querystring: Query }>(
    '/api/cld/files/:project/text',
    async (request, reply) => {
      const who = session(request, reply);
      if (!who) return reply;
      try {
        const root = rootFor(request.params.project, request.query.root, request.query.task);
        const file = readForEdit(root, request.query.path ?? '', sensitive.has(who.hash));
        return request.query.hashOnly === '1' ? { path: file.path, hash: file.hash } : file;
      } catch (error) {
        return responseError(reply, error);
      }
    },
  );
  // Save: the same session, same-origin, root, denylist and sensitive checks as the reads; refused with
  // 409 and the disk's hash when the file changed since it was opened.
  app.put<{
    Params: ProjectParam;
    Body: { path?: unknown; root?: unknown; task?: unknown; text?: unknown; baseHash?: unknown };
  }>(
    '/api/cld/files/:project/text',
    { bodyLimit: EDIT_MAX_BYTES * 4 },
    async (request, reply) => {
      const who = session(request, reply);
      if (!who) return reply;
      const { path: relative, root: chosen, task, text, baseHash } = request.body ?? {};
      if (
        typeof relative !== 'string' ||
        typeof text !== 'string' ||
        typeof baseHash !== 'string' ||
        (task !== undefined && typeof task !== 'string') ||
        (chosen !== undefined && typeof chosen !== 'string')
      )
        return reply.code(400).send({ error: koText('file_request_invalid') });
      try {
        const root = rootFor(request.params.project, chosen, task);
        const result = saveEdit(root, relative, sensitive.has(who.hash), text, baseHash);
        if (!result.ok)
          return reply.code(409).send({ ...refused('file_changed_on_disk'), hash: result.hash });
        audit(
          'edit',
          who,
          request.params.project === FOLDER_PROJECT ? root : request.params.project,
          result.path,
          result.size,
        );
        return { path: result.path, hash: result.hash };
      } catch (error) {
        return responseError(reply, error);
      }
    },
  );

  app.get('/api/cld/files/settings', async (request, reply) => {
    const who = session(request, reply);
    return who ? { allowSensitive: sensitive.has(who.hash) } : reply;
  });
  app.post<{ Body: { allowSensitive?: unknown } }>(
    '/api/cld/files/settings',
    async (request, reply) => {
      const who = session(request, reply);
      if (!who) return reply;
      if (typeof request.body?.allowSensitive !== 'boolean')
        return reply.code(400).send({ ...refused('setting_invalid') });
      if (request.body.allowSensitive) sensitive.add(who.hash);
      else sensitive.delete(who.hash);
      return { allowSensitive: sensitive.has(who.hash) };
    },
  );

  app.post<{ Params: ProjectParam; Body: { path?: unknown; root?: unknown; task?: unknown; mode?: unknown } }>(
    '/api/cld/files/:project/ticket',
    async (request, reply) => {
      const who = session(request, reply);
      if (!who) return reply;
      if (
        typeof request.body?.path !== 'string' ||
        !['preview', 'download', 'open'].includes(String(request.body.mode))
      )
        return reply.code(400).send({ error: koText('file_request_invalid') });
      try {
        const task = typeof request.body.task === 'string' ? request.body.task : undefined;
        const root = rootFor(request.params.project, request.body.root as string | undefined, task);
        const file = fileForContent(root, request.body.path, sensitive.has(who.hash));
        // 'open' (DESKTOP-ACTIONS): a preview for the default browser, see Ticket.external.
        const external = request.body.mode === 'open';
        if (request.body.mode !== 'download' && !INLINE.includes(file.kind))
          throw new FileAccessError(koText('preview_unsupported'), 415);
        const ticket = tickets.mint({
          // A browser's PDF viewer asks for ranges too; a PDF in this tab is fetched by the page once.
          reusable:
            request.body.mode !== 'download' &&
            (file.kind === 'video' || (external && file.kind === 'pdf')),
          ...(external && { external: true }),
          session: who.hash,
          project: request.params.project,
          ...(request.params.project === FOLDER_PROJECT && { root }),
          ...(task !== undefined && { task }),
          path: request.body.path,
          mode: request.body.mode === 'download' ? 'download' : 'preview',
        });
        return { url: `/api/cld/files/content/${ticket}`, expiresIn: 60 };
      } catch (error) {
        return responseError(reply, error);
      }
    },
  );

  app.get<{ Params: { ticket: string } }>(
    '/api/cld/files/content/:ticket',
    async (request, reply) => {
      // An external ticket stands for its minting session only while that session is live
      // (signed out, revoked or expired: 401); any other ticket needs this request's cookie.
      const external = tickets.externalSession(request.params.ticket);
      const who = session(
        request,
        reply,
        external !== undefined
          ? auth.liveSessionByHash(external)
          : auth.session(sessionIdFromCookie(request.headers.cookie)),
      );
      if (!who) return reply;
      const ticket = tickets.consume(request.params.ticket, who.hash);
      if (!ticket) return reply.code(404).send({ ...refused('link_expired') });
      try {
        const root = rootFor(ticket.project, ticket.root, ticket.task);
        const file = openContent(root, ticket.path, sensitive.has(who.hash));
        const filename = path.basename(file.real);
        const disposition =
          ticket.mode === 'preview' && INLINE.includes(file.kind) ? 'inline' : 'attachment';
        reply.header(
          'Content-Disposition',
          `${disposition}; filename*=UTF-8''${encodeURIComponent(filename)}`,
        );
        reply.header(
          'Content-Type',
          disposition === 'inline' ? mimeType(file.real) : 'application/octet-stream',
        );
        // An HTML report or SVG opened inline, even top-level, runs no script
        // in an opaque origin: CSP sandbox without allow-scripts.
        if (file.kind === 'html' || path.extname(file.real).toLowerCase() === '.svg')
          reply.header(
            'Content-Security-Policy',
            "default-src 'none'; script-src 'none'; img-src data:; style-src 'unsafe-inline'; frame-ancestors 'self'; sandbox",
          );
        // Range (iOS Safari plays and seeks a <video> only through it): 206 with the slice, 416 when
        // it lies outside the file. The ticket, session and path checks above ran for every request.
        reply.header('Accept-Ranges', 'bytes');
        const range = parseRange(request.headers.range, file.size);
        if (range === 'unsatisfiable') {
          fs.closeSync(file.fd);
          return reply
            .code(416)
            .type('application/json; charset=utf-8')
            .header('Content-Range', `bytes */${file.size}`)
            .send({ ...refused('range_invalid') });
        }
        if (range) {
          reply
            .code(206)
            .header('Content-Range', `bytes ${range.start}-${range.end}/${file.size}`)
            .header('Content-Length', range.end - range.start + 1);
        } else reply.header('Content-Length', file.size);
        // One line per playback, not per range request.
        if (!range || range.start === 0)
          audit(ticket.mode, who, ticket.root ?? ticket.project, ticket.path, file.size);
        return reply.send(
          fs.createReadStream(file.real, { fd: file.fd, autoClose: true, ...range }),
        );
      } catch (error) {
        return responseError(reply, error);
      }
    },
  );
}
