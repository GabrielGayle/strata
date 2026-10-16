import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { PNG } from 'pngjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyMasterSizeCli, loadProject, main, parseCliArgs, type CliIo } from '../src/cli';
import { setMapTileFetcher } from '../src/core/mapTerrarium';
import { fixtureTileFetcher } from './map-cli-fixtures';
import { NEASDEN_BBOX } from './map-fixtures';
import { evaluateParams } from '../src/core/params';
import { buildZip } from '../src/core/exporters';
import { createPipeline, type Assets } from '../src/core/pipeline';
import { deserialize } from '../src/core/project';

const example = fileURLToPath(new URL('../examples/image-cliff.strata.json', import.meta.url));
const dirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'strata-cli-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function capture(): CliIo & { out: string; err: string } {
  const io = { out: '', err: '', stdout: (s: string) => { io.out += s; }, stderr: (s: string) => { io.err += s; } };
  return io;
}

function walk(dir: string, prefix = ''): string[] {
  const names: string[] = [];
  for (const ent of readdirSync(dir)) {
    const rel = prefix ? `${prefix}/${ent}` : ent;
    const path = join(dir, ent);
    if (statSync(path).isDirectory()) names.push(...walk(path, rel));
    else names.push(rel);
  }
  return names.sort();
}

function pngFile(path: string, w: number, h: number, fill: (x: number, y: number) => [number, number, number, number]) {
  const png = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = fill(x, y);
      const i = (y * w + x) * 4;
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = a;
    }
  writeFileSync(path, PNG.sync.write(png));
}

describe('cli export', () => {
  it('writes the same bundle as the app for a preset project', async () => {
    const dir = scratch();
    const out = join(dir, 'out');
    const io = capture();
    expect(await main([example, '--out', out], io)).toBe(0);
    expect(io.err).toBe('');
    expect(io.out).toMatch(/wrote \d+ parts, \d+ sheets?/);

    const text = readFileSync(example, 'utf8');
    const { project, issues } = loadProject(text);
    expect(issues).toEqual([]);
    const assets: Assets = { sideImg: null, frontImg: null, topImg: null, insMesh: null, srcMesh: null };
    const zip = unzipSync(buildZip(createPipeline()(project, assets), project));
    const onDisk = walk(out);
    expect(onDisk).toEqual(Object.keys(zip).sort());
    for (const name of onDisk) {
      const disk = readFileSync(join(out, name));
      const packed = Buffer.from(zip[name]);
      expect(disk.equals(packed), name).toBe(true);
    }
    expect(onDisk.some((n) => n.startsWith('laser/parts/') && n.endsWith('.dxf'))).toBe(true);
    expect(onDisk.some((n) => n.startsWith('laser/sheets/') && n.endsWith('.dxf'))).toBe(true);
    expect(onDisk.some((n) => n.startsWith('mould/dxf/') && n.endsWith('.dxf'))).toBe(true);
    expect(onDisk).toContain('model.stl');
    expect(onDisk).toContain('cutlist.csv');
    expect(onDisk).toContain('price-estimate.txt');
    expect(onDisk).toContain('price-estimate.json');
    expect(onDisk).toContain('build-pack.html');
    expect(onDisk).toContain('project.strata.json');
    const dxf = readFileSync(join(out, onDisk.find((n) => n.startsWith('laser/parts/') && n.endsWith('.dxf'))!), 'utf8');
    expect(dxf).toContain('AC1009');
    expect(dxf).toContain('EOF');

    const back = deserialize(readFileSync(join(out, 'project.strata.json'), 'utf8'));
    expect(back.params.plateCount).toBe('24');
    expect(back.params.imgSideMode).toBe('heightmap');
    expect(back.params.imgFrontMode).toBe('layers');
    expect(back.params.insShape).toBe('none');
    expect(back.params.thickness).toBe('1.5');
    expect(back.name).toBe('Image cliff');
  });

  it('lets --preset fill in under explicit params', async () => {
    const dir = scratch();
    const project = join(dir, 'p.json');
    writeFileSync(project, JSON.stringify({ format: 'strata-project', version: 1, name: 'Override', params: { plateCount: '5' } }));
    const out = join(dir, 'out');
    const io = capture();
    expect(await main([project, '--out', out, '--preset', 'Mini waffle'], io)).toBe(0);
    expect(io.err).toBe('');
    const back = deserialize(readFileSync(join(out, 'project.strata.json'), 'utf8'));
    expect(back.params.sliceMode).toBe('waffle');
    expect(back.params.insShape).toBe('none');
    expect(back.params.plateCount).toBe('5');
    expect(back.name).toBe('Override');
    expect(walk(out).some((n) => n.startsWith('laser/parts/') && n.endsWith('.dxf'))).toBe(true);
  });

  it('applies --rates to price-estimate.json', async () => {
    const dir = scratch();
    const rates = join(dir, 'rates.json');
    writeFileSync(rates, JSON.stringify({ machinePerHour: 0, setup: 0, perPart: 0, minimum: 0, vat: 0, waste: 0, perKg: { steel: 0, corten: 0, aluminium: 0 } }));
    const out = join(dir, 'out');
    const io = capture();
    expect(await main([example, '--out', out, '--rates', rates], io)).toBe(0);
    const priced = JSON.parse(readFileSync(join(out, 'price-estimate.json'), 'utf8'));
    expect(priced.total).toBe(0);
    const plain = join(dir, 'plain');
    expect(await main([example, '--out', plain], capture())).toBe(0);
    const normal = JSON.parse(readFileSync(join(plain, 'price-estimate.json'), 'utf8'));
    expect(normal.total).toBeGreaterThan(0);
  });
});

describe('cli master size', () => {
  it('applies --size a4 portrait to the exported project', async () => {
    const dir = scratch();
    const project = join(dir, 'p.json');
    writeFileSync(project, JSON.stringify({ format: 'strata-project', version: 1, preset: 'Mini waffle', params: { plateCount: '9', thickness: '2' } }));
    const out = join(dir, 'out');
    const io = capture();
    expect(await main([project, '--out', out, '--size', 'a4'], io)).toBe(0);
    const back = deserialize(readFileSync(join(out, 'project.strata.json'), 'utf8'));
    expect(back.params.baseWidth).toBe('210');
    expect(back.params.baseLength).toBe('297');
    expect(back.params.masterScale).toBe('1');
    expect(back.params.plateCount).toBe('9');
    expect(back.params.thickness).toBe('2');
    const { values } = evaluateParams(back.params);
    expect(values.baseWidth).toBe(210);
    expect(values.baseLength).toBe(297);
  });

  it('applies --orientation landscape', async () => {
    const dir = scratch();
    const project = join(dir, 'p.json');
    writeFileSync(project, JSON.stringify({ format: 'strata-project', version: 1, preset: 'Mini waffle' }));
    const out = join(dir, 'out');
    expect(await main([project, '--out', out, '--size', 'a4', '--orientation', 'landscape'], capture())).toBe(0);
    const back = deserialize(readFileSync(join(out, 'project.strata.json'), 'utf8'));
    expect(back.params.baseWidth).toBe('297');
    expect(back.params.baseLength).toBe('210');
  });

  it('ratio --size keeps the long edge from the loaded project', async () => {
    const dir = scratch();
    const project = join(dir, 'p.json');
    writeFileSync(
      project,
      JSON.stringify({
        format: 'strata-project',
        version: 1,
        params: { baseLength: '800', baseWidth: '300', masterScale: '0.5', plateCount: '11', thickness: '1.5' },
      }),
    );
    const out = join(dir, 'out');
    expect(await main([project, '--out', out, '--size', '16:9'], capture())).toBe(0);
    const back = deserialize(readFileSync(join(out, 'project.strata.json'), 'utf8'));
    expect(back.params.plateCount).toBe('11');
    expect(back.params.thickness).toBe('1.5');
    const { values } = evaluateParams(back.params);
    expect(values.baseLength).toBeCloseTo(400);
    expect(values.baseWidth).toBeCloseTo(225);
  });

  it('errors on unknown --size and --orientation without --size', async () => {
    const dir = scratch();
    const project = join(dir, 'p.json');
    writeFileSync(project, JSON.stringify({ format: 'strata-project', version: 1, preset: 'Mini waffle' }));
    const io = capture();
    expect(await main([project, '--out', join(dir, 'out'), '--size', 'tabloid'], io)).toBe(1);
    expect(io.err).toMatch(/unknown size 'tabloid'/);
    expect(io.err).toMatch(/iphone-17/);
    expect(() => statSync(join(dir, 'out'))).toThrow();

    const io2 = capture();
    expect(await main([project, '--out', join(dir, 'out2'), '--orientation', 'landscape'], io2)).toBe(1);
    expect(io2.err).toMatch(/--orientation requires --size/);
  });

  it('applyMasterSizeCli resolves iphone-17', () => {
    const { project } = loadProject(JSON.stringify({ format: 'strata-project', version: 1 }));
    applyMasterSizeCli(project, 'iphone-17');
    expect(project.params.baseWidth).toBe('71.5');
    expect(project.params.baseLength).toBe('149.6');
  });
});

describe('cli validation', () => {
  it('exits non-zero on unknown parameters, choices and formula errors, and does not write', async () => {
    const dir = scratch();
    const unknown = join(dir, 'unknown.json');
    writeFileSync(unknown, JSON.stringify({ format: 'strata-project', version: 1, params: { notARealParam: '1', sliceMode: 'sideways' } }));
    const io = capture();
    expect(await main([unknown, '--out', join(dir, 'unknown-out')], io)).toBe(1);
    expect(io.err).toMatch(/unknown parameter 'notARealParam'/);
    expect(io.err).toMatch(/sliceMode: unknown choice 'sideways'/);
    expect(() => statSync(join(dir, 'unknown-out'))).toThrow();

    const formula = join(dir, 'formula.json');
    writeFileSync(formula, JSON.stringify({ format: 'strata-project', version: 1, preset: 'Mini waffle', params: { pitch: 'nope + 1' } }));
    const io2 = capture();
    expect(await main([formula, '--out', join(dir, 'formula-out')], io2)).toBe(1);
    expect(io2.err).toMatch(/pitch: Unknown name 'nope'/);
    expect(() => statSync(join(dir, 'formula-out'))).toThrow();

    const preset = join(dir, 'preset.json');
    writeFileSync(preset, JSON.stringify({ format: 'strata-project', version: 1, preset: 'Not a preset' }));
    const io3 = capture();
    expect(await main([preset, '--out', join(dir, 'preset-out')], io3)).toBe(1);
    expect(io3.err).toMatch(/unknown preset 'Not a preset'/);
  });

  it('warns when a value is clamped and still exports', async () => {
    const dir = scratch();
    const project = join(dir, 'p.json');
    writeFileSync(project, JSON.stringify({ format: 'strata-project', version: 1, preset: 'Mini waffle', params: { baseLength: '9000' } }));
    const out = join(dir, 'out');
    const io = capture();
    expect(await main([project, '--out', out], io)).toBe(0);
    expect(io.err).toMatch(/warning: baseLength was clamped to 3000 \(range 20\.\.3000\)/);
    expect(walk(out)).toContain('laser/sheets/sheet-01.dxf');
    const back = deserialize(readFileSync(join(out, 'project.strata.json'), 'utf8'));
    expect(back.params.baseLength).toBe('9000');
  });
});

describe('cli catalogues', () => {
  it('prints params and presets as JSON from PARAMS and PRESETS', async () => {
    const paramsIo = capture();
    expect(await main(['params'], paramsIo)).toBe(0);
    const params = JSON.parse(paramsIo.out);
    const baseLength = params.find((p: { id: string }) => p.id === 'baseLength');
    expect(baseLength).toEqual({ id: 'baseLength', type: 'number', default: '800', range: [20, 3000], choices: null, group: 'Base', help: null });
    const sliceMode = params.find((p: { id: string }) => p.id === 'sliceMode');
    expect(sliceMode.type).toBe('choice');
    expect(sliceMode.default).toBe('parallel');
    expect(sliceMode.choices).toEqual(['parallel', 'radial', 'waffle', 'flat']);
    expect(sliceMode.group).toBe('Slicer');
    expect(sliceMode.help).toMatch(/Flat stack/);
    expect(params.every((p: { id: string; type: string; group: string }) => p.id && p.type && p.group && 'default' in p && 'range' in p && 'choices' in p && 'help' in p)).toBe(true);

    const presetsIo = capture();
    expect(await main(['presets'], presetsIo)).toBe(0);
    const presets = JSON.parse(presetsIo.out);
    const cliff = presets.find((p: { name: string }) => p.name === 'Image cliff');
    expect(cliff.id).toBe('Image cliff');
    expect(cliff.params.imgSideMode).toBe('heightmap');
    expect(cliff.params.plateCount).toBe('48');
    expect(cliff.small).toBe(false);
    expect(presets.some((p: { name: string; small: boolean }) => p.name === 'Mini waffle' && p.small)).toBe(true);
  });
});

describe('cli images', () => {
  it('decodes a project image and an --image override into the same plates', async () => {
    const dir = scratch();
    const png = join(dir, 'side.png');
    pngFile(png, 32, 16, (x) => (x < 16 ? [0, 0, 0, 255] : [255, 255, 255, 255]));
    const dataUrl = `data:image/png;base64,${readFileSync(png).toString('base64')}`;
    const body = {
      format: 'strata-project',
      version: 1,
      name: 'With side',
      preset: 'Image cliff',
      params: { plateCount: '8' },
      images: { side: { name: 'side.png', dataUrl } },
    };
    const embedded = join(dir, 'embedded.json');
    writeFileSync(embedded, JSON.stringify(body));
    const overridden = join(dir, 'override.json');
    writeFileSync(overridden, JSON.stringify({ ...body, images: {} }));
    const outA = join(dir, 'a');
    const outB = join(dir, 'b');
    const outC = join(dir, 'c');
    expect(await main([embedded, '--out', outA], capture())).toBe(0);
    expect(await main([overridden, '--out', outB, '--image', `side=${png}`], capture())).toBe(0);
    expect(await main([overridden, '--out', outC], capture())).toBe(0);
    const part = (dirPath: string) => {
      const name = walk(dirPath).find((n) => n.startsWith('laser/parts/') && n.endsWith('.dxf'))!;
      return readFileSync(join(dirPath, name), 'utf8');
    };
    expect(part(outA)).toBe(part(outB));
    expect(part(outA)).not.toBe(part(outC));
  });
});

describe('cli map', () => {
  beforeEach(() => setMapTileFetcher(fixtureTileFetcher));
  afterEach(() => setMapTileFetcher(null));

  it('builds Neasden from fixtures offline with --map flags', async () => {
    const dir = scratch();
    const project = join(dir, 'base.json');
    writeFileSync(
      project,
      JSON.stringify({
        format: 'strata-project',
        version: 1,
        preset: 'Stamped stack',
        params: { plateCount: '12', imgTopMode: 'carve', topDepth: '40' },
      }),
    );
    const out = join(dir, 'neasden-out');
    const io = capture();
    const [w, s, e, n] = NEASDEN_BBOX;
    const code = await main(
      [
        project,
        '--out',
        out,
        '--map',
        'Neasden, London',
        '--bbox',
        `${w},${s},${e},${n}`,
        '--map-source',
        'terrarium',
        '--map-res',
        '8',
        '--exaggeration',
        'auto',
        '--engrave',
        'roads,water,title,compass',
      ],
      io,
    );
    expect(io.err).toBe('');
    expect(code).toBe(0);
    const back = deserialize(readFileSync(join(out, 'project.strata.json'), 'utf8'));
    expect(back.images.top?.map?.bbox).toEqual(NEASDEN_BBOX);
    expect(back.images.top?.depth?.w).toBeGreaterThan(32);
    expect(back.images.top?.map?.engrave.enabled).toBe(true);
    expect(walk(out).some((n) => n.startsWith('laser/parts/'))).toBe(true);
  });

  it('exits 1 on a bad bbox', async () => {
    const dir = scratch();
    const project = join(dir, 'p.json');
    writeFileSync(project, JSON.stringify({ format: 'strata-project', version: 1 }));
    const io = capture();
    expect(await main([project, '--out', join(dir, 'out'), '--map', 'X', '--bbox', '0,0,0,1'], io)).toBe(1);
    expect(io.err).toMatch(/invalid bbox/i);
  });

  it('accepts cop30 but reports not yet implemented', async () => {
    const dir = scratch();
    const project = join(dir, 'p.json');
    writeFileSync(project, JSON.stringify({ format: 'strata-project', version: 1 }));
    const io = capture();
    const [w, s, e, n] = NEASDEN_BBOX;
    expect(
      await main([project, '--out', join(dir, 'out'), '--map', 'T', '--bbox', `${w},${s},${e},${n}`, '--map-source', 'cop30'],
        io,
      ),
    ).toBe(1);
    expect(io.err).toMatch(/not yet implemented/i);
  });

  it('defaults engraving on when --engrave is omitted', () => {
    const args = parseCliArgs(['p.json', '--out', 'x', '--map', 'T', '--bbox', '0,0,1,1']);
    expect(args.map?.engrave.enabled).toBe(true);
  });
});

describe('cli auto-dimension', () => {
  it('mentions --auto-dimension in help', async () => {
    const io = capture();
    expect(await main(['help'], io)).toBe(0);
    expect(io.out).toMatch(/--auto-dimension/);
    expect(io.out).toMatch(/--relief-exaggeration/);
  });
});

describe('cli script', () => {
  it('runs under tsx', () => {
    const out = execFileSync('npx', ['tsx', 'src/cli.ts', 'presets'], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' });
    const presets = JSON.parse(out);
    expect(presets.some((p: { name: string }) => p.name === 'Image cliff')).toBe(true);
  });
});
