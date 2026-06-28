import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The six "drone feeds" are streamed from the Python producer over the WebSocket
// (`packet.frame_b64`) and rendered as live JPEG frames — the browser never
// plays the source MP4s directly. (The repo-root `footage/` clips are read
// server-side by the producer, not served to the frontend.) So there is no
// footage middleware here; the dev server only proxies the Mapbox runtime token.

// Dev/build config for the SIX-EYES React frontend. (Test config lives in the
// separate vitest.config.ts.) The React plugin provides JSX transform + Fast
// Refresh; `index.html` at the project root is the entry Vite bundles from.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    open: true,
    proxy: {
      // Secure Mapbox-token delivery. The Python dashboard server
      // (`python -m src.dashboard_server`, port 8000) reads MAPBOX_ACCESS_TOKEN
      // from `.env` and serves it as `window.SIX_EYES_CONFIG` via
      // /runtime-config.js. Proxying that one path means the React dev app
      // fetches the token at RUNTIME from the server — it is never baked into
      // the JS bundle or committed. Run the dashboard server alongside `npm run
      // dev`. If it isn't running the request 404s harmlessly and the map shows
      // a "MAP UNAVAILABLE" fallback (see TacticalMap) instead of crashing.
      '/runtime-config.js': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
});
