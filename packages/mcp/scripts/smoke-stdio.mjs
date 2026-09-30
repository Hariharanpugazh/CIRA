// Smoke test: connect to the BUILT server (dist/server.js) over real stdio
// with the official SDK client, exactly as an MCP-compatible agent would.
//
//   node packages/mcp/scripts/smoke-stdio.mjs [--dir <contexts dir>]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const server = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'server.js');
const extra = process.argv.slice(2);

const transport = new StdioClientTransport({ command: process.execPath, args: [server, ...extra], env: { ...process.env }, stderr: 'inherit' });
const client = new Client({ name: 'cira-smoke', version: '0.0.0' });
await client.connect(transport);

const tools = await client.listTools();
console.log('tools:', tools.tools.map((t) => t.name).join(', '));

const list = await client.callTool({ name: 'list_contexts', arguments: {} });
console.log('\n--- list_contexts ---\n' + list.content[0].text);

const ctx = await client.callTool({ name: 'get_context', arguments: { types: ['decision', 'constraint', 'task'] } });
console.log('\n--- get_context(types=[decision,constraint,task]) ---\n' + ctx.content[0].text);

await client.close();
process.exitCode = ctx.isError ? 1 : 0;
