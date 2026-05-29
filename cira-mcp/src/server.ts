/**
 * CIRA MCP Server — Companion Process
 *
 * Architecture:
 *   - Streamable HTTP on http://127.0.0.1:9020/mcp (for IDE MCP clients)
 *   - WebSocket on ws://127.0.0.1:9021 (for Chrome extension push)
 *   - In-memory store of current context snapshots per source
 *
 * IDE agents (Claude Code, VS Code, etc.) connect via MCP and call:
 *   - get_context(source: "chatgpt" | "claude") → compressed summary
 *   - list_conversations() → all captured conversations
 *   - capture_page(url) → trigger extension to capture current tab
 *
 * The Chrome extension connects via WebSocket and pushes:
 *   - { type: "context_snapshot", source, conversation }
 *   - { type: "live_delta", source, newMessages }
 *
 * The MCP server exposes a `resource` that SSE-streams live context changes
 * so IDE agents get real-time updates without polling.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  type CallToolRequestSchema,
  type ListToolsResult,
  type Tool,
  CallToolResultSchema,
  ListResourcesResult,
  ListPromptsResult,
  ReadResourceRequestSchema,
  type Resource,
  type Prompt,
} from "@modelcontextprotocol/sdk/types.js";
import { WebSocketServer, type WebSocket } from "ws";
import express from "express";
import http from "node:http";

// ── Types (mirror CIRA extension schema) ──────────────────────────────────

type Source = "chatgpt" | "claude" | "gemini" | "unknown";

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

interface RelayPayload {
  conversation: Conversation;
  summary: string;
}

// WebSocket message types from extension
type WsInbound =
  | { type: "context_snapshot"; source: Source; conversation: Conversation; summary: string }
  | { type: "live_delta"; source: Source; url: string; newMessages: Message[] }
  | { type: "clear_context"; source: Source };

type WsOutbound =
  | { type: "capture_request"; source: Source }
  | { type: "ack"; id: string };

// ── In-memory store ───────────────────────────────────────────────────────

interface ContextEntry {
  conversation: Conversation;
  summary: string;
  /** Monotonically increasing version, bumped on each delta. */
  version: number;
}

const contexts = new Map<Source, ContextEntry>();
let globalVersion = 0;

function bumpVersion(): number {
  return ++globalVersion;
}

function storeContext(source: Source, conversation: Conversation, summary: string): void {
  const entry: ContextEntry = { conversation, summary, version: bumpVersion() };
  contexts.set(source, entry);
  console.log(`[cira-mcp] stored context for ${source}: ${conversation.title} (v${entry.version})`);
}

function applyDelta(source: Source, url: string, newMessages: Message[]): void {
  let entry = contexts.get(source);
  if (!entry) {
    entry = {
      conversation: { source, title: url, url, capturedAt: new Date().toISOString(), messages: [] },
      summary: "",
      version: 0,
    };
  }
  // Append new messages that aren't already present (by content hash)
  const existing = new Set(entry.conversation.messages.map((m) => m.content.slice(0, 200)));
  for (const msg of newMessages) {
    if (!existing.has(msg.content.slice(0, 200))) {
      entry.conversation.messages.push(msg);
    }
  }
  // Re-compress summary (simple heuristic)
  entry.summary = compressSummary(entry.conversation);
  entry.version = bumpVersion();
  contexts.set(source, entry);
  console.log(`[cira-mcp] delta applied to ${source}, now ${entry.conversation.messages.length} messages (v${entry.version})`);
}

// ── Simple summary compression (mirrors CIRA core/compress.ts logic) ──────

function compressSummary(conv: Conversation): string {
  const userMsgs = conv.messages.filter((m) => m.role === "user");
  const lastUser = userMsgs.at(-1)?.content?.slice(0, 600) ?? "";
  const sections: string[] = [
    `# Context handoff from ${conv.source.toUpperCase()}`,
    `Title: ${conv.title}`,
    `Captured: ${conv.capturedAt}`,
    `${conv.messages.length} messages total`,
    "",
    "## Recent conversation",
  ];
  // Last 8 messages, truncated
  for (const m of conv.messages.slice(-8)) {
    const prefix = m.role === "user" ? "User" : "Assistant";
    const content = m.content.slice(0, 500);
    sections.push(`**${prefix}:** ${content}`);
  }
  if (lastUser) {
    sections.push("", "## Most recent user message", lastUser);
  }
  return sections.join("\n");
}

// ── MCP Tool Definitions ──────────────────────────────────────────────────

const tools: Tool[] = [
  {
    name: "get_context",
    description:
      "Get the current conversation context captured from an AI assistant (ChatGPT, Claude, or Gemini). Use this when you need to understand what the user was discussing before they switched to you.",
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
    description:
      "List all available conversation contexts that have been captured. Returns source, title, message count, and capture time for each.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "capture_page",
    description:
      "Request the Chrome extension to capture the current conversation from the given AI assistant's tab. The extension must be connected via WebSocket.",
    inputSchema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          enum: ["chatgpt", "claude"],
          description: "Which assistant to capture from",
        },
      },
      required: ["source"],
    },
  },
];

const prompts: Prompt[] = [
  {
    name: "continue_conversation",
    description:
      "Generates a prompt that primes you with context from the user's previous AI assistant conversation. Use this as a system/handoff prompt.",
    arguments: [
      {
        name: "source",
        description: "Which AI assistant's context to use",
        required: true,
      },
    ],
  },
];

// ── MCP Server Setup (dual transport: stdio + HTTP) ────────────────────────

const mcpServer = new Server(
  {
    name: "cira-mcp",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: { listChanged: true },
      prompts: { listChanged: false },
      resources: { subscribe: true, listChanged: true },
    },
  },
);

// tools/list
mcpServer.setRequestHandler(
  { method: "tools/list" },
  async (): Promise<ListToolsResult> => ({ tools }),
);

// tools/call
mcpServer.setRequestHandler(
  { method: "tools/call" },
  async (request) => {
    const { name, arguments: args } = request.params;

    if (name === "get_context") {
      const source = (args as { source: string }).source as Source;
      const entry = contexts.get(source);
      if (!entry) {
        return {
          content: [
            {
              type: "text",
              text: `No context available from ${source}. Open a ${source} conversation and use the CIRA extension to capture it, or ask the user to run 'capture_page' first.`,
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: entry.summary,
          },
        ],
      };
    }

    if (name === "list_conversations") {
      if (contexts.size === 0) {
        return {
          content: [{ type: "text", text: "No conversations captured yet." }],
        };
      }
      const lines = Array.from(contexts.entries()).map(
        ([src, e]) =>
          `- **${src}**: "${e.conversation.title}" — ${e.conversation.messages.length} messages, captured ${e.conversation.capturedAt} (v${e.version})`,
      );
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    if (name === "capture_page") {
      const source = (args as { source: string }).source as Source;
      // Send request to extension via WebSocket
      for (const ws of wsClients) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "capture_request", source } satisfies WsOutbound));
        }
      }
      return {
        content: [
          {
            type: "text",
            text: `Requested capture from ${source}. The extension should respond shortly. Use get_context("${source}") to check results.`,
          },
        ],
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  },
);

// prompts/list
mcpServer.setRequestHandler(
  { method: "prompts/list" },
  async (): Promise<ListPromptsResult> => ({ prompts }),
);

// prompts/get
mcpServer.setRequestHandler(
  { method: "prompts/get" },
  async (request) => {
    const { name, arguments: args } = request.params;
    if (name === "continue_conversation" && args?.source) {
      const entry = contexts.get(args.source as Source);
      const body = entry?.summary ?? `No context captured from ${args.source}.`;
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: body,
            },
          },
        ],
      };
    }
    throw new Error(`Unknown prompt: ${name}`);
  },
);

// resources/list — expose live context as subscribable resources
mcpServer.setRequestHandler(
  { method: "resources/list" },
  async (): Promise<ListResourcesResult> => ({
    resources: Array.from(contexts.entries()).map(([source, entry]) => ({
      uri: `cira://context/${source}`,
      name: `Current ${source} context`,
      description: `${entry.conversation.messages.length} messages, v${entry.version}`,
      mimeType: "text/markdown",
    })),
  }),
);

// resources/read
mcpServer.setRequestHandler(
  { method: "resources/read" },
  async (request) => {
    const uri = request.params.uri;
    const match = /^cira:\/\/context\/(.+)$/.exec(uri);
    if (!match) throw new Error(`Unknown resource: ${uri}`);
    const entry = contexts.get(match[1] as Source);
    if (!entry) throw new Error(`No context for ${match[1]}`);
    return {
      contents: [
        { uri, mimeType: "text/markdown", text: entry.summary },
      ],
    };
  },
);

// ── WebSocket Server (extension bridge) ────────────────────────────────────

const wsClients = new Set<WebSocket>();

const wss = new WebSocketServer({ port: 9021, host: "127.0.0.1" });
console.log("[cira-mcp] WebSocket bridge listening on ws://127.0.0.1:9021");

wss.on("connection", (ws) => {
  console.log("[cira-mcp] extension connected");
  wsClients.add(ws);

  ws.on("message", (raw) => {
    let msg: WsInbound;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "context_snapshot") {
      storeContext(msg.source, msg.conversation, msg.summary);
      // Notify MCP clients that resource list changed
      mcpServer.notification({ method: "notifications/resources/list_changed" }).catch(() => {});
    } else if (msg.type === "live_delta") {
      applyDelta(msg.source, msg.url, msg.newMessages);
      mcpServer.notification({ method: "notifications/resources/list_changed" }).catch(() => {});
    } else if (msg.type === "clear_context") {
      contexts.delete(msg.source);
      mcpServer.notification({ method: "notifications/resources/list_changed" }).catch(() => {});
    }
  });

  ws.on("close", () => {
    wsClients.delete(ws);
    console.log("[cira-mcp] extension disconnected");
  });
});

// ── Express HTTP server for MCP Streamable HTTP ────────────────────────────

const app = express();
app.use(express.json());

// MCP endpoint for Streamable HTTP transport
app.post("/mcp", async (req, res) => {
  // In production, validate Origin header here
  const body = req.body;
  if (!body || typeof body.method !== "string") {
    res.status(400).json({ jsonrpc: "2.0", error: { code: -32600, message: "Invalid Request" } });
    return;
  }

  try {
    // Use the MCP server's internal transport to handle the message
    // The @modelcontextprotocol/sdk v1 uses a transport abstraction
    // For Streamable HTTP, we handle messages directly
    const response = await mcpServer.handleMessage(body);
    if (response) {
      res.json(response);
    } else {
      res.status(202).end();
    }
  } catch (err) {
    console.error("[cira-mcp] error handling message:", err);
    res.status(500).json({
      jsonrpc: "2.0",
      id: body.id ?? null,
      error: { code: -32603, message: "Internal error" },
    });
  }
});

// SSE endpoint for server-initiated notifications
app.get("/mcp-sse", (_req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const sendEvent = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  // Send resource list on connect
  const resources = Array.from(contexts.entries()).map(([source, entry]) => ({
    uri: `cira://context/${source}`,
    mimeType: "text/markdown",
    name: `${source} context`,
  }));
  sendEvent("resources", resources);

  // Keep-alive ping every 15s
  const keepAlive = setInterval(() => {
    res.write(": ping\n\n");
  }, 15_000);

  req.on("close", () => {
    clearInterval(keepAlive);
  });
});

// Health check
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    contexts: contexts.size,
    wsClients: wsClients.size,
    version: globalVersion,
  });
});

const httpServer = http.createServer(app);
httpServer.listen(9020, "127.0.0.1", () => {
  console.log("");
  console.log("╭──────────────────────────────────────────────────╮");
  console.log("│              CIRA MCP Companion                  │");
  console.log("├──────────────────────────────────────────────────┤");
  console.log("│  Streamable HTTP : http://127.0.0.1:9020/mcp     │");
  console.log("│  SSE events      : http://127.0.0.1:9020/mcp-sse │");
  console.log("│  Health check    : http://127.0.0.1:9020/health  │");
  console.log("│  WebSocket       : ws://127.0.0.1:9021           │");
  console.log("│  Tools           : get_context, list_conversations│");
  console.log("│                   capture_page                    │");
  console.log("╰──────────────────────────────────────────────────╯");
  console.log("");
});

// ── Graceful shutdown ─────────────────────────────────────────────────────

function shutdown() {
  console.log("[cira-mcp] shutting down...");
  wss.close();
  httpServer.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
