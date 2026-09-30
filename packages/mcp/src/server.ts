/**
 * CIRA MCP server.
 *
 * A thin, read-only MCP connector over @cira/core: it reads Portable Context
 * Objects from a ContextStore and renders them with Core's decoder. It has no
 * context logic of its own.
 *
 * Tools (Phase 01):
 *  - list_contexts  — summaries of stored contexts (newest first)
 *  - get_context    — one context rendered as Markdown (or decoded JSON),
 *                     optionally filtered by item type / confidence
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { CONTEXT_ITEM_TYPES, decode, renderMarkdown, type ContextStore, type ContextSummary } from '@cira/core';

export const SERVER_NAME = 'cira';
export const SERVER_VERSION = '0.1.0';

function summaryLine(s: ContextSummary): string {
  const counts = Object.entries(s.item_counts)
    .map(([t, n]) => `${n} ${t}`)
    .join(', ');
  return `- ${s.id} — ${s.title ?? '(untitled)'} · ${s.sources.join(', ') || 'no source'} · updated ${s.updated_at} · ${s.item_count} items${counts ? ` (${counts})` : ''}`;
}

export function createCiraMcpServer(store: ContextStore, options: { storeLabel?: string } = {}): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        'CIRA provides user-owned context captured from other AI tools as Portable Context Objects (PCO). ' +
        'Call list_contexts to see what is available, then get_context to read one. Items carry provenance ' +
        '(source platform, conversation, turn) and an extraction method; heuristic items may be misclassified, ' +
        'so treat them as hints and respect constraints and decisions unless the user says otherwise.',
    },
  );

  server.registerTool(
    'list_contexts',
    {
      title: 'List CIRA contexts',
      description: 'List Portable Context Objects stored locally by CIRA, most recently updated first.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const list = await store.list();
      const text = list.length
        ? `${list.length} context(s)${options.storeLabel ? ` in ${options.storeLabel}` : ''}:\n${list.map(summaryLine).join('\n')}`
        : `No CIRA contexts found${options.storeLabel ? ` in ${options.storeLabel}` : ''}. Capture a conversation with the CIRA browser extension or run \`cira save <file>\`.`;
      return { content: [{ type: 'text', text }], structuredContent: { contexts: list } };
    },
  );

  server.registerTool(
    'get_context',
    {
      title: 'Get a CIRA context',
      description:
        'Read one Portable Context Object as agent-ready context. Defaults to the most recently updated context. ' +
        'Filter with `types` (e.g. ["decision","constraint","task"]) and `min_confidence`.',
      inputSchema: {
        id: z.string().min(1).optional().describe('Context id from list_contexts. Omit for the most recent.'),
        types: z.array(z.enum(CONTEXT_ITEM_TYPES)).min(1).optional().describe('Only include these item types.'),
        min_confidence: z.number().min(0).max(1).optional().describe('Drop items below this confidence (0..1).'),
        format: z.enum(['markdown', 'json']).default('markdown').describe('markdown (default) or decoded JSON.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ id, types, min_confidence, format }) => {
      let targetId = id;
      if (!targetId) {
        const [latest] = await store.list();
        if (!latest) {
          return { isError: true, content: [{ type: 'text', text: 'No CIRA contexts are stored yet.' }] };
        }
        targetId = latest.id;
      }
      const doc = await store.get(targetId);
      if (!doc) {
        const available = (await store.list()).slice(0, 20).map((s) => s.id);
        return {
          isError: true,
          content: [{ type: 'text', text: `Unknown context id "${targetId}". Available: ${available.join(', ') || 'none'}` }],
        };
      }
      const decoded = decode(doc, { types, minConfidence: min_confidence });
      const text = format === 'json' ? JSON.stringify(decoded, null, 2) : renderMarkdown(decoded);
      return { content: [{ type: 'text', text }] };
    },
  );

  return server;
}
