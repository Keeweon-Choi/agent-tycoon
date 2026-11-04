/**
 * UI-FONT check: the 글꼴 setting (픽셀 감성 default, 읽기 쉬움 = ASCII in Galmuri11).
 * dist/cli.js with --engine on --allow-chat in an isolated HOME (the engine fake `claude`), on a
 * spare port, headless Chromium with --disable-gpu, phone 390x844 and desktop 1280x800.
 * - the setting applies at once (no reload) and survives a reload;
 * - the phone's 설정 has one row of tabs, 보안 once, 기기 추가 under 접속, 범례 under 화면;
 * - a DM, the stat detail, 설정 and (desktop) the elevator are shot in both modes; modes.png puts
 *   them side by side (pixel left, readable right).
 * Screenshots to cld/artifacts/ui-font/.
 *
 *   npx tsx cld/test/run-ui-font.ts <port 18256-18269>
 */
import type { Locator, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

import { transcriptPath } from '../../server/src/cld/providers/claudeProvider.js';
import { configDirectory } from '../../server/src/cld/configPath.js';
import {
  assertPortFree,
  killFakeSessions,
  launchBrowser,
  makeEngineHome,
  openOfficeWindow,
  REPO_ROOT,
  sparePort,
  startDaemon,
  topBarButton,
  topBarReady,
} from '../../server/src/cld/testHome.js';

const port = sparePort();
const OUT = path.join(REPO_ROOT, 'cld/artifacts/ui-font');
const DEADLINE_MS = 420_000;
const LEADS = ['alpha', 'beta'];
const MODES = ['pixel', 'readable'] as const;
type Mode = (typeof MODES)[number];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let oks = 0;
function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  oks++;
  console.log(`ok - ${what}`);
}

async function main() {
  await assertPortFree(port);
  fs.mkdirSync(OUT, { recursive: true });
  const { home, claudePath } = makeEngineHome();
  const sessions = path.join(home, '.claude/sessions');
  fs.writeFileSync(
    path.join(configDirectory(home), 'config.json'),
    JSON.stringify({ accessChosen: true, port }),
  );
  fs.writeFileSync(
    path.join(configDirectory(home), 'building.json'),
    JSON.stringify({
      version: 1,
      floors: ['로비', '개발동', '연구동'].map((name, i) => ({ id: String(i + 1), name, rooms: [], characters: [] })),
      perProject: false,
    }),
  );
  fs.mkdirSync(sessions, { recursive: true });
  const folders = Object.fromEntries(LEADS.map((n) => [n, path.join(home, 'work', n)]));
  for (const f of Object.values(folders)) fs.mkdirSync(f, { recursive: true });
  fs.writeFileSync(
    path.join(configDirectory(home), 'projects.json'),
    JSON.stringify(LEADS.map((name) => ({ name, folder: folders[name], room: '개발실', wantRunning: true }))),
  );
  const daemon = startDaemon({ home, claudePath }, port, ['--engine', 'on', '--allow-chat', '--no-terminal'], {
    FAKE_TURN_MS: '600',
    SHELL: '/bin/sh',
  });
  const abort = (why: string) => {
    console.error(`aborted: ${why}`);
    if (daemon.child.exitCode === null && daemon.child.signalCode === null) daemon.child.kill('SIGKILL');
    killFakeSessions(home);
    fs.rmSync(home, { recursive: true, force: true });
    process.exit(1);
  };
  const deadline = setTimeout(() => abort(`deadline ${DEADLINE_MS / 1000} s`), DEADLINE_MS);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.once(sig, () => abort(sig));

  type Sess = { sessionId: string; cwd: string; name: string };
  const sessionOf = (name: string): Sess | null => {
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
  let uuid = 0;
  const say = (name: string, role: 'user' | 'assistant', text: string) => {
    const s = sessionOf(name)!;
    const file = transcriptPath(s.cwd, s.sessionId, home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(
      file,
      `${JSON.stringify({
        uuid: `${(++uuid).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`,
        timestamp: new Date().toISOString(),
        type: role,
        message: role === 'user' ? { role, content: text } : { role, content: [{ type: 'text', text }] },
      })}\n`,
    );
  };

  const browser = await launchBrowser();
  const pageErrors: string[] = [];
  try {
    for (const end = Date.now() + 40_000; LEADS.some((n) => !sessionOf(n)); ) {
      if (Date.now() > end) throw new Error('the engine did not revive the sessions');
      await sleep(300);
    }
    say('alpha', 'user', '오늘 14:30 회의 전에 PR #482 상태 확인해 줘');
    say('alpha', 'assistant', '확인했어요. CI 3/3 통과, 리뷰 2건 대기, 경로는 src/cld/ez/nameplate.ts 입니다. Lv 12, 62%.');
    say('alpha', 'user', '고마워요 (v1.5.0)');
    await sleep(3_000);

    const login = await browser.newContext();
    const lp = await login.newPage();
    await lp.goto(await daemon.loginUrl());
    await lp.waitForURL(`http://127.0.0.1:${port}/`);
    const cookies = await login.cookies();
    await login.close();

    /** [tag, viewport, phone]: crops for modes.png are collected per tag. */
    const crops: Record<string, string[]> = {};
    for (const [tag, viewport, phone] of [
      ['phone', { width: 390, height: 844 }, true],
      ['desktop', { width: 1280, height: 800 }, false],
    ] as const) {
      const ctx = await browser.newContext({ viewport, isMobile: phone, hasTouch: phone, deviceScaleFactor: phone ? 2 : 1 });
      await ctx.addInitScript('globalThis.__name = (fn) => fn; window.__AGENT_TYCOON_E2E = true;');
      await ctx.addCookies(cookies);
      const page = await ctx.newPage();
      page.on('pageerror', (err) => pageErrors.push(String(err)));
      const act = (l: Locator) => (phone ? l.tap() : l.click());
      const ready = async () => {
        await page.goto(`http://127.0.0.1:${port}/`);
        await topBarReady(page, 60_000);
        const closeInfo = page.getByRole('button', { name: '정보 창 닫기' });
        if (await closeInfo.count()) await closeInfo.first().click();
        await page.waitForTimeout(1_500);
      };
      const closeDialogs = async () => {
        for (let i = 0; i < 4; i++) {
          const xs = page.getByRole('button', { name: 'x', exact: true });
          if (!(await xs.count())) break;
          await act(xs.last());
          await page.waitForTimeout(250);
        }
      };
      const shot = async (mode: Mode, name: string, crop?: Locator) => {
        await page.waitForTimeout(500);
        await page.screenshot({ path: path.join(OUT, `${tag}-${name}-${mode}.png`) });
        const key = `${tag}-${name}`;
        const cropFile = path.join(OUT, `${key}-${mode}-crop.png`);
        if (crop) await crop.screenshot({ path: cropFile });
        else fs.copyFileSync(path.join(OUT, `${tag}-${name}-${mode}.png`), cropFile);
        (crops[key] ??= []).push(cropFile);
      };
      const family = () => page.evaluate(() => getComputedStyle(document.body).fontFamily);
      const openSettings = async () => {
        await (phone ? act(page.getByRole('button', { name: '설정', exact: true }).first()) : topBarButton(page, '설정'));
        await page.getByTestId('settings-tabs').waitFor();
      };
      const displayTab = () => act(page.getByTestId('settings-tabs').getByRole('tab', { name: '화면', exact: true }));

      const dm = async (mode: Mode) => {
        await ready();
        if (phone) await act(page.locator('[data-dock="messenger"]'));
        else await act(page.getByRole('button', { name: /^메신저/ }));
        const pm = page.getByRole('region', { name: '메신저', exact: true });
        await act(pm.getByRole('list', { name: '연락처' }).getByRole('button', { name: /^alpha/ }));
        const conv = pm.getByRole('region', { name: 'alpha 대화' });
        await conv.getByText('PR #482').first().waitFor({ timeout: 20_000 });
        await shot(mode, 'dm', phone ? undefined : conv);
      };
      const stat = async (mode: Mode) => {
        await ready();
        if (phone) {
          await act(page.locator('[data-testid="agent-card"]').first());
        } else {
          await openOfficeWindow(page);
          const win = page.locator('[data-hud-window="office"]');
          const open1 = win.locator('[data-testid="stat-open"]');
          for (let i = 0; i < 20 && (await open1.count()) === 0; i++) {
            const head = win.locator('article h3 button').first();
            if (await head.count()) await head.click();
            await page.waitForTimeout(300);
          }
        }
        await act(page.locator('[data-testid="stat-open"]').first());
        const detail = page.getByTestId('stat-detail');
        await detail.waitFor({ timeout: 10_000 });
        await shot(mode, 'stat', phone ? undefined : detail);
      };
      const settings = async (mode: Mode) => {
        await ready();
        await openSettings();
        await displayTab();
        await page.getByTestId('ui-font-option').waitFor();
        await shot(mode, 'settings', phone ? undefined : page.getByRole('dialog').last());
      };
      const elevator = async (mode: Mode) => {
        await ready();
        const el = page.locator('.cld-elevator-panel');
        await el.waitFor({ timeout: 20_000 });
        await shot(mode, 'elevator', el);
      };

      await ready();
      check((await page.locator('html').getAttribute('data-ui-font')) === 'pixel', `${tag}: a new browser starts on 픽셀 감성`);
      check(!(await family()).includes('Galmuri11 ASCII'), `${tag}: the default stack has no ASCII Galmuri face`);

      // The phone's 설정: one row of tabs, no duplicate.
      await openSettings();
      const tabs = await page.getByTestId('settings-tabs').getByRole('tab').allTextContents();
      if (phone) {
        check((await page.getByTestId('settings-quick').count()) === 0, 'phone: no second row over the tabs');
        check(tabs.filter((n) => n.trim() === '보안').length === 1, `phone: 보안 once (${tabs.join(' | ')})`);
        await act(page.getByTestId('settings-tabs').getByRole('tab', { name: '접속', exact: true }));
        check(await page.getByTestId('add-device-option').getByRole('button', { name: '기기 추가' }).isVisible(), 'phone: 기기 추가 under 접속');
        await displayTab();
        check(await page.getByTestId('legend-option').getByRole('button', { name: '범례' }).isVisible(), 'phone: 범례 under 화면');
        await page.screenshot({ path: path.join(OUT, 'phone-settings-one-row.png') });
      } else {
        check((await page.getByTestId('add-device-option').count()) === 0, 'desktop: no phone rows');
        await displayTab();
      }

      // At once, no reload.
      await page.evaluate(() => ((window as unknown as { __kept: boolean }).__kept = true));
      const choose = (m: Mode) => act(page.getByTestId('ui-font-option').locator(`[data-ui-font="${m}"]`));
      await choose('readable');
      check((await page.locator('html').getAttribute('data-ui-font')) === 'readable', `${tag}: 읽기 쉬움 applies at once`);
      check((await family()).includes('Galmuri11 ASCII'), `${tag}: the stack now starts with Galmuri11 for ASCII`);
      check(await page.evaluate(() => (window as unknown as { __kept?: boolean }).__kept === true), `${tag}: no reload happened`);
      await choose('pixel');
      check((await page.locator('html').getAttribute('data-ui-font')) === 'pixel', `${tag}: 픽셀 감성 comes back at once`);
      await closeDialogs();

      for (const mode of MODES) {
        await page.evaluate((m) => localStorage.setItem('cld.ui-font', m), mode);
        await dm(mode);
        await stat(mode);
        await settings(mode);
        if (!phone) await elevator(mode);
        check((await page.locator('html').getAttribute('data-ui-font')) === mode, `${tag}: ${mode} survives a reload`);
      }
      await ctx.close();
    }

    // modes.png: pixel left, readable right, one row per view.
    const img = (f: string) => `data:image/png;base64,${fs.readFileSync(f).toString('base64')}`;
    const cell = (key: string, w: number) => {
      const [a, b] = crops[key];
      return `<figure><div><img src="${img(a)}" style="width:${w}px"><img src="${img(b)}" style="width:${w}px"></div><figcaption>${key}: 픽셀 감성 | 읽기 쉬움</figcaption></figure>`;
    };
    const html = `<style>body{margin:0;padding:12px;background:#111;color:#ccc;font:14px sans-serif;width:2600px}
      .row{display:flex;gap:24px;align-items:flex-start;margin-bottom:16px;flex-wrap:wrap}figure{margin:0}div{display:flex;gap:8px}img{display:block}</style>
      <div class="row">${['phone-dm', 'phone-stat', 'phone-settings'].map((k) => cell(k, 390)).join('')}</div>
      <div class="row">${['desktop-dm', 'desktop-stat', 'desktop-settings'].map((k) => cell(k, 600)).join('')}</div>
      <div class="row">${cell('desktop-elevator', 300)}</div>`;
    const sheet = await browser.newPage({ viewport: { width: 2624, height: 900 } });
    await sheet.setContent(html);
    await sheet.screenshot({ path: path.join(OUT, 'modes.png'), fullPage: true });

    check(pageErrors.length === 0, `no page errors (${pageErrors.join(' | ') || 'none'})`);
    console.log(`\nall ${oks} checks passed`);
  } finally {
    clearTimeout(deadline);
    await browser.close();
    killFakeSessions(home);
    await daemon.stop();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
