/**
 * Mock-up left, ours right (any number of pictures, left to right), one PNG at height H (default 1086):
 *   [H=1688] npx tsx agent-tycoon/test/compare-gpt.mts <mock.png> <ours.png> [<more.png> ...] <out.png>
 */
import { chromium } from '@playwright/test';
import * as fs from 'fs';
const args = process.argv.slice(2);
const out = args.pop()!;
const h = Number(process.env.H ?? 1086);
const b64 = (p: string) => `data:image/png;base64,${fs.readFileSync(p).toString('base64')}`;
const browser = await chromium.launch({ args: ['--disable-gpu'] });
const page = await browser.newPage({ viewport: { width: 400, height: h } });
await page.setContent(
  `<body style="margin:0;background:#000;display:inline-flex;gap:8px">${args.map((p) => `<img style="height:${h}px;width:auto" src="${b64(p)}">`).join('')}</body>`,
);
await page.waitForLoadState('load');
const w = await page.evaluate(() => document.body.scrollWidth);
await page.setViewportSize({ width: w, height: h });
await page.screenshot({ path: out });
await browser.close();
