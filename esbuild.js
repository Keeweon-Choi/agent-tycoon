const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** Package version read from package.json at build time, inlined via esbuild `define`. */
const pkgVersion = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8'),
).version;
/** cld-gui product version (P1): one source, cld/release/version.json. */
const productVersion = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'cld', 'release', 'version.json'), 'utf-8'),
).version;
const versionDefine = {
  'process.env.AGENT_TYCOON_VERSION': JSON.stringify(pkgVersion),
  'process.env.CLD_GUI_VERSION': JSON.stringify(productVersion),
};

/**
 * CHAR-FACTORY: copy the built-in content packs (cld/packs/<id>/) to dist/packs/. Expansion packs
 * never live in the repo (packs-private/, the user's ~/.config/cld-gui/packs/).
 */
function copyPacks() {
  const srcDir = path.join(__dirname, 'cld', 'packs');
  const dstDir = path.join(__dirname, 'dist', 'packs');
  if (fs.existsSync(dstDir)) fs.rmSync(dstDir, { recursive: true });
  if (!fs.existsSync(srcDir)) return;
  for (const id of fs.readdirSync(srcDir)) {
    if (!fs.existsSync(path.join(srcDir, id, 'pack.json'))) continue;
    fs.cpSync(path.join(srcDir, id), path.join(dstDir, id), { recursive: true });
    console.log(`✓ Copied pack ${id} → dist/packs/`);
  }
}

/**
 * Copy assets folder to dist/assets
 */
function copyAssets() {
  const srcDir = path.join(__dirname, 'webview-ui', 'public', 'assets');
  const dstDir = path.join(__dirname, 'dist', 'assets');

  if (fs.existsSync(srcDir)) {
    // Remove existing dist/assets if present
    if (fs.existsSync(dstDir)) {
      fs.rmSync(dstDir, { recursive: true });
    }

    // Copy recursively
    fs.cpSync(srcDir, dstDir, { recursive: true });
    console.log('✓ Copied assets/ → dist/assets/');
  } else {
    console.log('ℹ️  assets/ folder not found (optional)');
  }
}

/**
 * Bundle hook scripts (TypeScript) to dist/hooks via esbuild.
 * Produces a self-contained CJS file with shebang for Claude Code to execute.
 */
function buildHooks() {
  const entry = path.join(
    __dirname,
    'server',
    'src',
    'providers',
    'hook',
    'claude',
    'hooks',
    'claude-hook.ts',
  );
  if (!fs.existsSync(entry)) return;
  require('esbuild').buildSync({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outdir: path.join(__dirname, 'dist', 'hooks'),
    banner: { js: '#!/usr/bin/env node' },
  });
  console.log('✓ Built hooks/ → dist/hooks/');
}

/**
 * @type {import('esbuild').Plugin}
 */
const esbuildProblemMatcherPlugin = {
  name: 'esbuild-problem-matcher',

  setup(build) {
    build.onStart(() => {
      console.log('[watch] build started');
    });
    build.onEnd((result) => {
      result.errors.forEach(({ text, location }) => {
        console.error(`✘ [ERROR] ${text}`);
        console.error(`    ${location.file}:${location.line}:${location.column}:`);
      });
      console.log('[watch] build finished');
    });
  },
};

async function main() {
  if (watch) {
    const ctx = await esbuild.context({
      ...cliOptions,
      logLevel: 'silent',
      plugins: [esbuildProblemMatcherPlugin],
    });
    await ctx.watch();
    return;
  }
  copyAssets();
  copyPacks();
  buildHooks();
  await esbuild.build(cliOptions);
  asciiOnly(cliOptions.outfile);
  await buildWorker();
  await buildPtyHost();
  await buildLoginPage();
}

/** cld-gui (T-0022): the login page's script and style, served at /login/*
 *  without a session, so they stay out of the session-gated app bundle. */
async function buildLoginPage() {
  const src = path.join(__dirname, 'webview-ui', 'src', 'cld', 'login');
  const out = path.join(__dirname, 'dist', 'login');
  await esbuild.build({
    entryPoints: [path.join(src, 'login.ts')],
    bundle: true,
    format: 'esm',
    minify: production,
    sourcemap: false,
    platform: 'browser',
    target: 'es2020',
    outfile: path.join(out, 'login.js'),
    logLevel: 'silent',
  });
  fs.copyFileSync(path.join(src, 'login.css'), path.join(out, 'login.css'));
  console.log('✓ Built login page → dist/login/');
}

/** cld-gui (T-0021): the GPU wrapper and the Codex worker, run outside the daemon. */
async function buildWorker() {
  await esbuild.build({
    entryPoints: ['server/src/cld/engine/workerMain.ts'],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    outfile: 'dist/cld-worker.js',
    define: versionDefine,
    logLevel: 'silent',
  });
}

/** cld-gui TERM-P1 (ADR-0018): our PTY host, its own small process (no Fastify, no engine). */
async function buildPtyHost() {
  await esbuild.build({
    entryPoints: ['server/src/cld/ptyhost/hostMain.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    platform: 'node',
    target: 'node18',
    outfile: 'dist/cld-ptyhost.js',
    external: ['@lydell/node-pty', 'node-pty'],
    define: versionDefine,
    logLevel: 'silent',
  });
}

/** MEM-IDLE: V8 keeps the daemon's source for as long as it runs, and one non-ASCII character
 *  (esbuild leaves them in regex literals: 가-힣, ’, ¹) makes all of it two-byte, 2.2 MB more
 *  heap. Each becomes its \uXXXX escape, the same character in a regex, string or template.
 *  The development build too (the installer builds it): lines are kept, so a log's line numbers
 *  and the source map's rows hold; only the columns of a line that had such a character shift. */
function asciiOnly(file) {
  const src = fs.readFileSync(file, 'utf8');
  // `\가` (an identity escape) would turn into `\\uAC00`: refuse rather than change a pattern.
  if (/\\[^\x00-\x7f]/.test(src)) throw new Error(`${file}: an escaped non-ASCII character`);
  const out = src.replace(/[^\x00-\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  fs.writeFileSync(file, out);
}

/** The standalone daemon (dist/cli.js). */
const cliOptions = {
  entryPoints: ['server/src/cli.ts'],
  bundle: true,
  format: 'cjs',
  minify: production,
  sourcemap: !production,
  platform: 'node',
  outfile: 'dist/cli.js',
  external: [
    'fastify',
    '@fastify/websocket',
    '@fastify/static',
    '@fastify/cors',
    // Native PTY modules: they ship platform-specific .node binaries that
    // cannot be bundled, and they're OPTIONAL -- esbuild must not fail the
    // build when they're absent, and the runtime require() must be left
    // intact so its failure can be caught and degraded gracefully.
    // See server/src/terminal/ptyModule.ts.
    '@lydell/node-pty',
    'node-pty',
    // cld-gui direct connector (T-0024): loaded from node_modules only when a
    // certificate is issued, instead of 1.4 MB (axios, node-forge) parsed at every start.
    'acme-client',
  ],
  define: versionDefine,
  logLevel: 'silent',
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
