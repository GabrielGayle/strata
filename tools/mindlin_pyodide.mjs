#!/usr/bin/env node
/**
 * The same 2D Mindlin solve as tools/mindlin_plate.py, inside Pyodide.
 *
 * Pyodide is not an app dependency (it would dwarf the build). Install it
 * beside the repo and point Node at it:
 *
 *   mkdir -p /tmp/pyodide-run && npm install --prefix /tmp/pyodide-run pyodide
 *   NODE_PATH=/tmp/pyodide-run/node_modules node tools/mindlin_pyodide.mjs
 *
 * Prints the plate report (analytic f, bending partials, assemble and eigen
 * times) plus how long Pyodide itself took to boot and fetch numpy/scipy.
 * If Pyodide cannot load, run `python3 tools/mindlin_plate.py` instead.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

let loadPyodide;
try {
  ({ loadPyodide } = await import('pyodide'));
} catch (err) {
  console.error('Could not import pyodide:', err instanceof Error ? err.message : err);
  console.error('Install it outside the app and set NODE_PATH, then re-run.');
  console.error('Native fallback: python3 tools/mindlin_plate.py');
  process.exit(1);
}

const src = readFileSync(join(here, 'mindlin_plate.py'), 'utf8');
const boot0 = performance.now();
const py = await loadPyodide();
const bootS = (performance.now() - boot0) / 1000;
const pkg0 = performance.now();
await py.loadPackage(['numpy', 'scipy', 'micropip']);
const pkgS = (performance.now() - pkg0) / 1000;
const pip0 = performance.now();
await py.runPythonAsync(`
import micropip
await micropip.install('scikit-fem==12.0.2')
`);
const pipS = (performance.now() - pip0) / 1000;
py.FS.writeFile('/mindlin_plate.py', src);
const run0 = performance.now();
const report = await py.runPythonAsync(`
import io, json, runpy, sys
buf = io.StringIO()
prev = sys.stdout
sys.stdout = buf
try:
    runpy.run_path('/mindlin_plate.py', run_name='__main__')
finally:
    sys.stdout = prev
buf.getvalue()
`);
const wallS = (performance.now() - run0) / 1000;
const plate = JSON.parse(String(report));
console.log(JSON.stringify({ runtime: 'pyodide', boot_s: bootS, packages_s: pkgS, scikit_fem_s: pipS, script_wall_s: wallS, plate }, null, 2));
