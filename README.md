# CIRA — Context Intelligent Relay Assistant

A Chrome extension that lets you carry conversation context between AI assistants
(ChatGPT, Claude, and later Gemini) without copy-paste. Instead of dumping a
raw chat into the next model, CIRA extracts a structured, compressed summary
and injects it into the target site's input box so the next model continues
where the previous one left off.

## Status

Phase 1 MVP — Chrome only, ChatGPT → Claude relay, rule-based compression.

## Tech stack

- Manifest V3 Chrome extension
- TypeScript + React
- Vite + @crxjs/vite-plugin
- Tailwind CSS for the popup UI

## Project structure

```
src/
  content/        Per-site content scripts (DOM scrape + inject UI)
    chatgpt.ts
    claude.ts
  background/     MV3 service worker (message bus, storage)
    service-worker.ts
  popup/          Extension popup (React)
  core/
    schema.ts     Common Conversation type
    extractors/   site DOM -> Conversation
    compress.ts   Conversation -> structured summary
    injectors/    summary -> site input box
  shared/         Cross-cutting utilities
```

## Develop

```
npm install
npm run dev      # Vite dev build with watch
npm run build    # Production build into dist/
```

Then in Chrome: `chrome://extensions` -> Developer mode -> Load unpacked ->
select the `dist/` folder.

## Roadmap

- **Phase 1** Chrome MVP: ChatGPT -> Claude, rule-based compression, popup UI
- **Phase 2** Gemini support, optional LLM-powered "Smart Summary"
- **Phase 3** Context Layers (research / decisions / code / errors), Firefox
- **Phase 4** Optional backend for sync, accounts, vector search
