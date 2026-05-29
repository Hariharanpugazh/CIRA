/**
 * CIRA MCP Server — stdio entry point for Claude Code / VS Code
 *
 * This is the file IDE agents launch as a subprocess.
 * It runs the MCP server over stdio transport, accepting JSON-RPC
 * messages on stdin and writing responses to stdout.
 *
 * The HTTP/WS server from server.ts is NOT started in stdio mode —
 * context comes purely from what the extension has pushed via WebSocket.
 * If no companion HTTP process is running, the server serves empty state.
 *
 * Usage in .claude/settings.json (Claude Code):
 *   {
 *     "mcpServers": {
 *       "cira": {
 *         "command": "bun",
 *         "args": ["run", "cira-mcp/src/stdio.ts"]
 *       }
 *     }
 *   }
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  type ListToolsResult,
  type Tool,
  ListResourcesResult,
  ListPromptsResult,
  type Prompt,
} from "@modelcontextprotocol/sdk/types.js";
import { WebSocket } from "ws";
import http from "node:http";

// ── Types ─────────────────────────────────────────────────────────────────

type Source = "chatgpt" | "claude" | "gemini";

interface Message {
  role: "user" | "assistant" | "system";
  content: string;
}

interface Conversation {
  source: Source;
  title: string;
  url: string;
  capturedAt: string;
  messages: Message[];
}

interface ContextEntry {
  conversation: Conversation;
  summary: string;
  version: number;
}

// ── Shared state via HTTP from the companion process ──────────────────────

const MCP_HTTP_URL = "http://127.0.0.1:9020";

async function getContexts(): Promise<Map<Source, ContextEntry>> {
  try {
    const res = await fetch(`${MCP_HTTP_URL}/health`);
    const health = (await res.json()) as { contexts: number; wsClients: number };
    console.error(`[cira-stdio] companion status: ${health.contexts} contexts, ${health.wsClients} ws clients`);
  } catch {
    console.error("[cira-stdio] companion not running — context will be empty");
  }
  // For full data sharing, the companion process would need a data endpoint.
  // For now, stdio mode acts as a thin proxy to the companion over HTTP.
  return new Map();
}

// ── MCP Server ────────────────────────────────────────────────────────────

const tools: Tool[] = [
  {
    name: "get_context",
    description:
      "Get the current conversation context captured from an AI assistant (ChatGPT, Claude, or Gemini).",
    inputSchema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          enum: ["chatgpt", "claude", "gemini"],
          description: "Which AI assistant's context to retrieve",
        },
      },
      required: ["source"],
    },
  },
  {
    name: "list_conversations",
    description: "List all available conversation contexts.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "request_capture",
    description: "Request the extension to capture the current page from the given AI assistant.",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", enum: ["chatgpt", "claude"] },
      },
      required: ["source"],
    },
  },
];

const prompts: Prompt[] = [
  {
    name: "continue_conversation",
    description: "Generates a handoff prompt from captured context.",
    arguments: [{ name: "source", description: "Which assistant's context", required: true }],
  },
];

const server = new Server(
  { name: "cira-mcp-stdio", version: "0.1.0" },
  {
    capabilities: {
      tools: { listChanged: false },
      prompts: { listChanged: false },
      resources: { subscribe: false, listChanged: false },
    },
  },
);

// tools/list
server.setRequestHandler(
  { method: "tools/list" },
  async (): Promise<ListToolsResult> => ({ tools }),
);

// tools/call — proxied to companion HTTP
server.setRequestHandler(
  { method: "tools/call" },
  async (request) => {
    try {
      const res = await fetch(`${MCP_HTTP_URL}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(request),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        return {
          content: [{ type: "text", text: `Companion error: ${res.status} — ${JSON.stringify(err)}` }],
        };
      }
      return (await res.json()) as never;
    } catch {
      return {
        content: [
          {
            type: "text",
            text: "CIRA companion process is not running. Start it with: cd cira-mcp && npm start\n\nThen the Chrome extension must also be connected for context to be available.",
          },
        ],
      };
    }
  },
);

// prompts/list
server.setRequestHandler(
  { method: "prompts/list" },
  async (): Promise<ListPromptsResult> => ({ prompts }),
);

// prompts/get — proxied to companion
server.setRequestHandler(
  { method: "prompts/get" },
  async (request) => {
    try {
      const res = await fetch(`${MCP_HTTP_URL}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(request),
      });
      return (await res.json()) as never;
    } catch {
      return {
        messages: [
          {
            role: "user",
            content: { type: "text", text: "CIRA companion process is not running." },
          },
        ],
      };
    }
  },
);

// resources/list — proxied to companion
server.setRequestHandler(
  { method: "resources/list" },
  async (): Promise<ListResourcesResult> => {
    try {
      const res = await fetch(`${MCP_HTTP_URL}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "resources/list" }),
      });
      return (await res.json()).result ?? { resources: [] };
    } catch {
      return { resources: [] };
    }
  },
);

// ── Start ──────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[cira-stdio] MCP server ready on stdio");
}

main().catch((err) => {
  console.error("[cira-stdio] fatal:", err);
  process.exit(1);
});
