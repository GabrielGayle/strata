import { useStore } from '../state/store';
import { useModel } from './model';
import { VIEWPORT_LAYER_LABELS, showRodsLayerToggle, type ViewportLayerId } from './viewportLayers';

// the concrete base has one button (Base); 'concrete' stays a stored id only
const ORDER: ViewportLayerId[] = ['grid', 'base', 'frame', 'plates', 'rods', 'fin', 'objects', 'engraving', 'water', 'labels'];

export default function ViewportLayersToolbar() {
  const layers = useStore((s) => s.ui.viewportLayers);
  const toggle = useStore((s) => s.toggleViewportLayer);
  const model = useModel();
  const ids = ORDER.filter((id) => (id !== 'rods' || showRodsLayerToggle(model.v.sliceMode, model.sliced)) && (id !== 'objects' || model.objects.length > 0));
  return (
    <div className="viewport-layers overlay bc" role="toolbar" aria-label="Viewport visibility" data-testid="viewport-layers">
      {ids.map((id) => (
        <button
          key={id}
          type="button"
          className={`btn sm ${layers[id] ? 'on' : ''}`}
          data-testid={`viewport-layer-${id}`}
          onClick={() => toggle(id)}
          title={`Show or hide ${VIEWPORT_LAYER_LABELS[id]} (view only)`}
        >
          {VIEWPORT_LAYER_LABELS[id]}
        </button>
      ))}
    </div>
  );
}
