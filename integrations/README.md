# Integrations

This folder is for future connectors: VS Code, Cursor, Antigravity, Codex, OpenCode, Claude Code, and other agents. **None are implemented in Phase 01.** This file defines the contract they will follow, so that no environment needs its own memory system.

```text
External environment ──► CIRA connector ──► @cira/core ──► PCO ──► ContextStore
                     ◄── rendered context ◄── decode() ◄──────────┘
```

## Connector contract

A connector:

1. **Captures** only what the user chose to share, such as a chat, an editor selection, a terminal session or a share-sheet payload.
2. **Converts** it to `ConversationInput` (see `@cira/core` `encoder/types.ts`) with an honest `source`:
   - `kind`: `ide`, `cli`, `agent`, `mobile` and so on
   - `platform`: for example `vscode`, `codex` or `claude-code`
   - `client`: `<connector-name>@<version>`
3. **Encodes** with `encode()`, optionally adding its own `ItemExtractor`s with the correct `method`.
4. **Checks** with `scanDocument()` and warns the user about potential secrets before persisting or sharing.
5. **Stores** through a `ContextStore`: `FileContextStore` (`~/.cira/contexts`) for local tools, or a `KeyValueContextStore` over the host's storage.
6. **Consumes** with `store.list()` and `store.get()`, then `decode(doc, { types, minConfidence })`, then renders in the environment's native format. `renderMarkdown()` is the generic fallback.

A connector must not re-implement PCO parsing, validation, encoding or decoding. It also must not add platform names to Core.

## Fastest path for agents today

Any MCP-capable agent can read CIRA context now through the stdio server in `packages/mcp`; see its README. Examples of how agents might connect:

| Agent | How it would connect (not yet shipped as an integration) |
|---|---|
| Claude Code, Codex, OpenCode, Cursor, VS Code | MCP stdio server: `node <repo>/packages/mcp/dist/server.js` |
| Scripts / CI | `cira export <id> --format md` |

## Planned folders

- `vscode/`
- `antigravity/`
- `codex/`
- `opencode/`
- `claude-code/`

Each will be created when its connector is implemented.
