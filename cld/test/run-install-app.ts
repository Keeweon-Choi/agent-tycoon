/**
 * T-0097 Chrome PWA check: opens the cld office in Chromium, checks the manifest Chromium parsed
 * (headless never fires beforeinstallprompt), then stubs prompt() to verify
 * the in-app settings action calls it. The direct connector is not started by
 * this test harness; its secret-path URL resolution is covered by relative URLs
 * in the page and manifest.
 *
 *   npx tsx cld/test/run-install-app.ts
 */
import {
  launchBrowser,
  makeFakeHome,
  sparePort,
  startDaemon,
} from '../../server/src/cld/testHome.js';

const port = sparePort();

function check(ok: unknown, what: string): void {
  if (!ok) throw new Error(`check failed: ${what}`);
  console.log(`ok - ${what}`);
}

type PwaManifest = {
  name?: string;
  short_name?: string;
  id?: string;
  start_url?: string;
  scope?: string;
  display?: string;
  icons?: Array<{ src: string; sizes: string; type?: string }>;
};

function hasInstallManifest(manifest: PwaManifest): boolean {
  return (
    // I1 (10-24): the manifest is one static file, so it carries the English name; the page title follows the language.
    manifest.name === 'Agent Tycoon' &&
    manifest.short_name === 'Agent Tycoon' &&
    manifest.id === './' &&
    manifest.start_url === './' &&
    manifest.scope === './' &&
    manifest.display === 'standalone' &&
    ['192x192', '512x512'].every((size) =>
      manifest.icons?.some((icon) => icon.sizes === size && icon.type === 'image/png'),
    )
  );
}

async function main(): Promise<void> {
  const fake = makeFakeHome({ claude: null });
  const daemon = startDaemon(fake, port, ['--no-terminal']);
  const browser = await launchBrowser();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(await daemon.loginUrl());
    await page.waitForURL(`http://127.0.0.1:${port}/`);
    await page.getByRole('button', { name: '설정', exact: true }).waitFor({ timeout: 20_000 });
    check((await page.title()) === '에이전트 타이쿤', 'office document title is 에이전트 타이쿤');

    const manifest = await page.evaluate(async () => {
      const response = await fetch('./manifest.webmanifest');
      if (!response.ok) throw new Error(`manifest HTTP ${response.status}`);
      return (await response.json()) as PwaManifest;
    });
    check(
      hasInstallManifest(manifest),
      'manifest has the app name, stable id, standalone mode, and 192/512 PNG icons',
    );
    for (const icon of manifest.icons ?? []) {
      if (icon.sizes !== '192x192' && icon.sizes !== '512x512') continue;
      const response = await page.evaluate(
        async (src) => fetch(src).then((r) => r.status),
        icon.src,
      );
      check(response === 200, `${icon.sizes} icon is served`);
    }
    // Negative control: Chrome's required-icon criteria reject a manifest
    // without its 192px icon, even if the 512px icon remains present.
    check(
      !hasInstallManifest({
        ...manifest,
        icons: manifest.icons?.filter((icon) => icon.sizes !== '192x192'),
      }),
      'negative control: install manifest criteria fail when the 192px icon is removed',
    );
    // Headless Chromium has no install UI: it never dispatches beforeinstallprompt, and its
    // Page.getInstallabilityErrors is empty for any page. So the criteria are checked on what
    // Chromium itself parsed from the manifest (Page.getAppManifest); the real prompt needs a
    // headed Chrome (the user's check).
    const appManifest = async (p: typeof page) => {
      const cdp = await context.newCDPSession(p);
      return (await cdp.send('Page.getAppManifest' as never)) as {
        url: string;
        errors: unknown[];
        manifest?: { icons?: Array<{ src: string; sizes: string }>; id?: string; name?: string };
      };
    };
    const seen = await appManifest(page);
    const sizes = (seen.manifest?.icons ?? []).map((icon) => icon.sizes).join(' ');
    check(
      seen.url.endsWith('/manifest.webmanifest') &&
        seen.errors.length === 0 &&
        seen.manifest?.name === 'Agent Tycoon' &&
        seen.manifest.id === `http://127.0.0.1:${port}/` &&
        /\b192x192\b/.test(sizes) &&
        /\b512x512\b/.test(sizes),
      `Chromium parsed the manifest without errors: name, id ${seen.manifest?.id}, icons ${sizes}`,
    );
    // Negative control: the same page without the manifest link has no manifest in Chromium.
    const bareCtx = await browser.newContext({ serviceWorkers: 'block' });
    const bare = await bareCtx.newPage();
    await bare.route('**/', async (route) => {
      const response = await route.fetch();
      const body = (await response.text()).replace(/<link rel="manifest"[^>]*>/, '');
      await route.fulfill({ response, body });
    });
    await bare.goto(`http://127.0.0.1:${port}/`);
    await bare.waitForTimeout(1_000);
    const missing = await (async () => {
      const cdp = await bareCtx.newCDPSession(bare);
      return (await cdp.send('Page.getAppManifest' as never)) as { url: string };
    })();
    check(
      missing.url === '',
      'negative control: without the manifest link Chromium sees no manifest',
    );
    await bareCtx.close();

    await page.getByRole('button', { name: '설정', exact: true }).click();
    const installButton = page.getByRole('button', { name: '앱으로 설치', exact: true });
    check((await installButton.count()) === 1, 'settings contains the 앱으로 설치 button');
    await page.evaluate(() => {
      const stub = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
        prompt: () => Promise<void>;
        userChoice: Promise<{ outcome: 'accepted'; platform: string }>;
      };
      stub.prompt = async () => {
        (window as Window & { __promptCalled?: boolean }).__promptCalled = true;
      };
      stub.userChoice = Promise.resolve({ outcome: 'accepted', platform: 'web' });
      window.dispatchEvent(stub);
    });
    await installButton.click();
    await page.waitForFunction(
      () => (window as Window & { __promptCalled?: boolean }).__promptCalled === true,
    );
    check(true, 'the settings button calls the saved install event prompt()');
  } finally {
    await browser.close();
    await daemon.stop();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
