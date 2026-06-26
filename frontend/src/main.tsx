/**
 * SIX-EYES frontend entry point.
 * ------------------------------
 * Mounts the React tree and opens the WebSocket. The socket is connected here,
 * outside React, because the Module-A store is global (Zustand) and the service
 * pushes straight into it via `getState()` — no provider needed. `connect()` is
 * idempotent, so StrictMode's double-invoke is safe.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { webSocketService } from './services/websocket';
import './styles/theme.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('SIX-EYES: #root container not found in index.html');
}

// Open the live telemetry socket (auto-reconnects on drop).
webSocketService.connect();

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
