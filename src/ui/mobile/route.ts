// The phone viewer lives at /m in the same app. Phones that open the editor's
// address are sent there too, unless they chose the full editor once.

export const VIEWER_PATH = '/m';
export const DESKTOP_CHOICE_KEY = 'strata.viewer.desktop';

export function isViewerPath(pathname: string): boolean {
  return pathname === VIEWER_PATH || pathname === `${VIEWER_PATH}/` || pathname.startsWith(`${VIEWER_PATH}/`);
}

/** A phone: touch first and narrow. iPads and desktops keep the editor. */
export function looksLikePhone(win: Pick<Window, 'matchMedia'> | undefined = typeof window !== 'undefined' ? window : undefined): boolean {
  try {
    return !!win?.matchMedia('(pointer: coarse) and (max-width: 600px)').matches;
  } catch {
    return false;
  }
}

export function choseDesktop(ls?: Storage): boolean {
  try {
    return (ls ?? localStorage).getItem(DESKTOP_CHOICE_KEY) === '1';
  } catch {
    return false;
  }
}

export function setDesktopChoice(on: boolean, ls?: Storage): void {
  try {
    const s = ls ?? localStorage;
    if (on) s.setItem(DESKTOP_CHOICE_KEY, '1');
    else s.removeItem(DESKTOP_CHOICE_KEY);
  } catch {
    /* private mode */
  }
}

/** Where a phone opening the editor should go instead, if anywhere. Share links (#…) stay in the editor. */
export function phoneRedirect(loc: Pick<Location, 'pathname' | 'hash' | 'search'>, phone: boolean, desktop: boolean): string | null {
  if (!phone || desktop || isViewerPath(loc.pathname)) return null;
  if (loc.pathname !== '/' || loc.hash || loc.search) return null;
  return VIEWER_PATH;
}
