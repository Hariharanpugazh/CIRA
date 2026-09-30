# CIRA browser extension

This is the Chrome MV3 connector. It captures conversations from ChatGPT, Claude, Gemini, DeepSeek, Perplexity and other AI web apps. It relays them to another platform and saves them as Portable Context Objects.

```powershell
pnpm install
pnpm build:extension      # → <repo>/dist
pnpm dev:extension        # Vite dev build with HMR (run in your own terminal)
```

To load it in Chrome: open `chrome://extensions`, turn on Developer mode, click **Load unpacked**, and select `<repo>/dist`.

To write captured PCOs to `~/.cira/contexts`, install the local host once; see [cli/README.md](../../cli/README.md#local-host-for-the-browser-extension). Without it, PCOs are kept in `chrome.storage.local`, and you can copy them from **Export → PCO (JSON)**.

Architecture: [docs/architecture/browser-extension.md](../../docs/architecture/browser-extension.md).
