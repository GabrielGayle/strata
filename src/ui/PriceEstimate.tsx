import { useMemo, useState } from 'react';
import type { Bom } from '../core/bom';
import { MATERIAL_NAME } from '../core/bom';
import { CHOPCHOP_QUOTE_URL, DEFAULT_RATES, estimatePrice, type PriceRates } from '../core/price';
import { fmt } from './model';

const KEY = 'strata.priceRates';

function loadRates(): PriceRates {
  try {
    const s = localStorage.getItem(KEY);
    if (s) {
      const r = JSON.parse(s);
      return { ...DEFAULT_RATES, ...r, perKg: { ...DEFAULT_RATES.perKg, ...r.perKg } };
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
          style={{ width: 70, textAlign: 'right', background: 'transparent', border: '1px solid var(--line)', borderRadius: 3, padding: '1px 4px' }}
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

/** Chop Chop Laser cost estimate for the plate parts, with editable rates. */
export function PriceEstimate({ bom, material, thickness }: { bom: Bom; material: string; thickness: number }) {
  const [rates, setRatesState] = useState(loadRates);
  const [editing, setEditing] = useState(false);
  const est = useMemo(() => estimatePrice(bom, material, thickness, rates), [bom, material, thickness, rates]);

  const setRates = (r: PriceRates) => {
    setRatesState(r);
    try {
      localStorage.setItem(KEY, JSON.stringify(r));
    } catch {
      /* not persisted */
    }
  };
  const set = (k: keyof Omit<PriceRates, 'perKg'>) => (x: number) => setRates({ ...rates, [k]: x });

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
            {gbp(est.net)} <small>{fmt(est.minutes, 0)} min laser</small>
          </div>
        </div>
      </div>
      <dl className="kv">
        {est.lines.map((l) => (
          <div key={l.label} style={{ display: 'contents' }}>
            <dt title={l.detail}>
              {l.label} <span style={{ fontSize: 11 }}>· {l.detail}</span>
            </dt>
            <dd>{gbp(l.cost)}</dd>
          </div>
        ))}
        {est.net > est.subtotal && (
          <>
            <dt>Minimum order</dt>
            <dd>+{gbp(est.net - est.subtotal)}</dd>
          </>
        )}
        <dt>VAT {fmt(rates.vat * 100, 0)}%</dt>
        <dd>{gbp(est.vat)}</dd>
      </dl>
      {est.warnings.map((w) => (
        <div key={w} className="note warn">
          {w}
        </div>
      ))}
      <div className="note">
        Estimate only, not a Chop Chop quote. They don&rsquo;t publish rates, so this uses typical UK laser rates applied to the cut list ({MATERIAL_NAME[material] ?? material} {fmt(thickness, 1)} mm).
        Delivery, etching and the concrete base aren&rsquo;t included. For a real price, upload the plate DXFs to their{' '}
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
          {Object.keys(DEFAULT_RATES.perKg).map((m) => (
            <RateInput key={m} label={`${MATERIAL_NAME[m] ?? m} sheet`} unit="£/kg" value={rates.perKg[m]} onChange={(x) => setRates({ ...rates, perKg: { ...rates.perKg, [m]: x } })} />
          ))}
          <RateInput label="Offcut waste" unit="%" step={5} value={Math.round(rates.waste * 100)} onChange={(x) => set('waste')(x / 100)} />
          <RateInput label="Laser" unit="£/h" step={5} value={rates.machinePerHour} onChange={set('machinePerHour')} />
          <RateInput label="Setup" unit="£/job" step={5} value={rates.setup} onChange={set('setup')} />
          <RateInput label="Handling" unit="£/part" value={rates.perPart} onChange={set('perPart')} />
          <RateInput label="Minimum order" unit="£" step={5} value={rates.minimum} onChange={set('minimum')} />
          <RateInput label="VAT" unit="%" step={1} value={Math.round(rates.vat * 100)} onChange={(x) => set('vat')(x / 100)} />
        </dl>
      )}
    </>
  );
}
