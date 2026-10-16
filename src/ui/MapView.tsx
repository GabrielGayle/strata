import { useCallback, useState } from 'react';
import { defaultMapSpec, type MapModel, type MapSource, type MapSpec, type MapWater, type LayerBudgetMode } from '../core/mapSpec';
import { MAP_ENGRAVE_PRESETS, type MapEngravePresetId } from '../core/mapEngravePresets';
import { MAP_PRESET_CATALOG, mapPresetSpecKeepingUser } from '../core/mapPresets';
import { nominatimBbox, searchNominatim, type NominatimPlace } from '../core/mapNominatim';
import { MAP_SOURCE_REGISTRY } from '../core/mapSourceRegistry';
import { noticesWithoutStaleEngraveSkip } from '../core/mapNotices';
import { useStore } from '../state/store';
import MapPreviewPane from './MapPreviewPane';

const SOURCES: MapSource[] = ['auto', 'ea-dtm', 'ea-dsm', 'scot-dtm', 'wales-dtm', 'ni-dtm', 'cop30', 'terrarium'];

function radioId(name: string, value: string): string {
  return `${name}-${value.replace(/[^a-z0-9]+/gi, '-')}`;
}

function MapRadioGroup<T extends string>({
  name,
  value,
  options,
  disabled,
  onChange,
}: {
  name: string;
  value: T;
  options: { id: T; label: string }[];
  disabled?: boolean;
  onChange: (v: T) => void;
}) {
  return (
    <>
      {options.map((o) => {
        const id = radioId(name, o.id);
        return (
          <div className="field-row" key={o.id}>
            <input
              id={id}
              type="radio"
              name={name}
              checked={value === o.id}
              disabled={disabled}
              onChange={() => onChange(o.id)}
            />
            <label htmlFor={id}>{o.label}</label>
          </div>
        );
      })}
    </>
  );
}

function parseBboxFields(w: string, s: string, e: string, n: string): MapSpec['bbox'] | null {
  const west = Number(w);
  const south = Number(s);
  const east = Number(e);
  const north = Number(n);
  if (![west, south, east, north].every(Number.isFinite)) return null;
  if (west >= east || south >= north) return null;
  return [west, south, east, north];
}

function patchMap(existing: MapSpec | undefined, patch: Partial<MapSpec>): MapSpec {
  const bbox = patch.bbox ?? existing?.bbox;
  if (!bbox) throw new Error('bbox required');
  return defaultMapSpec({ ...existing, ...patch, bbox });
}

export default function MapView() {
  const project = useStore((s) => s.project);
  const setTopMap = useStore((s) => s.setTopMap);
  const mapTerrain = useStore((s) => s.mapTerrain);
  const existing = project.images.top?.map;
  const [title, setTitle] = useState(existing?.title ?? project.name ?? 'Map terrain');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<NominatimPlace[]>([]);
  const [west, setWest] = useState(String(existing?.bbox?.[0] ?? ''));
  const [south, setSouth] = useState(String(existing?.bbox?.[1] ?? ''));
  const [east, setEast] = useState(String(existing?.bbox?.[2] ?? ''));
  const [north, setNorth] = useState(String(existing?.bbox?.[3] ?? ''));
  const [searchStatus, setSearchStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const applyBbox = useCallback((bbox: MapSpec['bbox']) => {
    setWest(String(bbox[0]));
    setSouth(String(bbox[1]));
    setEast(String(bbox[2]));
    setNorth(String(bbox[3]));
  }, []);

  const search = async () => {
    setBusy(true);
    setSearchStatus('');
    try {
      const rows = await searchNominatim(query);
      setHits(rows);
      if (rows[0]) {
        applyBbox(nominatimBbox(rows[0]));
        setSearchStatus(rows[0].display_name);
      } else setSearchStatus('No results');
    } catch (e) {
      setSearchStatus((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const commit = (patch: Partial<MapSpec>) => {
    const bbox = patch.bbox ?? parseBboxFields(west, south, east, north);
    if (!bbox) {
      setSearchStatus('Invalid bbox (west,south,east,north in degrees)');
      return;
    }
    setTopMap(patchMap(existing, { ...patch, title: (patch.title ?? title).trim() || 'Map terrain', bbox }));
  };

  const applyFromFields = () => commit({});

  const loadPreset = (id: string) => {
    const spec = mapPresetSpecKeepingUser(id, existing);
    setTitle(spec.title ?? id);
    applyBbox(spec.bbox);
    setTopMap(spec);
  };

  const model = existing?.model ?? 'dtm';
  const source = existing?.source ?? 'auto';
  const water = existing?.water ?? 'bathy';
  const layerBudget = existing?.layerBudget ?? 'jenks';
  const exaggeration = existing?.exaggeration ?? 'auto';
  const engravePreset = (existing?.engrave?.preset ?? 'city') as MapEngravePresetId;
  const engraveOn = existing?.engrave?.enabled ?? true;

  const previewBbox = existing?.bbox ?? parseBboxFields(west, south, east, north) ?? undefined;
  const engraveCount = existing?.engraveArt?.lines?.length ?? 0;
  const notices = noticesWithoutStaleEngraveSkip(existing?.sourceWarnings ?? [], engraveCount > 0);

  return (
    <div
      className="map-view-layout"
      data-strata-map-engrave-count={engraveCount}
      data-strata-resolved-source={existing?.resolvedSource ?? ''}
    >
      <div className="map-view">
      <header className="map-view-head">
        <h2>Map terrain</h2>
        <p className="map-view-note">Elevation, engraving and edition settings for the top face. Changes rebuild depth automatically.</p>
      </header>

      <div
        className={`map-terrain-status${mapTerrain.phase === 'error' ? ' map-terrain-error' : ''}${mapTerrain.phase === 'working' ? ' map-terrain-working' : ''}`}
        role="status"
        aria-live="polite"
      >
        {mapTerrain.phase === 'working' && <span className="map-terrain-spinner" aria-hidden />}
        <span>{mapTerrain.message || (mapTerrain.phase === 'idle' ? 'No map on the top face yet.' : '')}</span>
        {mapTerrain.error && (
          <p className="map-terrain-error" data-testid="map-terrain-error" data-strata-map-error={mapTerrain.error}>
            {mapTerrain.error}
          </p>
        )}
        {notices.length ? (
          <ul className="map-notices">
            {notices.map((w, i) => (
              <li key={`${w.severity}-${i}`} className={w.severity === 'info' ? 'map-notice-info' : 'map-notice-warn'}>
                {w.message}
              </li>
            ))}
          </ul>
        ) : null}
        {existing?.exaggerationReadout && mapTerrain.phase === 'ready' ? (
          <p className="map-readout">Exaggeration {existing.exaggerationReadout} · source {existing.resolvedSource ?? source}</p>
        ) : null}
      </div>

      <section className="map-section">
        <h3>Presets</h3>
        <div className="map-preset-row">
          {MAP_PRESET_CATALOG.map((p) => (
            <button key={p.id} type="button" className="btn sm" onClick={() => loadPreset(p.id)} title={p.note}>
              {p.label}
            </button>
          ))}
        </div>
      </section>

      <section className="map-section">
        <h3>Source &amp; bbox</h3>
        <div className="field-row-stacked">
          <label htmlFor="map-title">Title</label>
          <input id="map-title" type="text" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="field-row-stacked">
          <label htmlFor="map-query">Place search (Nominatim)</label>
          <div className="map-search-row">
            <input id="map-query" type="text" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && search()} />
            <button type="button" disabled={busy || !query.trim()} onClick={search}>Search</button>
          </div>
        </div>
        {hits.length > 1 && (
          <ul className="map-hit-list">
            {hits.map((h) => (
              <li key={`${h.lat}-${h.lon}`}>
                <button type="button" className="linkish" onClick={() => applyBbox(nominatimBbox(h))}>{h.display_name}</button>
              </li>
            ))}
          </ul>
        )}
        <label>
          Source
          <select
            value={source}
            onChange={(e) => commit({ source: e.target.value as MapSource })}
            disabled={!existing}
          >
            {SOURCES.map((id) => (
              <option key={id} value={id}>{id} ({MAP_SOURCE_REGISTRY[id].resolutionM} m)</option>
            ))}
          </select>
        </label>
        <fieldset>
          <legend>Ground model (DTM / DSM / buildings)</legend>
          <MapRadioGroup
            name="map-model"
            value={model}
            disabled={!existing}
            onChange={(m) => commit({ model: m })}
            options={[
              { id: 'dtm' as MapModel, label: 'DTM (bare ground)' },
              { id: 'dsm' as MapModel, label: 'DSM (with buildings)' },
              { id: 'dtm+buildings' as MapModel, label: 'DTM + OSM buildings' },
            ]}
          />
        </fieldset>
        <fieldset>
          <legend>Bbox (WGS84)</legend>
          <div className="map-bbox-grid">
            <label>West <input inputMode="decimal" value={west} onChange={(e) => setWest(e.target.value)} /></label>
            <label>South <input inputMode="decimal" value={south} onChange={(e) => setSouth(e.target.value)} /></label>
            <label>East <input inputMode="decimal" value={east} onChange={(e) => setEast(e.target.value)} /></label>
            <label>North <input inputMode="decimal" value={north} onChange={(e) => setNorth(e.target.value)} /></label>
          </div>
        </fieldset>
        {searchStatus && <p className="map-window-status">{searchStatus}</p>}
        <button type="button" className="btn default" onClick={applyFromFields}>Apply bbox &amp; title</button>
      </section>

      <section className="map-section">
        <h3>Exaggeration &amp; layer budget</h3>
        <label>
          Vertical exaggeration
          <select
            value={exaggeration === 'auto' ? 'auto' : String(exaggeration)}
            onChange={(e) => {
              const v = e.target.value;
              commit({ exaggeration: v === 'auto' ? 'auto' : Number(v) });
            }}
            disabled={!existing}
          >
            <option value="auto">auto</option>
            {[4, 8, 11, 12, 16, 18, 21, 28, 36].map((n) => (
              <option key={n} value={n}>×{n}</option>
            ))}
          </select>
        </label>
        <label>
          Layer budget
          <select
            value={layerBudget}
            onChange={(e) => commit({ layerBudget: e.target.value as LayerBudgetMode })}
            disabled={!existing}
          >
            <option value="jenks">jenks</option>
            <option value="quantile">quantile</option>
            <option value="equal">equal</option>
          </select>
        </label>
        <label>
          Ground resolution (m)
          <input
            type="number"
            min={2}
            max={64}
            step={1}
            value={existing?.resM ?? 8}
            disabled={!existing}
            onChange={(e) => commit({ resM: Number(e.target.value) })}
          />
        </label>
      </section>

      <section className="map-section">
        <h3>Engraving</h3>
        <label>
          <input
            type="checkbox"
            checked={engraveOn}
            disabled={!existing}
            onChange={(e) => commit({ engrave: { ...(existing?.engrave ?? { features: ['roads', 'water', 'title'] }), enabled: e.target.checked } })}
          />
          OSM engrave on top face
        </label>
        <label>
          Preset &amp; font pairing
          <select
            value={engravePreset}
            disabled={!existing}
            onChange={(e) =>
              commit({
                engrave: {
                  ...(existing?.engrave ?? { enabled: true, features: ['roads', 'water', 'title'] }),
                  preset: e.target.value,
                },
              })
            }
          >
            {Object.values(MAP_ENGRAVE_PRESETS).map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
        </label>
      </section>

      <section className="map-section">
        <h3>Water &amp; bathymetry</h3>
        <MapRadioGroup
          name="map-water"
          value={water}
          disabled={!existing}
          onChange={(w) => commit({ water: w })}
          options={[
            { id: 'bathy' as MapWater, label: 'Bathymetry where available' },
            { id: 'flat' as MapWater, label: 'Flat water surface' },
            { id: 'raw' as MapWater, label: 'Raw (no flatten)' },
          ]}
        />
      </section>

      <section className="map-section">
        <h3>Frame &amp; edition</h3>
        <label>
          <input
            type="checkbox"
            checked={!!existing?.sunkenFrame?.enabled}
            disabled={!existing}
            onChange={(e) =>
              commit({
                sunkenFrame: e.target.checked ? { enabled: true, wallMm: existing?.sunkenFrame?.wallMm ?? 12 } : { enabled: false },
              })
            }
          />
          Sunken concrete frame
        </label>
        <label>
          Edition number
          <input
            type="number"
            min={1}
            disabled={!existing}
            value={existing?.editionNumber ?? ''}
            onChange={(e) => {
              const n = Number(e.target.value);
              commit({ editionNumber: Number.isFinite(n) && n > 0 ? n : undefined });
            }}
          />
        </label>
        <label>
          Commemorative text
          <input
            type="text"
            disabled={!existing}
            value={existing?.commemorativeText ?? ''}
            onChange={(e) => commit({ commemorativeText: e.target.value.trim() || undefined })}
          />
        </label>
      </section>
    </div>
      <MapPreviewPane bbox={previewBbox} title={existing?.title ?? title} depth={project.images.top?.depth} />
    </div>
  );
}
