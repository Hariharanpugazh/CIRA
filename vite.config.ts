import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import { resolve } from 'node:path';
import manifest from './manifest.config';

export default defineConfig({
  plugins: [react(), crx({ manifest })],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    // Vite >= 5.4 blocks cross-origin requests by default, which breaks the
    // crxjs service-worker loader (it fetches `@vite/env` from localhost from
    // a `chrome-extension://` origin). Allow the extension origin explicitly.
    cors: {
      origin: [/chrome-extension:\/\//],
    },
    hmr: {
      port: 5173,
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
  },
});
