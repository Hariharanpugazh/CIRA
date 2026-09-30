# @cira/cli — `cira`

A command-line connector for CIRA. Every command is a thin wrapper over `@cira/core`, so there is no separate context logic here.

```powershell
pnpm --filter @cira/cli build        # → cli/dist/cira.js (self-contained)
node cli/dist/cira.js --help         # or: pnpm cira --help
```

To get a global `cira` command, run `pnpm --dir cli link --global`. This requires `pnpm setup` to have been run once. Alternatively, add an alias to `node <repo>/cli/dist/cira.js`.

## Commands

```powershell
cira migrate conversation.json               # legacy CIRA export (popup → Export → JSON) → conversation.pco.json
cira validate conversation.pco.json          # structural + semantic validation; exit 1 on errors
cira save conversation.pco.json              # validate, scan for secrets, store in ~/.cira/contexts
cira list                                    # stored contexts
cira export conversation.pco.json --format md
cira export <id> --types decision,constraint,task --min-confidence 0.6
cira export <id> --format json               # decoded context (sections + resolved provenance)
cira export <id> --format pco                # the raw validated PCO
```

Global options:

- `--dir <path>` overrides the store directory.
- The `CIRA_HOME` environment variable moves the whole CIRA home (default `~/.cira`).

Exit codes:

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | invalid input or failure |
| 2 | usage error |

### Reading PCO files in Windows PowerShell 5.1

PCO files are UTF-8 without a BOM. Windows PowerShell 5.1 decodes BOM-less files with the ANSI code page, and the output of native commands with the console code page. So `├──` can show up as `â”œâ”€â”€` (`Get-Content`, `type`) or `Ôö£ÔöÇÔöÇ` (`cira export … > file.md`) even though the stored file is correct. Read and write as UTF-8 instead:

```powershell
Get-Content -Encoding UTF8 $HOME\.cira\contexts\<id>.pco.json
cira export <id> --format md -o context.md   # writes UTF-8; avoid `> context.md`
```

PowerShell 7 reads BOM-less files as UTF-8 by default.

## Local host for the browser extension

The extension saves PCOs to disk through Chrome native messaging. To enable it:

```powershell
pnpm --filter @cira/cli build
node cli/dist/cira.js native-host install --extension-id <your extension id from chrome://extensions>
node cli/dist/cira.js native-host status
```

`install` does three things:

- writes a launcher and host manifest under `~/.cira/native-host/`
- sets `allowed_origins` to only your extension ID
- registers the manifest:
  - on Windows, under `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.cira.context_host` (per-user, no admin needed)
  - on macOS and Linux, by copying it into the browser's per-user `NativeMessagingHosts` folder
- on Windows, checks `ComSpec`. Chrome starts every native host (`.cmd` or `.exe`) through `%ComSpec%`, and with the variable missing it fails with "Failed to start native messaging host." (`COMSPEC is not set` in `chrome --enable-logging` output). If it is missing or points at a file that doesn't exist, `install` sets the per-user value to `%SystemRoot%\System32\cmd.exe`. Quit Chrome completely and start it again afterwards.

Use `--browser edge|chromium|brave` for other browsers, and `--dry-run` to preview. `native-host uninstall` reverses it.

If you move the repository, run `install` again, because the launcher points at `cli/dist/cira.js`.

`node scripts/smoke-native-host.mjs` drives the built host exactly as Chrome does.
