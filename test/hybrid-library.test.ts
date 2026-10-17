import { describe, expect, it } from 'vitest';
import { handleProjectsApi } from '../api/_lib/projectsApi';
import { memoryProjectStore } from '../api/_lib/projectStore';
import { newProject } from '../src/core/project';
import { createCloudLibrary } from '../src/state/cloudLibrary';
import { hybridLibrary, localProjectsPendingMigration, migrateLocalToCloud } from '../src/state/hybridLibrary';
import { memoryLibrary, openEntry, saveAs } from '../src/state/library';
import { setCloudSync } from '../src/state/cloudSync';

const TOKEN = 'hybrid-token';
const env = { STRATA_OWNER_TOKEN: TOKEN };

function fakeFetch(store: ReturnType<typeof memoryProjectStore>): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://127.0.0.1');
    const result = await handleProjectsApi(
      {
        method: init?.method ?? 'GET',
        id: url.searchParams.get('id') ?? undefined,
        authorization: new Headers(init?.headers).get('Authorization') ?? undefined,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      },
      { store, env },
    );
    return new Response(JSON.stringify(result.json), { status: result.status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}

describe('hybrid library', () => {
  it('keeps the local copy when the cloud write fails', async () => {
    setCloudSync('locked');
    const local = memoryLibrary();
    const cloud = createCloudLibrary({
      token: () => TOKEN,
      fetch: async () => {
        throw new Error('Failed to fetch');
      },
    });
    const hybrid = hybridLibrary(local, cloud, () => TOKEN);
    const p = { ...newProject(), name: 'Keep me' };
    await expect(saveAs(hybrid, p, 'Keep me', undefined, 10)).rejects.toThrow(/cloud copy failed/);
    const opened = await openEntry(local, (await local.list())[0].id);
    expect(opened.project.name).toBe('Keep me');
  });

  it('lists cloud projects through the API and migrates local-only entries', async () => {
    const blob = memoryProjectStore();
    const local = memoryLibrary();
    const cloud = createCloudLibrary({ fetch: fakeFetch(blob), token: () => TOKEN });
    await saveAs(local, { ...newProject(), name: 'Local only', images: { top: { name: 't.png', dataUrl: 'data:image/png;base64,AAAA' } } }, 'Local only', 'thumb', 1);
    const r = await migrateLocalToCloud(local, cloud);
    expect(r.added).toEqual(['Local only']);
    const hybrid = hybridLibrary(local, cloud, () => TOKEN);
    const list = await hybrid.list();
    expect(list.map((m) => m.name)).toEqual(['Local only']);
    const opened = await openEntry(hybrid, list[0].id);
    expect(opened.project.images.top?.dataUrl).toBe('data:image/png;base64,AAAA');
    expect(localProjectsPendingMigration(await local.list(), list)).toEqual([]);
  });

  it('saves without a token as local-only', async () => {
    const local = memoryLibrary();
    const blob = memoryProjectStore();
    const cloud = createCloudLibrary({ fetch: fakeFetch(blob), token: () => null });
    const hybrid = hybridLibrary(local, cloud, () => null);
    const { meta } = await saveAs(hybrid, newProject(), 'Offline', undefined, 3);
    expect((await local.getMeta(meta.id))?.name).toBe('Offline');
    expect(await blob.list()).toEqual([]);
  });

  it('round-trips plateCount overrides through the cloud client', async () => {
    const blob = memoryProjectStore();
    const cloud = createCloudLibrary({ fetch: fakeFetch(blob), token: () => TOKEN });
    const p = { ...newProject(), name: 'Eleven', params: { ...newProject().params, plateCount: '11' }, userParamOverrides: { plateCount: true as const } };
    const { meta } = await saveAs(cloud, p, 'Eleven', undefined, 9);
    const data = await cloud.getData(meta.id);
    expect(JSON.parse(data!).userParamOverrides.plateCount).toBe(true);
    expect(JSON.parse(data!).params.plateCount).toBe('11');
  });
});
