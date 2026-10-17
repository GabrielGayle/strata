import { beforeEach, describe, expect, it } from 'vitest';
import { handleProjectsApi } from '../api/_lib/projectsApi';
import { memoryProjectStore } from '../api/_lib/projectStore';
import { newProject, serialize } from '../src/core/project';
import { createCloudLibrary } from '../src/state/cloudLibrary';
import { cloudSyncLabel, getCloudSync, setCloudSync, subscribeCloudWarning, takeCloudWarning } from '../src/state/cloudSync';
import { flushPendingUploads, hybridLibrary, resetHybridSyncers, startPendingRetry } from '../src/state/hybridLibrary';
import { fingerprint, memoryLibrary, openEntry, saveAs, saveOver } from '../src/state/library';
import { memoryStorage, readPending, writePending } from '../src/state/pendingUploads';

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

function gatedFetch(store: ReturnType<typeof memoryProjectStore>, gate: { fail: boolean }): typeof fetch {
  const inner = fakeFetch(store);
  return (async (input, init) => {
    if (gate.fail) throw new Error('Failed to fetch');
    return inner(input, init);
  }) as typeof fetch;
}

beforeEach(() => {
  resetHybridSyncers();
  setCloudSync('locked');
});

describe('pending cloud uploads', () => {
  it('labels pending and offline as not yet Cloud saved', () => {
    expect(cloudSyncLabel('saved')).toBe('Cloud saved');
    expect(cloudSyncLabel('pending')).toBe('Pending sync');
    expect(cloudSyncLabel('offline')).toBe('Offline, not synced');
  });

  it('queues a save when the API is down and uploads it on flush without saving again', async () => {
    const blob = memoryProjectStore();
    const local = memoryLibrary();
    const storage = memoryStorage();
    const gate = { fail: false };
    const cloud = createCloudLibrary({ fetch: gatedFetch(blob, gate), token: () => TOKEN });
    const hybrid = hybridLibrary(local, cloud, () => TOKEN, { storage });

    const first = { ...newProject(), name: 'Vermilion 40', params: { ...newProject().params, plateCount: '40' } };
    const { meta } = await saveAs(hybrid, first, 'Vermilion 40', undefined, 10);
    expect(JSON.parse((await blob.getData(meta.id))!).params.plateCount).toBe('40');
    expect(readPending(storage)).toEqual([]);
    expect(getCloudSync().status).toBe('saved');

    gate.fail = true;
    const next = { ...first, params: { ...first.params, plateCount: '17' } };
    const saved = await saveOver(hybrid, meta.id, next, undefined, 20);
    expect(saved).toBeTruthy();
    expect(JSON.parse((await local.getData(meta.id))!).params.plateCount).toBe('17');
    expect(JSON.parse((await blob.getData(meta.id))!).params.plateCount).toBe('40');
    expect(readPending(storage).map((p) => p.id)).toEqual([meta.id]);
    expect(getCloudSync().status).toMatch(/offline|pending/);
    expect(getCloudSync().status).not.toBe('saved');

    gate.fail = false;
    await flushPendingUploads();
    expect(readPending(storage)).toEqual([]);
    expect(JSON.parse((await blob.getData(meta.id))!).params.plateCount).toBe('17');
    expect(getCloudSync().status).toBe('saved');
  });

  it('restores the queue from storage after a reload and then catches up', async () => {
    const blob = memoryProjectStore();
    const local = memoryLibrary();
    const storage = memoryStorage();
    const gate = { fail: true };
    const cloud = createCloudLibrary({ fetch: gatedFetch(blob, gate), token: () => TOKEN });
    const hybrid = hybridLibrary(local, cloud, () => TOKEN, { storage });
    const p = { ...newProject(), name: 'Keep me', params: { ...newProject().params, plateCount: '17' } };
    await saveAs(hybrid, p, 'Keep me', undefined, 10);
    expect(readPending(storage).length).toBe(1);
    expect(await blob.list()).toEqual([]);

    resetHybridSyncers();
    gate.fail = false;
    const cloud2 = createCloudLibrary({ fetch: gatedFetch(blob, gate), token: () => TOKEN });
    hybridLibrary(local, cloud2, () => TOKEN, { storage });
    await flushPendingUploads();
    const listed = await blob.list();
    expect(listed).toHaveLength(1);
    expect(JSON.parse((await blob.getData(listed[0].id))!).params.plateCount).toBe('17');
    expect(readPending(storage)).toEqual([]);
  });

  it('keeps both copies when the cloud project changed while a save was queued', async () => {
    const blob = memoryProjectStore();
    const local = memoryLibrary();
    const storage = memoryStorage();
    const gate = { fail: false };
    const cloud = createCloudLibrary({ fetch: gatedFetch(blob, gate), token: () => TOKEN });
    const hybrid = hybridLibrary(local, cloud, () => TOKEN, { storage });

    const first = { ...newProject(), name: 'Vermilion 40', params: { ...newProject().params, plateCount: '40' } };
    const { meta } = await saveAs(hybrid, first, 'Vermilion 40', undefined, 10);

    const elsewhere = { ...newProject(), name: 'Vermilion 40', params: { ...newProject().params, plateCount: '23' } };
    const elsewhereData = serialize(elsewhere);
    await blob.put({ ...meta, updatedAt: 9_000, savedAt: 9_000, size: elsewhereData.length }, elsewhereData);
    expect(fingerprint(elsewhereData)).not.toBe(fingerprint(serialize(first)));

    gate.fail = true;
    const localEdit = { ...first, params: { ...first.params, plateCount: '17' } };
    await saveOver(hybrid, meta.id, localEdit, undefined, 20);
    expect(readPending(storage).length).toBe(1);

    gate.fail = false;
    const seen: string[] = [];
    const stopWarn = subscribeCloudWarning(() => {
      const w = takeCloudWarning();
      if (w) seen.push(w);
    });
    await flushPendingUploads();
    stopWarn();
    expect(readPending(storage)).toEqual([]);
    expect(JSON.parse((await blob.getData(meta.id))!).params.plateCount).toBe('17');
    const names = (await blob.list()).map((m) => m.name).sort();
    expect(names).toContain('Vermilion 40');
    expect(names.length).toBe(2);
    const other = (await blob.list()).find((m) => m.id !== meta.id)!;
    expect(JSON.parse((await blob.getData(other.id))!).params.plateCount).toBe('23');
    expect(seen.some((s) => /Kept it as/.test(s))).toBe(true);
  });

  it('does not clobber a pending local copy when listing or opening from the cloud', async () => {
    const blob = memoryProjectStore();
    const local = memoryLibrary();
    const storage = memoryStorage();
    const gate = { fail: false };
    const cloud = createCloudLibrary({ fetch: gatedFetch(blob, gate), token: () => TOKEN });
    const hybrid = hybridLibrary(local, cloud, () => TOKEN, { storage });
    const first = { ...newProject(), name: 'Stay', params: { ...newProject().params, plateCount: '40' } };
    const { meta } = await saveAs(hybrid, first, 'Stay', undefined, 10);
    gate.fail = true;
    await saveOver(hybrid, meta.id, { ...first, params: { ...first.params, plateCount: '17' } }, undefined, 20);
    const listed = await hybrid.list();
    expect(listed.find((m) => m.id === meta.id)?.size).toBe((await local.getMeta(meta.id))!.size);
    expect(getCloudSync().status).not.toBe('saved');
    const opened = await openEntry(hybrid, meta.id);
    expect(opened.project.params.plateCount).toBe('17');
    expect(JSON.parse((await blob.getData(meta.id))!).params.plateCount).toBe('40');
    writePending([], storage);
  });

  it('arms backoff after a failed put without an online or focus event', async () => {
    const blob = memoryProjectStore();
    const local = memoryLibrary();
    const storage = memoryStorage();
    const gate = { fail: false };
    const cloud = createCloudLibrary({ fetch: gatedFetch(blob, gate), token: () => TOKEN });
    const hybrid = hybridLibrary(local, cloud, () => TOKEN, { storage });

    const queued: Array<() => void> = [];
    const target = {
      addEventListener() {},
      removeEventListener() {},
      setTimeout(fn: () => void) {
        queued.push(fn);
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clearTimeout() {},
    };
    const stop = startPendingRetry(target as unknown as Window);
    const first = { ...newProject(), name: 'Backoff', params: { ...newProject().params, plateCount: '11' } };
    const { meta } = await saveAs(hybrid, first, 'Backoff', undefined, 10);
    expect(queued).toHaveLength(0);

    gate.fail = true;
    await saveOver(hybrid, meta.id, { ...first, params: { ...first.params, plateCount: '17' } }, undefined, 20);
    expect(readPending(storage).length).toBe(1);
    expect(queued.length).toBeGreaterThan(0);

    gate.fail = false;
    const run = queued[0];
    queued.length = 0;
    run();
    await flushPendingUploads();
    expect(readPending(storage)).toEqual([]);
    expect(JSON.parse((await blob.getData(meta.id))!).params.plateCount).toBe('17');
    stop();
  });
});
