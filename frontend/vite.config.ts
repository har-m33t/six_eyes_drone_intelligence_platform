import { defineConfig, type Plugin, type Connect } from 'vite';
import react from '@vitejs/plugin-react';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ServerResponse } from 'node:http';

// The six "drone feeds" are pre-recorded MP4s that live in the repo-root
// `footage/` directory (one level above this frontend). Serving them at
// `/footage/*` lets the video tiles play the clips DIRECTLY in the browser, so
// the dashboard shows moving video even when the Python producer isn't running
// — live WebSocket frames simply take over when the backend is up. We stream the
// files straight from disk (no copy into the bundle) with HTTP range support so
// <video> looping/seeking works across browsers.
const FOOTAGE_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'footage');
const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
};

function serveFootage(req: Connect.IncomingMessage, res: ServerResponse, next: () => void): void {
  // The middleware is mounted at `/footage`, so `req.url` is the path BELOW it.
  const name = decodeURIComponent((req.url ?? '').split('?')[0]).replace(/^\/+/, '');
  // Only flat filenames from FOOTAGE_DIR — reject traversal / subpaths.
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) return next();

  const file = resolve(FOOTAGE_DIR, name);
  if (!file.startsWith(FOOTAGE_DIR) || !existsSync(file)) return next();

  const { size } = statSync(file);
  const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
  res.setHeader('Content-Type', type);
  res.setHeader('Accept-Ranges', 'bytes');

  const range = req.headers.range;
  const match = range ? /bytes=(\d*)-(\d*)/.exec(range) : null;
  if (match) {
    const start = match[1] ? parseInt(match[1], 10) : 0;
    const end = match[2] ? parseInt(match[2], 10) : size - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= size) {
      res.statusCode = 416; // Range Not Satisfiable
      res.setHeader('Content-Range', `bytes */${size}`);
      res.end();
      return;
    }
    res.statusCode = 206;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    res.setHeader('Content-Length', String(end - start + 1));
    createReadStream(file, { start, end }).pipe(res);
  } else {
    res.statusCode = 200;
    res.setHeader('Content-Length', String(size));
    createReadStream(file).pipe(res);
  }
}

function footageServer(): Plugin {
  return {
    name: 'six-eyes-footage-server',
    configureServer(server) {
      server.middlewares.use('/footage', serveFootage);
    },
    configurePreviewServer(server) {
      server.middlewares.use('/footage', serveFootage);
    },
  };
}

// Dev/build config for the SIX-EYES React frontend. (Test config lives in the
// separate vitest.config.ts.) The React plugin provides JSX transform + Fast
// Refresh; `index.html` at the project root is the entry Vite bundles from.
export default defineConfig({
  plugins: [react(), footageServer()],
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
