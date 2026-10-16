import { useStore } from '../state/store';
import { VIEWPORT_LAYER_LABELS, type ViewportLayerId } from './viewportLayers';

const ORDER: ViewportLayerId[] = ['grid', 'base', 'concrete', 'backing', 'frame', 'plates', 'engraving', 'water', 'labels'];

export default function ViewportLayersToolbar() {
  const layers = useStore((s) => s.ui.viewportLayers);
  const toggle = useStore((s) => s.toggleViewportLayer);
  return (
    <div className="viewport-layers overlay bc" role="toolbar" aria-label="Viewport visibility" style={{ bottom: 52 }}>
      {ORDER.map((id) => (
        <button
          key={id}
          type="button"
          className={`btn sm ${layers[id] ? 'on' : ''}`}
          onClick={() => toggle(id)}
          title={`Show or hide ${VIEWPORT_LAYER_LABELS[id]} (view only)`}
        >
          {VIEWPORT_LAYER_LABELS[id]}
        </button>
      ))}
    </div>
  );
}
