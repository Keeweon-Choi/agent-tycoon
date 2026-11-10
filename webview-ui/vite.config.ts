import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import * as fs from 'fs';
import * as path from 'path';
import { PNG } from 'pngjs';
import type { Plugin } from 'vite';
import { defineConfig } from 'vite';

import { buildAssetIndex, buildFurnitureCatalog } from '../core/src/assets/build.ts';
import {
  decodeAllCarpets,
  decodeAllCharacters,
  decodeAllFloors,
  decodeAllFurniture,
  decodeAllWalls,
} from '../core/src/assets/loader.ts';
import type { IsoManifest } from './src/agent-tycoon/iso/art.ts';
import owner from './src/agent-tycoon/iso/art/owner-manifest.json';
import { shipScales } from './src/agent-tycoon/iso/ship.ts';

// ── Decoded asset cache (invalidated on file change) ─────────────────────────

interface DecodedCache {
  characters: ReturnType<typeof decodeAllCharacters> | null;
  floors: ReturnType<typeof decodeAllFloors> | null;
  walls: ReturnType<typeof decodeAllWalls> | null;
  carpets: ReturnType<typeof decodeAllCarpets> | null;
  furniture: ReturnType<typeof decodeAllFurniture> | null;
}

// ── Vite plugin ───────────────────────────────────────────────────────────────

function browserMockAssetsPlugin(): Plugin {
  const assetsDir = path.resolve(__dirname, 'public/assets');
  // Default for production builds; configResolved below rewrites this to
  // track the actual build.outDir, so vite build calls that override outDir
  // (e.g. the build-subpath integration test) still receive the JSON sidecars.
  let distAssetsDir = path.resolve(__dirname, '../dist/webview/assets');

  const cache: DecodedCache = {
    characters: null,
    floors: null,
    walls: null,
    carpets: null,
    furniture: null,
  };

  function clearCache(): void {
    cache.characters = null;
    cache.floors = null;
    cache.walls = null;
    cache.carpets = null;
    cache.furniture = null;
  }

  return {
    name: 'browser-mock-assets',
    configResolved(config) {
      distAssetsDir = path.resolve(config.root, config.build.outDir, 'assets');
    },
    configureServer(server) {
      // Strip trailing slash: '/' → '', '/sub/' → '/sub'
      const base = server.config.base.replace(/\/$/, '');

      // Catalog & index (existing)
      server.middlewares.use(`${base}/assets/furniture-catalog.json`, (_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(buildFurnitureCatalog(assetsDir)));
      });
      server.middlewares.use(`${base}/assets/asset-index.json`, (_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(buildAssetIndex(assetsDir)));
      });

      // Pre-decoded sprites (new — eliminates browser-side PNG decoding)
      server.middlewares.use(`${base}/assets/decoded/characters.json`, (_req, res) => {
        cache.characters ??= decodeAllCharacters(assetsDir);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(cache.characters));
      });
      server.middlewares.use(`${base}/assets/decoded/floors.json`, (_req, res) => {
        cache.floors ??= decodeAllFloors(assetsDir);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(cache.floors));
      });
      server.middlewares.use(`${base}/assets/decoded/walls.json`, (_req, res) => {
        cache.walls ??= decodeAllWalls(assetsDir);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(cache.walls));
      });
      server.middlewares.use(`${base}/assets/decoded/carpets.json`, (_req, res) => {
        cache.carpets ??= decodeAllCarpets(assetsDir);
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(cache.carpets));
      });
      server.middlewares.use(`${base}/assets/decoded/furniture.json`, (_req, res) => {
        cache.furniture ??= decodeAllFurniture(assetsDir, buildFurnitureCatalog(assetsDir));
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(cache.furniture));
      });

      // Hot-reload on asset file changes (PNGs, manifests, layouts)
      server.watcher.add(assetsDir);
      server.watcher.on('change', (file) => {
        if (file.startsWith(assetsDir)) {
          console.log(`[browser-mock-assets] Asset changed: ${path.relative(assetsDir, file)}`);
          clearCache();
          server.ws.send({ type: 'full-reload' });
        }
      });
    },
    // Build output includes lightweight metadata consumed by browser runtime.
    closeBundle() {
      fs.mkdirSync(distAssetsDir, { recursive: true });

      const catalog = buildFurnitureCatalog(assetsDir);
      fs.writeFileSync(path.join(distAssetsDir, 'furniture-catalog.json'), JSON.stringify(catalog));
      fs.writeFileSync(
        path.join(distAssetsDir, 'asset-index.json'),
        JSON.stringify(buildAssetIndex(assetsDir)),
      );
    },
  };
}

// ── iso-prep-1104: isometric pictures shipped at the size they are drawn ─────────

/** `png` k times smaller: each k×k block averaged (colour weighted by alpha; a block past the
 *  edge counts as transparent), so the copy's pixels stay on the master's grid. */
function shrinkPng(png: Buffer, k: number): Buffer {
  const src = PNG.sync.read(png);
  const out = new PNG({ width: Math.ceil(src.width / k), height: Math.ceil(src.height / k) });
  for (let y = 0; y < out.height; y++)
    for (let x = 0; x < out.width; x++) {
      const acc = [0, 0, 0, 0];
      for (let v = y * k; v < Math.min(src.height, (y + 1) * k); v++)
        for (let u = x * k; u < Math.min(src.width, (x + 1) * k); u++) {
          const i = (v * src.width + u) * 4;
          const a = src.data[i + 3];
          for (let c = 0; c < 3; c++) acc[c] += src.data[i + c] * a;
          acc[3] += a;
        }
      const o = (y * out.width + x) * 4;
      if (!acc[3]) continue;
      for (let c = 0; c < 3; c++) out.data[o + c] = Math.round(acc[c] / acc[3]);
      out.data[o + 3] = Math.round(acc[3] / (k * k));
    }
  return PNG.sync.write(out);
}

/** The owner's isometric masters (src/agent-tycoon/iso/art) that are finer than ever drawn ship as the
 *  shrunk copy only (ship.ts says by how much; art.ts reads their coordinates divided by it). */
function isoShipPlugin(): Plugin {
  const dir = path.resolve(__dirname, 'src/agent-tycoon/iso/art');
  const scales = shipScales(owner as unknown as IsoManifest);
  let build = false;
  return {
    name: 'iso-ship',
    enforce: 'pre',
    configResolved(config) {
      build = config.command === 'build';
    },
    load(id) {
      const k = path.dirname(id) === dir ? scales.get(path.basename(id)) : undefined;
      if (!k) return null;
      const png = shrinkPng(fs.readFileSync(id), k);
      if (!build)
        return `export default ${JSON.stringify(`data:image/png;base64,${png.toString('base64')}`)};`;
      const ref = this.emitFile({ type: 'asset', name: path.basename(id), source: png });
      return `export default import.meta.ROLLUP_FILE_URL_${ref};`;
    },
  };
}

export default defineConfig({
  plugins: [tailwindcss(), react(), browserMockAssetsPlugin(), isoShipPlugin()],
  server: {
    // Dev-only: allow reaching `vite --host` from another device on a
    // Tailscale network (Vite rejects non-localhost Host headers by default).
    allowedHosts: ['.ts.net'],
  },
  build: {
    outDir: '../dist/webview',
    emptyOutDir: true,
  },
  base: './',
});
