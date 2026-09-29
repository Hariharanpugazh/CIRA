# CIRA architecture overview

CIRA is not an AI model or a chatbot, and it is not another memory database. It is an **interoperability layer**: user-owned context that any AI environment can read and write through one representation, the **Portable Context Object (PCO)**.

```text
                  CIRA CORE  (@cira/core — no browser, no Node, no platform knowledge)
                     │
              Portable Context Object (PCO v0.1)
                     │
      ┌──────────────┼───────────────┐
      ↓              ↓               ↓
   Browser          IDE             CLI            ← connectors
      ↓              ↓               ↓
   ChatGPT        VS Code          Codex
   Claude         Cursor           OpenCode
   Gemini         Antigravity      Claude Code
                     │
                     ↓
                    MCP                          ← protocol surface for agents
```

Phase 01 implements the **Core**, the **PCO**, and three consumers: the browser extension, the CLI and a stdio MCP server. IDE, agent and mobile connectors are designed for but not built yet.

## Vocabulary

| Term | Meaning | In this repo |
|---|---|---|
| **Core** | Environment-neutral domain logic: the PCO model, validation, upgrade, encoding, decoding, provenance, safety scan, and storage *interfaces*. It never imports `chrome`, `document`, `window`, `process` or `fs`, and this is enforced by its tsconfig (`lib: ES2022`, `types: []`). One subpath, `@cira/core/node`, is explicitly allowed to use Node for the file store. | `packages/core` |
| **Protocol** | A wire contract between processes. It has no behaviour of its own. | PCO JSON (`packages/pco`), the local-host messages (`core/src/protocol/local-host.ts`), MCP |
| **Connector** | Adapts one external environment to Core. It captures that environment's native data (DOM, editor state, terminal session), converts it to Core input, and delivers decoded context back in the environment's own format. Connectors own all platform knowledge. | Browser: `apps/browser-extension/src/{adapters,platform,background}`. Future ones go in `integrations/*`. |
| **Integration** | A connector packaged for a specific third-party tool, such as a VS Code extension, a Codex plugin or a Claude Code MCP config. | `integrations/` (contract only in Phase 01) |
| **Application** | A user-facing product that hosts one or more connectors plus UI. | `apps/browser-extension` today; `apps/desktop-app` and `apps/mobile-app` later |

## Phase 01 data flow

```text
ChatGPT tab ──DOM adapter──► legacy Conversation ──┬──► legacy rule compressor ──► relay text (unchanged behaviour)
                                                   │
                                                   └──► migrate + encode (Core) ──► PCO ──► validate (Core)
                                                                                           ──► safety scan (Core)
                                                                                           ──► ChromeContextStore (chrome.storage.local)
                                                                                           ──► native messaging ──► `cira native-host`
                                                                                                                       ──► validate (Core)
                                                                                                                       ──► FileContextStore (~/.cira/contexts)
                                                                                                                             │
                                          `cira validate | export | list` ◄───────────────────────────────────────────────┤
                                          MCP agent ── stdio ──► @cira/mcp list_contexts / get_context ◄──────────────────┘
```

Every consumer, whether that's the extension, the CLI, the native host or the MCP server, calls the same Core functions. None of them re-implements encoding, decoding or validation.

## Why these boundaries

- **PCO is representation; compression is an optimisation.** The PCO keeps the full transcript plus extracted items with provenance. Compressors, including the legacy relay compressor, sit behind `Compressor` in `core/src/selection` and never change stored data.
- **Storage is an interface.** Core defines `ContextStore`. The implementations are in-memory, key/value (used for `chrome.storage`), and file (Node). SQLite, IndexedDB and encrypted sync can be added without touching Core's model.
- **Local-first and explicit.** Context reaches disk only through a native messaging host that the user installs, allow-listed for one extension ID. The MCP server is stdio-only and read-only, and opens no network port.
- **Honest extraction.** Every item records `extracted_by.method` (`deterministic`, `heuristic`, `manual`, `model` or `migration`) and a confidence value. Phase 01 has no model-based extraction.

## Adding a new environment (no Core changes required)

1. Capture native data and build `ConversationInput` (or call `migrateLegacyConversation` for legacy JSON).
2. Call `encode()`, then store through any `ContextStore`.
3. To consume, call `store.get()`, then `decode(doc, { types, minConfidence })`, then render with `renderMarkdown()` or with the target's own format.

See [integrations/README.md](../../integrations/README.md) for the connector contract, and [core.md](core.md) for the API.

## Future (not Phase 01)

- **Mobile:** share sheet, Android intents, iOS share extensions, clipboard and deep links. The user explicitly chooses what to send. There is no background access to other apps. `KeyValueContextStore` already fits AsyncStorage-style APIs.
- **Desktop app:** a long-running local host with a UI. It would replace `cira native-host` as the file-store owner.
- **Selection research:** measure the PCO-based relay against the legacy compressor before switching (Phase 02).
