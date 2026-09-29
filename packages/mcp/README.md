# @cira/mcp — CIRA MCP server (stdio)

This is a read-only [Model Context Protocol](https://modelcontextprotocol.io) server. It exposes the Portable Context Objects stored in `~/.cira/contexts` to any MCP-compatible agent. It is built on the official SDK (`McpServer` + `StdioServerTransport`), and all context logic comes from `@cira/core`.

## Tools

| Tool | Input | Returns |
|---|---|---|
| `list_contexts` | none | Stored contexts, newest first (text + `structuredContent.contexts`) |
| `get_context` | `id?` (default: most recent), `types?` (e.g. `["decision","constraint","task"]`), `min_confidence?` (0..1), `format?` (`markdown` \| `json`) | One context rendered with provenance |

## Build and run

```powershell
pnpm install
pnpm --filter @cira/mcp build
node packages/mcp/dist/server.js            # uses $CIRA_HOME/contexts or ~/.cira/contexts
node packages/mcp/dist/server.js --dir D:\some\contexts
node packages/mcp/scripts/smoke-stdio.mjs   # connects with the SDK client and calls both tools
```

## Register with an agent

Use absolute paths. The server speaks MCP on stdout and logs to stderr.

```json
{
  "mcpServers": {
    "cira": {
      "command": "node",
      "args": ["D:/Projects/CIRA/packages/mcp/dist/server.js"]
    }
  }
}
```

That block works for clients using the common `mcpServers` format, such as Claude Code's `.mcp.json` and Cursor. For VS Code, put the same `command`/`args` under `servers` in `.vscode/mcp.json`. For Claude Code, you can instead run `claude mcp add cira -- node D:/Projects/CIRA/packages/mcp/dist/server.js`. Check your client's documentation for its exact config location.

## Security

- stdio only: no HTTP or WebSocket listener, and no port opened.
- Read-only: there are no write tools. Stored files are validated before they are served, and invalid files are skipped.
- The server exposes everything in the context directory to the connected agent, so only store context you are willing to share with that agent.
- This replaces the Phase 0 companion (`cira-mcp/`), whose HTTP (:9020) and WebSocket (:9021) servers had no authentication or Origin checks.
