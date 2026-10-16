import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '98.css/dist/98.css';
import './styles.css';
import './win98.css';
import './form-chrome.css';
import App from './ui/App';
import { applyTheme, loadTheme } from './ui/theme';
import { hydrate, useStore } from './state/store';
import { activeLayout, useWorkspaces } from './state/workspaces';
import { visibleTabs } from './core/workspace';
import { preloadView } from './ui/Workspace';
import { installE2eMapTileFixtures } from './core/mapBrowserTiles';

installE2eMapTileFixtures();

// apply the saved window appearance before the first paint
applyTheme(loadTheme());

// start fetching the views on the first screen while the session loads
for (const t of new Set([...visibleTabs(activeLayout(useWorkspaces.getState())), useStore.getState().ui.tab])) preloadView(t);

// read the last session back from browser storage before the first render
hydrate()
  .catch((e) => console.warn('Could not read the last session', e))
  .finally(() =>
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <App />
      </StrictMode>,
    ),
  );
