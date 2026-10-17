import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { newProject, serialize } from '../src/core/project';
import {
  assertProjectId,
  blobProjectStore,
  createProjectStore,
  fileProjectStore,
  hasBlobCreds,
  memoryBlobBackend,
  memoryProjectStore,
  resetProjectStoreSingleton,
  StoreNotConfiguredError,
} from '../api/_lib/projectStore';

const dirs: string[] = [];
afterEach(() => {
  resetProjectStoreSingleton();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'strata-projects-'));
  dirs.push(dir);
  return dir;
}

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function sampleProject() {
  const p = {
    ...newProject(),
    name: 'Cloud Roundtrip',
    params: { ...newProject().params, plateCount: '11' },
    userParamOverrides: { plateCount: true as const },
    images: { top: { name: 'dot.png', dataUrl: PNG } },
  };
  return { project: p, data: serialize(p) };
}

describe('project store', () => {
  it('rejects path-traversal ids', () => {
    expect(() => assertProjectId('../etc')).toThrow(/Invalid project id/);
    expect(() => assertProjectId('pabc_1')).not.toThrow();
  });

  it('round-trips project JSON with images and user overrides (memory, file, mock Blob)', async () => {
    const { project, data } = sampleProject();
    const now = 1_700_000_000_000;
    const meta = {
      id: 'pround1',
      name: project.name,
      savedAt: now,
      openedAt: now,
      updatedAt: now,
      size: data.length,
      thumb: 'data:image/jpeg;base64,xx',
    };
    const stores = [memoryProjectStore(), fileProjectStore(scratch()), blobProjectStore(memoryBlobBackend())];
    for (const store of stores) {
      await store.put(meta, data);
      const list = await store.list();
      expect(list).toHaveLength(1);
      expect(list[0].name).toBe('Cloud Roundtrip');
      expect(list[0].thumb).toBe('data:image/jpeg;base64,xx');
      const back = JSON.parse((await store.getData(meta.id))!);
      expect(back.params.plateCount).toBe('11');
      expect(back.userParamOverrides.plateCount).toBe(true);
      expect(back.images.top.dataUrl).toBe(PNG);
      await store.remove(meta.id);
      expect(await store.list()).toEqual([]);
    }
  });

  it('two file-store instances share the same directory', async () => {
    const dir = scratch();
    const a = fileProjectStore(dir);
    const b = fileProjectStore(dir);
    const { data } = sampleProject();
    await a.put({ id: 'pshare', name: 'Shared', savedAt: 1, openedAt: 1, updatedAt: 1, size: data.length }, data);
    expect((await b.getMeta('pshare'))?.name).toBe('Shared');
    expect(await b.getData('pshare')).toBe(data);
  });

  it('detects Blob credentials and refuses a Vercel deploy with no store', async () => {
    expect(hasBlobCreds({})).toBe(false);
    expect(hasBlobCreds({ BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_x' })).toBe(true);
    expect(hasBlobCreds({ BLOB_STORE_ID: 'store_1', VERCEL_OIDC_TOKEN: 'oidc' })).toBe(true);
    const store = createProjectStore({ VERCEL: '1' }) as { list: () => Promise<unknown> };
    await expect(store.list()).rejects.toBeInstanceOf(StoreNotConfiguredError);
  });

  it('uses a file store when STRATA_PROJECTS_DIR is set', async () => {
    const dir = scratch();
    const store = createProjectStore({ STRATA_PROJECTS_DIR: dir });
    const { data } = sampleProject();
    await (await store).put({ id: 'pdir', name: 'Dir', savedAt: 2, openedAt: 2, size: data.length }, data);
    expect((await fileProjectStore(dir).getMeta('pdir'))?.name).toBe('Dir');
  });
});
