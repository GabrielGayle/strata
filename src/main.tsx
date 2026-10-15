import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';
import App from './ui/App';
import { applyTheme, loadTheme } from './ui/theme';
import { hydrate } from './state/store';

// apply the saved window appearance before the first paint
applyTheme(loadTheme());

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
