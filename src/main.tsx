import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '98.css/dist/98.css';
import './styles.css';
import './win98.css';
import './form-chrome.css';
import './busy98.css';
import App from './ui/App';
import { applyTheme, loadTheme } from './ui/theme';
import { hydrate, useStore } from './state/store';
import { activeLayout, useWorkspaces } from './state/workspaces';
import { visibleTabs } from './core/workspace';
import { preloadView } from './ui/Workspace';
import { installE2eMapTileFixtures } from './core/mapBrowserTiles';
import { preloadModel } from './state/results';
import { choseDesktop, isViewerPath, looksLikePhone, phoneRedirect } from './ui/mobile/route';
import { startCockpitAuth } from './state/cockpitAuth';

installE2eMapTileFixtures();
// the cockpit yoga sign-in shared with lace and cockpit.yoga (no-op unless configured)
void startCockpitAuth();

// apply the saved window appearance before the first paint
applyTheme(loadTheme());

const goTo = phoneRedirect(location, looksLikePhone(), choseDesktop());
if (goTo) history.replaceState(null, '', goTo);

if (isViewerPath(location.pathname)) {
  // the phone viewer: it only reads saved projects, so the last session is never read back (or written)
  void import('./ui/mobile/MobileApp').then(({ default: MobileApp }) =>
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <MobileApp />
      </StrictMode>,
    ),
  );
} else {
  // start fetching the views on the first screen while the session loads
  for (const t of new Set([...visibleTabs(activeLayout(useWorkspaces.getState())), useStore.getState().ui.tab])) preloadView(t);

  // read the last session back from browser storage before the first render
  hydrate()
    .catch((e) => console.warn('Could not read the last session', e))
    // and the model it last showed, from the result cache, so the first frame needn't slice the plates here
    .then(() => preloadModel(useStore.getState().project))
    .catch(() => {})
    .finally(() =>
      createRoot(document.getElementById('root')!).render(
        <StrictMode>
          <App />
        </StrictMode>,
      ),
    );
}
