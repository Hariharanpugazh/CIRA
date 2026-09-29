# CIRA — a user-owned AI context layer

CIRA carries **your** context between AI systems: browser chats (ChatGPT, Claude, Gemini and others) today, and IDE agents, terminal agents and mobile later. CIRA is not an AI model, a chatbot, or another memory database. It is the interoperability layer between them, built on one representation: the **Portable Context Object (PCO)**.

```text
Browser AI ─┐                                    ┌─► CLI (cira)
IDE AI ─────┼─► connector ─► CIRA Core ─► PCO ───┼─► MCP agents (Claude Code, Codex, Cursor, …)
Terminal AI ┘                                    └─► other connectors
```

## Status: Phase 01 — CIRA Core + PCO

| Piece | Where |
|---|---|
| PCO v0.1 schema (Zod source of truth + generated JSON Schema), provenance, validation, upgrade | `packages/core`, `packages/pco` |
| Encoder (deterministic + heuristic extraction), decoder, Markdown rendering | `packages/core` |
| Legacy CIRA conversation → PCO migration | `packages/core/src/migration` |
| `ContextStore` with in-memory, key/value (chrome.storage) and file (`~/.cira/contexts`) stores | `packages/core` |
| Browser extension: capture → PCO → browser store → local host sync. The legacy relay is unchanged. | `apps/browser-extension` |
| `cira` CLI: `validate`, `migrate`, `export`, `save`, `list`, `native-host` | `cli` |
| MCP stdio server: `list_contexts`, `get_context` | `packages/mcp` |

Extraction in Phase 01 is **rule-based**. Code and links are extracted deterministically. Everything else comes from keyword/phrase heuristics, labelled as such, with hand-set confidence values. No language model is involved.

## Quick start

```powershell
pnpm install
pnpm build            # extension → dist/, cli/dist/cira.js, packages/mcp/dist/server.js
pnpm test             # all Vitest projects
pnpm typecheck
```

1. Load `dist/` as an unpacked extension (`chrome://extensions`, Developer mode, **Load unpacked**).
2. Connect the extension to `~/.cira/contexts` (one time):
   ```powershell
   node cli/dist/cira.js native-host install --extension-id <id shown on chrome://extensions>
   ```
3. Open a ChatGPT conversation. In the CIRA popup, click **Capture Conversation**. The popup reports where the PCO was saved.
4. Use the PCO:
   ```powershell
   node cli/dist/cira.js list
   node cli/dist/cira.js validate $HOME\.cira\contexts\<id>.pco.json
   node cli/dist/cira.js export <id> --format md
   ```
5. Give it to an agent through MCP: register `node <repo>/packages/mcp/dist/server.js` as a stdio server (see [packages/mcp/README.md](packages/mcp/README.md)), then call `list_contexts` / `get_context`.

## Repository layout

```text
apps/browser-extension   Chrome MV3 app + browser connector
packages/core            @cira/core — environment-neutral Core (PCO, validation, encoder, decoder, storage)
packages/pco             generated JSON Schema + canonical examples
packages/mcp             stdio MCP server
cli                      `cira` command
integrations             connector contract for future IDE/agent integrations
docs                     architecture and PCO specification
scripts                  smoke tests and CI helpers
```

## Documentation

- [Architecture overview](docs/architecture/overview.md): Core, connector, integration, application and protocol
- [Core](docs/architecture/core.md)
- [Browser extension](docs/architecture/browser-extension.md)
- [PCO specification v0.1](docs/pco/specification.md)
- [Integrations contract](integrations/README.md)

## License

[Apache-2.0](LICENSE)
