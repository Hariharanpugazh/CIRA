/**
 * Exercises the server through a real MCP client over the SDK's in-memory
 * transport (same JSON-RPC as stdio), backed by a FileContextStore.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { decode, renderMarkdown, type PCODocument } from '@cira/core';
import { FileContextStore } from '@cira/core/node';
import { createCiraMcpServer } from '../src/server';

const EXAMPLES = resolve(__dirname, '../../pco/examples');
const example = async (name: string) => JSON.parse(await readFile(join(EXAMPLES, `${name}.pco.json`), 'utf8')) as PCODocument;

let dir = '';
let client: Client;
let store: FileContextStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cira-mcp-'));
  store = new FileContextStore(dir);
  const server = createCiraMcpServer(store);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientTransport);
});
afterEach(async () => {
  await client.close();
  await rm(dir, { recursive: true, force: true });
});

const text = (r: Awaited<ReturnType<Client['callTool']>>) => (r.content as Array<{ type: string; text: string }>)[0].text;

describe('CIRA MCP server', () => {
  it('exposes exactly list_contexts and get_context, both read-only', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['get_context', 'list_contexts']);
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true);
    const get = tools.find((t) => t.name === 'get_context')!;
    expect(Object.keys(get.inputSchema.properties ?? {})).toEqual(['id', 'types', 'min_confidence', 'format']);
  });

  it('list_contexts reports an empty store helpfully', async () => {
    const r = await client.callTool({ name: 'list_contexts', arguments: {} });
    expect(text(r)).toContain('No CIRA contexts found');
    expect(r.structuredContent).toEqual({ contexts: [] });
  });

  it('list_contexts → get_context returns the same context the CLI exports', async () => {
    const doc = await example('technical-project');
    await store.put(doc);
    await store.put(await example('decisions'));

    const list = await client.callTool({ name: 'list_contexts', arguments: {} });
    expect(text(list)).toContain(doc.id);
    expect((list.structuredContent as { contexts: unknown[] }).contexts).toHaveLength(2);

    const got = await client.callTool({ name: 'get_context', arguments: { id: doc.id } });
    expect(got.isError).toBeFalsy();
    expect(text(got)).toBe(renderMarkdown(decode(doc)));
  });

  it('get_context filters by type', async () => {
    const doc = await example('technical-project');
    await store.put(doc);
    const r = await client.callTool({ name: 'get_context', arguments: { id: doc.id, types: ['decision', 'constraint', 'task'], format: 'json' } });
    const decoded = JSON.parse(text(r));
    expect(decoded.sections.map((s: { type: string }) => s.type)).toEqual(['constraint', 'decision', 'task']);
    expect(decoded.sections.flatMap((s: { items: Array<{ provenance: { platform: string } }> }) => s.items.map((i) => i.provenance.platform))).toContain('claude');
  });

  it('get_context defaults to the most recent context', async () => {
    await store.put(await example('decisions'));
    const r = await client.callTool({ name: 'get_context', arguments: {} });
    expect(text(r)).toMatch(/^# Context: /);
  });

  it('returns tool errors (not protocol errors) for unknown ids and empty stores', async () => {
    const empty = await client.callTool({ name: 'get_context', arguments: {} });
    expect(empty.isError).toBe(true);
    await store.put(await example('decisions'));
    const unknown = await client.callTool({ name: 'get_context', arguments: { id: 'pco_nope' } });
    expect(unknown.isError).toBe(true);
    expect(text(unknown)).toContain('Available:');
  });

  it('rejects invalid arguments via schema validation', async () => {
    const r = await client.callTool({ name: 'get_context', arguments: { types: ['feelings'] } });
    expect(r.isError).toBe(true);
  });
});
