import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleEaProxyHttp } from './src/server/eaProxyHttp';
import { handleOverpassProxyHttp } from './src/server/overpassProxyHttp';

// Strata's own geometry code (and the mesh loaders it uses) needs only three's
// core: maths, geometry, shapes. Point those imports straight at three.core.js,
// so the WebGL renderer half (three.module.js) is only fetched with the 3D views.
// Build only: in dev the deps are pre-bundled, and two copies of three would load.
const CORE_ONLY = /\/src\/(core|state)\/|\/three\/examples\/jsm\/(loaders\/(STL|OBJ)Loader|exporters\/STLExporter|utils\/BufferGeometryUtils)\.js$/;
const mapFixtureRoot = join(fileURLToPath(new URL('.', import.meta.url)), 'test/fixtures/map');

function attachApiMiddleware(server: { middlewares: { use: Function } }) {
  server.middlewares.use((req: import('http').IncomingMessage, res: import('http').ServerResponse, next: () => void) => {
    const url = req.url?.split('?')[0] ?? '';
    if (url === '/api/ea-proxy') {
      void handleEaProxyHttp(req, res).catch((e) => {
        res.statusCode = 500;
        res.end((e as Error).message);
      });
      return;
    }
    if (url === '/api/overpass') {
      void handleOverpassProxyHttp(req, res).catch((e) => {
        res.statusCode = 500;
        res.end((e as Error).message);
      });
      return;
    }
    next();
  });
}

function attachMapFixtureMiddleware(server: { middlewares: { use: Function } }) {
  attachApiMiddleware(server);
  server.middlewares.use('/map-fixtures', (req: import('http').IncomingMessage, res: import('http').ServerResponse, next: () => void) => {
    const url = req.url?.split('?')[0] ?? '';
    const file = normalize(join(mapFixtureRoot, url.replace(/^\//, '')));
    if (!file.startsWith(mapFixtureRoot) || !existsSync(file) || !statSync(file).isFile()) {
      next();
      return;
    }
    if (file.endsWith('.json')) res.setHeader('Content-Type', 'application/json');
    else if (file.endsWith('.png')) res.setHeader('Content-Type', 'image/png');
    createReadStream(file).pipe(res);
  });
}

/** Serve offline map tiles / grids for Playwright (`/map-fixtures/...`). */
const mapCacheClient = join(fileURLToPath(new URL('.', import.meta.url)), 'src/core/mapCache.client.ts');

/** Keep pngjs / Buffer out of the browser bundle (Node-only terrarium decode). */
function excludeNodeTerrarium(): Plugin {
  return {
    name: 'strata-exclude-node-terrarium',
    apply: 'build',
    enforce: 'pre',
    resolveId(source, _importer, options) {
      if (options?.ssr) return null;
      if (
        source === './mapTerrarium.node' ||
        source === './mapTerrarium.node.js' ||
        source === './mapTerrarium.node.ts' ||
        source.endsWith('/mapTerrarium.node') ||
        source.endsWith('/mapTerrarium.node.js') ||
        source.endsWith('/mapTerrarium.node.ts')
      ) {
        return '\0strata-terrarium-node-stub';
      }
    },
    load(id) {
      if (id !== '\0strata-terrarium-node-stub') return null;
      return 'export function decodeTerrariumPng() { throw new Error("mapTerrarium.node is Node-only"); }';
    },
  };
}

/** Browser bundle uses in-memory fetch only (CLI keeps on-disk `mapCache.ts`). */
function mapCacheBrowser(): Plugin {
  return {
    name: 'strata-map-cache-browser',
    enforce: 'pre',
    resolveId(source, importer, options) {
      if (options.ssr) return null;
      if (source !== './mapCache' && source !== '../core/mapCache' && !source.endsWith('/mapCache')) return null;
      if (!importer?.includes('/src/')) return null;
      if (importer.includes('mapCache.ts') || importer.includes('mapCache.client')) return null;
      return mapCacheClient;
    },
  };
}

function mapFixtures(): Plugin {
  return {
    name: 'strata-map-fixtures',
    configureServer: attachMapFixtureMiddleware,
    configurePreviewServer: attachMapFixtureMiddleware,
  };
}

function threeCore(): Plugin {
  return {
    name: 'strata-three-core',
    apply: 'build',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (source !== 'three' || !importer || !CORE_ONLY.test(importer.replace(/\\/g, '/'))) return null;
      const r = await this.resolve(source, importer, { ...options, skipSelf: true });
      return r && { ...r, id: r.id.replace(/three\.module\.js$/, 'three.core.js') };
    },
  };
}

// Libraries in their own files, so an app update doesn't make phones fetch them again.
function vendorChunk(id: string): string | undefined {
  if (!id.includes('node_modules')) return;
  if (/[\\/]three[\\/]build[\\/]three\.core\.js$/.test(id)) return 'three-core';
  if (/[\\/]node_modules[\\/](react|react-dom|scheduler)[\\/]/.test(id)) return 'react';
  if (/[\\/]node_modules[\\/]clipper-lib[\\/]/.test(id)) return 'clipper';
}

export default defineConfig({
  base: './',
  plugins: [react(), threeCore(), excludeNodeTerrarium(), mapCacheBrowser(), mapFixtures()],
  define: {
    'process.env': {},
  },
  resolve: {
    alias: {
      buffer: 'buffer/',
    },
  },
  optimizeDeps: {
    include: ['buffer'],
  },
  build: {
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: { manualChunks: vendorChunk },
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
} as any);
