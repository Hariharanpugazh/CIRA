/**
 * stdio entry point: `node packages/mcp/dist/server.js`.
 *
 * Reads contexts from $CIRA_HOME/contexts (default ~/.cira/contexts), or from
 * the directory given with `--dir <path>`. stdio only: no network listener,
 * read-only, so there is no remote attack surface. stdout carries MCP
 * JSON-RPC; logs go to stderr.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { defaultContextDir, FileContextStore } from '@cira/core/node';
import { createCiraMcpServer } from './server';

const dirFlag = process.argv.indexOf('--dir');
const dir = dirFlag >= 0 && process.argv[dirFlag + 1] ? process.argv[dirFlag + 1] : defaultContextDir();

const store = new FileContextStore(dir, {
  onInvalidFile: ({ file, reason }) => console.error(`[cira-mcp] skipping invalid context file ${file}: ${reason}`),
});
const server = createCiraMcpServer(store, { storeLabel: store.dir });

await server.connect(new StdioServerTransport());
console.error(`[cira-mcp] ready on stdio · contexts: ${store.dir}`);
