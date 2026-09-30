# Semantic context engine (Phase 02)

CIRA does not copy or summarise conversations. It compiles the messages the user selected into **typed, evidence-backed, attributed** context items in a PCO v0.1 document.

```text
selected messages ──► ExtractionInput ──┬──► DeterministicExtractor (rules, offline)  ─┐
                                        └──► SemanticExtractor ─► StructuredOutputProvider ─► model
                                                   │  (JSON only, validated with Zod)       │
                                                   ▼                                         │
                                      contract: evidence located, origin derived,           │
                                      attribution rules, provenance built                   │
                                                   ▼                                         ▼
                                            ExtractionResult  ──────────►  reconcile ──► PCO items
                                                                                         + extensions["cira.semantic"]
                                                                                         ──► validate
```

It works like a compiler stage: `conversation → extraction → validated typed candidates → reconciliation → PCO`. It is not `conversation → LLM summary → text blob`.

Code: `packages/core/src/semantic/` and `packages/core/src/evaluation/`.

## 1. Why deterministic extraction is not enough

The Phase 01 rules (`cira.deterministic`) are fast, private and predictable, and they remain the default. They cannot understand meaning:

- They miss paraphrases. "I use React" is not a "fact" pattern, and "Authentication is required" only works because of the word "required".
- They label a whole sentence with one type. They cannot split "I prefer React and the backend must use Django" into a preference and a constraint.
- They know which turn a sentence came from, but not whether it was a suggestion, a quotation or a correction.

On the fixture set they achieve precision 100% and recall 54.5% (see §9). A semantic extractor is needed for recall and nuance. The rules stay as the baseline and fallback.

## 2. Extractor abstraction

```ts
interface ContextExtractor {
  readonly info: { id; version; kind: 'deterministic' | 'semantic'; locality: 'local' | 'remote'; provider?; model? };
  extract(input: ExtractionInput): Promise<ExtractionResult>;
}
interface ExtractionInput  { conversation /* selected turns only */; source; now; metadata? }
interface ExtractionResult { extractor; items: ContextItem[]; annotations: Record<itemId, SemanticAnnotation>;
                             relations; diagnostics /* never contain conversation text */; usage? }
```

- `createDeterministicExtractor()` wraps the Phase 01 rules. Its items are byte-identical to `encode()`.
- `createSemanticExtractor({ provider })` works with any `StructuredOutputProvider`:

```ts
interface StructuredOutputProvider {
  name; model; locality: 'local' | 'remote'; endpointHost;
  generate({ system, user, schemaName, schema }): Promise<{ text; usage? }>;
}
```

Implemented providers:

| Provider | Use |
|---|---|
| `createOpenAICompatibleProvider({ baseUrl, model, apiKey?, responseFormat })` | Any Chat Completions server: Ollama, LM Studio, vLLM, llama.cpp, OpenAI, Groq, OpenRouter… It uses `response_format: json_schema` (strict) or `json_object`. HTTP goes through an injectable transport, which keeps Core environment-neutral. |
| `createScriptedProvider(json)` | Replays recorded output for tests, demos and benchmark replays. It is named `scripted` so it can never pass for a model. |

Adding Gemini or Anthropic native APIs means writing one more provider. Extraction logic does not change.

## 3. Semantic extraction contract

A provider must return JSON matching `ModelOutputSchema`, which `modelOutputJsonSchema()` exports as a strict JSON Schema:

```jsonc
{ "items": [ { "ref": "i1", "type": "constraint", "content": "Backend must use Django",
               "origin": "user", "assertion": "explicit", "confidence": 0.95,
               "strength": "must", "status": null, "language": null, "filename": null, "uri": null, "title": null,
               "evidence": [ { "message": "m0", "quote": "The backend must use Django." } ] } ],
  "relations": [ { "type": "supersedes", "from": "i2", "to": "i1" } ] }
```

- Types are the eight PCO types. No new types were added.
- Output that fails the schema is rejected as a whole (`ContractError`). Error messages list paths and codes only, never values.
- `normalizeModelOutput()` then applies the deterministic rules below. Items that break a rule are dropped with a diagnostic, and the rest are kept.

## 4. Attribution

Origin is **not** what the model claims. It is the speaker (turn role) of the message the evidence was found in. If the model's claim differs, it is corrected and the correction is recorded in the diagnostics.

These attribution rules (`applyAttributionRules`) are pure and deterministic:

| Model says | Speaker | Recorded as |
|---|---|---|
| constraint / preference | assistant | decision, status `proposed`, assertion `suggested` |
| constraint / preference / decision / task | tool | fact, assertion `quoted` |
| decision `accepted` | assistant | decision `proposed`. The assistant cannot accept on the user's behalf. |
| constraint | user or system | constraint (requirements belong to the user or system prompt) |

**An assistant suggestion can never become a user requirement or preference.** For example:

> User: "I need the backend to use Django." Assistant: "You could use FastAPI instead."

This gives `constraint: Backend must use Django` (user, explicit) and `decision [proposed]: FastAPI could be used` (assistant, suggested). Even a model that labels FastAPI as the user's requirement is corrected, because its evidence is in the assistant's message.

The `assertion` values are `explicit`, `inferred` (confidence capped at 0.8), `suggested`, `quoted` and `unknown`.

## 5. Evidence and provenance

- **Evidence is required.** The model quotes text verbatim. CIRA locates the quote itself (`locateQuote`): an exact match first, then a case-, whitespace-, quote- and dash-insensitive match mapped back to the original offsets.
- **In strict mode (the default), an item whose evidence cannot be found in the *selected* messages is rejected** (`unsupported_item`). This is the main defence against invented items and prompt injection.
- A message reference outside the selection is rejected as well.
- In lenient mode, an unlocated quote in a valid message is kept with confidence ≤ 0.4 and no span.

Provenance uses the existing PCO model: `source`, `conversation_id`, `turn_id`, `span`, `captured_at` and `extracted_by: { method: "model", agent: "cira.semantic@0.1.0" }`. Nothing new was added to the core schema.

Semantic metadata lives in the extension namespace, so PCO v0.1 is unchanged:

```jsonc
"extensions": { "cira.semantic": {
  "version": 1, "mode": "hybrid",
  "extractors": [ { "id": "cira.deterministic", "version": "0.1.0", "kind": "deterministic", "locality": "local" },
                  { "id": "cira.semantic", "version": "0.1.0", "kind": "semantic", "locality": "local", "provider": "openai-compatible", "model": "qwen2.5:7b" } ],
  "items": { "itm_…": { "origin": "user", "assertion": "explicit",
                         "evidence": [ { "turn_id": "conv_…_t0", "span": { "start": 42, "end": 70 } } ],
                         "extractors": ["cira.semantic@0.1.0", "cira.heuristic-statements@0.1.0"],
                         "merged_from": [ { "extractor": "cira.deterministic@0.1.0", "type": "constraint", "content": "…", "confidence": 0.7 } ] } },
  "relations": [ { "type": "supersedes", "from": "itm_new", "to": "itm_old", "source": "cira.semantic@0.1.0" } ] } }
```

- `validateSemanticExtension(doc)` checks the extension against the document: unknown items or turns, bad spans, origin/speaker mismatches and dangling relations.
- `cira validate` reports these as warnings.
- Readers that ignore extensions see an ordinary PCO v0.1 document.
- Provider credentials are never stored here.

## 6. Reconciliation

`reconcile(results)` merges candidates from several extractors. It is deterministic.

- **Same item:** different extractors, the same type and the same origin, and either equal normalised content (code: equal code; links: equal URI) or ≥ 50% overlap of cited text in the same turn.
- **Never merged:** items with different origins, so a user requirement and an assistant suggestion stay separate. Two items from the same extractor are never merged either.
- **Canonical item:**
  - code and links: the deterministic literal copy
  - everything else: the higher confidence, with ties going to semantic
- **On merge:** evidence and extractor lists are unioned, and the other candidate is kept in `merged_from`.
- **Conflicts are never resolved silently:**
  - `supersedes` and `conflicts_with` relations from extractors are kept and re-pointed at canonical items.
  - Different-type items citing the same text get a `same_evidence` link.
  - Both sides of a conflict ("I use React" / "I switched to Vue") remain, with their evidence.

## 7. Privacy boundary

- **Only selected messages are extracted.** `extractContext(input, { selection })` applies `selectTurns()` before anything runs. The prompt is built only from the selected turns, with their original message numbers (`m3`, `m7`), and never includes the title, URL or unselected turns. A regression test with 10 messages and 4 selected proves it for the semantic provider, the rules and the PCO.
- **Local vs remote:** a provider's locality comes from its endpoint. Only loopback counts as local, and the locality is recorded in the extension. The CLI refuses remote endpoints without `--allow-remote`, and it refuses to send selections that contain potential secrets without `--allow-secrets`.
- **Nothing sensitive in logs:** diagnostics and errors never include conversation text. Provider error messages are capped and suppressed if they echo the prompt. API keys come from the environment only (`CIRA_SEMANTIC_API_KEY`) and are never written to PCO files, logs or errors.
- **Size limit:** oversized selections are refused, never silently truncated.

## 8. Modes

| Mode | Runs | Network | On semantic failure |
|---|---|---|---|
| `deterministic` (default) | Phase 01 rules | none | n/a |
| `semantic` | semantic extractor only | the configured provider | error (no silent fallback) |
| `hybrid` | rules + semantic → reconcile | the configured provider | deterministic items only, `fallback: true` |

Configuring a provider never changes the mode. The browser extension, `cira migrate` and every existing flow stay deterministic.

```powershell
cira extract chat.json                                   # deterministic (same as migrate)
cira extract chat.json --mode hybrid --model qwen2.5:7b  # local Ollama (default base URL)
cira extract chat.json --mode semantic --messages 2,5-6 --model gpt-4o-mini `
  --base-url https://api.openai.com/v1 --allow-remote    # CIRA_SEMANTIC_API_KEY in the environment
```

## 9. Evaluation (CIRA-Bench foundation)

The fixtures are in `packages/core/tests/fixtures/eval/*.eval.json`. Each holds a legacy conversation, an optional selection, gold items `{ type, origin, message, match[] }`, and `forbidden` items (for example "assistant suggestion recorded as a user requirement").

`evaluateDocument` and `runFixture` report:

- precision, recall and F1 (type-strict, keyword match)
- attribution accuracy
- provenance accuracy (right message, valid span)
- unsupported items
- forbidden items

`cira eval <dir> --mode …` runs any extractor. `--replay <dir>` scores recorded outputs.

Results on the 6 fixtures (22 gold items):

| Extractor | Precision | Recall | F1 | Attribution | Forbidden |
|---|---|---|---|---|---|
| deterministic (Phase 01 rules) | 100% | 54.5% | 70.6% | 100% | 0 |
| hand-written reference output (harness check, not a model) | 100% | 100% | 100% | 100% | 0 |
| hybrid, `qwen2.5:1.5b` via Ollama (one local run) | 57.1% | 54.5% | 55.8% | 100% | 0 |
| semantic, `qwen2.5:1.5b` (1 of 6 fixtures timed out) | 33.3% | 5.0% | 8.7% | 100% | 0 |

The small 1.5B model mostly produces broad summary "facts" that the gold does not ask for. The contract still kept it from mis-attributing anything: 0 forbidden items and 100% attribution. Larger models are expected to do better, but that has not been measured yet.

This is a foundation, not a benchmark. The fixtures are small and hand-written, and keyword matching is coarse. CIRA-Bench will need more data, inter-annotator agreement and span-level scoring.

## 10. Known limitations

- The browser extension still uses deterministic mode. Semantic mode needs a settings surface and host permissions for provider endpoints; that is the next step.
- On Node, the built-in `fetch` stops waiting for response headers after about 300 s, whatever `--timeout` says. Very slow local models can hit this.
- `json_object` mode depends on the model following the schema from the prompt alone. Small models often fail, and those outputs are rejected.
- Supersession is recorded, not resolved. Keyword-based evaluation cannot score relations yet.
