/**
 * T-115 사이드 질문: a question answered from a copy of a Lead's conversation while the Lead keeps
 * working. The user's own `claude` resumes the Lead's session as a fork that is never written
 * (--no-session-persistence: no new transcript in the Lead's project folder, so the office adopts
 * no stranger), with hooks off (--safe-mode: no hook event reaches the daemon) and read-only tools.
 * Checked against Claude Code 2.1.323 on 11-13: the fork answered from the Lead's context, no
 * transcript appeared, the original transcript stayed as it was, a request to write a file or run
 * a command was refused (the same request without these flags wrote the file).
 */
import * as os from 'node:os';

import { type Refused, refused } from '../../../core/src/agent-tycoon/serverText.js';
import type { SideAsk } from '../../../core/src/messages.js';
import { SIDE_QUESTION_REASON_MAX, SIDE_QUESTION_TIMEOUT_MS } from '../constants.js';
import { type SpawnFn, spawnJson, SpawnJsonError } from './spawnJson.js';

/** Only tools that read; no MCP server (its tools may write), nothing prompts (anything that would is denied). */
export const SIDE_READ_ONLY_ARGS = [
  '--tools',
  'Read,Grep,Glob',
  '--strict-mcp-config',
  '--permission-mode',
  'dontAsk',
  '--permission-prompts',
  'none',
  '--safe-mode',
  '--disable-slash-commands',
];

/** A model value as the CLI lists it (`--model <value>`): never a flag. */
export const SIDE_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/;

export type SideExchange = { question: string; answer: string };

/** The prompt goes in on stdin: an argument could start with `-`, and cmd.exe cannot pass a line break. */
export function sideQuestionArgs(sessionId: string, model: string): string[] {
  return [
    '-p',
    '--resume',
    sessionId,
    '--fork-session',
    '--no-session-persistence',
    '--model',
    model,
    '--output-format',
    'json',
    ...SIDE_READ_ONLY_ARGS,
  ];
}

/** Every question forks the Lead's latest conversation afresh, so this drawer's earlier exchanges ride in the text. */
export function sideQuestionPrompt(question: string, earlier: readonly SideExchange[]): string {
  const before = earlier.length
    ? [
        'Earlier side questions and your answers, in this side panel:',
        ...earlier.flatMap((e) => [`Q: ${e.question}`, `A: ${e.answer}`]),
        '',
      ]
    : [];
  return [
    'Side question from the owner, asked in a side panel while the main conversation keeps working.',
    'Answer it briefly from the conversation so far, in the language of the question.',
    'This is a read-only copy: change no file and run no command.',
    '',
    ...before,
    `Side question: ${question}`,
  ].join('\n');
}

/**
 * The running fork's pid: `claude -p` still writes ~/.claude/sessions/<pid>.json (an interactive,
 * busy row in the Lead's folder) despite --no-session-persistence, and the live-session list skips
 * it so no stray agent joins the Lead's room. Never filtered on its entrypoint: that would hide
 * the user's own SDK sessions too.
 * ponytail: through cmd.exe (a Windows claude.cmd) or a shim that spawns instead of execs, this is
 * the wrapper's pid, not claude's: the fork shows up again, and sideCancel, a socket close and the
 * timeout stop only the wrapper while claude runs on. Resolve the .cmd to its node or exe entry, or
 * kill the tree (taskkill /T), if that matters; a claude.exe or the native binary is fine.
 */
let sidePid: number | undefined;
/** One side question in flight per daemon: RAM stays at the daemon, one queued probe and one fork. */
let sideBusy = false;
export const sideQuestionPid = (): number | undefined => sidePid;

export type SideResult = { ok: true; text: string } | { ok: false; why: Refused };

/**
 * T-140: why a fork failed, as the CLI said it, safe to show and log: the JSON answer's `result`
 * when it is an error (never its account fields), else the last non-empty stderr line; one line,
 * home folders as ~, anything token-like and e-mail addresses cut, at most SIDE_QUESTION_REASON_MAX.
 */
export function sideReason(json: unknown, stderr: string): string {
  const j = json && typeof json === 'object' ? (json as Record<string, unknown>) : null;
  const raw =
    j?.is_error === true && typeof j.result === 'string' && j.result.trim()
      ? j.result
      : (stderr
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .at(-1) ?? '');
  const home = os.homedir();
  let s = raw.replace(/\s+/g, ' ').trim();
  if (home.length > 1) s = s.split(home).join('~');
  s = s
    .replace(/(?:\/home|\/Users|[A-Za-z]:\\Users)[\\/][^\\/\s"']+/g, '~')
    .replace(/\b(Bearer|Basic)\s+\S+/gi, '$1 …')
    .replace(/\bsk-[\w-]+/g, '…')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '…')
    .replace(/[A-Za-z0-9_+=]{32,}/g, '…');
  return s.length > SIDE_QUESTION_REASON_MAX ? `${s.slice(0, SIDE_QUESTION_REASON_MAX - 1)}…` : s;
}

/** T-140: the card's refusal for a failed fork, one the owner can act on: log in again, wait for the limit, or the CLI's own words. */
export function sideFailure(reason: string): Refused {
  if (/\b401\b|\/login|authenticat|oauth|api key|not logged in/i.test(reason))
    return refused('side_login');
  if (
    /usage limit|rate limit|limit reached|(?:hit|reached) your (?:\w+ )?limit|\b429\b/i.test(reason)
  ) {
    // ponytail: only a written "resets <when>" is read; the old "limit reached|<epoch>" form gets no time.
    const reset = /\bresets?\s+(?:at\s+)?([^·∙|]+)/i
      .exec(reason)?.[1]
      .trim()
      .replace(/[.\s]+$/, '');
    return reset ? refused('side_limit_reset', { reset }) : refused('side_limit');
  }
  return reason ? refused('side_failed_reason', { reason }) : refused('side_failed');
}

export async function askSide(o: {
  claude: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  sessionId: string;
  model: string;
  question: string;
  earlier: readonly SideExchange[];
  timeoutMs?: number;
  spawnFn?: SpawnFn;
  /** Aborted: the fork is stopped and the result is side_failed (nobody waits for it). */
  signal?: AbortSignal;
}): Promise<SideResult> {
  const timeoutMs = o.timeoutMs ?? SIDE_QUESTION_TIMEOUT_MS;
  if (sideBusy) return { ok: false, why: refused('side_busy') };
  sideBusy = true;
  try {
    // Outside spawnJson's queue: the terminal attach list, the office poll and the probes must
    // not wait up to two minutes behind an answer.
    const json = (await spawnJson(o.claude, sideQuestionArgs(o.sessionId, o.model), {
      env: o.env,
      cwd: o.cwd,
      timeoutMs,
      stdin: sideQuestionPrompt(o.question, o.earlier),
      spawnFn: o.spawnFn,
      unqueued: true,
      signal: o.signal,
      onSpawn: (child) => (sidePid = child.pid),
    })) as Record<string, unknown> | null;
    // Only `result` is copied: the CLI's answer also carries account fields.
    const text = typeof json?.result === 'string' ? json.result.trim() : '';
    if (json?.is_error === true || !text) {
      const reason = sideReason(json, '');
      console.warn(`[agty] side question: an error answer${reason ? `: ${reason}` : ''}`);
      return { ok: false, why: sideFailure(reason) };
    }
    return { ok: true, text };
  } catch (err) {
    if (err instanceof SpawnJsonError && err.timedOut)
      return { ok: false, why: refused('side_timeout', { seconds: Math.round(timeoutMs / 1000) }) };
    if (o.signal?.aborted) return { ok: false, why: refused('side_failed') };
    // The message's own tail is stderr as it came (home paths and all): the log takes the cleaned reason instead.
    const reason = err instanceof SpawnJsonError ? sideReason(err.json, err.stderr) : '';
    const head =
      err instanceof SpawnJsonError
        ? err.message.replace(/:[\s\S]*$/, '')
        : String(err).slice(0, 300);
    console.warn(`[agty] side question: ${head}${reason ? `: ${reason}` : ''}`);
    return { ok: false, why: sideFailure(reason) };
  } finally {
    sidePid = undefined;
    sideBusy = false;
  }
}

/** A `sideAsk` as the schema allows it, or null. */
export function parseSideAsk(msg: Record<string, unknown>): SideAsk | null {
  const str = (v: unknown, max: number, min = 0): v is string =>
    typeof v === 'string' && v.length >= min && v.length <= max;
  const { requestId, agentId, question, model, earlier } = msg;
  if (
    !str(requestId, 100) ||
    !Number.isInteger(agentId) ||
    !str(question, 4000, 1) ||
    !str(model, 100)
  )
    return null;
  if (!question.trim() || !Array.isArray(earlier) || earlier.length > 10) return null;
  const pairs: SideExchange[] = [];
  for (const e of earlier as unknown[]) {
    const x = e as Record<string, unknown> | null;
    if (!x || typeof x !== 'object' || !str(x.question, 4000) || !str(x.answer, 20000)) return null;
    pairs.push({ question: x.question, answer: x.answer });
  }
  return {
    type: 'sideAsk',
    requestId,
    agentId: agentId as number,
    question,
    model,
    earlier: pairs,
  };
}
