/// <reference types="vitest" />
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    // Module C tests only — they must not pull in Module B's mapbox-gl runtime.
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
    // Force a hermetic, token-less baseline so the TacticalMap token-resolution
    // tests assert the documented fallback chain rather than whatever a developer
    // happens to have in `.env.local` (where the real Mapbox dev token lives).
    // Tests that need a token pass one explicitly via the `accessToken` prop.
    env: { VITE_MAPBOX_ACCESS_TOKEN: '' },
  },
});
