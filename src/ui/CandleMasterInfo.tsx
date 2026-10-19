// What the candle master takes: the master, the box, silicone, wax per candle and the pin.
import { useModel, fmt } from './model';
import { useStore } from '../state/store';
import { download } from '../core/exporters';
import { masterShopping, masterText } from '../core/candleMaster';

export default function CandleMasterInfo() {
  const model = useModel();
  const s = model.sliced.candleMaster;
  if (!s) return null;
  const short = s.frameLayers > 0 && s.inner.h < s.height + model.v.cmCover - 1e-6;
  return (
    <div className="candle-master" data-testid="candle-master">
      <div className="note">
        Master {s.masterLayers} layers, {fmt(s.height, 0)} mm tall, {fmt(s.volume / 1000, 0)} cm³. Box inside {fmt(s.inner.w, 0)} × {fmt(s.inner.d, 0)} × {fmt(s.inner.h, 0)} mm.
      </div>
      <ul className="note">
        {masterShopping(s).map((r) => (
          <li key={r.item}>
            {r.item}: {r.qty}
          </li>
        ))}
      </ul>
      {short && <div className="note warn">The box stops short of the silicone over the top: raise Plate count to {s.layersNeeded}.</div>}
      <div className="note">
        <button className="btn sm" onClick={() => download(`${(useStore.getState().project.name || 'strata').replace(/[^\w-]+/g, '-')}-candle-master.txt`, masterText(s), 'text/plain')} title="What to buy and how to glue up the master, cast the silicone and pour the candles">
          How to make it
        </button>
      </div>
    </div>
  );
}
