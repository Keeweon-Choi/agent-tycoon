/** Engine, project-import and job client-message routes owned by the office. */
import * as fs from 'fs';
import * as path from 'path';

import { refused, refusedOf } from '../../../../core/src/agent-tycoon/serverText.js';
import type { JobActionKind, JobActionResult, ProjectImportRow } from '../../../../core/src/messages.js';
import { configDirectory } from '../configPath.js';
import { deviceLabel } from '../device.js';
import type { Engine } from '../engine/engine.js';
import type { Jobs } from '../engine/jobs.js';
import type { ClientMessageContext } from '../hooks.js';

interface EngineRoutesDeps {
  engine: Engine | null;
  jobs: Jobs | null;
  readOnly: boolean;
  home: string;
}

export function engineRoutes(
  msg: Record<string, unknown>,
  ctx: ClientMessageContext,
  deps: EngineRoutesDeps,
): boolean {
  const { send, privileged, userAgent, stepUp } = ctx;
  if (msg.type === 'engineAction') {
    deps.engine?.handle(msg, send, privileged, deviceLabel(userAgent), stepUp);
    return true;
  }
  if (msg.type === 'engineMoveAll') {
    if (deps.engine) deps.engine.handleMoveAll(msg, send, privileged);
    return true;
  }
  if (msg.type === 'projectScan') {
    if (
      typeof msg.requestId !== 'string' ||
      (msg.folder !== undefined && typeof msg.folder !== 'string')
    )
      return true;
    try {
      const candidates =
        deps.engine?.scanImport(
          msg.folder ?? path.join(deps.home, 'projects'),
          privileged,
        ) ?? [];
      send({
        type: 'projectScanResult',
        requestId: msg.requestId,
        ok: !!deps.engine,
        candidates,
      });
    } catch (e) {
      send({
        type: 'projectScanResult',
        requestId: msg.requestId,
        ok: false,
        candidates: [],
        ...refusedOf(e, (err) => (err instanceof Error ? err.message : refused('folder_unreadable').error)),
      });
    }
    return true;
  }
  if (msg.type === 'engineInheritable') {
    // INHERIT: the add dialog's removed agents of a folder (the owner's: names, Lv, conversations).
    if (typeof msg.requestId !== 'string' || typeof msg.folder !== 'string' || msg.folder.length > 4096) return true;
    send({
      type: 'engineInheritableResult',
      requestId: msg.requestId.slice(0, 128),
      folder: msg.folder,
      agents: privileged && deps.engine ? deps.engine.inheritable(msg.folder) : [],
    });
    return true;
  }
  if (msg.type === 'projectImport') {
    if (
      typeof msg.requestId !== 'string' ||
      typeof msg.folder !== 'string' ||
      !Array.isArray(msg.rows) ||
      msg.rows.length > 100 ||
      !msg.rows.every(
        (r: unknown) =>
          typeof r === 'object' &&
          r !== null &&
          typeof (r as Record<string, unknown>).folder === 'string' &&
          typeof (r as Record<string, unknown>).name === 'string' &&
          typeof (r as Record<string, unknown>).room === 'string' &&
          typeof (r as Record<string, unknown>).resume === 'boolean' &&
          typeof (r as Record<string, unknown>).start === 'boolean',
      )
    )
      return true;
    if (deps.engine)
      void deps.engine
        .importProjects(
          msg.requestId,
          msg.folder,
          msg.rows as ProjectImportRow[],
          privileged,
        )
        .then((result) => send({ ...result }));
    return true;
  }
  if (msg.type === 'projectImportUndo') {
    if (typeof msg.requestId === 'string' && typeof msg.batchId === 'string' && deps.engine)
      send({ ...deps.engine.undoImport(msg.requestId, msg.batchId, privileged) });
    return true;
  }
  if (msg.type === 'projectImportDismiss') {
    if (privileged && !deps.readOnly) {
      const file = path.join(configDirectory(deps.home), 'import-suggestion.json');
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        fs.writeFileSync(file, '{}\n', { mode: 0o600 });
      } catch {
        /* next launch may suggest again */
      }
    }
    return true;
  }
  if (msg.type === 'engineChoicesRefresh') {
    // Runs the CLIs (synchronously): not for a read-only viewer.
    if (deps.engine && privileged)
      send(deps.engine.refreshAgentChoices() as unknown as Record<string, unknown>);
    return true;
  }
  if (msg.type === 'jobAction') {
    jobAction(msg, send, privileged, deviceLabel(userAgent), deps);
    return true;
  }
  return false;
}

/** The job panel (T-0019): read an engine job's log, or stop it (actions on, after the client's confirmation). */
function jobAction(
  msg: Record<string, unknown>,
  send: ClientMessageContext['send'],
  privileged: boolean,
  device: string,
  deps: EngineRoutesDeps,
): void {
  const { requestId, action, id } = msg;
  if (typeof requestId !== 'string' || !requestId || requestId.length > 128) return;
  if (action !== 'log' && action !== 'stop') return;
  if (typeof id !== 'string' || id.length > 128) return;
  const reply = (r: Partial<JobActionResult> & { ok: boolean }) =>
    send({ type: 'jobActionResult', requestId, action: action as JobActionKind, id, ...r });
  if (!deps.jobs) return reply({ ok: false, ...refused('engine_off') });
  if (!privileged) return reply({ ok: false, ...refused('no_permission') });
  if (action === 'log') {
    const log = deps.jobs.readLog(id);
    return reply(
      log
        ? {
            ok: true,
            log: log.text,
            truncated: log.truncated,
            digest: log.digest,
            logPath: log.path,
          }
        : { ok: false, ...refused('job_unknown') },
    );
  }
  if (deps.readOnly) return reply({ ok: false, ...refused('read_only_mode') });
  const r = deps.jobs.stop(id, `gui:${device}`);
  reply(r.ok ? { ok: true } : { ok: false, error: r.error, ...(r.errorCode && { errorCode: r.errorCode, errorParams: r.errorParams }) });
}
