import { useCallback, useEffect, useRef, useState } from 'react';
import { defaultMapSpec, type MapModel, type MapSource, type MapSpec, type MapWater, type LayerBudgetMode } from '../core/mapSpec';
import { MAP_ENGRAVE_PRESETS, type MapEngravePresetId } from '../core/mapEngravePresets';
import { MAP_PRESET_CATALOG, mapPresetSpecKeepingUser } from '../core/mapPresets';
import { engraveHasLabels } from '../core/quickMap';
import { nominatimBbox, searchNominatim, type NominatimPlace } from '../core/mapNominatim';
import { MAP_SOURCE_REGISTRY } from '../core/mapSourceRegistry';
import { WORKING_MAP_SOURCES, isWorkingMapSource } from '../core/mapSourcePick';
import { noticesWithoutStaleEngraveSkip } from '../core/mapNotices';
import { formatLiveMapReadout } from '../core/mapGeometryReadout';
import { SUNKEN_FRAME_FLAT_HINT, SUNKEN_FRAME_FLAT_ONLY_HINT, sunkenFrameApplies } from '../core/mapSunkenFrame';
import { useStore } from '../state/store';
import { useModel } from './model';
import MapPreviewPane from './MapPreviewPane';
import { trackBusy } from './busy';

function sourceLabel(id: MapSource): string {
  if (id === 'auto') return 'auto (EA 1 m in England, else 30 m)';
  const res = `${MAP_SOURCE_REGISTRY[id].resolutionM} m`;
  return isWorkingMapSource(id) ? `${id} (${res})` : `${id} (not supported yet, uses terrarium)`;
}

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
  const applyQuickMap = useStore((s) => s.applyQuickMap);
  const mapTerrain = useStore((s) => s.mapTerrain);
  const geom = useModel();
  const existing = project.images.top?.map;
  const frameApplies = sunkenFrameApplies(geom.v.sliceMode);
  const frameHint = frameApplies ? SUNKEN_FRAME_FLAT_HINT : SUNKEN_FRAME_FLAT_ONLY_HINT;
  const factor =
    existing?.exaggerationFactor ?? (typeof existing?.exaggeration === 'number' ? existing.exaggeration : undefined);
  const reliefM = project.images.top?.depth?.mapOrtho?.reliefM;
  const liveReadout =
    mapTerrain.phase === 'ready' && existing && typeof factor === 'number' && factor > 0 && reliefM != null
      ? formatLiveMapReadout({
          factor,
          reliefM,
          sliceMode: geom.v.sliceMode,
          plates: geom.sliced.plates,
          thicknessMm: geom.v.thickness,
          mapFace: true,
          terrainTopMm: geom.hf?.max,
        })
      : existing?.exaggerationReadout;
  const [title, setTitle] = useState(existing?.title ?? project.name ?? 'Map terrain');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<NominatimPlace[]>([]);
  const [west, setWest] = useState(String(existing?.bbox?.[0] ?? ''));
  const [south, setSouth] = useState(String(existing?.bbox?.[1] ?? ''));
  const [east, setEast] = useState(String(existing?.bbox?.[2] ?? ''));
  const [north, setNorth] = useState(String(existing?.bbox?.[3] ?? ''));
  const [searchStatus, setSearchStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const bboxFocus = useRef<null | 'west' | 'south' | 'east' | 'north'>(null);

  const applyBbox = useCallback((bbox: MapSpec['bbox']) => {
    setWest(String(bbox[0]));
    setSouth(String(bbox[1]));
    setEast(String(bbox[2]));
    setNorth(String(bbox[3]));
  }, []);

  const bboxKey = existing?.bbox?.join(',') ?? '';
  useEffect(() => {
    if (!existing?.bbox) return;
    const [w, s, e, n] = existing.bbox;
    const focus = bboxFocus.current;
    if (focus !== 'west') setWest(String(w));
    if (focus !== 'south') setSouth(String(s));
    if (focus !== 'east') setEast(String(e));
    if (focus !== 'north') setNorth(String(n));
  }, [bboxKey, existing?.bbox]);

  const search = async () => {
    setBusy(true);
    setSearchStatus('');
    try {
      const rows = await trackBusy({ scene: 'search', title: 'Finding the place', detail: `Looking up “${query.trim()}” on OpenStreetMap…` }, searchNominatim(query));
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
  const water = existing?.water ?? 'flat';
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
        {liveReadout && mapTerrain.phase === 'ready' ? (
          <p className="map-readout" data-testid="map-readout">
            Exaggeration {liveReadout} · source {existing?.resolvedSource ?? source}
          </p>
        ) : null}
      </div>

      <section className="map-section">
        <h3>Presets</h3>
        <button
          type="button"
          className="btn default"
          data-testid="quick-map"
          onClick={() => {
            applyQuickMap();
            const spec = useStore.getState().project.images.top?.map;
            if (spec) {
              setTitle(spec.title ?? title);
              applyBbox(spec.bbox);
            }
          }}
          title="Dense plates and pitch so contours read, landscape, no insert, OSM engrave with Survey fonts, bathymetry, labels. Your exaggeration, frame, near/far, sizes and tuning stay if you set them."
        >
          Quick map
        </button>
        <p className="map-view-note">One click: plate options a map can actually show. Undo brings the last settings back.</p>
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
            {WORKING_MAP_SOURCES.map((id) => (
              <option key={id} value={id}>{sourceLabel(id)}</option>
            ))}
            {!isWorkingMapSource(source) && (
              <option value={source} disabled>{sourceLabel(source)}</option>
            )}
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
            <label>West <input data-testid="map-bbox-west" inputMode="decimal" value={west} onChange={(e) => setWest(e.target.value)} onFocus={() => { bboxFocus.current = 'west'; }} onBlur={() => { bboxFocus.current = null; }} /></label>
            <label>South <input data-testid="map-bbox-south" inputMode="decimal" value={south} onChange={(e) => setSouth(e.target.value)} onFocus={() => { bboxFocus.current = 'south'; }} onBlur={() => { bboxFocus.current = null; }} /></label>
            <label>East <input data-testid="map-bbox-east" inputMode="decimal" value={east} onChange={(e) => setEast(e.target.value)} onFocus={() => { bboxFocus.current = 'east'; }} onBlur={() => { bboxFocus.current = null; }} /></label>
            <label>North <input data-testid="map-bbox-north" inputMode="decimal" value={north} onChange={(e) => setNorth(e.target.value)} onFocus={() => { bboxFocus.current = 'north'; }} onBlur={() => { bboxFocus.current = null; }} /></label>
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
        <label title="Snap the terrain to one level per plate, the stepped look. Flat stacks are always stepped.">
          <input
            type="checkbox"
            id="map-terraced"
            data-testid="map-terraced"
            checked={geom.v.sliceMode === 'flat' || existing?.terraced === true}
            disabled={!existing || geom.v.sliceMode === 'flat'}
            onChange={(e) => commit({ terraced: e.target.checked })}
          />
          Terraced layers
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
            id="map-engrave-on"
            type="checkbox"
            checked={engraveOn}
            disabled={!existing}
            onChange={(e) => commit({ engrave: { ...(existing?.engrave ?? { features: ['roads', 'water', 'title'] }), enabled: e.target.checked } })}
          />
          OSM engrave on top face
        </label>
        <label>
          <input
            type="checkbox"
            data-testid="map-engrave-labels"
            checked={engraveHasLabels(existing?.engrave?.features)}
            disabled={!existing || !engraveOn}
            onChange={(e) => {
              const prev = existing?.engrave ?? { enabled: true, features: ['roads', 'water', 'title'] };
              const next = new Set(prev.features);
              if (e.target.checked) next.add('labels');
              else {
                next.delete('labels');
                next.delete('label');
              }
              commit({ engrave: { ...prev, enabled: true, features: [...next] } });
            }}
          />
          Place labels
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
        <p className="map-view-note">
          Each lake uses its own shoreline from the DEM inside the water polygon. Streams follow the terrain. Bathymetry
          falls back to the same per-lake surface where no soundings exist (only the Welsh Harp sample has them). Quick
          map keeps your choice.
        </p>
      </section>

      <section className="map-section">
        <h3>Frame &amp; edition</h3>
        <div className={`map-frame-field${existing && !frameApplies ? ' is-disabled' : ''}`}>
          <label title={frameHint} htmlFor="map-sunken-frame">
            <input
              id="map-sunken-frame"
              data-testid="sunken-frame-checkbox"
              type="checkbox"
              checked={frameApplies && !!existing?.sunkenFrame?.enabled}
              disabled={!existing || !frameApplies}
              aria-describedby={!frameApplies && existing ? 'map-sunken-frame-hint' : undefined}
              onChange={(e) =>
                commit({
                  sunkenFrame: e.target.checked ? { enabled: true, wallMm: existing?.sunkenFrame?.wallMm ?? 12 } : { enabled: false },
                })
              }
            />
            Sunken concrete frame
          </label>
          {existing && !frameApplies ? (
            <p id="map-sunken-frame-hint" className="map-frame-hint">
              {SUNKEN_FRAME_FLAT_ONLY_HINT}
            </p>
          ) : null}
        </div>
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
