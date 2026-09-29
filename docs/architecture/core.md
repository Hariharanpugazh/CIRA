# CIRA Core (`@cira/core`)

Environment-neutral. It runs unchanged in a browser service worker, a web page, Node, or a future mobile runtime. Its only runtime dependency is `zod`.

## Layout

```text
packages/core/src/
├── pco/           schema.ts (Zod: single source of truth), version.ts, runtime.ts
├── types/         TypeScript types inferred from the schema (discriminated ContextItem union)
├── validation/    validate() structural + semantic, upgrade() version chain, parsePco()
├── provenance/    createProvenance(), resolveProvenance(), describeProvenance(), explainItem()
├── encoder/       encode(), pluggable ItemExtractor, deterministic + heuristic extractors
├── decoder/       decode() → DecodedContext, renderMarkdown()
├── migration/     legacy CIRA v0 conversation → encoder input / PCO
├── selection/     Compressor interface + the legacy rule-based relay compressor (unchanged output)
├── safety/        secret detector (regex + entropy) and scanDocument()
├── storage/       ContextStore interface, InMemoryContextStore, KeyValueContextStore
├── protocol/      local-host message contract (connector ↔ `cira native-host`)
└── node/          @cira/core/node — FileContextStore (the only Node-dependent code)
```

## API at a glance

```ts
import {
  encode, migrateLegacyConversation,           // → PCO
  parsePco, validate, upgrade, assertValid,    // read path for untrusted JSON
  decode, renderMarkdown,                      // PCO → context
  resolveProvenance, explainItem,              // "where did this come from?"
  scanDocument,                                // safety check before saving/sharing
  InMemoryContextStore, KeyValueContextStore,  // storage
  compressLegacy, legacyRuleCompressor,        // legacy relay text (optimisation, not representation)
} from '@cira/core';
import { FileContextStore, defaultContextDir } from '@cira/core/node';

const { document } = migrateLegacyConversation(capturedConversation, { client: 'my-connector@1.0.0' });
const r = parsePco(JSON.parse(text));          // upgrade() then validate(); never throws on bad input
if (r.ok) console.log(renderMarkdown(decode(r.document!, { types: ['constraint', 'decision'] })));
```

## Contracts

- `validate(input)` never throws or mutates. It returns `{ ok, document?, errors[], warnings[] }`, and each issue has a `code` and a JSON `path`.
- Older minor versions go through `upgrade()`. A newer minor version is readable with a warning. A different major version is rejected.
- `encode()` is deterministic: the same input and options give the same IDs. Re-capturing the same conversation URL updates the same PCO.
- `ContextStore.put()` validates first and rejects invalid documents. When it replaces a document it keeps the original `created_at`.
- Items always carry provenance. The validator checks that `conversation_id` and `turn_id` exist in the document and that spans fall inside the turn.

## Adding an extractor

```ts
const myExtractor: ItemExtractor = {
  id: 'acme.todo-comments', version: '1.0.0', method: 'deterministic',
  extract: ({ turn, prose }) => [...prose.matchAll(/TODO: (.+)/g)].map((m) => ({
    type: 'task', status: 'open', content: m[1], confidence: 1,
    span: { start: m.index!, end: m.index! + m[0].length },
  })),
};
encode(input, { extractors: [...DEFAULT_EXTRACTORS, myExtractor] });
```

The encoder adds IDs, provenance (source, conversation, turn, span, capture time, extractor identity) and timestamps.

## Guarantees and non-guarantees

- The heuristic extractor is a set of keyword and phrase rules. It misses paraphrases and misclassifies some sentences. Its confidences are fixed, hand-set values, listed in `RULE_CONFIDENCE`.
- The secret detector is pattern-based. It is a warning mechanism, not a security guarantee.
