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
| Browser extension: side-panel Select → Review → Send flow, capture → PCO → browser store → local host sync. The legacy relay is unchanged. | `apps/browser-extension` |
| `cira` CLI: `validate`, `migrate`, `export`, `save`, `list`, `native-host`, `extract`, `eval` | `cli` |
| MCP stdio server: `list_contexts`, `get_context` | `packages/mcp` |
| Semantic extraction engine (optional, model-based; OpenAI-compatible providers) + evaluation harness | `packages/core/src/semantic`, `packages/core/src/evaluation` |

**Default extraction is rule-based and offline.** Code and links are extracted deterministically; everything else comes from keyword/phrase heuristics, labelled as such, with hand-set confidence values, and no language model is involved. A model is used only when you explicitly choose **Semantic** or **Hybrid** mode and configure a provider — see [Semantic extraction with a model](#semantic-extraction-with-a-model).

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
3. Open a ChatGPT conversation and open the CIRA side panel. Pick the messages to carry, review the extracted context, then save it (see [Carrying context from the side panel](#carrying-context-from-the-side-panel)).
4. Use the PCO:
   ```powershell
   node cli/dist/cira.js list
   node cli/dist/cira.js validate $HOME\.cira\contexts\<id>.pco.json
   node cli/dist/cira.js export <id> --format md
   ```
5. Give it to an agent through MCP: register `node <repo>/packages/mcp/dist/server.js` as a stdio server (see [packages/mcp/README.md](packages/mcp/README.md)), then call `list_contexts` / `get_context`.

## Carrying context from the side panel

The side panel lets you choose exactly what CIRA carries forward, rather than capturing a whole conversation automatically. It is a three-step flow — **Select → Review → Send** — and nothing is saved or sent until you confirm on the last step.

Open the panel from the CIRA toolbar icon (or the browser's side-panel menu) while an AI conversation is open, then click **Read chat**.

### 1. Select messages

Every message is listed with its role and number, selected by default. Trim it down to what matters:

- Tick or untick individual messages. The count ("Selected 4 / 6 messages") updates as you go.
- **Select all** / **Clear all** / **Invert** act on the whole list.
- **Shift-click** a checkbox to select a contiguous range from your last click.
- **Search conversation** filters the list locally. Filtering never changes your selection, and while a search is active the bulk buttons act on the matches only ("Select matches").
- Long messages and code blocks are shown as a compact preview; **Show more** expands the full text.

Click **Continue to Review**. Only the selected messages are passed to the extractor.

> By default, CIRA extracts with fast, offline rules (Deterministic). To let an AI model pull out richer context instead, set the extraction mode and provider first — see [Semantic extraction with a model](#semantic-extraction-with-a-model). The model runs only when you press **Continue to Review**, and only the selected messages are sent.

### 2. Review the extracted context

CIRA runs its Phase 01 extraction over the selected messages and lists the items it found, each with its type (fact, decision, constraint, preference, task, question, code, reference) and the source message ("Message 4").

- Untick any item you don't want to carry. Removed items are left out of the saved PCO and anything you send.
- **Select all** / **Clear all** toggle every item.
- The summary shows messages selected, item count, an estimated token size, and the source. It warns if a potential secret is detected.

Each item keeps its provenance: a decision from message 7 still points at message 7, with the original character span.

Click **Continue**.

### 3. Save and/or send

- **Pick a target AI** (Claude, Gemini, DeepSeek, …) to continue the conversation there. CIRA opens the target and injects only the reviewed context, never the whole chat. This target is optional.
- **Save locally** stores the PCO in the browser and, if the native host is installed, in `~/.cira/contexts`.

Choose either or both, then click the action button (**Save context**, **Send to <AI>**, or **Save & send to <AI>**). The success screen confirms what happened; if local sync is unavailable it offers **Retry**.

### Active context and backward compatibility

- Once a context exists, an **Active context** card shows its title, source, message/item counts and where it was saved, with **View**, **Edit**, **Replace** and **Clear**. **Edit** reopens Review with your previous choices.
- To reproduce the old "capture everything" behaviour: **Read chat → Continue to Review → Continue → Save**. With every message and item selected, the resulting PCO matches a full capture.

The saved PCO is a standard v0.1 document, so `cira validate`, `cira export`, the MCP server and the legacy relay all keep working.

## Semantic extraction with a model

By default CIRA extracts context with offline rules (code, links, keyword heuristics) — fast, private, no model. You can optionally have an AI model read the selected messages and pull out richer, attributed context. CIRA stays model-independent: it talks to any OpenAI-compatible Chat Completions server, and it never downloads or picks a model for you.

**Extraction modes:**

| Mode | What runs | Network |
|---|---|---|
| **Deterministic** (default) | Phase 01 rules only | Nothing leaves this machine |
| **Semantic** | the model only | Selected messages → your provider |
| **Hybrid** | rules + model, reconciled; falls back to rules if the model fails | Selected messages → your provider |

Only the messages you selected are ever sent. The title, URL and unselected messages are never sent. Each item keeps evidence and provenance, and the model's claims are corrected against who actually spoke (an assistant suggestion can't become your requirement). See [docs/architecture/semantic-engine.md](docs/architecture/semantic-engine.md) for the full design.

### Run a local model (recommended)

[Ollama](https://ollama.com) is the simplest local option.

1. Install Ollama and pull a model, e.g. `ollama pull qwen2.5:7b`. (Bigger models extract better; a 1.5B model is weak.)
2. For the **browser** only, allow the extension to reach Ollama by setting the `OLLAMA_ORIGINS` environment variable to include `chrome-extension://*`, then restart Ollama. Without this, Ollama returns HTTP 403 to the extension. The CLI doesn't need this.
   ```powershell
   setx OLLAMA_ORIGINS "chrome-extension://*"
   ```
3. Ollama listens on `http://127.0.0.1:11434/v1`, which is CIRA's default endpoint.

Other local servers (LM Studio, vLLM, llama.cpp) work the same way: point the endpoint at their OpenAI-compatible URL.

### Configure in the side panel

On the **Select** step, the footer has a mode dropdown (Deterministic / Semantic / Hybrid) and a **Model** button. Pick **Semantic** or **Hybrid**, open **Model**, and fill in:

- **Provider** — Ollama (local) or a generic OpenAI-compatible server.
- **Endpoint** — the base URL, e.g. `http://127.0.0.1:11434/v1`.
- **Model** — the exact name you pulled, e.g. `qwen2.5:7b`. CIRA never guesses or downloads it.

A one-line privacy hint shows where messages will go. The first time you run a model, Chrome asks permission to reach that one endpoint; nothing is sent if you decline. Settings are saved in `chrome.storage.local`. An optional API key (for a remote provider) is held only in `chrome.storage.session` — it's cleared when the browser closes and never written to a PCO, log, or content script. Remote endpoints must use `https://`, and CIRA refuses to send a selection that looks like it contains a secret.

Then use the flow as usual: **Continue to Review** runs the model once; Review shows an origin badge on each item (User, Assistant suggestion, Assistant, System, Tool) and a `model` marker, and you can still remove items; Save/Send reuse the reviewed result without calling the model again. If the model fails, you get **Retry** and **Switch to Deterministic**; Hybrid falls back to rules and says so.

### Configure in the CLI

`cira extract` runs the same engine from the command line, independent of the browser:

```powershell
# Deterministic (default) — same result as `cira migrate`
node cli/dist/cira.js extract chat.json

# Hybrid with a local Ollama (default endpoint http://127.0.0.1:11434/v1)
node cli/dist/cira.js extract chat.json --mode hybrid --model qwen2.5:7b

# Semantic over selected messages, sent to a remote provider
$env:CIRA_SEMANTIC_API_KEY = "sk-…"   # environment only; never a flag
node cli/dist/cira.js extract chat.json --mode semantic --messages 2,5-6 `
  --model gpt-4o-mini --base-url https://api.openai.com/v1 --allow-remote

node cli/dist/cira.js extract chat.json --mode hybrid --model qwen2.5:7b --save   # store in ~/.cira/contexts
```

Flags and environment variables (flags win):

| Flag | Env | Default |
|---|---|---|
| `--mode deterministic\|semantic\|hybrid` | — | `deterministic` |
| `--model <name>` | `CIRA_SEMANTIC_MODEL` | required for semantic/hybrid |
| `--base-url <url>` | `CIRA_SEMANTIC_BASE_URL` | `http://127.0.0.1:11434/v1` |
| `--messages 1,3,5-7` | — | all messages (1-based, as shown in the UI) |
| `--allow-remote` | — | required for any non-loopback endpoint |
| `--allow-secrets` | — | required to send a selection with a potential secret to a remote endpoint |
| `--response-format json_schema\|json_object` | `CIRA_SEMANTIC_RESPONSE_FORMAT` | `json_schema` |
| `--timeout <seconds>` | `CIRA_SEMANTIC_TIMEOUT` | 120 |
| — | `CIRA_SEMANTIC_API_KEY` | unset (environment only) |

`node cli/dist/cira.js --help` lists these, and `cira eval <dir> --mode …` scores an extractor against the evaluation fixtures.

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
