// A Blender-style panel for the 3D view's sidebar: a header that folds its
// contents away. Which panels are folded is remembered per panel.
import { useState, type ReactNode } from 'react';

const KEY = 'strata.folds.v1';

function readFolds(): Record<string, boolean> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

export function Fold({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  const [shut, setShut] = useState(() => !!readFolds()[id]);
  const flip = () => {
    setShut(!shut);
    try {
      localStorage.setItem(KEY, JSON.stringify({ ...readFolds(), [id]: !shut }));
    } catch {
      /* private mode: just not remembered */
    }
  };
  return (
    <section className={`vs-fold${shut ? ' shut' : ''}`} aria-label={title}>
      <button className="vs-fold-head" aria-expanded={!shut} onClick={flip} data-hl={`fold-${id}`} title={shut ? 'Show this panel' : 'Fold this panel away'}>
        <span className="vs-fold-arrow" aria-hidden="true">
          {shut ? '▸' : '▾'}
        </span>
        {title}
      </button>
      {!shut && <div className="vs-fold-body">{children}</div>}
    </section>
  );
}
