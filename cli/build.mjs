// Bundles the CLI (and @cira/core + zod) into one self-contained ESM file so
// `node cli/dist/cira.js` works without a TypeScript runtime. This matters
// for the native messaging host, which the browser launches directly.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/bin.ts'],
  outfile: 'dist/cira.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'info',
});
