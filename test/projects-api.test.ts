import { describe, expect, it } from 'vitest';
import { handleProjectsApi } from '../api/_lib/projectsApi';
import { memoryProjectStore } from '../api/_lib/projectStore';
import { newProject, serialize } from '../src/core/project';

const TOKEN = 'owner-secret';
const env = { STRATA_OWNER_TOKEN: TOKEN };
const auth = `Bearer ${TOKEN}`;
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function projectData() {
  const p = {
    ...newProject(),
    name: 'Api Project',
    params: { ...newProject().params, plateCount: '11' },
    userParamOverrides: { plateCount: true as const },
    images: { top: { name: 'dot.png', dataUrl: PNG } },
  };
  return serialize(p);
}

describe('owner token gate', () => {
  it('returns 503 when STRATA_OWNER_TOKEN is unset', async () => {
    const r = await handleProjectsApi({ method: 'GET' }, { store: memoryProjectStore(), env: {} });
    expect(r.status).toBe(503);
    expect(JSON.stringify(r.json)).toMatch(/STRATA_OWNER_TOKEN/);
  });

  it('returns 401 without a bearer token or with the wrong one', async () => {
    const store = memoryProjectStore();
    expect((await handleProjectsApi({ method: 'GET' }, { store, env })).status).toBe(401);
    expect((await handleProjectsApi({ method: 'GET', authorization: 'Bearer nope' }, { store, env })).status).toBe(401);
  });
});

describe('/api/projects', () => {
  it('lists, saves, reads, warns on a newer cloud copy, then deletes', async () => {
    const store = memoryProjectStore();
    const data = projectData();
    const meta = { id: 'p1', name: 'Api Project', savedAt: 100, openedAt: 100, updatedAt: 100, size: data.length, thumb: 't' };

    expect((await handleProjectsApi({ method: 'GET', authorization: auth }, { store, env })).json).toEqual({ entries: [] });

    const created = await handleProjectsApi(
      { method: 'PUT', id: 'p1', authorization: auth, body: { meta, data } },
      { store, env, now: 100 },
    );
    expect(created.status).toBe(200);
    expect((created.json as { overwrittenNewer: boolean }).overwrittenNewer).toBe(false);

    const listed = await handleProjectsApi({ method: 'GET', authorization: auth }, { store, env });
    expect((listed.json as { entries: { name: string }[] }).entries[0].name).toBe('Api Project');

    const got = await handleProjectsApi({ method: 'GET', id: 'p1', authorization: auth }, { store, env });
    expect(got.status).toBe(200);
    const body = got.json as { data: string; meta: { thumb?: string } };
    const parsed = JSON.parse(body.data);
    expect(parsed.params.plateCount).toBe('11');
    expect(parsed.userParamOverrides.plateCount).toBe(true);
    expect(parsed.images.top.dataUrl).toBe(PNG);
    expect(body.meta.thumb).toBe('t');

    const newer = { ...meta, updatedAt: 500, savedAt: 500 };
    const clash = await handleProjectsApi(
      { method: 'PUT', id: 'p1', authorization: auth, body: { meta: newer, data, baseUpdatedAt: 50 } },
      { store, env, now: 500 },
    );
    expect(clash.status).toBe(200);
    expect((clash.json as { overwrittenNewer: boolean }).overwrittenNewer).toBe(true);

    const ok = await handleProjectsApi(
      { method: 'PUT', id: 'p1', authorization: auth, body: { meta: { ...newer, updatedAt: 600 }, data, baseUpdatedAt: 500 } },
      { store, env, now: 600 },
    );
    expect((ok.json as { overwrittenNewer: boolean }).overwrittenNewer).toBe(false);

    expect((await handleProjectsApi({ method: 'DELETE', id: 'p1', authorization: auth }, { store, env })).status).toBe(200);
    expect((await handleProjectsApi({ method: 'GET', id: 'p1', authorization: auth }, { store, env })).status).toBe(404);
  });

  it('rejects a bad id and a PUT without meta', async () => {
    const store = memoryProjectStore();
    expect((await handleProjectsApi({ method: 'GET', id: '../x', authorization: auth }, { store, env })).status).toBe(400);
    expect((await handleProjectsApi({ method: 'PUT', id: 'p1', authorization: auth, body: {} }, { store, env })).status).toBe(400);
  });
});
