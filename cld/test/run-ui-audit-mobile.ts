/**
 * UI-AUDIT-MOBILE: every page and sheet the phone shows, at 393x852 (iPhone 14/15), 375x667
 * (small iPhone) and 412x915 (Android), plus the key bar with the keyboard open and one landscape
 * pass. Each is screenshotted and audited in the page: horizontal overflow, an element outside the
 * viewport, an interactive element or a text under a safe-area inset, a label clipped by its
 * container, a button/tab label that wraps, a touch target under 44 px.
 *
 * dist/cli.js with --engine on --allow-chat --allow-terminal --no-terminal in an isolated HOME whose
 * `claude` is the engine fake, shells in a tmux server of this run's own, on a spare port.
 * Chromium --disable-gpu, office hours off in the page. Hangul is drawn with the app's bundled Galmuri11.
 *
 *   --before   survey only: print and save the findings, fail nothing (run on the old build)
 *   (default)  the same, then fail on any finding of the hard kinds (HARD below)
 *
 * Screenshots and `<stage>.json` (every finding) go to cld/artifacts/ui-audit-mobile/.
 *
 *   npx tsx cld/test/run-ui-audit-mobile.ts <port 18256-18259> [--before]
 */
import type {
  Browser,
  BrowserContext,
  BrowserContextOptions,
  Locator,
  Page,
} from '@playwright/test';
import { devices } from '@playwright/test';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { transcriptPath } from '../../server/src/cld/providers/claudeProvider.js';
import { findTmux, Tmux } from '../../server/src/cld/shell/tmux.js';
import {
  assertPortFree,
  daemonLoginUrl,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  REPO_ROOT,
  sparePort,
  startDaemon,
} from '../../server/src/cld/testHome.js';
import { configDirectory } from '../../server/src/cld/configPath.js';

const port = sparePort();
const BEFORE = process.argv.includes('--before');
const STAGE = BEFORE ? 'before' : 'after';
const OUT = path.join(REPO_ROOT, 'cld/artifacts/ui-audit-mobile');
/** Hangul comes from the app's own Galmuri11 (as on a phone); only the emoji need a font of this PC. */
const EMOJI_FONT = '/mnt/c/Windows/Fonts/seguiemj.ttf';
const FONT_CSS = `@font-face { font-family: 'FS Pixel Sans'; src: url('/__ua/emoji.ttf');
  unicode-range: U+2300-23FF, U+2600-27BF, U+FE0F, U+1F000-1FAFF; }`;
const DEADLINE_MS = 900_000;
const LEADS = ['alpha', 'beta'];
const TMUX_SOCKET = `cld-test-${randomBytes(6).toString('hex')}`;
const tmuxBin = findTmux();
/** Findings of these kinds fail the run (the owner's "no horizontal scroll, nothing under the notch"). */
const HARD = new Set(['overflow', 'outside', 'inset', 'clipped', 'wrap', 'target']);
/** Dev only: reuse a daemon a scratch script started (its info file), instead of starting one. */
const ATTACH = process.env.UA_ATTACH;

interface Size {
  name: string;
  w: number;
  h: number;
  /** Safe-area insets the page is given (an iPhone's notch and home indicator, as the app's vars carry them). */
  inset: { top: number; bottom: number };
  device: 'ios' | 'android';
}
const SIZES: Size[] = [
  { name: 'iphone393', w: 393, h: 852, inset: { top: 47, bottom: 34 }, device: 'ios' },
  { name: 'iphone375', w: 375, h: 667, inset: { top: 20, bottom: 0 }, device: 'ios' },
  { name: 'android412', w: 412, h: 915, inset: { top: 0, bottom: 0 }, device: 'android' },
];
const KEYBOARD_PX = 290;

function contextOptions(size: Size): BrowserContextOptions {
  if (size.device === 'ios') {
    const d = { ...devices['iPhone 13'] } as BrowserContextOptions & {
      defaultBrowserType?: string;
    };
    delete d.defaultBrowserType;
    return {
      ...d,
      viewport: { width: size.w, height: size.h },
      screen: { width: size.w, height: size.h },
    };
  }
  return {
    viewport: { width: size.w, height: size.h },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
    userAgent: devices['Pixel 5'].userAgent,
  };
}
/** The insets the page's own vars carry (set through the CSSOM: the page's CSP refuses inline style tags). */
const setInsets = (page: Page, i: { top: number; bottom: number; side?: number }) =>
  page.evaluate((v) => {
    const root = document.documentElement.style;
    root.setProperty('--cld-safe-top', `${v.top}px`);
    root.setProperty('--cld-safe-bottom', `${v.bottom}px`);
    root.setProperty('--cld-safe-left', `${v.side ?? 0}px`);
    root.setProperty('--cld-safe-right', `${v.side ?? 0}px`);
  }, i);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Finding {
  kind: string;
  what: string;
  detail: string;
}
interface PageReport {
  size: string;
  page: string;
  shot: string;
  findings: Finding[];
}
const reports: PageReport[] = [];
const stepErrors: string[] = [];

/** Everything the page can get wrong on a phone, found by measuring it (runs in the page). */
function auditInPage(arg: {
  insets: { top: number; bottom: number; left: number; right: number };
}): Finding[] {
  const { insets } = arg;
  const W = window.innerWidth;
  const H = window.innerHeight;
  const out: Finding[] = [];
  const seen = new Set<string>();
  const add = (kind: string, el: Element, detail: string) => {
    const cls = typeof el.className === 'string' ? el.className.split(/\s+/)[0] : '';
    const label =
      el.getAttribute('data-testid') ||
      el.getAttribute('aria-label') ||
      `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}`;
    const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 28);
    const key = `${kind}|${label}|${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, what: `${label}${text ? ` "${text}"` : ''}`, detail });
  };
  const shown = (el: Element, r: DOMRect) => {
    const s = getComputedStyle(el);
    return (
      s.visibility !== 'hidden' &&
      s.display !== 'none' &&
      Number(s.opacity) > 0 &&
      r.width > 0 &&
      r.height > 0
    );
  };
  /** The horizontal span of `el` that no clipping ancestor cuts away; null when none is left. */
  const clipSpan = (
    el: Element,
    r: DOMRect,
  ): { l: number; r: number; clippedBy: Element | null } | null => {
    let l = r.left;
    let rt = r.right;
    let clippedBy: Element | null = null;
    for (let p = el.parentElement; p; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (s.overflowX === 'visible') continue;
      const pr = p.getBoundingClientRect();
      // A scroller (auto/scroll) only hides what its reader can scroll to; hidden/clip cuts for good.
      if ((pr.left > l || pr.right < rt) && s.overflowX !== 'auto' && s.overflowX !== 'scroll')
        clippedBy = clippedBy ?? p;
      l = Math.max(l, pr.left);
      rt = Math.min(rt, pr.right);
      if (rt <= l) return null;
    }
    return { l, r: rt, clippedBy };
  };
  const vOk = (r: DOMRect) => r.bottom > 0 && r.top < H;
  /** The vertical span of `el` left after the clipping ancestors (a scrolled-out row is not under the notch). */
  const clipRows = (el: Element, r: DOMRect): { t: number; b: number } => {
    let t = r.top;
    let b = r.bottom;
    for (let p = el.parentElement; p; p = p.parentElement) {
      if (getComputedStyle(p).overflowY === 'visible') continue;
      const pr = p.getBoundingClientRect();
      t = Math.max(t, pr.top);
      b = Math.min(b, pr.bottom);
    }
    return { t, b: Math.max(t, b) };
  };
  const interactive =
    'button, a[href], input, textarea, select, [role="button"], [role="tab"], summary';
  const reach = (el: Element) => {
    const r = el.getBoundingClientRect();
    const hit = (x: number, y: number) => {
      const t = document.elementFromPoint(x, y);
      return (
        t !== null &&
        (t === el ||
          el.contains(t) ||
          t.closest(interactive) === el ||
          (t.closest('label')?.contains(el) ?? false))
      );
    };
    const run = (dx: number, dy: number) => {
      let n = 0;
      while (n < 60 && hit(r.x + r.width / 2 + dx * (n + 1), r.y + r.height / 2 + dy * (n + 1)))
        n++;
      return n;
    };
    return { w: run(-1, 0) + run(1, 0) + 1, h: run(0, -1) + run(0, 1) + 1 };
  };

  if (document.documentElement.scrollWidth > W + 1 || document.body.scrollWidth > W + 1)
    out.push({
      kind: 'overflow',
      what: 'document',
      detail: `scrollWidth ${document.documentElement.scrollWidth} > ${W}`,
    });

  for (const el of document.body.querySelectorAll('*')) {
    if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') continue;
    const r = el.getBoundingClientRect();
    if (!shown(el, r) || !vOk(r)) continue;
    const span = clipSpan(el, r);
    if (!span) continue;
    // Something lying over it (a dialog, another page) hides it: not on screen for the owner.
    const cx = Math.min(Math.max((span.l + span.r) / 2, 0), W - 1);
    const cy = Math.min(Math.max((Math.max(r.top, 0) + Math.min(r.bottom, H)) / 2, 0), H - 1);
    const top = document.elementFromPoint(cx, cy);
    if (!top || !(top === el || el.contains(top) || top.contains(el))) continue;
    const s = getComputedStyle(el);
    if (s.animationName !== 'none' && el.closest('[class*="ticker"]')) continue; // the news ticker scrolls on purpose
    const isLeafText =
      [...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? '').trim() !== '') &&
      el.tagName !== 'SCRIPT';
    const isControl = el.matches(interactive);

    // Outside the viewport: what is left after the clipping ancestors still lies outside.
    if (span.r > W + 1 || span.l < -1)
      add('outside', el, `x ${Math.round(span.l)}..${Math.round(span.r)} of ${W}`);

    // A label cut by the box that holds it (a clipped label, not a scroller and not an ellipsis).
    if (
      isLeafText &&
      span.clippedBy &&
      (r.right > span.r + 1.5 || r.left < span.l - 1.5) &&
      s.textOverflow !== 'ellipsis'
    )
      add(
        'clipped',
        el,
        `cut by ${span.clippedBy.getAttribute('data-testid') ?? span.clippedBy.tagName.toLowerCase()}: x ${Math.round(r.left)}..${Math.round(r.right)} in ${Math.round(span.l)}..${Math.round(span.r)}`,
      );
    if (
      isLeafText &&
      s.overflowX !== 'visible' &&
      s.overflowX !== 'auto' &&
      s.overflowX !== 'scroll' &&
      s.textOverflow !== 'ellipsis' &&
      el.scrollWidth > el.clientWidth + 1 &&
      el.clientWidth > 0
    )
      add('clipped', el, `own text ${el.scrollWidth} px in ${el.clientWidth}`);

    // Under a safe-area inset: something to read or press where the notch, the home indicator or the side cuts in.
    if ((isLeafText || isControl) && s.pointerEvents !== 'none') {
      const rows = clipRows(el, r);
      const inTop = insets.top > 0 && rows.t < insets.top - 1 && rows.b > rows.t + 1 && rows.b > 1;
      let scrolled = false;
      for (let p = el.parentElement; p && !scrolled; p = p.parentElement) {
        const ps = getComputedStyle(p);
        scrolled =
          (ps.overflowY === 'auto' || ps.overflowY === 'scroll') &&
          p.scrollHeight > p.clientHeight + 1;
      }
      const inBottom =
        !scrolled && insets.bottom > 0 && rows.b > H - insets.bottom + 1 && rows.t < H - 1;
      const inLeft = insets.left > 0 && span.l < insets.left - 1;
      const inRight = insets.right > 0 && span.r > W - insets.right + 1;
      if (inTop || inBottom || inLeft || inRight)
        add(
          'inset',
          el,
          `${inTop ? 'top ' : ''}${inBottom ? 'bottom ' : ''}${inLeft ? 'left ' : ''}${inRight ? 'right ' : ''}y ${Math.round(r.top)}..${Math.round(r.bottom)} x ${Math.round(span.l)}..${Math.round(span.r)}`,
        );
    }

    // A scroller that reaches into the bottom inset: its last row must be able to scroll clear of it.
    if (
      insets.bottom > 0 &&
      (s.overflowY === 'auto' || s.overflowY === 'scroll') &&
      el.scrollHeight > el.clientHeight + 1 &&
      r.bottom > H - insets.bottom + 1 &&
      r.height > 40
    ) {
      const pad = parseFloat(s.paddingBottom) || 0;
      if (pad < insets.bottom - 1)
        add(
          'inset',
          el,
          `scroller ends at ${Math.round(r.bottom)} of ${H} with ${pad} px padding under the ${insets.bottom} px inset`,
        );
    }

    // A control's label on two lines.
    if (el.matches('button, [role="tab"], th, summary, label') && r.width > 2 && r.height > 2) {
      for (const node of el.childNodes) {
        const text = (node.textContent ?? '').trim();
        if (node.nodeType !== 3 || text.length === 0 || text.length > 40) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const tops = new Set(
          [...range.getClientRects()].filter((q) => q.width > 0).map((q) => Math.round(q.top / 3)),
        );
        if (tops.size > 1) add('wrap', el, `${tops.size} lines in ${Math.round(r.width)} px`);
      }
    }

    // A tap target under 44 px (what answers the finger; a strip marked data-touch-compact is small on purpose).
    if (
      isControl &&
      !el.closest('[data-touch-compact]') &&
      (r.width < 44 || r.height < 44) &&
      r.top >= 0 &&
      r.bottom <= H &&
      s.pointerEvents !== 'none'
    ) {
      if (el.matches('textarea') && (r.width < 4 || r.height < 4)) continue;
      // A control cut by its scroller (a longer tab: the last row half below the fold) is measured when
      // scrolled into view, not as the clip leaves it: only a whole visible control is judged here.
      // (A checkbox answers through its label: that box is what the scroller cuts.)
      const hit = el.closest('label')?.getBoundingClientRect() ?? r;
      let clipped = false;
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        const oy = getComputedStyle(p).overflowY;
        if (oy !== 'auto' && oy !== 'scroll') continue;
        const pr = p.getBoundingClientRect();
        if (hit.top < pr.top - 0.5 || hit.bottom > pr.bottom + 0.5) clipped = true;
      }
      if (clipped) continue;
      const a = reach(el);
      if (a.w < 44 || a.h < 44) add('target', el, `${a.w}x${a.h} px`);
    }
  }
  return out;
}

async function main() {
  await assertPortFree(...(ATTACH ? [] : [port]));
  if (!tmuxBin)
    throw new Error('this check needs tmux (the terminal workspace lists shells in it)');
  fs.mkdirSync(OUT, { recursive: true });
  // This stage's earlier shots go (the numbering moves when a page is added or dropped).
  for (const f of fs.readdirSync(OUT))
    if (f.startsWith(`${STAGE}-`)) fs.unlinkSync(path.join(OUT, f));
  const attached = ATTACH
    ? (JSON.parse(fs.readFileSync(ATTACH, 'utf-8')) as { home: string; pid: number; port: number })
    : null;
  const made = attached ? null : makeEngineHome();
  const home = attached ? attached.home : made!.home;
  const testTmux = new Tmux(tmuxBin, TMUX_SOCKET);
  const sessions = path.join(home, '.claude/sessions');
  let daemon: ReturnType<typeof startDaemon> | null = null;
  if (!attached) {
    // The spare port in the temp HOME's own config: nothing can fall back to the live 18240.
    fs.writeFileSync(
      path.join(configDirectory(home), 'config.json'),
      JSON.stringify({ accessChosen: true, port }),
    );
    // Two floors, so the phone's floor picker shows in its top bar.
    fs.writeFileSync(
      path.join(configDirectory(home), 'building.json'),
      JSON.stringify({
        version: 1,
        floors: [
          { id: '1', name: '로비', rooms: [], characters: [] },
          { id: '2', name: '연구동', rooms: [], characters: [] },
        ],
        perProject: false,
      }),
    );
    fs.mkdirSync(sessions, { recursive: true });
    const folders = Object.fromEntries(
      [...LEADS, 'gamma'].map((n) => [n, path.join(home, 'work', n)]),
    );
    for (const f of Object.values(folders)) fs.mkdirSync(f, { recursive: true });
    fs.writeFileSync(
      path.join(configDirectory(home), 'projects.json'),
      JSON.stringify([
        ...LEADS.map((name) => ({
          name,
          folder: folders[name],
          room: '개발실',
          wantRunning: true,
        })),
        // Stopped: its card opens the off-duty sheet; a long room name for the messenger's list.
        {
          name: 'gamma',
          folder: folders.gamma,
          room: '긴이름을가진아주긴방이름테스트실',
          wantRunning: false,
        },
      ]),
    );
    daemon = startDaemon(
      { home, claudePath: path.join(made!.bin, 'claude') },
      port,
      ['--engine', 'on', '--allow-chat', '--allow-terminal', '--no-terminal'],
      { FAKE_TURN_MS: '600', SHELL: '/bin/sh', CLD_GUI_SHELL_TMUX_SOCKET: TMUX_SOCKET },
    );
  }
  const server = daemon?.child;
  const cleanup = () => {
    if (attached) return;
    killFakeSessions(home);
    testTmux.killServer();
    fs.rmSync(home, { recursive: true, force: true });
  };
  const abort = (why: string) => {
    console.error(`aborted: ${why}`);
    if (server && server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
    cleanup();
    process.exit(1);
  };
  const deadline = setTimeout(() => abort(`deadline ${DEADLINE_MS / 1000} s`), DEADLINE_MS);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(sig, () => abort(sig));

  type Sess = { pid: number; sessionId: string; cwd: string; name: string; jobId: string };
  const sessionOf = (name: string): Sess | null => {
    for (const f of fs.existsSync(sessions) ? fs.readdirSync(sessions) : []) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(sessions, f), 'utf-8')) as Sess;
        if (s.name === name) return s;
      } catch {
        /* being written */
      }
    }
    return null;
  };
  let uuid = 0;
  const rec = (name: string, record: Record<string, unknown>) => {
    const s = sessionOf(name)!;
    const file = transcriptPath(s.cwd, s.sessionId, home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(
      file,
      `${JSON.stringify({
        uuid: `${(++uuid).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`,
        timestamp: new Date().toISOString(),
        ...record,
      })}\n`,
    );
  };
  const say = (name: string, role: 'user' | 'assistant', text: string) =>
    rec(
      name,
      role === 'user'
        ? { type: 'user', message: { role, content: text } }
        : { type: 'assistant', message: { role, content: [{ type: 'text', text }] } },
    );
  const call = (id: string, tool: string, input: Record<string, unknown>) => ({
    type: 'tool_use',
    id,
    name: tool,
    input,
  });
  /** The lead opens a Bash call and Claude Code asks about it (the fake's dialog shows the same words). */
  const ask = (toolId: string, description: string, command: string) => {
    rec('alpha', {
      type: 'assistant',
      message: { role: 'assistant', content: [call(toolId, 'Bash', { command, description })] },
    });
    fs.writeFileSync(
      path.join(home, `fake-perm-${sessionOf('alpha')!.jobId}`),
      JSON.stringify({ title: 'Bash command', desc: description, command }),
    );
  };
  const answered = (toolId: string) =>
    rec('alpha', {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: toolId, content: 'ok' }],
      },
    });

  let browser: Browser | undefined;
  try {
    const font = fs.readFileSync(EMOJI_FONT);
    const url = attached
      ? await daemonLoginUrl(home, attached.port, attached.pid)
      : await daemon!.loginUrl();
    const base = attached ? `http://127.0.0.1:${attached.port}/` : `http://127.0.0.1:${port}/`;
    for (const end = Date.now() + 40_000; LEADS.some((n) => !sessionOf(n));) {
      if (Date.now() > end) throw new Error('the engine did not revive the sessions');
      await sleep(300);
    }
    // Conversations long enough to scroll, with a long line, a code block and a wide table.
    for (const n of LEADS) {
      for (let i = 1; i <= 24; i++)
        say(n, i % 2 ? 'user' : 'assistant', `${n} ${i}번째 메시지: 오늘 할 일 정리`);
    }
    say(
      'alpha',
      'assistant',
      [
        '긴 한 줄: ' + 'abcdefghij'.repeat(14),
        '',
        '```ts',
        'const veryLongName = someFunction(argumentNumberOne, argumentNumberTwo, argumentNumberThree);',
        '```',
        '',
        '| 항목 | 값 | 설명 |',
        '| --- | --- | --- |',
        '| 이름이 아주 긴 항목입니다 | 1234567890123 | 설명도 꽤 길어서 한 줄에 안 들어갑니다 |',
      ].join('\n'),
    );
    // A sub-agent inside alpha's turn (a temp), for the work view.
    rec('alpha', {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          call('tu-dig', 'Agent', { description: '로그 조사', prompt: '로그를 조사해 주세요.' }),
        ],
      },
    });
    rec('alpha', {
      type: 'progress',
      parentToolUseID: 'tu-dig',
      data: {
        type: 'agent_progress',
        message: {
          type: 'assistant',
          message: {
            model: 'claude-opus-4-5',
            content: [{ type: 'text', text: '원인은 **캐시 만료**예요.' }],
          },
        },
      },
    });
    await sleep(4_000);

    browser = await launchBrowser();
    const audit = async (
      page: Page,
      size: Size,
      label: string,
      insets: { top: number; bottom: number; left: number; right: number },
    ) => {
      await page.waitForTimeout(500);
      const n = String(reports.filter((r) => r.size === size.name).length + 1).padStart(2, '0');
      const shot = `${STAGE}-${size.name}-${n}-${label}.png`;
      await page.screenshot({ path: path.join(OUT, shot) });
      const findings = await page.evaluate(auditInPage, { insets });
      reports.push({ size: size.name, page: label, shot, findings });
      console.log(`${size.name} ${n} ${label}: ${findings.length ? '' : 'clean'}`);
      for (const f of findings) console.log(`    [${f.kind}] ${f.what} (${f.detail})`);
    };
    const step = async (size: Size, label: string, fn: () => Promise<void>) => {
      try {
        await fn();
      } catch (err) {
        const msg = `${size.name} ${label}: ${String(err).split('\n')[0]}`;
        console.log(`  STEP FAILED ${msg}`);
        stepErrors.push(msg);
      }
    };

    let login: Awaited<ReturnType<BrowserContext['storageState']>> | null = null;
    for (const size of SIZES.filter(
      (z) => !process.env.UA_SIZES || process.env.UA_SIZES.split(',').includes(z.name),
    )) {
      const ctx: BrowserContext = await browser.newContext({
        ...contextOptions(size),
        ...(login ? { storageState: login } : {}),
      });
      await ctx.route('**/__ua/emoji.ttf', (route) =>
        route.fulfill({ body: font, contentType: 'font/ttf' }),
      );
      await ctx.addInitScript('window.__name = (f) => f');
      const page = await ctx.newPage();
      const portrait = { top: size.inset.top, bottom: size.inset.bottom, left: 0, right: 0 };
      await page.goto(login ? base : url);
      if (!login) {
        await page.waitForURL(base);
        login = await ctx.storageState();
      }
      await page.addStyleTag({ content: FONT_CSS });
      await setInsets(page, size.inset);
      await page.evaluate(() => document.fonts.load("16px 'FS Pixel Sans'", '📝'));
      await page.locator('[data-testid="agent-overlay"]').first().waitFor();
      await page.waitForTimeout(1_500);
      const reload = async () => {
        await page.reload();
        await page.addStyleTag({ content: FONT_CSS });
        await setInsets(page, size.inset);
        await page.locator('[data-testid="agent-overlay"]').first().waitFor();
        await page.waitForTimeout(2_500);
      };
      const A = (label: string) => audit(page, size, label, portrait);
      const dock = (screen: string) => page.locator(`[data-dock="${screen}"]`);
      const tapDock = (screen: string) => dock(screen).tap();
      const closeDialogs = async () => {
        for (let i = 0; i < 4; i++) {
          const xs = page.getByRole('button', { name: 'x', exact: true });
          if (!(await xs.count())) break;
          await xs.last().tap();
          await page.waitForTimeout(250);
        }
      };
      /** Each tab of the shown page (its nav buttons or role=tab), selecting it and auditing it. */
      const eachTab = async (scope: Locator, prefix: string) => {
        const tabs = scope.locator('[role="tab"], nav button');
        const names = (await tabs.allTextContents()).map((s) => s.trim()).filter(Boolean);
        for (const name of names) {
          await scope
            .locator('[role="tab"], nav button')
            .filter({ hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) })
            .first()
            .tap();
          await A(`${prefix}-${name}`);
        }
      };

      await step(size, 'office', async () => {
        await A('office');
        await page.getByTestId('cards-toggle').tap();
        await A('office-cards-expanded');
        await page.getByTestId('cards-toggle').tap();
        await page.locator('[data-testid="agent-card"]').first().tap();
        await A('office-card-selected');
      });
      await step(size, 'board', async () => {
        await tapDock('board');
        await page.locator('[aria-label="현황판 화면"]').waitFor();
        await A('board-status');
        await eachTab(page.getByRole('navigation', { name: '작업 메뉴' }), 'board');
      });
      await step(size, 'workbench', async () => {
        await tapDock('workbench');
        const wb = page.locator('[aria-label="작업실 화면"]');
        await wb.waitFor();
        await A('workbench');
        await eachTab(wb, 'workbench');
      });
      await step(size, 'files', async () => {
        await tapDock('files');
        await page.locator('[aria-label="파일 화면"]').waitFor();
        await page.waitForTimeout(800);
        await A('files');
      });
      await step(size, 'notices', async () => {
        await tapDock('notices');
        await page.locator('[aria-label="알림 화면"]').waitFor();
        await A('notices');
      });

      // Messenger: list, a DM, a room.
      const pm = page.getByRole('region', { name: '메신저', exact: true });
      /** The messenger on `name`'s conversation, from wherever it was left (list, another conversation). */
      const openDm = async (name: string) => {
        await tapDock('messenger');
        const list = pm.getByRole('list', { name: '연락처' });
        if (!(await list.isVisible())) await pm.getByRole('button', { name: /목록/ }).first().tap();
        await list.getByRole('button', { name: new RegExp(`^${name}`) }).tap();
        await pm.getByRole('region', { name: `${name} 대화` }).waitFor();
      };
      await step(size, 'messenger-list', async () => {
        await tapDock('messenger');
        await pm.getByRole('list', { name: '연락처' }).waitFor();
        await A('messenger-list');
      });
      await step(size, 'messenger-dm', async () => {
        await pm
          .getByRole('list', { name: '연락처' })
          .getByRole('button', { name: /^alpha/ })
          .tap();
        await pm
          .getByRole('region', { name: 'alpha 대화' })
          .getByText('오늘 할 일 정리')
          .first()
          .waitFor();
        await A('messenger-dm');
        const box = pm.getByRole('textbox', { name: '보낼 글' });
        await box.fill('길게 쓰는 중인 글 '.repeat(12));
        await A('messenger-dm-long-draft');
        await box.fill('');
      });
      await step(size, 'messenger-room', async () => {
        await tapDock('messenger'); // the shown tab takes it back to its list
        await pm.getByRole('list', { name: '연락처' }).waitFor();
        await pm.locator('button', { hasText: '전체' }).first().tap();
        await page.waitForTimeout(800);
        await A('messenger-room');
      });
      await step(size, 'terminal', async () => {
        await openDm('alpha');
        await pm
          .getByRole('region', { name: 'alpha 대화' })
          .getByRole('button', { name: '터미널로 보기' })
          .tap();
        await page.waitForFunction(
          () =>
            [...document.querySelectorAll<HTMLElement>('.xterm-rows')].some(
              (el) => el.offsetParent !== null && el.innerText.includes('fake Claude Code'),
            ),
          undefined,
          { timeout: 15_000 },
        );
        await A('terminal');
      });
      await step(size, 'key-bar', async () => {
        await page.locator('.xterm-screen').first().tap();
        await page.setViewportSize({ width: size.w, height: size.h - KEYBOARD_PX });
        await page.getByRole('button', { name: 'Esc 키', exact: true }).waitFor();
        // The keyboard covers the home indicator: no bottom inset while it is up.
        await audit(page, size, 'terminal-keyboard', { ...portrait, bottom: 0 });
        await page.setViewportSize({ width: size.w, height: size.h });
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await page.waitForTimeout(500);
      });
      await step(size, 'messenger-keyboard', async () => {
        await openDm('alpha');
        await pm.getByRole('textbox', { name: '보낼 글' }).tap();
        await page.setViewportSize({ width: size.w, height: size.h - KEYBOARD_PX });
        await page.waitForTimeout(600);
        await audit(page, size, 'messenger-keyboard', { ...portrait, bottom: 0 });
        await page.setViewportSize({ width: size.w, height: size.h });
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await page.waitForTimeout(500);
      });

      // 설정: the quick row, each tab, 보안, 기기 추가, 범례.
      await step(size, 'settings', async () => {
        await tapDock('office');
        const gear = page.getByTestId('mobile-top-bar').getByRole('button', { name: '설정' });
        await gear.tap();
        await page.getByTestId('settings-quick').waitFor();
        await A('settings-quick');
        const tabs = page.getByTestId('settings-tabs').getByRole('tab');
        for (const name of (await tabs.allTextContents()).map((s) => s.trim())) {
          await page.getByTestId('settings-tabs').getByRole('tab', { name, exact: true }).tap();
          await A(`settings-${name}`);
        }
        for (const [name, label] of [
          ['보안', 'security'],
          ['기기 추가', 'add-device'],
          ['범례', 'legend'],
        ] as const) {
          await page.getByTestId('settings-quick').getByRole('button', { name, exact: true }).tap();
          await page.waitForTimeout(label === 'security' ? 1_500 : 600);
          await A(label);
          await closeDialogs();
          await closeDialogs();
          await gear.tap();
          await page.getByTestId('settings-quick').waitFor();
        }
        await closeDialogs();
      });

      await step(size, 'work-view', async () => {
        await tapDock('office');
        await page.getByTestId('cards-toggle').tap();
        await page.locator('[data-testid="temp-chip"]').first().tap();
        await page.locator('[data-testid="temp-list"]').waitFor();
        await A('temp-list');
        await page.locator('[data-testid="work-open"]').first().tap();
        await page.getByTestId('work-sheet').waitFor();
        await A('work-view');
        await page.getByTestId('work-close').tap();
        await page.getByTestId('cards-toggle').tap();
      });
      await step(size, 'permission', async () => {
        rec('alpha', { type: 'permission-mode', permissionMode: 'bypassPermissions' });
        ask(
          `toolu_perm_${size.name}`,
          'Remove the old build output and caches for every package',
          'rm -rf "${OUT:?}"/build "${OUT:?}"/.cache',
        );
        await openDm('alpha');
        const card = pm.getByRole('region', { name: 'alpha 대화' }).getByTestId('permission-card');
        await card.waitFor({ timeout: 40_000 });
        await A('permission-card');
        await card.getByRole('button', { name: '허용' }).tap();
        await card.waitFor({ state: 'detached', timeout: 20_000 });
        answered(`toolu_perm_${size.name}`);
        await tapDock('office');
      });

      await step(size, 'off-duty', async () => {
        // After hours the office sends everyone home: a card then opens the off-duty sheet.
        await tapDock('office');
        await page.evaluate(() => localStorage.setItem('cld.office-hours', '{"on":true}'));
        await reload();
        await page.locator('[data-testid="agent-card"]').filter({ hasText: 'gamma' }).first().tap();
        await page.getByTestId('off-duty-sheet').waitFor();
        await A('off-duty-sheet');
        await page
          .getByTestId('off-duty-sheet')
          .getByRole('button')
          .filter({ hasText: /꾸미기|모습/ })
          .first()
          .tap();
        await page.waitForTimeout(800);
        await A('looks');
        await tapDock('office');
        await page.evaluate(() => localStorage.setItem('cld.office-hours', '{"on":false}'));
        await reload();
      });
      // Landscape once (the notch on the side), on the first size.
      if (size === SIZES[0]) {
        await step(size, 'landscape', async () => {
          await page.setViewportSize({ width: size.h, height: size.w });
          await setInsets(page, { top: 0, bottom: 21, side: 47 });
          const land = { top: 0, bottom: 21, left: 47, right: 47 };
          await page.waitForTimeout(800);
          await audit(page, size, 'landscape-office', land);
          for (const [screen, label] of [
            ['board', 'landscape-board'],
            ['workbench', 'landscape-workbench'],
            ['messenger', 'landscape-messenger'],
          ] as const) {
            await tapDock(screen);
            await audit(page, size, label, land);
          }
          await page.setViewportSize({ width: size.w, height: size.h });
          await setInsets(page, size.inset);
        });
      }
      await ctx.close();
    }
  } finally {
    await browser?.close();
    if (daemon) await daemon.stop();
    clearTimeout(deadline);
    cleanup();
  }

  fs.writeFileSync(
    path.join(OUT, `${STAGE}.json`),
    JSON.stringify({ reports, stepErrors }, null, 1),
  );
  const counts: Record<string, number> = {};
  for (const r of reports) for (const f of r.findings) counts[f.kind] = (counts[f.kind] ?? 0) + 1;
  console.log(
    `${reports.length} pages audited; findings by kind: ${JSON.stringify(counts)}; steps failed: ${stepErrors.length}`,
  );
  if (BEFORE) return;
  const hard = reports.flatMap((r) =>
    r.findings
      .filter((f) => HARD.has(f.kind))
      .map((f) => `${r.size} ${r.page}: [${f.kind}] ${f.what} (${f.detail})`),
  );
  if (hard.length || stepErrors.length) {
    for (const h of [...hard, ...stepErrors]) console.error(`FAIL ${h}`);
    throw new Error(`${hard.length} findings and ${stepErrors.length} failed steps`);
  }
  console.log('all pages clean');
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
