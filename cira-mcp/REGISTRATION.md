// ── CIRA MCP Registration ──────────────────────────────────────────
// Add this to your project's .claude/settings.json (Claude Code)
// or VS Code / Cursor MCP configuration to use CIRA context in your IDE.

// === Option A: stdio transport (recommended) ===
// The IDE launches cira-mcp as a subprocess. The companion HTTP/WS
// process must also be running for context to flow through.
//
// .claude/settings.json:
// {
//   "mcpServers": {
//     "cira": {
//       "command": "bun",
//       "args": ["run", "path/to/CIRA/cira-mcp/src/stdio.ts"]
//     }
//   }
// }

// === Option B: Streamable HTTP transport ===
// Connect directly to the companion process's HTTP endpoint.
// No stdio needed — the IDE connects over HTTP.
//
// .claude/settings.json:
// {
//   "mcpServers": {
//     "cira": {
//       "type": "http",
//       "url": "http://127.0.0.1:9020/mcp"
//     }
//   }
// }

// === VS Code / Cursor (settings.json) ===
// {
//   "mcp": {
//     "servers": {
//       "cira": {
//         "command": "bun",
//         "args": ["run", "path/to/CIRA/cira-mcp/src/stdio.ts"]
//       }
//     }
//   }
// }

// === Alternative: npx (no bun needed) ===
// {
//   "command": "npx",
//   "args": ["tsx", "path/to/CIRA/cira-mcp/src/stdio.ts"]
// }
