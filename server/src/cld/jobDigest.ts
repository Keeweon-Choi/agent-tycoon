/** Log presentation; rules live beside the command-name rules. */
import { koText } from '../../../core/src/cld/serverText.js';
// @ts-expect-error esbuild bundles this JSON into the server.
import data from './jobRules.json';
import { maskText } from './mask.js';

interface StepRule {
  name: string;
  start?: string;
  done?: string;
  fail?: string;
}
interface DigestRule {
  command: string;
  steps?: StepRule[];
  dynamic?: string;
}
export interface DigestStep {
  name: string;
  state: 'done' | 'running' | 'failed' | 'waiting';
}
export interface JobDigest {
  steps: DigestStep[];
  lines: Array<{ text: string; error: boolean }>;
}

/** The raw view uses this too: no login URL or eight-character login code reaches a screen. */
export function maskJobLog(raw: string): string {
  return maskText(raw)
    .replace(/(\/login\?[^\s]*?\bcode=)[^&#\s]+/gi, '$1***')
    .replace(/(\bcode=)[^&#\s]+/gi, '$1***')
    .replace(/(^|\n)(\s*(?:로그인|인증|기기)?\s*코드\s*[:：]\s*)[A-Z0-9]{8}(?=\s|$)/gim, '$1$2***');
}

const cleanLines = (raw: string) =>
  maskJobLog(raw)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .split(/\r|\n/)
    .map((s) => s.trim())
    .filter((s) => s && !/^(?:npm warn|npm notice|\d+%\|)/i.test(s));

function dynamicSteps(kind: string, lines: string[]): DigestStep[] {
  const steps: DigestStep[] = [];
  for (const line of lines) {
    const m =
      kind === 'gate'
        ? /^==\s*(.+?)(?:\s*==)?$/.exec(line)
        : /^run-all:\s*(run-[\w-]+)\s+(PASS|FAIL)\b/.exec(line);
    if (kind === 'gate' && m) steps.push({ name: m[1], state: 'running' });
    if (kind === 'run-all' && m)
      steps.push({
        name: koText('jobname_browser', { name: m[1].replace(/^run-/, '') }),
        state: m[2] === 'PASS' ? 'done' : 'failed',
      });
    if (kind === 'gate' && /^(PASS|FAIL)\b/.test(line) && steps.length)
      steps.at(-1)!.state = line.startsWith('PASS') ? 'done' : 'failed';
  }
  return steps;
}

export function digestJobLog(cmd: string, raw: string): JobDigest {
  const lines = cleanLines(raw);
  const rule = (data.digests as DigestRule[]).find((r) => new RegExp(r.command, 'i').test(cmd));
  const steps = rule?.dynamic
    ? dynamicSteps(rule.dynamic, lines)
    : (rule?.steps ?? []).map((s) => {
        const has = (p?: string) => !!p && lines.some((line) => new RegExp(p, 'i').test(line));
        return {
          name: s.name,
          state: has(s.fail)
            ? 'failed'
            : has(s.done)
              ? 'done'
              : has(s.start)
                ? 'running'
                : 'waiting',
        } as DigestStep;
      });
  let lastReached = -1;
  for (let i = 0; i < steps.length; i++) if (steps[i].state !== 'waiting') lastReached = i;
  for (let i = 0; i < lastReached; i++) if (steps[i].state === 'running') steps[i].state = 'done';
  const meaningful = lines.filter(
    (line) => !/^DRY-RUN|^\[작업 종료|^Node \d|^npm \w+ ✔/.test(line),
  );
  return {
    steps,
    lines: meaningful.slice(-8).map((line) => ({
      text: line,
      error: /(?:^|\b)(?:ERROR|FAIL(?:ED)?|실패|오류)(?:\b|:)/i.test(line),
    })),
  };
}
