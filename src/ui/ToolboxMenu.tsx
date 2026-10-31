import { createElement, useEffect } from 'react';

// The cockpit yoga toolbox menu: the site serves <cockpit-toolbox>, a menu of every tool in the
// suite (lace, strata, kerf, fret, seep), drawn in the same clean DS look as Strata (look="clean").
// It sits at the right end of the title bar. Offline, or before the site answers, the slot stays empty.

const SITE = ((import.meta.env?.VITE_COCKPIT_URL as string | undefined) ?? 'https://cockpit.yoga').replace(/\/$/, '');

function loadMenuScript() {
  if (typeof document === 'undefined' || document.querySelector('script[data-cockpit-toolbox]')) return;
  const s = document.createElement('script');
  s.src = `${SITE}/toolbox/menu.js`;
  s.defer = true;
  s.dataset.cockpitToolbox = '';
  document.head.append(s);
}

export function ToolboxMenu() {
  useEffect(loadMenuScript, []);
  return (
    <span className="toolbox-slot" data-hl="toolbox-menu">
      {/* opens leftwards, from the right edge of the screen */}
      {createElement('cockpit-toolbox', { current: 'strata', look: 'clean', align: 'right' })}
    </span>
  );
}
