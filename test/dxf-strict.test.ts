import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import { createPipeline, type Assets } from '../src/core/pipeline';
import { newProject } from '../src/core/project';
import { buildZip } from '../src/core/exporters';
import { DxfWriter, LAYERS, assertStrictDxfR2000 } from '../src/core/dxf';
import { GABRIEL_PARAMS, sliverFrontGray, sliverSideGray } from './image-sliver-fixture';

const empty: Assets = { sideImg: null, frontImg: null, topImg: null, insMesh: null, srcMesh: null };

function ezdxfRead(text: string) {
  const dir = mkdtempSync(join(tmpdir(), 'strata-dxf-'));
  const path = join(dir, 'part.dxf');
  writeFileSync(path, text);
  try {
    const py = `
import ezdxf, sys
ezdxf.readfile(sys.argv[1])
`;
    const r = spawnSync('python3', ['-c', py, path], { encoding: 'utf8' });
    return r;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('DXF R2000 strict', { timeout: 60_000 }, () => {
  it('emits AcDbEntity / AcDbPolyline / handles on a writer sample', () => {
    const w = new DxfWriter([LAYERS.CUT]);
    w.polyline(LAYERS.CUT.name, [
      { kind: 'line', a: [0, 0], b: [10, 0] },
      { kind: 'line', a: [10, 0], b: [10, 10] },
      { kind: 'line', a: [10, 10], b: [0, 10] },
      { kind: 'line', a: [0, 10], b: [0, 0] },
    ], true);
    w.circle(LAYERS.CUT.name, 4, 4, 1);
    const text = w.toString();
    expect(text).toContain('AC1015');
    expect(text).toMatch(/100\nAcDbEntity/);
    expect(text).toMatch(/100\nAcDbPolyline/);
    expect(text).toMatch(/100\nAcDbCircle/);
    assertStrictDxfR2000(text);
    const r = ezdxfRead(text);
    if (r.error && /No such file|not found/i.test(r.error.message)) {
      throw new Error('python3 is required to open DXFs with ezdxf');
    }
    if (r.status !== 0 && /ModuleNotFoundError|No module named 'ezdxf'/.test(r.stderr + r.stdout)) {
      const inst = spawnSync('python3', ['-m', 'pip', 'install', '--user', 'ezdxf'], { encoding: 'utf8' });
      expect(inst.status, inst.stderr).toBe(0);
      const r2 = ezdxfRead(text);
      expect(r2.status, r2.stderr).toBe(0);
    } else {
      expect(r.status, r.stderr).toBe(0);
    }
  });

  it('opens every exported DXF from default and image packs without recover', () => {
    const jobs = [
      createPipeline()(newProject(), empty),
      (() => {
        const p = newProject();
        p.params = { ...p.params, ...GABRIEL_PARAMS, fragmentMode: 'auto' };
        return createPipeline()(p, {
          sideImg: sliverSideGray(),
          frontImg: sliverFrontGray(),
          topImg: null,
          insMesh: null,
          srcMesh: null,
        });
      })(),
    ];
    let n = 0;
    for (const m of jobs) {
      const files = unzipSync(buildZip(m, newProject()));
      for (const name of Object.keys(files).filter((k) => k.endsWith('.dxf'))) {
        const text = strFromU8(files[name]);
        expect(text, name).toContain('AC1015');
        assertStrictDxfR2000(text);
        n++;
      }
    }
    expect(n).toBeGreaterThan(10);
  });
});
