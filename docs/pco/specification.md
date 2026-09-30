# Portable Context Object (PCO) — specification v0.1

A PCO is a JSON document that carries **meaningful context** between AI environments. It is not only a transcript: it holds the transcript *and* the typed context items extracted from it. Each item records where it came from.

- Source of truth: `packages/core/src/pco/schema.ts` (Zod)
- JSON Schema (generated): `packages/pco/schema/pco-0.1.schema.json` (draft 2020-12)
- Examples: `packages/pco/examples/*.pco.json`
- Reference validator: `@cira/core` `validate()` / `parsePco()`, or `cira validate <file>`

## Document

```jsonc
{
  "pco_version": "0.1",                 // "MAJOR.MINOR", required
  "id": "pco_4ca51855d1a92a98",          // document id
  "metadata": {
    "title": "CIRA sync service",        // optional
    "description": "…",                  // optional
    "created_at": "2026-09-29T12:00:00.000Z",
    "updated_at": "2026-09-29T12:00:00.000Z",
    "created_by": { "agent": "cira-browser-extension@0.1.0" },  // optional
    "tags": []                           // optional
  },
  "conversations": [ /* Conversation */ ],
  "items": [ /* ContextItem */ ],
  "extensions": { "vendor.name": { } }   // optional, namespaced keys
}
```

## Conventions

- **IDs:** 1–128 characters from `[A-Za-z0-9._-]`, starting with a letter or digit. All IDs share **one namespace per document**: the document, conversations, turns and items.
- **Timestamps:** ISO 8601 with an explicit offset (`Z` or `±hh:mm`), and they must be real calendar instants.
- **Field names:** snake_case.
- **Unknown fields** are preserved: objects are open, for forward compatibility. Put implementation-specific data under `extensions`, keyed by a namespace such as `"cira.browser"`.

## Conversation and turns

```jsonc
{
  "id": "conv_…",
  "source": { "kind": "browser", "platform": "claude", "client": "cira-browser-extension@0.1.0" },
  "title": "CIRA sync service",          // optional
  "url": "https://claude.ai/chat/…",     // optional
  "captured_at": "2026-09-21T08:30:00.000Z",
  "turns": [
    { "id": "conv_…_t0", "index": 0, "role": "user", "content": "…", "timestamp": "…", "attachments": [ { "kind": "image", "name": "a.png", "media_type": "image/png", "uri": "https://…" } ] }
  ]
}
```

- `source.kind` is one of `browser`, `ide`, `cli`, `agent`, `mobile`, `api`, `manual` or `unknown`.
- `source.platform` is an open string. Core does not enumerate platforms; connectors choose the names.
- `role` is one of `user`, `assistant`, `system` or `tool`.
- Turn `index` values are unique within a conversation.

## Context items

Every item has these fields:

| field | type | notes |
|---|---|---|
| `id` | Id | |
| `type` | discriminator | see the table below |
| `content` | string, non-empty | the statement itself (for `code_artifact`, the code) |
| `provenance` | Provenance | **required** |
| `confidence` | number 0..1 | how reliable the extraction is |
| `importance` | number 0..1, optional | not set by the Phase 01 encoder |
| `created_at` | Timestamp | when the item was extracted |
| `tags` | string[], optional | |

| `type` | extra fields |
|---|---|
| `fact` | none |
| `decision` | `status?`: `proposed` / `accepted` / `rejected` / `superseded`; `rationale?` |
| `constraint` | `strength`: `must` / `must_not` / `should` / `should_not` |
| `preference` | none |
| `task` | `status`: `open` / `in_progress` / `done` / `cancelled` |
| `question` | `status?`: `open` / `answered` |
| `code_artifact` | `language`; `filename?` |
| `reference` | `uri`; `title?` |

## Provenance

Provenance is what lets CIRA answer "where did this come from?"

```jsonc
{
  "source": { "kind": "browser", "platform": "chatgpt", "client": "cira-browser-extension@0.1.0" },
  "conversation_id": "conv_…",          // optional; must exist in this document
  "turn_id": "conv_…_t17",               // optional; requires conversation_id; must belong to it
  "span": { "start": 0, "end": 20 },     // optional; requires turn_id; [start,end) UTF-16 offsets within turn.content
  "captured_at": "…",
  "extracted_by": { "method": "heuristic", "agent": "cira.heuristic-statements@0.1.0" }
}
```

`extracted_by.method` must be honest:

| method | meaning |
|---|---|
| `deterministic` | literal structure: fenced code blocks and links |
| `heuristic` | keyword and phrase rules |
| `manual` | written or confirmed by a person |
| `model` | produced by a language model (unused in Phase 01) |
| `migration` | converted from an older format |

Items without a conversation, such as manually added context, carry only `source`, `captured_at` and `extracted_by`.

## Validation

A document is valid when:

1. **Structural:** it matches the JSON Schema.
2. **Semantic** (checked by `validate()`; JSON Schema cannot express these):
   - all IDs are unique within the document
   - `provenance.conversation_id` and `turn_id` exist, and the turn belongs to that conversation
   - a `turn_id` has a `conversation_id`, and a `span` has a `turn_id`
   - `0 ≤ span.start < span.end ≤ turn.content.length`
   - timestamps are real calendar instants
   - turn indices are unique per conversation
3. **Warnings, not errors:**
   - `updated_at` is earlier than `created_at`
   - the provenance source differs from its conversation's source
   - the document is a newer minor version

Error codes include:

- Version: `missing_version`, `invalid_version`, `unsupported_major_version`, `requires_upgrade`
- Structure: `schema`, `invalid_timestamp`, `unknown_item_type`
- Cross-references: `duplicate_id`, `unknown_conversation`, `unknown_turn`, `turn_not_in_conversation`, `turn_without_conversation`, `span_without_turn`, `invalid_span`, `duplicate_turn_index`

## Versioning and compatibility

| Document version vs reader | Behaviour |
|---|---|
| same `MAJOR.MINOR` | fully supported |
| same major, **newer** minor | readable with a warning; unknown fields preserved; unknown item types ignored with a warning |
| same major, **older** minor | pass through `upgrade()`, a chain of `from → to` transforms on raw JSON |
| different major | rejected |

Rules for future versions:

- **Minor:** only additive changes, such as optional fields or new item types.
- **Major:** any change that would make an older reader misinterpret data.
- Every older minor must have a registered upgrader.

## Phase 01 encoder (reference behaviour)

- **Transcript:** kept verbatim in `conversations[].turns[]`.
- **Deterministic extraction** (confidence 1.0):
  - fenced code blocks become `code_artifact` (language and optional filename come from the info string)
  - Markdown links and bare URLs become `reference`
  - image links are skipped
- **Heuristic extraction:** sentence rules over non-code prose.
  - user and system turns yield question, constraint, preference, decision, task and fact items; the first matching rule wins
  - assistant turns yield decisions only, with status `proposed`
  - confidences are hand-set per rule (`RULE_CONFIDENCE`): question 0.8, must/must_not 0.7, should/should_not 0.55, preference 0.6, user decision 0.65, assistant decision 0.5, task 0.5, fact 0.5. They are **estimates, not measurements**
- **Deduplication:** by type plus normalised content; the first occurrence is kept.
- **IDs:** derived deterministically.
  - conversation ID: from platform + URL, falling back to capture time when the URL has no path
  - turn ID: `<conversation>_t<index>`
  - item ID: a hash of turn, type, span and content

## Legacy migration (CIRA v0 → PCO)

The v0 shape is `{ source, title, url, capturedAt, messages: [{ role, content, code?, attachments? }] }`. This is what the browser extension captures and what its popup exports as JSON. The IndexedDB record variant, with `codeBlocks` and `platform`, is also accepted.

- Message text is kept verbatim.
- Code that exists only in `code` or `codeBlocks` is appended to the turn as fenced blocks.
- Attachment `dataUrl` payloads are dropped with a warning; name, type and URL are kept.
