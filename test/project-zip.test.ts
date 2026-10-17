import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { createPipeline, type Assets } from '../src/core/pipeline';
import { deserialize, newProject } from '../src/core/project';
import { buildZip } from '../src/core/exporters';
import { projectFromZip, projectOnlyZip, projectZipEntry, ProjectZipError } from '../src/core/projectZip';

const assets: Assets = { sideImg: null, frontImg: null, topImg: null, insMesh: null, srcMesh: null };
const oldJson = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/projects/old-coarse.strata.json'), 'utf8');

describe('project zip', () => {
  it('finds project.strata.json even under a folder or Windows path', () => {
    expect(projectZipEntry(['README.txt', 'pack/project.strata.json'])).toBe('pack/project.strata.json');
    expect(projectZipEntry(['laser\\parts\\a.dxf', 'out\\project.strata.json'])).toBe('out\\project.strata.json');
  });

  it('opens a current fabrication zip and keeps plateCount plus overrides', () => {
    const p = newProject();
    p.name = 'Roundtrip';
    p.params = { ...p.params, plateCount: '11', insShape: 'none' };
    p.userParamOverrides = { plateCount: true };
    p.images = {
      top: {
        name: 'dot.png',
        dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      },
    };
    const model = createPipeline()(p, assets);
    expect(model.sliced.plates.length).toBe(11);
    const zip = buildZip(model, p);
    const opened = projectFromZip(zip);
    expect(opened.entry).toBe('project.strata.json');
    expect(opened.project.params.plateCount).toBe('11');
    expect(opened.project.userParamOverrides?.plateCount).toBe(true);
    expect(opened.project.images.top?.dataUrl).toContain('data:image/png');
    const model2 = createPipeline()(opened.project, assets);
    expect(model2.sliced.plates.length).toBe(model.sliced.plates.length);
    expect(model2.sliced.parts.length).toBe(model.sliced.parts.length);
    const zip2 = buildZip(model2, opened.project);
    const back = deserialize(strFromU8(unzipSync(zip2)['project.strata.json']));
    expect(back.userParamOverrides?.plateCount).toBe(true);
  });

  it('opens an older coarse zip (project.strata.json only) and migrates missing fields', () => {
    const zip = zipSync({
      'README.txt': strToU8('Strata fabrication pack'),
      'nested/project.strata.json': strToU8(oldJson),
    });
    const opened = projectFromZip(zip);
    expect(opened.project.name).toBe('Coarse Oct 16');
    expect(opened.project.params.plateCount).toBe('11');
    expect(opened.project.userParamOverrides?.plateCount).toBe(true);
    expect(opened.project.images.top?.depth?.settings.near).toBe(3.25);
    expect(opened.project.images.top?.depth?.settings.far).toBe(14.5);
    expect(opened.project.images.top?.depth?.settingsOverrides?.near).toBe(true);
    expect(opened.project.images.top?.depth?.settingsOverrides?.far).toBe(true);
    // schema migration: current default params still present
    expect(opened.project.params.thickness).toBeDefined();
    expect(opened.project.format).toBe('strata-project');
  });

  it('rejects a zip with no project file', () => {
    const zip = zipSync({ 'README.txt': strToU8('nope') });
    expect(() => projectFromZip(zip)).toThrow(ProjectZipError);
    expect(() => projectFromZip(new Uint8Array([1, 2, 3, 4]))).toThrow(/not a readable zip/);
  });

  it('projectOnlyZip round-trips through projectFromZip', () => {
    const p = deserialize(oldJson);
    const opened = projectFromZip(projectOnlyZip(p));
    expect(opened.project.userParamOverrides?.plateCount).toBe(true);
    expect(opened.project.images.top?.depth?.settingsOverrides?.near).toBe(true);
  });
});
