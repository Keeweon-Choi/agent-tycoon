/**
 * FIX-MESSENGER-HEADER-OVERLAP (owner 11-06 17:18 and 17:29): three layout checks of the messenger, on the REAL API
 * (dist/cli.js --engine on --allow-chat in a temp HOME whose `claude` is the engine fake, headless Chromium,
 * --disable-gpu). Four leads, each with a transcript turn that carries token usage (so the head has its 피로도 row)
 * and a long message from each side; one lead has a long name; unread notices are seeded into the browser.
 *
 *  1. the head of every conversation pane: its text (name, state, 피로도) stays inside its box, and the box never
 *     overlaps the buttons (1150x700 in 2 panes; 1440x1000 in 1 pane and 2x2; a narrow 1024x640).
 *  2. 열기 / 읽음 buttons of the 알림 panel (opened in every scene): none is half drawn (cut by a clipping ancestor
 *     or off the page) and none is covered. A card scrolled wholly out of the list is not drawn at all, which is fine.
 *  3. the conversation's band (BAND scenes: 1440x1000 1 pane, 1150x700 2 panes, a 390x844 phone): a full-width
 *     box of the owner and one of the lead have the same left and right edges (±1 px), the margins left and right of
 *     the band are equal, each face sits in its own margin column on the top of its name line, and a command line
 *     starts on the lead's box edge.
 *
 * MSGHEAD_PHASE=before|after names the photos (cld/artifacts/fix-messenger-header-overlap/): the full scene and a 2x crop
 * of each head and of the band. "before" only records, "after" also asserts.
 *
 *  4. (owner 11-06 18:31) every message's 복사 / 답글 sit under its bubble, none in a name line: for each line of
 *     the conversation (a reply quote, attachments and folded / open long messages included; a phone has no hover row)
 *     the actions group starts below the bubble's bottom, on the bubble's own side, and no .dlg-plate holds a button.
 *
 *   npx tsx cld/test/run-messenger-header-overlap.ts <port 18920-18929 or 19010-19019>
 */
import type { Browser, BrowserContext, BrowserContextOptions, Page } from '@playwright/test';
import { devices } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import { configDirectory } from '../../server/src/cld/configPath.js';
import { transcriptPath } from '../../server/src/cld/providers/claudeProvider.js';
import {
  assertPortFree,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  REPO_ROOT,
  startDaemon,
} from '../../server/src/cld/testHome.js';

const port = Number(process.argv[2]);
if (!((port >= 18920 && port <= 18929) || (port >= 19010 && port <= 19019))) throw new Error('port must be 18920-18929 or 19010-19019');
/** MSGHEAD_STYLE=pixel|modern (default modern) and MSGHEAD_SCALE=small|medium|large (default medium): the screen style and size step. */
const STYLE = process.env.MSGHEAD_STYLE === 'pixel' ? 'pixel' : 'modern';
const SCALE = ['small', 'large'].includes(process.env.MSGHEAD_SCALE ?? '') ? process.env.MSGHEAD_SCALE : 'medium';
const PHASE = process.env.MSGHEAD_PHASE === 'before' ? 'before' : 'after';
const OUT = path.join(REPO_ROOT, 'cld/artifacts/fix-messenger-actions-below');
const DEADLINE_MS = 300_000;
const LEADS = ['cld-gui', 'pofol', 'keeweon-portfolio-site-redesign', 'echo'];
const LONG = '긴 이야기를 이어서 적어요 하나 둘 셋 넷 다섯 여섯 일곱 여덟. '.repeat(14);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SAFE_AREA = ':root { --cld-safe-top: 47px !important; --cld-safe-bottom: 34px !important; }';
const IPHONE: BrowserContextOptions = (() => {
  const d = { ...devices['iPhone 13'] } as BrowserContextOptions & { defaultBrowserType?: string };
  delete d.defaultBrowserType;
  return d;
})();

interface Scene {
  name: string;
  w: number;
  h: number;
  layout: 1 | 2 | 4;
  /** The messenger window on the room (the owner's own had 1152 x 665 at 385, 160). */
  place: { dx: number; dy: number; w: number; h: number };
  phone?: true;
}
const SCENES: Scene[] = [
  { name: 'owner-2pane', w: 1920, h: 1040, layout: 2, place: { dx: 385, dy: 160, w: 1152, h: 665 } },
  { name: '1150x700-2pane', w: 1150, h: 700, layout: 2, place: { dx: 8, dy: 8, w: 1060, h: 600 } },
  { name: '1440x1000-1pane', w: 1440, h: 1000, layout: 1, place: { dx: 20, dy: 20, w: 1280, h: 900 } },
  { name: '1440x1000-2x2', w: 1440, h: 1000, layout: 4, place: { dx: 20, dy: 20, w: 1280, h: 900 } },
  { name: '1024x640-1pane', w: 1024, h: 640, layout: 1, place: { dx: 8, dy: 8, w: 900, h: 560 } },
  { name: 'phone-390x844', w: 390, h: 844, layout: 1, place: { dx: 0, dy: 0, w: 0, h: 0 }, phone: true },
];
/** The scenes whose conversation band is measured (the lead `cld-gui` has the long messages of both sides). */
const BAND = new Set(['1440x1000-1pane', '1150x700-2pane', 'phone-390x844']);

function seedNotices(): unknown[] {
  const now = Date.now();
  const min = 60_000;
  const n = (i: number, cause: string, name: string, text: string, ago: number, read: boolean, target?: unknown) => ({
    id: `mh-${i}`,
    cause,
    agentId: null,
    name,
    text,
    at: now - ago * min,
    read,
    ...(target ? { target } : {}),
  });
  return [
    n(1, 'turnEnd', 'pofol', '일을 마쳤어요 · 연습 문제 정리', 2, false, { open: 'job', id: '4242' }),
    n(2, 'permission', 'cld-gui', '허락을 기다려요 · Bash: rm -rf dist/', 5, false),
    n(3, 'job', 'cld-gui', '배포 검사가 끝났어요', 31, false, { open: 'job', id: '4243' }),
    n(4, 'question', 'pofol', '질문이 있어요 · 배포 전에 스테이징부터 볼까요?', 49, false),
  ];
}

/** In the page: the heads' text against their buttons. */
function measureHeads(): { problems: string[]; count: number } {
  const problems: string[] = [];
  const TOL = 1;
  const box = (el: Element) => el.getBoundingClientRect();
  const heads = [...document.querySelectorAll('section[aria-label="메신저"] header.msg-head')];
  for (const head of heads) {
    const who = head.querySelector('strong')?.textContent ?? '?';
    const text = head.querySelector(':scope > span.flex-1');
    const tools = head.querySelector(':scope > .msg-head-tools') ?? head.querySelector(':scope > button');
    if (!text) {
      problems.push(`${who}: no text box`);
      continue;
    }
    const tb = box(text);
    const hb = box(head);
    if (tb.right > hb.right + TOL) problems.push(`${who}: the text box leaves the head`);
    if (tb.width < 60) problems.push(`${who}: the text box is ${Math.round(tb.width)} px wide`);
    if (tools) {
      const cb = box(tools);
      const sameRow = cb.top < tb.bottom - TOL && cb.bottom > tb.top + TOL;
      if (sameRow && cb.left < tb.right - TOL && cb.right > tb.left + TOL) problems.push(`${who}: the buttons sit on the text box`);
      if (cb.right > hb.right + TOL) problems.push(`${who}: the buttons leave the head`);
    }
    // everything the text box holds is drawn inside it: past its edge only where an ancestor inside it clips
    for (const el of text.querySelectorAll('*')) {
      const eb = box(el);
      if (eb.width === 0 || eb.right <= tb.right + TOL) continue;
      let clipped = false;
      for (let p: Element | null = el.parentElement; p && p !== text; p = p.parentElement)
        if (getComputedStyle(p).overflowX !== 'visible' && box(p).right <= tb.right + TOL) clipped = true;
      if (!clipped && getComputedStyle(el).overflowX === 'visible')
        problems.push(`${who}: <${el.tagName.toLowerCase()}> "${(el.textContent ?? '').slice(0, 16)}" ends at ${Math.round(eb.right)}, its box at ${Math.round(tb.right)}`);
    }
  }
  return { problems, count: heads.length };
}

/** In the page: the 열기 / 읽음 buttons of the 알림 cards, whole and uncovered. */
function measureNotices(): { problems: string[]; count: number } {
  const problems: string[] = [];
  const TOL = 1;
  let count = 0;
  for (const b of document.querySelectorAll('.nc-card .nc-act button')) {
    if (getComputedStyle(b).visibility === 'hidden') continue; // held back by the card cut at the list's edge
    const r = b.getBoundingClientRect();
    const label = (b.textContent ?? '').replace(/north_east|check/g, '').trim();
    let visible = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
    for (let p = b.parentElement; p; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
      const pb = p.getBoundingClientRect();
      visible = {
        left: Math.max(visible.left, pb.left),
        top: Math.max(visible.top, pb.top),
        right: Math.min(visible.right, pb.right),
        bottom: Math.min(visible.bottom, pb.bottom),
      };
    }
    const w = Math.max(0, Math.min(r.right, visible.right) - Math.max(r.left, visible.left));
    const h = Math.max(0, Math.min(r.bottom, visible.bottom) - Math.max(r.top, visible.top));
    if (w === 0 || h === 0) continue; // scrolled wholly out: not drawn
    count++;
    if (w < r.width - TOL || h < r.height - TOL)
      problems.push(`${label}: half drawn (${Math.round(w)}x${Math.round(h)} of ${Math.round(r.width)}x${Math.round(r.height)})`);
    for (const [fx, fy] of [[0.2, 0.2], [0.8, 0.2], [0.2, 0.8], [0.8, 0.8]] as const) {
      const top = document.elementFromPoint(r.left + r.width * fx, r.top + r.height * fy);
      if (top && top !== b && !b.contains(top)) {
        problems.push(`${label}: covered by <${top.tagName.toLowerCase()} class="${String(top.className).slice(0, 40)}">`);
        break;
      }
    }
  }
  return { problems, count };
}

/** In the page: the band of the first pane's conversation. */
function measureBand(): { problems: string[]; facts: string } {
  const problems: string[] = [];
  const TOL = 1;
  const scroll = document.querySelector('section[aria-label="메신저"] [data-testid="chat-scroll"]');
  if (!scroll) return { problems: ['no conversation'], facts: '' };
  const widest = (side: 'mine' | 'agent') => {
    let best: { line: DOMRect; box: DOMRect; el: Element } | null = null;
    for (const line of scroll.querySelectorAll(`.msg-line[data-side="${side}"]`)) {
      const box = line.querySelector('.dlg-box');
      if (!box) continue;
      const b = box.getBoundingClientRect();
      if (!best || b.width > best.box.width) best = { line: line.getBoundingClientRect(), box: b, el: line };
    }
    return best;
  };
  const mine = widest('mine');
  const agent = widest('agent');
  if (!mine || !agent) return { problems: [`a side has no box (mine ${!!mine}, agent ${!!agent})`], facts: '' };
  const near = (a: number, b: number) => Math.abs(a - b) <= TOL;
  if (!near(mine.box.left, agent.box.left)) problems.push(`left edges: mine ${mine.box.left.toFixed(1)}, agent ${agent.box.left.toFixed(1)}`);
  if (!near(mine.box.right, agent.box.right)) problems.push(`right edges: mine ${mine.box.right.toFixed(1)}, agent ${agent.box.right.toFixed(1)}`);
  const marginL = agent.box.left - agent.line.left;
  const marginR = agent.line.right - agent.box.right;
  if (!near(marginL, marginR)) problems.push(`margins: left ${marginL.toFixed(1)}, right ${marginR.toFixed(1)}`);
  if (!near(mine.box.left - mine.line.left, marginL) || !near(mine.line.right - mine.box.right, marginR))
    problems.push('the owner line has other margins than the lead line');
  const face = (el: Element) => el.querySelector('.msg-face')?.getBoundingClientRect();
  const af = face(agent.el);
  const mf = face(mine.el);
  const plate = (el: Element) => el.querySelector('.dlg-plate')?.getBoundingClientRect();
  const ap = plate(agent.el);
  const mp = plate(mine.el);
  if (!af || !mf) problems.push('a face is missing');
  else {
    if (af.left < agent.line.left - TOL || af.right > agent.box.left + TOL)
      problems.push(`the lead's face is not in the left margin column (${af.left.toFixed(1)}-${af.right.toFixed(1)}, box ${agent.box.left.toFixed(1)})`);
    if (mf.right > mine.line.right + TOL || mf.left < mine.box.right - TOL)
      problems.push(`the owner's face is not in the right margin column (${mf.left.toFixed(1)}-${mf.right.toFixed(1)}, box ${mine.box.right.toFixed(1)})`);
    if (ap && Math.abs(af.top - ap.top) > 2) problems.push(`the lead's face top ${af.top.toFixed(1)} and its name line top ${ap.top.toFixed(1)}`);
    if (mp && Math.abs(mf.top - mp.top) > 2) problems.push(`the owner's face top ${mf.top.toFixed(1)} and its name line top ${mp.top.toFixed(1)}`);
  }
  for (const d of scroll.querySelectorAll(':scope > details')) {
    const r = d.getBoundingClientRect();
    if (!near(r.left, agent.box.left) || r.right > agent.box.right + TOL)
      problems.push(`a command line ${r.left.toFixed(1)}-${r.right.toFixed(1)} is off the band ${agent.box.left.toFixed(1)}-${agent.box.right.toFixed(1)}`);
  }
  return {
    problems,
    facts: `box ${agent.box.left.toFixed(1)}-${agent.box.right.toFixed(1)} (w ${agent.box.width.toFixed(1)}), mine ${mine.box.left.toFixed(1)}-${mine.box.right.toFixed(1)}, margins ${marginL.toFixed(1)}/${marginR.toFixed(1)}`,
  };
}

/** In the page: every message's actions sit under its bubble on its own side; no name line holds one. */
function measureActions(): { problems: string[]; facts: string } {
  const problems: string[] = [];
  const TOL = 1;
  const scroll = document.querySelector('section[aria-label="메신저"] [data-testid="chat-scroll"]');
  if (!scroll) return { problems: ['no conversation'], facts: '' };
  let checked = 0;
  for (const plate of scroll.querySelectorAll('.dlg-plate'))
    if (plate.querySelector('button, [data-testid="message-actions"]') || /복사|답글/.test(plate.textContent ?? ''))
      problems.push(`a name line holds an action: "${(plate.textContent ?? '').slice(0, 30)}"`);
  const lines = [...scroll.querySelectorAll('.msg-line[data-side]')];
  for (const line of lines) {
    const side = line.getAttribute('data-side');
    const box = line.querySelector('.dlg-box')?.getBoundingClientRect();
    const acts = line.querySelector('[data-testid="message-actions"]');
    const what = `${side} "${(line.querySelector('.dlg-box')?.textContent ?? '').trim().slice(0, 14)}"`;
    if (!box) continue;
    if (!acts) {
      problems.push(`${what}: no actions`);
      continue;
    }
    const a = acts.getBoundingClientRect();
    if (a.width === 0) continue; // a phone holds on the bubble instead
    checked++;
    if (a.top < box.bottom - TOL) problems.push(`${what}: the actions start at ${a.top.toFixed(1)}, the bubble ends at ${box.bottom.toFixed(1)}`);
    if (side === 'agent' && !(a.left >= box.left - TOL && a.left < box.left + box.width / 2)) problems.push(`${what}: the actions are not on the bubble's left side`);
    if (side === 'mine' && !(a.right <= box.right + TOL && a.right > box.right - box.width / 2)) problems.push(`${what}: the actions are not on the bubble's right side`);
    const foot = acts.parentElement?.getBoundingClientRect();
    if (foot && (foot.left < box.left - TOL || foot.right > box.right + TOL)) problems.push(`${what}: the time line ${foot.left.toFixed(1)}-${foot.right.toFixed(1)} sticks out of the bubble ${box.left.toFixed(1)}-${box.right.toFixed(1)}`);
    if (foot && side === 'agent' && Math.abs(foot.left - box.left) > TOL) problems.push(`${what}: the time line does not start on the bubble's left edge`);
    if (foot && side === 'mine' && Math.abs(foot.right - box.right) > TOL) problems.push(`${what}: the time line does not end on the bubble's right edge`);
    if (!acts.parentElement?.querySelector('time')) problems.push(`${what}: no time beside the actions`);
  }
  return { problems, facts: `${lines.length} lines, ${checked} with actions measured, ${scroll.querySelectorAll('[data-testid="reply-quote"]').length} quotes, ${scroll.querySelectorAll('[data-testid="fold-toggle"]').length} folds` };
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, bin } = makeEngineHome();
  fs.writeFileSync(path.join(configDirectory(home), 'config.json'), JSON.stringify({ accessChosen: true, port }));
  const sessions = path.join(home, '.claude/sessions');
  fs.mkdirSync(sessions, { recursive: true });
  const folderOf = (name: string) => path.join(home, 'work', name);
  for (const name of LEADS) fs.mkdirSync(path.join(folderOf(name), '.cld-inbox'), { recursive: true });
  fs.writeFileSync(
    path.join(configDirectory(home), 'projects.json'),
    JSON.stringify(LEADS.map((name) => ({ name, folder: folderOf(name), room: '개발실', wantRunning: true }))),
  );
  const daemon = startDaemon({ home, claudePath: path.join(bin, 'claude') }, port, ['--engine', 'on', '--allow-chat', '--no-terminal'], { FAKE_TURN_MS: '600' }, false);
  const { child: server } = daemon;
  let browser: Browser | undefined;
  const abort = (why: string) => {
    console.error(`aborted: ${why}`);
    if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL'); // our own daemon only
    void browser?.close();
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true });
    process.exit(1);
  };
  const deadline = setTimeout(() => abort(`deadline ${DEADLINE_MS / 1000} s`), DEADLINE_MS);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(sig, () => abort(sig));

  type Sess = { pid: number; sessionId: string; cwd: string; name: string };
  const sessionFile = (name: string): Sess | null => {
    for (const f of fs.readdirSync(sessions)) {
      try {
        const s = JSON.parse(fs.readFileSync(path.join(sessions, f), 'utf-8')) as Sess;
        if (s.name === name) return s;
      } catch {
        /* being written */
      }
    }
    return null;
  };
  const failures: string[] = [];
  try {
    for (const end = Date.now() + 40_000; LEADS.some((n) => !sessionFile(n)); ) {
      if (Date.now() > end) throw new Error('the engine did not revive the sessions');
      await wait(300);
    }
    const H0 = Date.now() - 20 * 60_000;
    const rec = (i: number, role: 'user' | 'assistant', text: string, usage: boolean) =>
      `${JSON.stringify({
        type: role,
        uuid: `${i.toString(16).padStart(8, '0')}-6300-4000-8000-000000000000`,
        timestamp: new Date(H0 + i * 60_000).toISOString(),
        message:
          role === 'user'
            ? { role, content: text }
            : {
                role,
                model: 'claude-opus-5',
                content: [{ type: 'text', text }],
                ...(usage ? { usage: { input_tokens: 10, cache_read_input_tokens: 124_000, output_tokens: 100 } } : {}),
              },
      })}\n`;
    for (const name of LEADS) {
      const s = sessionFile(name)!;
      const file = transcriptPath(s.cwd, s.sessionId, home);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const live = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
      const body =
        rec(1, 'user', `${name}: 오늘 할 일 정리해 줘`, false) +
        rec(2, 'assistant', `${name} 할 일을 정리할게요.`, false) +
        rec(3, 'user', `제가 길게 적어 봅니다. ${LONG}`, false) +
        rec(4, 'assistant', `네, 길게 답해 드릴게요. ${LONG}`, true) +
        // a reply (its quote) to the long answer, a short answer, then a message that carries a file
        rec(5, 'user', `[사장 · 메신저 · 10-24 12:00] ⟨m:cccc4444⟩ ⟨re:00000004-6300-4000-8000-000000000000⟩\n> ${name}: 네, 길게 답해 드릴게요.\n이 말에 답해요`, false) +
        rec(6, 'assistant', `${name}: 답글 잘 받았어요.`, true) +
        rec(7, 'user', '[사장 · 메신저 · 10-24 12:01] ⟨m:dddd5555⟩\n파일도 보내요\n[첨부] /tmp/20261024-120100-build-log.txt (text/plain, 1 KB)', false);
      fs.writeFileSync(`${file}.tmp`, body + live);
      fs.renameSync(`${file}.tmp`, file);
    }
    await wait(3_000);

    browser = await launchBrowser();
    let cookies: Awaited<ReturnType<BrowserContext['cookies']>> = [];
    for (const scene of SCENES) {
      const touch = scene.phone === true;
      const ctx = await browser.newContext(
        touch ? { ...IPHONE, viewport: { width: scene.w, height: scene.h } } : { viewport: { width: scene.w, height: scene.h }, deviceScaleFactor: scene.name === 'owner-2pane' ? 1 : 2 },
      );
      await ctx.addInitScript('window.__name = (f) => f;');
      await ctx.addInitScript(
        (touch
          ? ''
          : `localStorage.setItem('cld.hud.layout.v1', ${JSON.stringify(
              JSON.stringify({ v: 1, items: { messenger: { place: { corner: 'tl', ...scene.place } } } }),
            )});`) + `localStorage.setItem('cld.ui-theme', '${STYLE}');localStorage.setItem('cld.ui-scale', '${SCALE}');` + `localStorage.setItem('cld.notices', ${JSON.stringify(JSON.stringify(seedNotices()))});`,
      );
      if (cookies.length) await ctx.addCookies(cookies);
      const page: Page = await ctx.newPage();
      if (cookies.length) await page.goto(`http://127.0.0.1:${port}/`);
      else {
        await page.goto(await daemon.loginUrl());
        await page.waitForURL(`http://127.0.0.1:${port}/`);
        cookies = await ctx.cookies();
      }
      await page.addStyleTag({ content: `.floating-toast-frame { display: none !important; }${touch ? SAFE_AREA : ''}` });
      await page.evaluate(() => document.fonts.ready);
      const tapOn = (l: ReturnType<Page['locator']>) => (touch ? l.tap() : l.click());
      const messenger = page.getByRole('region', { name: '메신저', exact: true });
      await tapOn(page.getByRole('button', { name: /^메신저($| \()/ }));
      const list = messenger.getByRole('list', { name: '연락처' });
      await list.getByRole('button', { name: /^cld-gui/ }).waitFor();
      await wait(600);
      // the layout's panes show the leads in order
      if (scene.layout !== 1) await messenger.getByTestId(`split-layout-${scene.layout}`).click();
      for (let i = 0; i < scene.layout; i++) {
        if (scene.layout !== 1) await messenger.getByTestId(`split-pane-${i}`).click({ position: { x: 6, y: 6 } });
        await tapOn(list.getByRole('button', { name: new RegExp(`^${LEADS[i]}`) }));
      }
      await wait(1_200);
      await page.mouse.move(0, 0);
      await page.getByTestId('chat-scroll').first().getByText('긴 이야기를').first().waitFor({ timeout: 15_000 });
      if (!touch) await page.getByTestId('fatigue').first().waitFor({ timeout: 15_000 });
      const suffix = `${STYLE === 'pixel' ? '-pixel' : ''}${SCALE === 'medium' ? '' : `-${SCALE}`}`;
      const tag = (n: string) => path.join(OUT, `${scene.name}-${n}${suffix}-${PHASE}.png`);
      const crop = async (n: string, loc: ReturnType<Page['locator']>) => {
        const b = await loc.boundingBox();
        if (b) await page.screenshot({ path: tag(n), clip: { x: b.x, y: b.y, width: b.width, height: b.height } });
      };
      const heads = messenger.locator('header.msg-head');
      for (let i = 0; i < (await heads.count()); i++) await crop(`head${i + 1}`, heads.nth(i));
      const problems: string[] = [];
      const headed = await page.evaluate(measureHeads);
      problems.push(...headed.problems);
      if (headed.count < scene.layout) problems.push(`only ${headed.count} heads`);
      let facts = '';
      if (BAND.has(scene.name)) {
        const scroll = page.getByTestId('chat-scroll').first();
        await scroll.evaluate((el) => (el.scrollTop = el.scrollHeight));
        await wait(400);
        const band = await page.evaluate(measureBand);
        problems.push(...band.problems);
        facts = band.facts;
        const acts = await page.evaluate(measureActions);
        problems.push(...acts.problems);
        facts += ` · actions: ${acts.facts}`;
        // the long messages open too: the same band, the same place for the actions
        for (const fold of await scroll.getByTestId('fold-toggle').all()) await fold.click();
        await wait(300);
        const opened = await page.evaluate(measureActions);
        problems.push(...opened.problems.map((p) => `(folds open) ${p}`));
        for (const fold of await scroll.getByTestId('fold-toggle').all()) await fold.click();
        await wait(300);
        await scroll.evaluate((el) => (el.scrollTop = el.scrollHeight));
        await wait(300);
        if (!touch) {
          const lead = page.locator('.msg-line[data-side="agent"]').last();
          await lead.hover();
          await wait(200);
          await crop('actions-hover', scroll);
          await page.locator('.msg-line[data-side="mine"]').last().hover();
          await wait(200);
          await crop('actions-hover-mine', scroll);
          await page.mouse.move(0, 0);
        }
        await crop('band-agent', scroll);
        await scroll.evaluate((el) => el.querySelector('.msg-line[data-side="mine"]:last-of-type, .msg-line[data-side="mine"]')?.scrollIntoView({ block: 'start' }));
        await wait(300);
        await crop('band-mine', scroll);
      }
      if (!touch) {
        // the notifications' panel open too (it holds the cards with 열기 / 읽음)
        const toggle = page.getByTestId('cc-seg-notices');
        if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
        await wait(300);
        const notices = await page.evaluate(measureNotices);
        problems.push(...notices.problems);
        facts += ` · ${notices.count} 열기/읽음 buttons drawn`;
      }
      await page.screenshot({ path: tag('scene') });
      console.log(`${scene.name}: ${problems.length} problems; ${facts}`);
      for (const p of problems) console.log(`  - ${p}`);
      for (const p of problems) failures.push(`${scene.name}: ${p}`);
      await ctx.close();
    }
    console.log(`photos in ${OUT}`);
    if (PHASE === 'after' && failures.length) throw new Error(`${failures.length} problems:\n${failures.join('\n')}`);
  } finally {
    clearTimeout(deadline);
    await browser?.close();
    if (server.exitCode === null && server.signalCode === null) server.kill('SIGTERM'); // our own daemon only
    killFakeSessions(home);
    await wait(500);
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
