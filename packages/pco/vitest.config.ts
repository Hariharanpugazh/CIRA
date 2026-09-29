import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'pco',
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
