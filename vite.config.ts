import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Strata's own geometry code (and the mesh loaders it uses) needs only three's
// core: maths, geometry, shapes. Point those imports straight at three.core.js,
// so the WebGL renderer half (three.module.js) is only fetched with the 3D views.
// Build only: in dev the deps are pre-bundled, and two copies of three would load.
const CORE_ONLY = /\/src\/(core|state)\/|\/three\/examples\/jsm\/(loaders\/(STL|OBJ)Loader|exporters\/STLExporter|utils\/BufferGeometryUtils)\.js$/;
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
  plugins: [react(), threeCore()],
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
