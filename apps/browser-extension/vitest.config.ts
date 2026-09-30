import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    },
  },
  // Components use the automatic JSX runtime (tsconfig "jsx": "react-jsx").
  esbuild: { jsx: 'automatic' },
  test: {
    name: 'browser-extension',
    include: ['tests/**/*.test.{ts,tsx}'],
    environment: 'node',
  },
});
