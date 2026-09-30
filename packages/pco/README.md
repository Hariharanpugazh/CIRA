# @cira/pco — PCO specification artifacts

- `schema/pco-0.1.schema.json`: JSON Schema (draft 2020-12), **generated** from `@cira/core`'s Zod schema. It covers structural rules only; semantic rules (unique IDs, provenance references, span bounds) are specified in [docs/pco/specification.md](../../docs/pco/specification.md) and implemented by `@cira/core` `validate()`.
- `examples/*.pco.json`: canonical documents encoded from the core test fixtures.

To regenerate after changing `packages/core/src/pco/schema.ts` or the encoder:

```powershell
pnpm generate:schema
```

`tests/artifacts.test.ts` fails if the files drift from Core. It also validates every example with Ajv, which shows the schema works for non-TypeScript consumers.
