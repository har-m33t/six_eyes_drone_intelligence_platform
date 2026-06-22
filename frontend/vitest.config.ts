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
  },
});
