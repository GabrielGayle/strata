import { useMemo, useState } from 'react';
import type { Bom } from '../core/bom';
import { MATERIAL_NAME } from '../core/bom';
import { CHOPCHOP_CALIBRATED } from '../core/chopchopRates';
import { CHOPCHOP_QUOTE_URL, DEFAULT_RATES, estimateMix, usesShopRates, withHardware, type PriceRates } from '../core/price';
import { fmt } from './model';

const KEY = 'strata.priceRates';

/** The rates last set in the estimate panel (defaults if none). */
export function loadRates(): PriceRates {
  try {
    const s = localStorage.getItem(KEY);
    if (s) {
      const r = JSON.parse(s);
      return { ...DEFAULT_RATES, ...r, perKg: { ...DEFAULT_RATES.perKg, ...r.perKg }, hardware: { ...DEFAULT_RATES.hardware, ...r.hardware } };
    }
  } catch {
    /* fall back to defaults */
  }
  return DEFAULT_RATES;
}

const gbp = (x: number) => `£${x.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function RateInput({ label, value, onChange, step = 0.05, unit }: { label: string; value: number; onChange: (x: number) => void; step?: number; unit: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>
        <input
          type="number"
          value={value}
          step={step}
          min={0}
          style={{
            width: 70,
            textAlign: 'right',
            background: 'var(--field-bg)',
            color: 'var(--field-fg)',
            border: '1px solid var(--line-soft)',
            borderRadius: 0,
            padding: '1px 4px',
          }}
          onChange={(e) => {
            const x = parseFloat(e.target.value);
            if (Number.isFinite(x) && x >= 0) onChange(x);
          }}
        />{' '}
        <span style={{ color: 'var(--muted)', display: 'inline-block', width: 38, textAlign: 'left' }}>{unit}</span>
      </dd>
    </>
  );
}

/** Chop Chop Laser cost estimate for the plate parts, with the shop rates still overridable. */
export function PriceEstimate({ bom, material, thickness }: { bom: Bom; material: string; thickness: number }) {
  const [rates, setRatesState] = useState(loadRates);
  const [editing, setEditing] = useState(false);
  const [includeEtch, setIncludeEtch] = useState(true);
  const shop = usesShopRates(rates);
  const est = useMemo(() => withHardware(estimateMix(bom, thickness, rates, { includeEtch }), bom.hardware, rates), [bom, thickness, rates, includeEtch]);
  const metals = bom.byMaterial?.filter((g) => g.partCount).map((g) => g.material) ?? [];
  const metalText = (metals.length ? metals : [material]).map((m) => MATERIAL_NAME[m] ?? m).join(' and ');
  const etchM = bom.rows.reduce((a, r) => a + (r.etch ?? 0), 0) / 1000;
  const areaM2 = bom.rows.reduce((a, r) => a + r.area, 0) / 1e6;
  const off = (1 - est.orderFactor) * 100;

  const setRates = (r: PriceRates) => {
    setRatesState(r);
    try {
      localStorage.setItem(KEY, JSON.stringify(r));
    } catch {
      /* not persisted */
    }
  };
  const set = (k: keyof Omit<PriceRates, 'perKg' | 'hardware'>) => (x: number) => setRates({ ...rates, [k]: x });
  const setHw = (k: keyof PriceRates['hardware']) => (x: number) => setRates({ ...rates, hardware: { ...rates.hardware, [k]: x } });

  return (
    <>
      <div className="stats">
        <div className="stat">
          <div className="k">Estimate inc. VAT</div>
          <div className="v">{gbp(est.total)}</div>
        </div>
        <div className="stat">
          <div className="k">Ex VAT</div>
          <div className="v">
            {gbp(est.net)} <small>{est.fitted ? (off >= 0.5 ? `${fmt(off, 0)}% off` : 'small order') : `${fmt(est.minutes, 0)} min laser`}</small>
          </div>
        </div>
      </div>
      {est.fitted && (
        <div className="note">
          <label htmlFor="price-etch">
            <input id="price-etch" type="checkbox" checked={includeEtch} onChange={(e) => setIncludeEtch(e.target.checked)} /> Include etch, priced at the cut rate
            {etchM > 0 ? ` (${fmt(etchM, 2)} m)` : ''}
          </label>
        </div>
      )}
      {est.warnings.map((w) => (
        <div key={w} className="note warn">
          {w}
        </div>
      ))}
      <dl className="kv">
        {est.lines.map((l, i) => (
          <div key={`${l.label}-${i}`} style={{ display: 'contents' }}>
            <dt title={l.detail}>
              {l.label} <span style={{ fontSize: 11 }}>· {l.detail}</span>
            </dt>
            <dd>{gbp(l.cost)}</dd>
          </div>
        ))}
        <dt>VAT {fmt(rates.vat * 100, 0)}%</dt>
        <dd>{gbp(est.vat)}</dd>
      </dl>
      {shop && <div className="note warn">Shop rates are overriding the fitted Chop Chop prices. Reset rates to use the {CHOPCHOP_CALIBRATED} fit.</div>}
      <div className="note">
        {est.fitted
          ? `Fitted to Chop Chop quotes from ${CHOPCHOP_CALIBRATED}, ex VAT (${metalText} ${fmt(thickness, 1)} mm${metals.length > 1 ? ', each metal on its own rate' : ''}). Qty-1 rates are scaled by the order’s true area (${fmt(areaM2, 2)} m²${off >= 0.5 ? `, ${fmt(off, 0)}% off` : ''}). `
          : `Shop rates applied to the cut list (${metalText} ${fmt(thickness, 1)} mm). `}
        {est.hardware ? 'Bracing rods, nuts and washers are priced separately at fastener-supplier rates. ' : ''}
        Delivery is not included. The concrete base isn&rsquo;t included. For a real price, upload the plate DXFs to their{' '}
        <a href={CHOPCHOP_QUOTE_URL} target="_blank" rel="noreferrer">
          instant quote
        </a>
        .
      </div>
      <div className="btnrow">
        <button className="btn sm" onClick={() => setEditing(!editing)} aria-expanded={editing}>
          {editing ? 'Hide rates' : 'Edit rates'}
        </button>
        {editing && (
          <button className="btn sm" onClick={() => setRates(DEFAULT_RATES)}>
            Reset rates
          </button>
        )}
      </div>
      {editing && (
        <dl className="kv">
          <div style={{ display: 'contents' }}>
            <dt style={{ gridColumn: '1 / -1', color: 'var(--muted)', fontSize: 11 }}>
              Sheet, laser, setup and handling replace the fitted prices with the shop model. Minimum, VAT and hardware still apply to the fit.
            </dt>
          </div>
          {Object.keys(DEFAULT_RATES.perKg).map((m) => (
            <RateInput key={m} label={`${MATERIAL_NAME[m] ?? m} sheet`} unit="£/kg" value={rates.perKg[m]} onChange={(x) => setRates({ ...rates, perKg: { ...rates.perKg, [m]: x } })} />
          ))}
          <RateInput label="Offcut waste" unit="%" step={5} value={Math.round(rates.waste * 100)} onChange={(x) => set('waste')(x / 100)} />
          <RateInput label="Laser" unit="£/h" step={5} value={rates.machinePerHour} onChange={set('machinePerHour')} />
          <RateInput label="Setup" unit="£/job" step={5} value={rates.setup} onChange={set('setup')} />
          <RateInput label="Handling" unit="£/part" value={rates.perPart} onChange={set('perPart')} />
          <RateInput label="Minimum order" unit="£" step={5} value={rates.minimum} onChange={set('minimum')} />
          <RateInput label="VAT" unit="%" step={1} value={Math.round(rates.vat * 100)} onChange={(x) => set('vat')(x / 100)} />
          {bom.hardware.length > 0 && (
            <>
              <RateInput label="Threaded rod" unit="£/m" step={0.25} value={rates.hardware.rodPerM} onChange={setHw('rodPerM')} />
              <RateInput label="Nut" unit="£ each" step={0.01} value={rates.hardware.nut} onChange={setHw('nut')} />
              <RateInput label="Washer" unit="£ each" step={0.01} value={rates.hardware.washer} onChange={setHw('washer')} />
            </>
          )}
        </dl>
      )}
    </>
  );
}
