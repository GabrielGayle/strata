import { afterEach, describe, expect, it, vi } from 'vitest';
import { nominatimBbox, searchNominatim, setNominatimFetcher, STRATA_NOMINATIM_UA } from '../src/core/mapNominatim';

describe('map Nominatim (T8)', () => {
  afterEach(() => {
    setNominatimFetcher(null);
    vi.useRealTimers();
  });

  it('parses bounding boxes south,north,west,east', () => {
    const bbox = nominatimBbox({
      display_name: 'Test',
      lat: '51.5',
      lon: '-0.1',
      boundingbox: ['51.4', '51.6', '-0.2', '0.0'],
    });
    expect(bbox).toEqual([-0.2, 51.4, 0, 51.6]);
  });

  it('throttles to at least 1s between searches', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    setNominatimFetcher(async (url) => {
      calls.push(url);
      return [{ display_name: 'A', lat: '0', lon: '0', boundingbox: ['0', '1', '0', '1'] }];
    });
    const p1 = searchNominatim('a');
    await vi.runOnlyPendingTimersAsync();
    await p1;
    const p2 = searchNominatim('b');
    await vi.advanceTimersByTimeAsync(999);
    let done = false;
    p2.then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(1);
    await p2;
    expect(done).toBe(true);
    expect(calls.length).toBe(2);
  });

  it('documents a Strata User-Agent constant', () => {
    expect(STRATA_NOMINATIM_UA).toMatch(/StrataMap/);
  });
});
