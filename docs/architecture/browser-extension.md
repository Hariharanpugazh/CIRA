# Browser extension (`apps/browser-extension`)

This is the Chrome MV3 extension. In the architecture it is an **application** that hosts the **browser connector**. All browser and platform knowledge lives here. Context logic comes from `@cira/core`.

## Layout

```text
apps/browser-extension/
├── manifest.config.ts        MV3 manifest (crxjs)
├── vite.config.ts            builds into <repo>/dist (see "Extension ID" below)
├── src/
│   ├── content/              content script entry (universal.ts) + relay pill UI
│   ├── background/           service worker, context-pipeline.ts, local-sync.ts
│   ├── popup/  sidepanel/    React UI
│   ├── adapters/             DOM → legacy Conversation (per-platform adapters, serializer, extract.ts) and inject.ts
│   ├── platform/             platform registry, URLs, detection, rate-limit detection
│   ├── storage/              db.ts (Dexie history, unchanged), chrome-context-store.ts (PCO store)
│   ├── shared/               messaging types, schema (browser Source list + Core legacy types), relay.ts, context-client.ts
│   └── experimental/         unused modules kept for later (search, versioning, export, templates, analytics, asset store, media extraction, ws-bridge)
└── tests/                    relay snapshot regression, platform detection, capture → PCO pipeline
```

## Responsibilities

| Browser-specific (here) | Browser-independent (Core) |
|---|---|
| DOM extraction, platform detection, adapters | PCO schema, types, versioning |
| UI (popup, side panel, relay pill) | Validation, upgrade |
| Injection into chat inputs | Encoding, decoding, provenance |
| `chrome.*` APIs, native messaging transport | Safety scan, compressor, storage interfaces |

## Capture flow (Phase 01)

1. The popup's **Capture Conversation** or the side panel's **Read chat** sends `CIRA/EXTRACT_REQUEST` to the content script. The adapter returns a legacy `Conversation`. This part is unchanged.
2. The UI sends `CIRA/SAVE_CONTEXT`. The service worker runs `saveConversationAsPco()`:
   1. `migrateLegacyConversation` + `encode`, then `validate`, then `scanDocument`.
   2. `ChromeContextStore.put`.
   3. `syncToLocalHost`, which calls `chrome.runtime.sendNativeMessage('com.cira.context_host', { type: 'save', document })`.
3. The UI shows one status line, for example `PCO saved to …/.cira/contexts/pco_….pco.json · 9 context items`. If the scan found anything, it adds an explicit warning. When the native host is not installed, the PCO is still saved in the browser and the UI explains how to enable local sync.
4. **Export → PCO (JSON)** copies the stored PCO to the clipboard.

## Relay (unchanged in Phase 01)

The text injected into the target platform still comes from the legacy rule-based compressor, through `shared/relay.ts` → `compressLegacy` in Core. `tests/legacy-relay.regression.test.ts` compares it byte-for-byte with snapshots recorded before the migration. That applies to the popup. The side panel relays the reviewed PCO through `buildPcoHandoff` (deterministic and semantic).

## Extension ID and data continuity

Chrome derives an unpacked extension's ID from the folder it was loaded from. The build therefore still writes to `<repo>/dist`, so existing installs keep their ID, Dexie history and `chrome.storage` data.

## Permissions added in Phase 01

`nativeMessaging` is added. It can only reach hosts the user installs with `cira native-host install --extension-id <id>`, and those hosts are allow-listed for that single ID. No network listener is involved. The old WebSocket bridge to `127.0.0.1:9021` was removed from the service worker because it had no authentication.

## Extraction modes (Phase 02C)

The side panel can extract with Deterministic (default), Semantic or Hybrid; see [semantic-engine.md §11](semantic-engine.md#11-browser-integration-phase-02c). The popup capture stays deterministic.

| Piece | Where |
|---|---|
| Mode picker, privacy hint, provider form | `sidepanel/components/ExtractionModeControl.tsx` (Select step footer) |
| Mode / provider / failure state | `sidepanel/state/workspace.ts` (`mode/set`, `settings/loaded`, `provider/set`, `review/semantic-fail`); the draft key includes mode and provider |
| Semantic / hybrid draft | `background/extraction.ts` via `CIRA/BUILD_DRAFT` (extension pages only) |
| Saving a reviewed draft | `background/context-pipeline.ts` (`SAVE_CONTEXT { draft }`), `shared/context-selection.ts` (`applyItemSelection`) |
| Settings | `shared/extraction-settings.ts`; `chrome.storage.local["cira.settings"]`; API key in `chrome.storage.session["cira.semantic.apiKey"]` |
| Origin badges | `sidepanel/components/ContextItemRow.tsx` |

## Permissions added in Phase 02C

`optional_host_permissions: http://127.0.0.1/*, http://localhost/*, https://*/*`. Nothing is granted at install. When the user first runs Semantic or Hybrid, the side panel requests the single origin of the configured endpoint (for example `http://127.0.0.1/*` for Ollama). `https://*/*` only makes a user-chosen remote endpoint requestable. Declining sends nothing.

## Known leftovers (not deleted, not used)

- `src/experimental/*`
- `popup/components/{RelayButton,StatusFooter,TerminalTitleBar}.tsx`
- The `MCP/*` message types and the service worker's conversation/template CRUD handlers

Nothing sends these messages. They are kept until a later cleanup pass confirms they are not needed.
