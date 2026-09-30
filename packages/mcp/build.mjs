// Bundles the server and @cira/core into dist/server.js. The MCP SDK and zod
// stay external (resolved from this package's node_modules) so the SDK and
// Core share one zod instance.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/server.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  external: ['@modelcontextprotocol/sdk', '@modelcontextprotocol/sdk/*', 'zod', 'zod/*'],
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'info',
});
