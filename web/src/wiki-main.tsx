import { StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import WikiView from './wiki/WikiView';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={<div className="flex h-screen items-center justify-center text-sm text-gray-400 bg-white">Loading Wiki...</div>}>
      <WikiView onGoHome={() => { window.location.href = '/'; }} />
    </Suspense>
  </StrictMode>
);
