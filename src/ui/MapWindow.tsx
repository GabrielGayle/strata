import { useCallback, useState } from 'react';
import { defaultMapSpec, type MapModel, type MapSpec } from '../core/mapSpec';
import { nominatimBbox, searchNominatim, type NominatimPlace } from '../core/mapNominatim';
import { useStore } from '../state/store';

function parseBboxFields(w: string, s: string, e: string, n: string): MapSpec['bbox'] | null {
  const west = Number(w);
  const south = Number(s);
  const east = Number(e);
  const north = Number(n);
  if (![west, south, east, north].every(Number.isFinite)) return null;
  if (west >= east || south >= north) return null;
  return [west, south, east, north];
}

export default function MapWindow({ onClose }: { onClose: () => void }) {
  const project = useStore((s) => s.project);
  const setTopMap = useStore((s) => s.setTopMap);
  const existing = project.images.top?.map;
  const [title, setTitle] = useState(existing?.title ?? project.name ?? 'Map terrain');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<NominatimPlace[]>([]);
  const [west, setWest] = useState(String(existing?.bbox?.[0] ?? ''));
  const [south, setSouth] = useState(String(existing?.bbox?.[1] ?? ''));
  const [east, setEast] = useState(String(existing?.bbox?.[2] ?? ''));
  const [north, setNorth] = useState(String(existing?.bbox?.[3] ?? ''));
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [model, setModel] = useState<MapModel>(existing?.model ?? 'dtm');

  const applyBbox = useCallback(
    (bbox: MapSpec['bbox']) => {
      setWest(String(bbox[0]));
      setSouth(String(bbox[1]));
      setEast(String(bbox[2]));
      setNorth(String(bbox[3]));
    },
    [],
  );

  const search = async () => {
    setBusy(true);
    setStatus('');
    try {
      const rows = await searchNominatim(query);
      setHits(rows);
      if (rows[0]) {
        applyBbox(nominatimBbox(rows[0]));
        setStatus(rows[0].display_name);
      } else setStatus('No results');
    } catch (e) {
      setStatus((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    const bbox = parseBboxFields(west, south, east, north);
    if (!bbox) {
      setStatus('Invalid bbox (west,south,east,north in degrees)');
      return;
    }
    const map = defaultMapSpec({
      ...existing,
      title: title.trim() || 'Map terrain',
      bbox,
      source: existing?.source ?? 'auto',
      model,
    });
    setTopMap(map);
    onClose();
  };

  return (
    <div className="map-window-overlay" role="dialog" aria-label="Map terrain">
      <div className="window map-window">
        <div className="title-bar">
          <div className="title-bar-text">Map terrain</div>
          <div className="title-bar-controls">
            <button type="button" aria-label="Close" onClick={onClose} />
          </div>
        </div>
        <div className="window-body map-window-body">
          <p className="map-window-note">Search uses Nominatim (max 1 request/s). Pick a place or edit the bbox manually.</p>
          <div className="field-row-stacked">
            <label htmlFor="map-title">Title</label>
            <input id="map-title" type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="field-row-stacked">
            <label htmlFor="map-query">Place search</label>
            <div className="map-search-row">
              <input id="map-query" type="text" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && search()} />
              <button type="button" disabled={busy || !query.trim()} onClick={search}>
                Search
              </button>
            </div>
          </div>
          {hits.length > 1 && (
            <ul className="map-hit-list">
              {hits.map((h) => (
                <li key={`${h.lat}-${h.lon}`}>
                  <button type="button" className="linkish" onClick={() => applyBbox(nominatimBbox(h))}>
                    {h.display_name}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <fieldset>
            <legend>Ground model</legend>
            <label>
              <input type="radio" name="map-model" checked={model === 'dtm'} onChange={() => setModel('dtm')} /> DTM (bare ground)
            </label>
            <label>
              <input type="radio" name="map-model" checked={model === 'dsm'} onChange={() => setModel('dsm')} /> DSM (with buildings)
            </label>
            <label>
              <input
                type="radio"
                name="map-model"
                checked={model === 'dtm+buildings'}
                onChange={() => setModel('dtm+buildings')}
              />
              DTM + OSM buildings
            </label>
          </fieldset>
          <fieldset>
            <legend>Bbox (WGS84)</legend>
            <div className="map-bbox-grid">
              <label>
                West <input inputMode="decimal" value={west} onChange={(e) => setWest(e.target.value)} />
              </label>
              <label>
                South <input inputMode="decimal" value={south} onChange={(e) => setSouth(e.target.value)} />
              </label>
              <label>
                East <input inputMode="decimal" value={east} onChange={(e) => setEast(e.target.value)} />
              </label>
              <label>
                North <input inputMode="decimal" value={north} onChange={(e) => setNorth(e.target.value)} />
              </label>
            </div>
          </fieldset>
          {status && <p className="map-window-status">{status}</p>}
          <div className="map-window-actions">
            <button type="button" onClick={save}>Apply MapSpec</button>
            <button type="button" onClick={onClose}>Cancel</button>
          </div>
        </div>
      </div>
    </div>
  );
}
