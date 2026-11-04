/**
 * SPT-P1A: /api/cld/spec/:project/... with the file routes' guards: a logged-in browser session
 * only (the host's Bearer token, which agent sessions can read, is refused: no agent reads or
 * changes this), same-origin for every write, a read-only daemon refuses writes, an unknown
 * project is 404, and every write leaves one `[cld spec]` line naming the device.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { refused, type ServerTextCode } from '../../../../core/src/cld/serverText.js';
import { auditLog } from '../audit.js';
import { contextOf, sameOriginRequest } from '../authRoutes.js';
import { configDirectory } from '../configPath.js';
import { maskText } from '../mask.js';
import { refId, type SpecLink } from './links.js';
import type { ItemQuery, SpecError, SpecProject, SpecService } from './service.js';
import { DOC_UID_RE, ITEM_UID_RE } from './store.js';

type Params = { project: string };
const NO_CACHE = 'private, no-store';

const ERRORS: Record<SpecError, [number, ServerTextCode]> = {
  corrupt: [409, 'spec_corrupt'],
  path: [400, 'spec_path'],
  tooMany: [400, 'spec_too_many'],
  off: [409, 'spec_off'],
  doc: [404, 'spec_doc_unknown'],
  item: [404, 'spec_item_unknown'],
  stale: [409, 'spec_stale'],
  value: [400, 'spec_value'],
  save: [500, 'spec_save'],
  boundary: [403, 'spec_boundary'],
  link: [404, 'spec_link_unknown'],
  full: [409, 'spec_accept_full'],
  // SPT-P4B
  comp: [404, 'spec_comp_unknown'],
  archFull: [409, 'spec_arch_full'],
};

export interface SpecRouteDeps {
  auth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  kindOf?: (request: FastifyRequest) => { host: boolean; remote: boolean };
  actorOf?: (request: FastifyRequest) => string | undefined;
  readOnly: boolean;
}

export function registerSpecRoutes(app: FastifyInstance, service: SpecService, deps: SpecRouteDeps): void {
  /** The project, or a reply already sent (401 by the preHandler, 403, 404). */
  const gate = (request: FastifyRequest<{ Params: Params }>, reply: FastifyReply, write: boolean): SpecProject | null => {
    reply.header('Cache-Control', NO_CACHE).header('X-Content-Type-Options', 'nosniff');
    const deny = (code: number, text: ServerTextCode) => {
      void reply.code(code).send(refused(text));
      return null;
    };
    if (deps.kindOf?.(request).host) return deny(403, 'spec_session_only');
    if (write && !sameOriginRequest(request)) return deny(403, 'origin_mismatch');
    if (write && deps.readOnly) return deny(403, 'read_only_mode');
    return service.project(request.params.project) ?? deny(404, 'project_unknown_short');
  };
  const record = auditLog(configDirectory(service.home));
  /**
   * One `[cld spec]` log line and (SPT §12.3, SPT-P1D) one audit.jsonl entry per write: the device,
   * how it came in, the project's id and what changed, as UIDs and fixed words (`what`, never a
   * document's text: every value in it was checked as an id, an enum, a number or a flag).
   */
  const audit = (request: FastifyRequest, action: string, p: SpecProject, detail: string, what: string[] = []) => {
    const device = deps.actorOf?.(request) ?? 'device';
    console.log(`[cld spec] ${action} device=${JSON.stringify(device)} project=${JSON.stringify(p.name)} ${detail}`);
    record.write({ kind: 'spec', by: device, ...contextOf(request), detail: [action, p.projectId, ...what].join(' ') });
  };
  // audit.jsonl keeps 60 characters: values only where their place says what they are.
  const values = (...vs: unknown[]) => vs.flatMap((v) => (typeof v === 'string' ? [v] : []));
  const words = (o: Record<string, unknown>) => Object.entries(o).flatMap(([k, v]) => (v === undefined ? [] : [`${k}:${String(v)}`]));
  const fail = (reply: FastifyReply, error: SpecError) => {
    const [code, text] = ERRORS[error];
    return reply.code(code).send(refused(text));
  };
  const opts = { preHandler: deps.auth };

  app.get<{ Params: Params }>('/api/cld/spec/:project/summary', opts, async (request, reply) => {
    const p = gate(request, reply, false);
    return p ? service.summary(p) : reply;
  });
  // Without `type`: the 켜기 window's documents (1a); with it: [연결 추가]'s pickers (SPT-P2).
  app.get<{ Params: Params; Querystring: { type?: unknown; q?: unknown } }>('/api/cld/spec/:project/candidates', opts, async (request, reply) => {
    const p = gate(request, reply, false);
    if (!p) return reply;
    if (request.query?.type === undefined) return service.candidates(p);
    const r = await service.picks(p, request.query.type, request.query.q);
    return r.ok ? r.value : fail(reply, r.error);
  });
  app.get<{ Params: Params }>('/api/cld/spec/:project/docs', opts, async (request, reply) => {
    const p = gate(request, reply, false);
    return p ? service.docs(p) : reply;
  });
  app.get<{ Params: Params; Querystring: ItemQuery }>('/api/cld/spec/:project/items', opts, async (request, reply) => {
    const p = gate(request, reply, false);
    if (!p) return reply;
    const r = await service.items(p, request.query ?? {});
    return r.ok ? r.value : fail(reply, r.error);
  });
  app.post<{ Params: Params; Body: { docs?: unknown } | undefined }>('/api/cld/spec/:project/enable', opts, async (request, reply) => {
    const p = gate(request, reply, true);
    if (!p) return reply;
    const r = await service.enable(p, request.body?.docs);
    if (!r.ok) return fail(reply, r.error);
    audit(request, 'enable', p, `docs=${r.value.docs}`, [`docs:${r.value.docs}`]);
    return r.value;
  });
  app.post<{ Params: Params }>('/api/cld/spec/:project/disable', opts, async (request, reply) => {
    const p = gate(request, reply, true);
    if (!p) return reply;
    const r = service.disable(p);
    if (!r.ok) return fail(reply, r.error);
    audit(request, 'disable', p, '');
    return { ok: true };
  });
  app.get<{ Params: Params }>('/api/cld/spec/:project/questions', opts, async (request, reply) => {
    const p = gate(request, reply, false);
    return p ? service.questions(p) : reply;
  });
  app.get<{ Params: Params; Querystring: { limit?: unknown } }>('/api/cld/spec/:project/decisions', opts, async (request, reply) => {
    const p = gate(request, reply, false);
    if (!p) return reply;
    const r = await service.decisions(p, request.query?.limit);
    return r.ok ? r.value : fail(reply, r.error);
  });
  // The answers name UIDs and words only: no text goes to the log.
  app.post<{ Params: Params; Body: { uid?: unknown; answer?: unknown; target?: unknown } | undefined }>('/api/cld/spec/:project/resolve', opts, async (request, reply) => {
    const p = gate(request, reply, true);
    if (!p) return reply;
    const r = service.resolve(p, request.body ?? {});
    if (!r.ok) return fail(reply, r.error);
    const { uid, answer, target } = request.body ?? {};
    // `target` is not read for every answer ('new'): it goes in only with a UID's shape.
    const uidShaped = (v: unknown) => typeof v === 'string' && (ITEM_UID_RE.test(v) || DOC_UID_RE.test(v));
    audit(request, 'resolve', p, JSON.stringify({ uid, answer, ...(uidShaped(target) && { target }) }), values(uid, answer, uidShaped(target) ? target : undefined));
    return { ok: true };
  });
  app.post<{ Params: Params; Body: { action?: unknown; uid?: unknown; into?: unknown } | undefined }>('/api/cld/spec/:project/undo', opts, async (request, reply) => {
    const p = gate(request, reply, true);
    if (!p) return reply;
    const r = service.undo(p, request.body ?? {});
    if (!r.ok) return fail(reply, r.error);
    const { action, uid, into } = request.body ?? {};
    audit(request, 'undo', p, `${JSON.stringify({ action, uid, into })} now=${r.value.uid}`, values(action, uid, r.value.uid));
    return r.value;
  });
  // 이어받기 / 새로 시작 (SPT §2.8): only an offer that still holds; ids and words only in the log.
  app.post<{ Params: Params; Body: { from?: unknown; answer?: unknown } | undefined }>('/api/cld/spec/:project/inherit', opts, async (request, reply) => {
    const p = gate(request, reply, true);
    if (!p) return reply;
    const r = await service.inherit(p, request.body ?? {});
    if (!r.ok) return fail(reply, r.error);
    const { from, answer } = request.body ?? {};
    audit(request, 'inherit', p, JSON.stringify({ from, answer }), values(answer, from));
    return r.value;
  });
  type DocBody = { kind?: unknown; mode?: unknown; depth?: unknown; tracked?: unknown; seen?: unknown; sensitive?: unknown };
  app.post<{ Params: Params & { uid: string }; Body: DocBody | undefined }>(
    '/api/cld/spec/:project/docs/:uid',
    opts,
    async (request, reply) => {
      const p = gate(request, reply, true);
      if (!p) return reply;
      if (!DOC_UID_RE.test(request.params.uid)) return fail(reply, 'doc');
      const r = service.setDoc(p, request.params.uid, request.body ?? {});
      if (!r.ok) return fail(reply, r.error);
      const { kind, mode, depth, tracked, seen, sensitive } = request.body ?? {};
      audit(request, 'doc', p, `uid=${r.value.uid} ${JSON.stringify({ kind, mode, depth, tracked, seen, sensitive })}`, [r.value.uid, ...words({ kind, mode, depth, tracked, seen, sensitive })]);
      return r.value;
    },
  );

  // ── SPT-P2: the trace (traceQuery, item detail) and the owner's link decisions ──
  type GraphQuery = { level?: unknown; group?: unknown; center?: unknown; depth?: unknown; types?: unknown; confirmedOnly?: unknown };
  app.get<{ Params: Params; Querystring: GraphQuery }>('/api/cld/spec/:project/graph', opts, async (request, reply) => {
    const p = gate(request, reply, false);
    if (!p) return reply;
    const r = await service.graph(p, request.query ?? {});
    return r.ok ? r.value : fail(reply, r.error);
  });
  app.get<{ Params: Params & { uid: string } }>('/api/cld/spec/:project/item/:uid', opts, async (request, reply) => {
    const p = gate(request, reply, false);
    if (!p) return reply;
    const r = await service.item(p, request.params.uid);
    return r.ok ? r.value : fail(reply, r.error);
  });
  // SPT-P4A: the architecture graph read from the documents.
  app.get<{ Params: Params; Querystring: { layer?: unknown } }>('/api/cld/spec/:project/arch', opts, async (request, reply) => {
    const p = gate(request, reply, false);
    if (!p) return reply;
    const r = await service.arch(p, request.query ?? {});
    return r.ok ? r.value : fail(reply, r.error);
  });
  // MAP-A: the 지도's structure view of one selected item (root or a module).
  app.get<{ Params: Params; Querystring: { uid?: unknown } }>('/api/cld/spec/:project/map', opts, async (request, reply) => {
    const p = gate(request, reply, false);
    if (!p) return reply;
    const r = await service.map(p, request.query ?? {});
    return r.ok ? r.value : fail(reply, r.error);
  });
  // SPT-P3-ISSUES: the 이슈 tab's Task detail (관련 요구사항).
  app.get<{ Params: Params & { taskId: string } }>('/api/cld/spec/:project/task/:taskId', opts, async (request, reply) => {
    const p = gate(request, reply, false);
    if (!p) return reply;
    const r = await service.task(p, request.params.taskId);
    return r.ok ? r.value : fail(reply, r.error);
  });
  // ── SPT-P3-OVERVIEW: the 개요's 최근 근거 (read only, session only like every spec read) ──
  app.get<{ Params: Params }>('/api/cld/spec/:project/recent', opts, async (request, reply) => {
    const p = gate(request, reply, false);
    if (!p) return reply;
    const r = await service.recent(p);
    return r.ok ? r.value : fail(reply, r.error);
  });
  type LinkBody = { from?: unknown; to?: unknown; rel?: unknown; kind?: unknown; note?: unknown };
  const deviceOf = (request: FastifyRequest) => deps.actorOf?.(request) ?? 'device';
  // The log and audit.jsonl name UIDs, ids, relations and kinds only: never a note.
  const linkWords = (l: SpecLink) => [l.id, l.from.uid, l.rel, ...(l.kind ? [l.kind] : []), refId(l.to)];
  app.post<{ Params: Params; Body: LinkBody | undefined }>('/api/cld/spec/:project/links', opts, async (request, reply) => {
    const p = gate(request, reply, true);
    if (!p) return reply;
    const r = await service.addLink(p, request.body ?? {}, deviceOf(request));
    if (!r.ok) return fail(reply, r.error);
    const w = linkWords(r.value);
    audit(request, 'link', p, w.join(' '), w);
    return r.value;
  });
  app.post<{ Params: Params; Body: { edges?: unknown } | undefined }>('/api/cld/spec/:project/links/confirm', opts, async (request, reply) => {
    const p = gate(request, reply, true);
    if (!p) return reply;
    const r = await service.confirmLinks(p, request.body ?? {}, deviceOf(request));
    if (!r.ok) return fail(reply, r.error);
    for (const l of r.value) {
      const w = linkWords(l);
      audit(request, 'confirm', p, w.join(' '), w);
    }
    return { ok: true, links: r.value.length };
  });
  app.post<{ Params: Params; Body: LinkBody | undefined }>('/api/cld/spec/:project/links/reject', opts, async (request, reply) => {
    const p = gate(request, reply, true);
    if (!p) return reply;
    const r = await service.rejectLink(p, request.body ?? {}, deviceOf(request));
    if (!r.ok) return fail(reply, r.error);
    const w = linkWords(r.value);
    audit(request, 'reject', p, w.join(' '), w);
    return r.value;
  });
  app.patch<{ Params: Params & { id: string }; Body: LinkBody | undefined }>('/api/cld/spec/:project/links/:id', opts, async (request, reply) => {
    const p = gate(request, reply, true);
    if (!p) return reply;
    const r = await service.editLink(p, request.params.id, request.body ?? {}, deviceOf(request));
    if (!r.ok) return fail(reply, r.error);
    const w = linkWords(r.value);
    audit(request, 'link-edit', p, w.join(' '), w);
    return r.value;
  });
  app.delete<{ Params: Params & { id: string } }>('/api/cld/spec/:project/links/:id', opts, async (request, reply) => {
    const p = gate(request, reply, true);
    if (!p) return reply;
    const r = await service.unlink(p, request.params.id, deviceOf(request));
    if (!r.ok) return fail(reply, r.error);
    audit(request, 'unlink', p, r.value.id, [r.value.id]);
    return { ok: true };
  });
  app.post<{ Params: Params; Body: { uid?: unknown } | undefined }>('/api/cld/spec/:project/review', opts, async (request, reply) => {
    const p = gate(request, reply, true);
    if (!p) return reply;
    const r = await service.reviewLinks(p, request.body ?? {}, deviceOf(request));
    if (!r.ok) return fail(reply, r.error);
    const uid = String(request.body?.uid);
    audit(request, 'review', p, `uid=${uid} links=${r.value.links}`, [uid, `links:${r.value.links}`]);
    return { ok: true, ...r.value };
  });
  app.post<{ Params: Params; Body: { jobId?: unknown; note?: unknown } | undefined }>('/api/cld/spec/:project/deploy-confirm', opts, async (request, reply) => {
    const p = gate(request, reply, true);
    if (!p) return reply;
    const r = await service.deployConfirm(p, request.body ?? {}, deviceOf(request));
    if (!r.ok) return fail(reply, r.error);
    const job = String(request.body?.jobId);
    audit(request, 'deploy-confirm', p, `job=${job} requirements=${r.value.requirements}`, [job, `reqs:${r.value.requirements}`]);
    return { ok: true, ...r.value };
  });

  // ── SPT-P3-ACCEPT: 수용 판정 per requirement version; the log names the UID and the state, never the note ──
  app.post<{ Params: Params; Body: { uid?: unknown; state?: unknown; note?: unknown } | undefined }>('/api/cld/spec/:project/acceptance', opts, async (request, reply) => {
    const p = gate(request, reply, true);
    if (!p) return reply;
    const r = await service.accept(p, request.body ?? {}, deviceOf(request));
    if (!r.ok) return fail(reply, r.error);
    audit(request, 'accept', p, `uid=${r.value.uid} state=${r.value.state}`, [r.value.uid, r.value.state]);
    return { ok: true, state: r.value.state, at: r.value.at };
  });

  // ── SPT-P4B: the owner's architecture (arch.json); the log names UIDs, ids, kinds, actions and folder paths, never a label or a note ──
  type CompBody = { label?: unknown; kind?: unknown; note?: unknown };
  const archAudit = (request: FastifyRequest, action: string, p: SpecProject, w: string[]) => audit(request, action, p, w.join(' '), w);
  app.post<{ Params: Params; Body: { doc?: unknown; block?: unknown; version?: unknown } | undefined }>('/api/cld/spec/:project/arch/approve', opts, async (request, reply) => {
    const p = gate(request, reply, true);
    if (!p) return reply;
    const r = await service.archApprove(p, request.body ?? {}, deviceOf(request));
    if (!r.ok) return fail(reply, r.error);
    archAudit(request, 'arch-approve', p, [r.value.doc, String(r.value.block), r.value.version]);
    return { ok: true, at: r.value.at };
  });
  app.post<{ Params: Params; Body: CompBody | undefined }>('/api/cld/spec/:project/arch/components', opts, async (request, reply) => {
    const p = gate(request, reply, true);
    if (!p) return reply;
    const r = await service.archAddComp(p, request.body ?? {}, deviceOf(request));
    if (!r.ok) return fail(reply, r.error);
    archAudit(request, 'arch-add', p, [r.value.uid, r.value.kind]);
    return r.value;
  });
  app.patch<{ Params: Params & { uid: string }; Body: CompBody | undefined }>('/api/cld/spec/:project/arch/components/:uid', opts, async (request, reply) => {
    const p = gate(request, reply, true);
    if (!p) return reply;
    const r = await service.archEditComp(p, request.params.uid, request.body ?? {}, deviceOf(request));
    if (!r.ok) return fail(reply, r.error);
    const { kind, label, note } = request.body ?? {};
    archAudit(request, 'arch-edit', p, [r.value.uid, ...(typeof kind === 'string' ? [kind] : []), ...(label !== undefined ? ['label'] : []), ...(note !== undefined ? ['note'] : [])]);
    return { ok: true };
  });
  app.delete<{ Params: Params & { uid: string } }>('/api/cld/spec/:project/arch/components/:uid', opts, async (request, reply) => {
    const p = gate(request, reply, true);
    if (!p) return reply;
    const r = await service.archDeleteComp(p, request.params.uid, deviceOf(request));
    if (!r.ok) return fail(reply, r.error);
    archAudit(request, 'arch-delete', p, [r.value.uid]);
    return { ok: true };
  });
  app.post<{ Params: Params; Body: { from?: unknown; to?: unknown; label?: unknown } | undefined }>('/api/cld/spec/:project/arch/relations', opts, async (request, reply) => {
    const p = gate(request, reply, true);
    if (!p) return reply;
    const r = await service.archAddRel(p, request.body ?? {}, deviceOf(request));
    if (!r.ok) return fail(reply, r.error);
    archAudit(request, 'arch-relate', p, [r.value.id, r.value.from, r.value.to]);
    return r.value;
  });
  app.delete<{ Params: Params & { id: string } }>('/api/cld/spec/:project/arch/relations/:id', opts, async (request, reply) => {
    const p = gate(request, reply, true);
    if (!p) return reply;
    const r = await service.archDeleteRel(p, request.params.id, deviceOf(request));
    if (!r.ok) return fail(reply, r.error);
    archAudit(request, 'arch-unrelate', p, [r.value.id]);
    return { ok: true };
  });
  app.post<{ Params: Params; Body: { uid?: unknown; into?: unknown } | undefined }>('/api/cld/spec/:project/arch/alias', opts, async (request, reply) => {
    const p = gate(request, reply, true);
    if (!p) return reply;
    const r = await service.archAlias(p, request.body ?? {}, deviceOf(request));
    if (!r.ok) return fail(reply, r.error);
    archAudit(request, 'arch-merge', p, [r.value.uid, r.value.into]);
    return { ok: true };
  });
  app.delete<{ Params: Params & { uid: string } }>('/api/cld/spec/:project/arch/alias/:uid', opts, async (request, reply) => {
    const p = gate(request, reply, true);
    if (!p) return reply;
    const r = await service.archUnalias(p, request.params.uid, deviceOf(request));
    if (!r.ok) return fail(reply, r.error);
    archAudit(request, 'arch-unmerge', p, [r.value.uid]);
    return { ok: true };
  });
  // MAP-A [제안 모두 승인] and its [되돌리기]: the batch id and the counts only in the log.
  app.post<{ Params: Params; Body: { diagrams?: unknown; folders?: unknown } | undefined }>('/api/cld/spec/:project/arch/approve-all', opts, async (request, reply) => {
    const p = gate(request, reply, true);
    if (!p) return reply;
    const r = await service.archApproveAll(p, request.body ?? {}, deviceOf(request));
    if (!r.ok) return fail(reply, r.error);
    archAudit(request, 'arch-approve-all', p, [r.value.batch, `d:${r.value.diagrams}`, `f:${r.value.folders}`]);
    return { ok: true, ...r.value };
  });
  app.post<{ Params: Params; Body: { batch?: unknown } | undefined }>('/api/cld/spec/:project/arch/approve-all/undo', opts, async (request, reply) => {
    const p = gate(request, reply, true);
    if (!p) return reply;
    const r = await service.archUndoBatch(p, request.body ?? {}, deviceOf(request));
    if (!r.ok) return fail(reply, r.error);
    archAudit(request, 'arch-undo-all', p, [r.value.batch]);
    return { ok: true };
  });
  // MAP-A [부모 정하기]: UIDs only in the log.
  app.post<{ Params: Params; Body: { uid?: unknown; parent?: unknown } | undefined }>('/api/cld/spec/:project/arch/parent', opts, async (request, reply) => {
    const p = gate(request, reply, true);
    if (!p) return reply;
    const r = await service.archParent(p, request.body ?? {}, deviceOf(request));
    if (!r.ok) return fail(reply, r.error);
    archAudit(request, 'arch-parent', p, [r.value.uid, r.value.parent ?? 'none']);
    return { ok: true };
  });
  app.post<{ Params: Params; Body: { path?: unknown; action?: unknown; label?: unknown; into?: unknown } | undefined }>('/api/cld/spec/:project/arch/skeleton', opts, async (request, reply) => {
    const p = gate(request, reply, true);
    if (!p) return reply;
    const r = await service.archSkeleton(p, request.body ?? {}, deviceOf(request));
    if (!r.ok) return fail(reply, r.error);
    const d = r.value;
    archAudit(request, 'arch-skeleton', p, [d.action, maskText(d.path), ...(d.uid ? [d.uid] : []), ...(d.into ? [d.into] : [])]);
    return d;
  });
}
