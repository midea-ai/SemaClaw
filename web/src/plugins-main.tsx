import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import PluginsView from './plugins/PluginsView';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PluginsView onGoHome={() => { window.location.href = '/'; }} />
  </StrictMode>
);
