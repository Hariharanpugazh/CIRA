import { defineConfig } from 'vitest/config';

// Vitest >= 4 replaced `vitest.workspace.ts` with `test.projects`; each
// workspace member (apps/*, packages/*, cli) owns its own `vitest.config.ts`.
export default defineConfig({
  test: {
    projects: ['{apps,packages}/*/vitest.config.ts', '*/vitest.config.ts'],
  },
});
