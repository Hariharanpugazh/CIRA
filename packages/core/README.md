# @cira/core

CIRA Core is environment-neutral. It holds the **Portable Context Object (PCO) v0.1** model and operates on it:

- validation and upgrade
- encoding and decoding
- provenance
- safety scan
- the legacy relay compressor
- storage interfaces

It does not import `chrome`, DOM, `process` or `fs`. The one exception is `@cira/core/node`, which contains `FileContextStore`.

- Architecture and API: [docs/architecture/core.md](../../docs/architecture/core.md)
- Wire format: [docs/pco/specification.md](../../docs/pco/specification.md)

```powershell
pnpm vitest run --project core
pnpm --filter @cira/core typecheck   # also proves the main entry compiles without DOM/Node types
```

Test fixtures live in `tests/fixtures/`. They use the legacy conversation shape exported by the browser extension. Snapshots of the legacy relay output live in `tests/__snapshots__/legacy-compress/`; they were recorded before the migration and must not change.
