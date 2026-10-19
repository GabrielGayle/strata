// Bundle the cloud job runner (worker/job.ts) and the engine it calls into one
// Node file, worker/dist/job.mjs, for the Modal image. Same engine build hash as the app.
//   npx tsx worker/build.ts
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { engineHash } from '../scripts/engine-hash';

const root = fileURLToPath(new URL('..', import.meta.url));
const engine = engineHash(root);

await build({
  entryPoints: [`${root}worker/job.ts`],
  outfile: `${root}worker/dist/job.mjs`,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  // CommonJS dependencies (pngjs, clipper-lib) still call require()
  banner: { js: "import { createRequire as __strataRequire } from 'node:module'; const require = __strataRequire(import.meta.url);" },
  define: {
    __STRATA_ENGINE__: JSON.stringify(engine),
    'import.meta.env': '{}',
  },
  logLevel: 'warning',
});
console.log(`worker/dist/job.mjs built, engine ${engine}`);
