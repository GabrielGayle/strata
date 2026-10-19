import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OVERPASS_PROXY_MAX_BODY_BYTES,
  handleOverpassProxy,
  isAllowedOverpassOrigin,
  overpassQueryProblem,
  type OverpassProxyRequest,
} from '../api/_lib/overpassProxy';
import { OverpassFetchError, resetOverpassInflight } from '../src/core/mapOverpassFetch';
import { overpassQueryForBbox } from '../src/core/mapOverpass';
import { NEASDEN_BBOX } from './map-fixtures';

afterEach(() => resetOverpassInflight());

const QUERY = overpassQueryForBbox(NEASDEN_BBOX, ['buildings', 'golf', 'ski']);

function post(body: unknown, over: Partial<OverpassProxyRequest> = {}): OverpassProxyRequest {
  return {
    method: 'POST',
    origin: 'https://strata-gamma-one.vercel.app',
    host: 'strata-gamma-one.vercel.app',
    contentType: 'application/x-www-form-urlencoded',
    body,
    ...over,
  };
}

const form = (q: string) => `data=${encodeURIComponent(q)}`;

describe('Overpass proxy origin check', () => {
  it('allows the app on its own host and local dev servers', () => {
    expect(isAllowedOverpassOrigin({ origin: 'https://strata-gamma-one.vercel.app', host: 'strata-gamma-one.vercel.app' })).toBe(true);
    expect(isAllowedOverpassOrigin({ origin: 'https://strata-git-x.vercel.app', host: 'strata-git-x.vercel.app' })).toBe(true);
    expect(isAllowedOverpassOrigin({ origin: 'http://localhost:5173', host: 'localhost:5173' })).toBe(true);
    expect(isAllowedOverpassOrigin({ origin: 'http://127.0.0.1:4173', host: '127.0.0.1:4173' })).toBe(true);
    expect(isAllowedOverpassOrigin({ secFetchSite: 'same-origin', host: 'strata-gamma-one.vercel.app' })).toBe(true);
  });

  it('refuses other sites and requests with no origin at all', () => {
    expect(isAllowedOverpassOrigin({ origin: 'https://evil.example', host: 'strata-gamma-one.vercel.app' })).toBe(false);
    expect(isAllowedOverpassOrigin({ origin: 'https://strata-gamma-one.vercel.app.evil.example', host: 'strata-gamma-one.vercel.app' })).toBe(false);
    expect(isAllowedOverpassOrigin({ origin: 'null', host: 'strata-gamma-one.vercel.app' })).toBe(false);
    expect(isAllowedOverpassOrigin({ host: 'strata-gamma-one.vercel.app' })).toBe(false);
    expect(isAllowedOverpassOrigin({ secFetchSite: 'cross-site', host: 'strata-gamma-one.vercel.app' })).toBe(false);
  });
});

describe('Overpass query shape', () => {
  it("accepts Strata's own queries", () => {
    expect(overpassQueryProblem(QUERY)).toBeNull();
    expect(overpassQueryProblem(overpassQueryForBbox(NEASDEN_BBOX))).toBeNull();
  });

  it('refuses other outputs, long timeouts, maxsize and missing out statements', () => {
    expect(overpassQueryProblem('[out:xml][timeout:25];node(1,2,3,4);out;')).toMatch(/out:json/);
    expect(overpassQueryProblem('[out:json][timeout:900];node(1,2,3,4);out;')).toMatch(/timeout/);
    expect(overpassQueryProblem('[out:json][timeout:25][maxsize:2000000000];node(1,2,3,4);out;')).toMatch(/maxsize/);
    expect(overpassQueryProblem('[out:json][timeout:25];node(1,2,3,4);')).toMatch(/out statement/);
  });
});

describe('Overpass proxy handler', () => {
  it('answers a good query from the first mirror that replies', async () => {
    const run = vi.fn(async () => ({ elements: [] }));
    const out = await handleOverpassProxy(post(form(QUERY)), run);
    expect(out.status).toBe(200);
    expect(out.contentType).toBe('application/json');
    expect(JSON.parse(out.body)).toEqual({ elements: [] });
    expect(run).toHaveBeenCalledWith(QUERY);
  });

  it('accepts the object Vercel parses a form body into', async () => {
    const run = vi.fn(async () => ({ elements: [] }));
    expect((await handleOverpassProxy(post({ data: QUERY }), run)).status).toBe(200);
  });

  it('refuses a foreign origin before any upstream request', async () => {
    const run = vi.fn();
    const out = await handleOverpassProxy(post(form(QUERY), { origin: 'https://evil.example' }), run);
    expect(out.status).toBe(403);
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses a body over the cap', async () => {
    const run = vi.fn();
    const big = `${QUERY}${' '.repeat(OVERPASS_PROXY_MAX_BODY_BYTES)}`;
    const out = await handleOverpassProxy(post(form(big)), run);
    expect(out.status).toBe(413);
    expect(run).not.toHaveBeenCalled();
  });

  it('refuses a malformed query with no upstream request', async () => {
    const run = vi.fn();
    const out = await handleOverpassProxy(post(form('[out:json][timeout:600];way;out;')), run);
    expect(out.status).toBe(400);
    expect(run).not.toHaveBeenCalled();
  });

  it('passes an upstream 400 through as 400 so the browser does not retry', async () => {
    const out = await handleOverpassProxy(post(form(QUERY)), async () => {
      throw new OverpassFetchError('Overpass failed (400) at mirror', 400);
    });
    expect(out.status).toBe(400);
  });

  it('answers 502 when every mirror is down, and 405 to anything but POST', async () => {
    const down = await handleOverpassProxy(post(form(QUERY)), async () => {
      throw new OverpassFetchError('Overpass timeout', 408);
    });
    expect(down.status).toBe(502);
    expect((await handleOverpassProxy(post(null, { method: 'GET' }))).status).toBe(405);
    expect((await handleOverpassProxy(post(null, { method: 'OPTIONS' }))).status).toBe(405);
  });
});
