// Little Windows 98 style wait animations, in the spirit of the old "copying
// files" dialog: something flies from one icon to another. The icons are new
// pixel art for Strata (the original Windows animations aren't open source),
// drawn from 16×16 character grids. Every animation moves only transforms, so
// it keeps playing while the page's main thread is busy.
import { memo, type CSSProperties, type ReactElement } from 'react';
import type { BusyScene } from './busy';

export const PAL: Record<string, string> = {
  k: '#000000',
  w: '#ffffff',
  s: '#c0c0c0',
  g: '#808080',
  d: '#404040',
  n: '#000080',
  b: '#0000ff',
  t: '#008080',
  c: '#00ffff',
  y: '#ffff00',
  o: '#808000',
  r: '#800000',
  R: '#ff0000',
  G: '#008000',
  L: '#00ff00',
  u: '#b5571f',
  U: '#6e3311',
  e: '#e0e0e0',
  f: '#a0a0a0',
  h: '#606060',
};

// prettier-ignore
export const ICONS = {
  photo: [
    'kkkkkkkkkkkkkkkk',
    'kwwwwwwwwwwwwwwk',
    'kwccccccccccccwk',
    'kwccccccccyyccwk',
    'kwcccccccyyyycwk',
    'kwccccccccyyccwk',
    'kwccccGcccccccwk',
    'kwcccGGGccccccwk',
    'kwccGGGGGccGccwk',
    'kwcGGGGGGGGGGcwk',
    'kwGGGGGGGGGGGGwk',
    'kwGGGGGGGGGGGGwk',
    'kwwwwwwwwwwwwwwk',
    'kkkkkkkkkkkkkkkk',
    '................',
    '................',
  ],
  depth: [
    'kkkkkkkkkkkkkkkk',
    'kwwwwwwwwwwwwwwk',
    'kwkkkkkkkkkkkkwk',
    'kwkkkkkkkkkkkkwk',
    'kwddddddddddddwk',
    'kwddddddhdddddwk',
    'kwhhhhhhfhhhhhwk',
    'kwhhhhhfsfhhhhwk',
    'kwffffseeesfffwk',
    'kwfffseeweesffwk',
    'kwssseewwweesswk',
    'kweeewwwwwweeewk',
    'kwwwwwwwwwwwwwwk',
    'kkkkkkkkkkkkkkkk',
    '................',
    '................',
  ],
  globe: [
    '.....kkkkkk.....',
    '...kkbbGGbbkk...',
    '..kbbGGGGbbbbk..',
    '.kbbbGGGbbbGGbk.',
    '.kbbbbGbbbGGGbk.',
    'kbbbbbbbbbGGGbbk',
    'kGGbbbbbbbbGbbbk',
    'kGGGGbbbbbbbbbbk',
    'kbGGGGbbbbbbbbbk',
    'kbbGGbbbbbGGbbbk',
    '.kbbGbbbbGGGGbk.',
    '.kbbbbbbbbGGbbk.',
    '..kbbbbbbbbbbk..',
    '...kkbbbbbbkk...',
    '.....kkkkkk.....',
    '................',
  ],
  terrain: [
    '................',
    '................',
    '.........k......',
    '........kwk.....',
    '.......kwssk....',
    '....k.kssssk....',
    '...kwkssgsssk...',
    '..kwssssggsssk..',
    '.kssgsssgggsssk.',
    'kGGGGGsggggGGGGk',
    'kGGGGGGGGGGGGGGk',
    'kooooooooooooook',
    'kuuuuuuuuuuuuuuk',
    'kUUUUUUUUUUUUUUk',
    'kkkkkkkkkkkkkkkk',
    '................',
  ],
  plates: [
    '................',
    '..kkkkkkkkkkkk..',
    '..kuuuuuuuuuuk..',
    '..kkkkkkkkkkkk..',
    '...kkkkkkkkkkkk.',
    '...kuuuuuuuuuuk.',
    '...kkkkkkkkkkkk.',
    '..kkkkkkkkkkkk..',
    '..kuuuuuuuuuuk..',
    '..kkkkkkkkkkkk..',
    '.kkkkkkkkkkkk...',
    '.kuuuuuuuuuuk...',
    '.kkkkkkkkkkkk...',
    'gggggggggggggggg',
    'ssssssssssssssss',
    'kkkkkkkkkkkkkkkk',
  ],
  folder: [
    '................',
    '................',
    '..kkkkk.........',
    '.kyyyyyk........',
    'kyyyyyyykkkkkkk.',
    'kwwwwwwwwwwwwwyk',
    'kwyyyyyykyyyyyok',
    'kwyyyyyykyyyyyok',
    'kwyyyyyywyyyyyok',
    'kwyyyyyykyyyyyok',
    'kwyyyyyywyyyyyok',
    'kwyyyyyykyyyyyok',
    'kwyyyyyywyyyyyok',
    'kooooooooooooook',
    '.kkkkkkkkkkkkkkk',
    '................',
  ],
  printer: [
    '....kkkkkkkk....',
    '....kwwwwwwk....',
    '....kwkkkkwk....',
    '....kwwwwwwk....',
    '..kkkkkkkkkkkk..',
    '.kssssssssssssk.',
    'kwwwwwwwwwwwwwsk',
    'kssssssssssLssgk',
    'ksssssssssssssgk',
    'kggggggggggggggk',
    'kskkkkkkkkkkkksk',
    'kskwwwwwwwwwwksk',
    '.kkwkkkkkkkkwkk.',
    '...kwwwwwwwwk...',
    '...kkkkkkkkkk...',
    '................',
  ],
  sun: [
    '.......y........',
    '.y.....y.....y..',
    '..y....y....y...',
    '...y.kkkkk.y....',
    '....kyyyyyk.....',
    '...kyyyyyyyk....',
    'yyykyyyyyyykyyy.',
    '...kyyyyyyyk....',
    '...kyyyyyyyk....',
    '....kyyyyyk.....',
    '...y.kkkkk.y....',
    '..y....y....y...',
    '.y.....y.....y..',
    '.......y........',
    '................',
    '................',
  ],
  wall: [
    'kkkkkkkkkkkkkkkk',
    'keeeeeeeeeeeeeek',
    'keeeeeeeeeeeeeek',
    'keeehhheeeeeeeek',
    'keeehhhheeeeeeek',
    'keeeehhhheeeeeek',
    'keeeeehhheeehhek',
    'keeeeeehheehhhek',
    'keeeeeeehhhhheek',
    'keeeeeeeehhheeek',
    'keeeeeeeeeeeeeek',
    'keeeeeeeeeeeeeek',
    'kkkkkkkkkkkkkkkk',
    'kffffffffffffffk',
    'kkkkkkkkkkkkkkkk',
    '................',
  ],
  disk: [
    'kkkkkkkkkkkkkkk.',
    'knnwwwwwwwwwnnnk',
    'knnwwwwwwwwwnnnk',
    'knnwkkkkkkkwnnnk',
    'knnwwwwwwwwwnnnk',
    'knnwkkkkkkwwnnnk',
    'knnwwwwwwwwwnnnk',
    'knnnnnnnnnnnnnnk',
    'knnnnnnnnnnnnnnk',
    'knnnsssssssssnnk',
    'knnnsskkssssnnnk',
    'knnnsskkssssnnnk',
    'knnnsskkssssnnnk',
    '.knnsssssssssnnk',
    '..kkkkkkkkkkkkkk',
    '................',
  ],
  page: [
    '..kkkkkkkkk.....',
    '..kwwwwwwwkk....',
    '..kwwwwwwwkwk...',
    '..kwkkkkwwkkkk..',
    '..kwwwwwwwwwwk..',
    '..kwkkkkkkkkwk..',
    '..kwwwwwwwwwwk..',
    '..kwkkkkkkkkwk..',
    '..kwwwwwwwwwwk..',
    '..kwuuuuuuwwwk..',
    '..kwuuuuuuwwwk..',
    '..kwwwwwwwwwwk..',
    '..kwkkkkkkkwwk..',
    '..kwwwwwwwwwwk..',
    '..kkkkkkkkkkkk..',
    '................',
  ],
  film: [
    'kkkkkkkkkkkkkkkk',
    'kkwkkwkkwkkwkkwk',
    'kkkkkkkkkkkkkkkk',
    'kcccccckkcccccck',
    'kcycccckkccccyck',
    'kcccccckkcccccck',
    'kGGcccckkcGGccck',
    'kGGGGcckkGGGGGck',
    'kGGGGGGkkGGGGGGk',
    'kkkkkkkkkkkkkkkk',
    'kkwkkwkkwkkwkkwk',
    'kkkkkkkkkkkkkkkk',
    '................',
    '................',
    '................',
    '................',
  ],
  map: [
    'kkkkkkkkkkkkkkkk',
    'keeGGeeeeeebbeek',
    'keGGGGeeeebbbeek',
    'keeGGeeeeebbbbek',
    'keeeeeekeeebbeek',
    'keeeeekkkeeeeeek',
    'keeeeeekeeeeeeek',
    'keGGeeeeeeeeGGek',
    'kGGGGeeeeeeGGGek',
    'keGGeeeeeeeeGGek',
    'keeeeebbbeeeeeek',
    'keeeebbbbbeeeeek',
    'keeeeebbbeeeeeek',
    'kkkkkkkkkkkkkkkk',
    '................',
    '................',
  ],
  // ── small flying sprites ──
  chip: [
    'kkkkkkkk',
    'kccyccck',
    'kcGcccck',
    'kGGGcGck',
    'kGGGGGGk',
    'kkkkkkkk',
    '........',
    '........',
  ],
  plate: [
    'kkkkkkkk',
    'kuuuuuuk',
    'kuUuuuuk',
    'kuuuuUuk',
    'kuuuuuuk',
    'kkkkkkkk',
    '........',
    '........',
  ],
  sheet: [
    'kkkkkk..',
    'kwwwwkk.',
    'kwkkwwk.',
    'kwwwwwk.',
    'kwkkkwk.',
    'kwwwwwk.',
    'kkkkkkk.',
    '........',
  ],
  tile: [
    'kkkkkkkk',
    'kGGsssGk',
    'kGssgsGk',
    'ksgggssk',
    'kssggGGk',
    'kkkkkkkk',
    '........',
    '........',
  ],
  ray: [
    '........',
    '...yy...',
    '..yyyy..',
    '.yyyyyy.',
    '..yyyy..',
    '...yy...',
    '........',
    '........',
  ],
  lens: [
    '..kkkk..........',
    '.kccwck.........',
    'kccwccck........',
    'kcwcccck........',
    'kcccccck........',
    '.kcccck.........',
    '..kkkkkk........',
    '.......kk.......',
    '........kk......',
    '.........kk.....',
    '................',
    '................',
    '................',
    '................',
    '................',
    '................',
  ],
} satisfies Record<string, string[]>;

type IconName = keyof typeof ICONS;

/** One pixel-art icon as an SVG, a <rect> per run of one colour. */
const Pixel = memo(function Pixel({ name, size, className, style }: { name: IconName; size?: number; className?: string; style?: CSSProperties }) {
  const rows = ICONS[name];
  const w = rows[0].length;
  const h = rows.length;
  const rects: ReactElement[] = [];
  rows.forEach((row, y) => {
    let x = 0;
    while (x < w) {
      const ch = row[x];
      let end = x + 1;
      while (end < w && row[end] === ch) end++;
      const fill = PAL[ch];
      if (fill) rects.push(<rect key={`${x}-${y}`} x={x} y={y} width={end - x} height={1} fill={fill} />);
      x = end;
    }
  });
  const px = size ?? w * 2;
  return (
    <svg className={className} style={style} width={px} height={(px * h) / w} viewBox={`0 0 ${w} ${h}`} shapeRendering="crispEdges" aria-hidden="true">
      {rects}
    </svg>
  );
});

const FLIGHTS: Partial<Record<BusyScene, { from: IconName; to: IconName; item: IconName }>> = {
  depth: { from: 'photo', to: 'depth', item: 'chip' },
  map: { from: 'globe', to: 'terrain', item: 'tile' },
  export: { from: 'plates', to: 'folder', item: 'plate' },
  pack: { from: 'plates', to: 'printer', item: 'sheet' },
  shadow: { from: 'sun', to: 'wall', item: 'ray' },
  save: { from: 'page', to: 'disk', item: 'sheet' },
  video: { from: 'film', to: 'photo', item: 'chip' },
};

/** The animation for one kind of wait. `small` is the 16px status bar size. */
export function BusyAnim({ scene, small }: { scene: BusyScene; small?: boolean }) {
  if (small) return <Hourglass small />;
  const flight = FLIGHTS[scene];
  if (flight) {
    return (
      <div className="busy-anim busy-flight" aria-hidden="true">
        <Pixel name={flight.from} className="busy-from" />
        <div className="busy-arc">
          {[0, 1, 2].map((i) => (
            <div key={i} className="busy-fly-x" style={{ animationDelay: `${-i * 0.6}s` }}>
              <div className="busy-fly-y" style={{ animationDelay: `${-i * 0.6}s` }}>
                <Pixel name={flight.item} size={14} />
              </div>
            </div>
          ))}
        </div>
        <Pixel name={flight.to} className="busy-to" />
      </div>
    );
  }
  if (scene === 'engine') return <Laser />;
  if (scene === 'search') {
    return (
      <div className="busy-anim busy-search" aria-hidden="true">
        <Pixel name="map" size={40} />
        <div className="busy-lens-orbit">
          <Pixel name="lens" size={32} />
        </div>
      </div>
    );
  }
  return (
    <div className="busy-anim busy-hourglass-wrap" aria-hidden="true">
      <Hourglass />
    </div>
  );
}

/** Plates in a stack with a laser line sweeping down them. */
function Laser() {
  return (
    <div className="busy-anim busy-laser" aria-hidden="true">
      <div className="busy-laser-stack">
        {[0, 1, 2, 3, 4].map((i) => (
          <div key={i} className="busy-laser-plate" style={{ animationDelay: `${i * 0.24}s` }} />
        ))}
        <div className="busy-laser-beam" />
      </div>
    </div>
  );
}

/** A pixel hourglass that drains and flips, like the old wait cursor. */
export function Hourglass({ small }: { small?: boolean }) {
  const s = small ? 1 : 2;
  return (
    <span className={`busy-hourglass ${small ? 'small' : ''}`} style={{ width: 12 * s, height: 16 * s }} aria-hidden="true">
      <svg width={12 * s} height={16 * s} viewBox="0 0 12 16" shapeRendering="crispEdges">
        <rect x="0" y="0" width="12" height="2" fill="#000" />
        <rect x="0" y="14" width="12" height="2" fill="#000" />
        <rect x="1" y="1" width="10" height="1" fill="#808080" />
        <rect x="1" y="14" width="10" height="1" fill="#808080" />
        <path d="M2 2h8v3h-1v1h-1v1h-1v2h1v1h1v1h1v3H2v-3h1v-1h1V9h1V7H4V6H3V5H2z" fill="#fff" stroke="#000" strokeWidth="0.5" />
        <g className="busy-sand-top">
          <rect x="3" y="3" width="6" height="2" fill="#b5571f" />
          <rect x="4" y="5" width="4" height="1" fill="#b5571f" />
        </g>
        <rect className="busy-sand-stream" x="5.5" y="6" width="1" height="6" fill="#b5571f" />
        <g className="busy-sand-bottom">
          <rect x="3" y="12" width="6" height="2" fill="#b5571f" />
          <rect x="4" y="11" width="4" height="1" fill="#b5571f" />
        </g>
      </svg>
    </span>
  );
}

/**
 * Windows 98 progress bar: 98.css's segmented .progress-indicator when the
 * amount is known, or a block that slides back and forth when it isn't.
 */
export function Progress98({ fraction, label }: { fraction: number | null; label: string }) {
  const pct = fraction === null ? undefined : Math.round(fraction * 100);
  return (
    <div
      className={`progress-indicator segmented busy-progress ${fraction === null ? 'indeterminate' : ''}`}
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
    >
      <span className="progress-indicator-bar" style={fraction === null ? undefined : { width: `${pct}%` }} />
    </div>
  );
}
